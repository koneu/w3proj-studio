// Names of the script's identifiers.

/** Identifiers from names: trailing spaces dropped, every byte of the UTF-8 text that isn't a letter,
 *  digit or _ becomes _ (so a Chinese character makes three), and a "u" is appended when that leaves
 *  a trailing _ (JASS doesn't allow one). */
export function ident(name: string): string {
  let s = "";
  for (const b of new TextEncoder().encode(name.trimEnd())) {
    const c = String.fromCharCode(b);
    s += /[A-Za-z0-9_]/.test(c) ? c : "_";
  }
  return s.endsWith("_") ? `${s}u` : s;
}
