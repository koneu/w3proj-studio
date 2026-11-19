// Preloaded (LD_PRELOAD) into the processes we-drive.mjs starts for the World Editor. The editor's file reader
// (CASC) opens the big data files of the install for reading and writing, and we-drive mounts those (hardlinks of
// the real install's files) read-only, so the open fails with EROFS and the editor asks for a repair. This turns
// such an open into a read-only one: reading works, and a write through it fails (EBADF).
// Only opens that failed with EROFS are retried, so nothing else behaves differently.
//
// This is NOT what keeps the install safe: the read-only mounts of bubblewrap are (an open this doesn't see, a
// direct syscall included, still meets EROFS). It only lets the editor start on them.
//
// Built by we-setup.mjs: cc -shared -fPIC -O2 -o we-rofs.so we-rofs.c -ldl

#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <sys/types.h>

typedef int (*open_fn)(const char *, int, ...);
typedef int (*openat_fn)(int, const char *, int, ...);
typedef int (*creat_fn)(const char *, mode_t);

static int readonly_flags(int flags) {
  return (flags & ~(O_ACCMODE | O_CREAT | O_TRUNC | O_APPEND)) | O_RDONLY;
}

static int wants_write(int flags) {
  return (flags & O_ACCMODE) != O_RDONLY || (flags & (O_TRUNC | O_APPEND));
}

// open(2) reads a mode argument only with O_CREAT or O_TMPFILE. O_TMPFILE includes the O_DIRECTORY bit, so a plain
// O_DIRECTORY open must not count: compare against the whole value.
static int takes_mode(int flags) {
  return (flags & O_CREAT) || ((flags & O_TMPFILE) == O_TMPFILE);
}

// Not covered (only a gap if the editor uses them; docs/testing/editor-tooling.md notes none): openat2 (glibc has no wrapper to
// replace: it is a direct syscall), fopen's internal calls that bypass these symbols (static glibc), and direct
// syscalls. Wine's own file opens go through open/openat. A symbol the C library doesn't have (dlsym NULL) fails the
// call with ENOSYS rather than jumping to address 0.
#define OPEN_WRAPPER(name)                                                    \
  int name(const char *path, int flags, ...) {                               \
    static open_fn real;                                                     \
    if (!real) real = (open_fn)dlsym(RTLD_NEXT, #name);                      \
    if (!real) { errno = ENOSYS; return -1; }                                \
    mode_t mode = 0;                                                         \
    if (takes_mode(flags)) {                                                 \
      va_list ap;                                                            \
      va_start(ap, flags);                                                   \
      mode = va_arg(ap, mode_t);                                             \
      va_end(ap);                                                            \
    }                                                                        \
    int fd = real(path, flags, mode);                                        \
    if (fd < 0 && errno == EROFS && wants_write(flags)) {                    \
      int again = real(path, readonly_flags(flags));                         \
      if (again >= 0) return again;                                          \
      errno = EROFS;                                                         \
    }                                                                        \
    return fd;                                                               \
  }

#define OPENAT_WRAPPER(name)                                                  \
  int name(int dir, const char *path, int flags, ...) {                      \
    static openat_fn real;                                                   \
    if (!real) real = (openat_fn)dlsym(RTLD_NEXT, #name);                    \
    if (!real) { errno = ENOSYS; return -1; }                                \
    mode_t mode = 0;                                                         \
    if (takes_mode(flags)) {                                                 \
      va_list ap;                                                            \
      va_start(ap, flags);                                                   \
      mode = va_arg(ap, mode_t);                                             \
      va_end(ap);                                                            \
    }                                                                        \
    int fd = real(dir, path, flags, mode);                                   \
    if (fd < 0 && errno == EROFS && wants_write(flags)) {                    \
      int again = real(dir, path, readonly_flags(flags));                    \
      if (again >= 0) return again;                                          \
      errno = EROFS;                                                         \
    }                                                                        \
    return fd;                                                               \
  }

// creat(path, mode) is open(path, O_CREAT | O_WRONLY | O_TRUNC, mode): the same retry, as a read-only open.
#define CREAT_WRAPPER(name)                                                   \
  int name(const char *path, mode_t mode) {                                  \
    static creat_fn real;                                                    \
    if (!real) real = (creat_fn)dlsym(RTLD_NEXT, #name);                     \
    if (!real) { errno = ENOSYS; return -1; }                                \
    int fd = real(path, mode);                                               \
    if (fd < 0 && errno == EROFS) {                                          \
      static open_fn real_open;                                              \
      if (!real_open) real_open = (open_fn)dlsym(RTLD_NEXT, "open");         \
      if (!real_open) { errno = EROFS; return -1; }                          \
      int again = real_open(path, O_RDONLY);                                 \
      if (again >= 0) return again;                                          \
      errno = EROFS;                                                         \
    }                                                                        \
    return fd;                                                               \
  }

OPEN_WRAPPER(open)
OPEN_WRAPPER(open64)
OPENAT_WRAPPER(openat)
OPENAT_WRAPPER(openat64)
CREAT_WRAPPER(creat)
CREAT_WRAPPER(creat64)
