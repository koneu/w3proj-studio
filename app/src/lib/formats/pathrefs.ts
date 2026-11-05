// References to a map file by its archive path (war3mapImported\foo.blp) in text: object data
// and other JSON (backslashes escaped as \\), map scripts and trigger text (JASS/Lua strings,
// also \\), INI-style .txt files, MDL models (plain \ or /). Used to follow an import that
// moves. Case-insensitive like the game; a separator is \, \\ or /, and the reference keeps the
// separator and the case of the rest of its text. Models are matched with either extension
// (object data names Foo.mdl for an imported Foo.mdx) or none (doodads and destructables store
// their model without one).

const MODEL = /\.(mdx|mdl)$/i;

/** A pattern for the path as a whole word of a path: not preceded or followed by more path. */
function pattern(path: string): RegExp {
  const model = MODEL.test(path);
  const stem = model ? path.replace(MODEL, "") : path;
  const parts = stem.split(/[\\/]/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Separator: \\ (escaped) before \ so the escaped form is matched whole.
  const body = parts.join("(\\\\\\\\|\\\\|/)");
  // Without an extension the text can't show where the path ends, so it has to end the value
  // (not "Fx\Hero\a.blp" or "Fx\Hero 2"), and it needs a folder (a bare "Hero" is just a word).
  const ext = "(\\.(?:mdx|mdl))";
  const end = !model ? "" : parts.length > 1 ? `(?:${ext}|(?=["',\\r\\n]|$))` : ext;
  return new RegExp(`(?<![\\w\\\\/.-])${body}${end}(?![\\w.])`, "gi");
}

/** Number of references to `from` in a text. */
export function countPathRefs(text: string, from: string): number {
  return text.match(pattern(from))?.length ?? 0;
}

/** The text with every reference to `from` changed to `to` (in the reference's separator
 *  style; a model keeps the extension it was referenced with, or stays without one). */
export function replacePathRefs(text: string, from: string, to: string): string {
  const model = MODEL.test(from) && MODEL.test(to);
  return text.replace(pattern(from), (...m: unknown[]) => {
    const groups = (m.slice(1, -2) as (string | undefined)[]).filter((g) => g !== undefined);
    const sep = groups.find((g) => g === "\\\\" || g === "\\" || g === "/") ?? "\\";
    const target = model ? to.replace(MODEL, "") + (groups.find((g) => MODEL.test(g)) ?? "") : to;
    return target.split(/[\\/]/).join(sep);
  });
}

/** The same archive path (case and separators aside; models with either extension). */
export function samePathRef(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase().replace(/\.mdl$/, ".mdx");
  return norm(a) === norm(b);
}
