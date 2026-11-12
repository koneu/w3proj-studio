// Which imported files get a preview in the Import Manager's detail box, and what the cached one is keyed by.

/** Files above this size aren't previewed (they'd be read and decoded on every selection). */
export const MAX_PREVIEW = 32 * 1024 * 1024;

/** The model preview reads .mdx and .mdl (text) models. */
export function isPreviewModel(path: string): boolean {
  return /\.md[xl]$/i.test(path);
}

/** The key of what is previewed: a changed file (replaced, undone) gets a new preview. Null: no preview of that file. */
export function previewKey(path: string, file: { path: string; size: number; modified?: unknown }, kind: "image" | "model"): string | null {
  if (file.size > MAX_PREVIEW) return null;
  if (kind === "model" && !isPreviewModel(path)) return null;
  return `${kind}|${path.toLowerCase()}|${file.path}|${file.size}|${String(file.modified)}`;
}
