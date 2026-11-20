/** A model's data path as the game stores it: object data names `.mdl`, the file is `.mdx`; a path without an
 *  extension gets `.mdx`. */
export function mdxPathOf(path: string): string {
  return path.replace(/\.mdl$/i, ".mdx").replace(/^(?!.*\.\w+$)(.*)$/, "$1.mdx");
}
