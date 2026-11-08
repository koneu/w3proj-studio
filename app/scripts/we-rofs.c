// Preloaded (LD_PRELOAD) into the processes we-drive.mjs starts for the World Editor. The editor's file reader
// (CASC) opens the big data files of the install for reading and writing, and we-drive mounts those (hardlinks of
// the real install's files) read-only, so the open fails with EROFS and the editor asks for a repair. This turns
// such an open into a read-only one: reading works, and a write fails (EBADF) instead of reaching the real file.
// Only opens that failed with EROFS are retried, so nothing else behaves differently.
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

static int readonly_flags(int flags) {
  return (flags & ~(O_ACCMODE | O_CREAT | O_TRUNC | O_APPEND)) | O_RDONLY;
}

static int wants_write(int flags) {
  return (flags & O_ACCMODE) != O_RDONLY || (flags & (O_TRUNC | O_APPEND));
}

#define OPEN_WRAPPER(name)                                                    \
  int name(const char *path, int flags, ...) {                               \
    static open_fn real;                                                     \
    if (!real) real = (open_fn)dlsym(RTLD_NEXT, #name);                      \
    mode_t mode = 0;                                                         \
    if (flags & (O_CREAT | O_TMPFILE)) {                                     \
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
    mode_t mode = 0;                                                         \
    if (flags & (O_CREAT | O_TMPFILE)) {                                     \
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

OPEN_WRAPPER(open)
OPEN_WRAPPER(open64)
OPENAT_WRAPPER(openat)
OPENAT_WRAPPER(openat64)
