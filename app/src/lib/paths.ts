// File system paths in the system's own form. The backend hands out roots as the system writes them:
// `C:\…` or `\\server\…` on Windows, `/…` on Linux. A path inside a project (or inside a map) is written
// with `/` and joined onto a root here, never with a hand-written `\`: on Linux a backslash is an ordinary
// character in a file name, so `/home/u/a\map\x` is one oddly named file next to the project, not a file in it.
//
// Paths inside a map archive or the game's storage (`Units\Human\…`) are not file system paths; they keep
// their backslashes and don't go through here.

/** A Windows path: a drive (`C:`) or a network share (`\\server`). Anything else is a POSIX path. */
export const isWindowsPath = (p: string) => /^[a-z]:/i.test(p) || p.startsWith("\\\\");

/** The separator of the root's system. */
export const separatorOf = (root: string) => (isWindowsPath(root) ? "\\" : "/");

/** A path below a root, in the root's system. The parts may hold `/` or `\`; empty parts are left out. */
export function joinPath(root: string, ...parts: string[]): string {
  const sep = separatorOf(root);
  const base = root.length > 1 ? root.replace(/[\\/]+$/, "") : root;
  const rest = parts.flatMap((p) => p.split(/[\\/]+/)).filter(Boolean);
  if (!rest.length) return base;
  return base.endsWith(sep) ? base + rest.join(sep) : `${base}${sep}${rest.join(sep)}`;
}

/** Whether a path is a full file system path on either system: `C:\…`, `\\server\…` or `/…`. For a path
 *  with no root to compare with (a folder the user or an AI client gave). Project paths never start with `/`. */
export const isFullPath = (p: string) => /^(?:[a-z]:[\\/]|\\\\|\/)/i.test(p);

/** Whether a path is already a full path in the root's system, rather than one inside the project. */
export function isAbsolutePath(p: string, root: string): boolean {
  if (/^[a-z]:[\\/]/i.test(p) || p.startsWith("\\\\")) return true;
  return !isWindowsPath(root) && p.startsWith("/");
}
