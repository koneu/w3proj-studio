// What git's text output means, kept apart from the view so it can be tested.

/** The real size of a file that's a Git LFS pointer in the commit, null for other text. */
export function lfsSize(text: string | null): number | null {
  if (!text?.startsWith("version https://git-lfs.github.com/spec/")) return null;
  const m = /^size (\d+)$/m.exec(text);
  return m ? Number(m[1]) : null;
}
