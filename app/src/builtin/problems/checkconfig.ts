// The project's check settings: a `[checks]` section in w3proj.toml, read by the Problems view and `w3proj check`.
//
//   [checks]
//   disable = ["imports", "melee/camps"]   # check ids (the Problems view's, `melee/<rule>` for check_melee, or "melee")
//
// A disabled Problems check isn't run; a disabled melee rule's findings aren't listed. This is for whole checks;
// the per-report ignore (.w3proj/problems-ignore.json) is for single reports of a check that stays on.
// Only this one section is read (the rest of the manifest is Rust's, which leaves it alone when writing). A section
// that is there but can't be read is an error the caller reports; nothing is disabled then, and nothing is written.

export const MANIFEST_FILE = "w3proj.toml";

/** What a project without a manifest gets before its first setting is added: Rust's `Manifest` needs only `format`
 *  (tests/fixtures/manifest-minimal-checks/w3proj.toml is this plus a disable, loaded by crates/w3proj tests). */
export const MINIMAL_MANIFEST = "format = 1\n";

export interface ChecksConfig { disable: string[] }
export const noChecksConfig = (): ChecksConfig => ({ disable: [] });

/** `line` without a trailing comment (a # outside a string). */
function stripComment(line: string): string {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) quote = ""; } else if (c === '"' || c === "'") quote = c; else if (c === "#") return line.slice(0, i);
  }
  return line;
}

/** The strings of a TOML array of strings: `["a", 'b']`. */
function strings(text: string): string[] {
  const body = text.trim();
  if (!body.startsWith("[") || !body.endsWith("]")) throw new Error("`disable` isn't a list of check ids");
  const out: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(,|$)/gy;
  const inner = body.slice(1, -1).trim();
  let pos = 0;
  while (pos < inner.length) {
    re.lastIndex = pos;
    const m = re.exec(inner);
    if (!m || m.index !== pos) throw new Error("`disable` isn't a list of check ids");
    out.push(m[1] !== undefined ? m[1].replace(/\\(["\\])/g, "$1") : m[2]);
    pos = re.lastIndex;
    if (m[3] === "") break;
  }
  return out;
}

/** The `[checks]` section of a manifest's text. Throws with the reason when it is there but unusable. */
export function parseChecksConfig(text: string): ChecksConfig {
  const config = noChecksConfig();
  let inChecks = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;
    const header = /^\[\[?\s*([^\]]*?)\s*\]\]?$/.exec(line);
    if (header) { inChecks = header[1] === "checks" && !line.startsWith("[["); continue; }
    if (!inChecks) continue;
    const kv = /^([A-Za-z0-9_-]+|"[^"]*")\s*=\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`[checks] line ${i + 1} isn't a key = value`);
    if (kv[1] !== "disable") continue;
    let value = kv[2];
    // A list may run over several lines.
    while (value.trim().startsWith("[") && !value.trim().endsWith("]")) {
      if (++i >= lines.length) throw new Error("`disable` isn't closed with ]");
      value += ` ${stripComment(lines[i]).trim()}`;
    }
    config.disable = strings(value);
  }
  return config;
}

/** Whether a check id is switched off: itself, or (for a melee rule) all of "melee". */
export const isDisabled = (c: ChecksConfig, id: string) => c.disable.includes(id) || (id.startsWith("melee/") && c.disable.includes("melee"));

/** Reads the project's config: none when the manifest has no [checks] (or no file); an `error` when it is unusable. */
export async function readChecksConfig(read: () => Promise<string>, exists: () => Promise<boolean>): Promise<{ config: ChecksConfig; error: string | null }> {
  try {
    if (!(await exists())) return { config: noChecksConfig(), error: null };
    return { config: parseChecksConfig(await read()), error: null };
  } catch (e) { return { config: noChecksConfig(), error: `${MANIFEST_FILE} can't be used for its [checks]: ${e instanceof Error ? e.message : String(e)}` }; }
}

/** The manifest's text with `id` added to `[checks] disable = [...]`: everything else stays as it is, byte for byte
 *  (comments, blank lines, other keys, line endings). The section or the key is created when missing, an id already
 *  listed is not added again. Throws (and so writes nothing) on text the parser refuses. */
export function addDisabled(text: string, id: string): string {
  if (parseChecksConfig(text).disable.includes(id)) return text;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const quoted = `"${id.replace(/([\\"])/g, "\\$1")}"`;
  const lines = text.split(/(?<=\n)/); // each with its line ending
  let offset = 0;
  let inChecks = false, found = false;
  let lastContent = -1; // offset just after the last non-blank line of the section
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], start = offset;
    offset += raw.length;
    const line = stripComment(raw).trim();
    if (!line) continue;
    const header = /^\[\[?\s*([^\]]*?)\s*\]\]?$/.exec(line);
    if (header) { inChecks = header[1] === "checks" && !line.startsWith("[["); if (inChecks) { found = true; lastContent = offset; } continue; }
    if (!inChecks) continue;
    lastContent = offset;
    const kv = /^([A-Za-z0-9_-]+|"[^"]*")\s*=/.exec(line);
    if (!kv || kv[1] !== "disable") continue;
    // The list starts at the first [ after the = (outside the key, which has no [).
    const eq = raw.indexOf("=");
    const open = raw.indexOf("[", eq);
    return insertInList(text, start + open + 1, quoted, eol);
  }
  const key = `disable = [${quoted}]`;
  if (found) {
    const head = text.slice(0, lastContent), tail = text.slice(lastContent);
    return `${head}${head.endsWith("\n") ? "" : eol}${key}${eol}${tail}`;
  }
  const sep = text === "" ? "" : text.endsWith("\n") ? (text.endsWith("\n\n") || text.endsWith("\n\r\n") ? "" : eol) : eol + eol;
  return `${text}${sep}[checks]${eol}${key}${eol}`;
}

/** Adds `quoted` to the array whose `[` is just before `from`, touching as little as possible. */
function insertInList(text: string, from: number, quoted: string, eol: string): string {
  let quote = "", lastEnd = -1, comma = false, close = -1;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === "\\" && quote === '"') i++; else if (c === quote) { quote = ""; lastEnd = i + 1; comma = false; } continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#") { while (i < text.length && text[i] !== "\n") i++; }
    else if (c === ",") comma = true;
    else if (c === "]") { close = i; break; }
  }
  if (close < 0) throw new Error("`disable` isn't closed with ]");
  if (lastEnd < 0) return `${text.slice(0, close)}${quoted}${text.slice(close)}`;
  const lineStart = text.lastIndexOf("\n", close - 1) + 1;
  const ownLine = /^[ \t]*$/.test(text.slice(lineStart, close)) && lineStart > lastEnd;
  if (ownLine) {
    const lastLineStart = text.lastIndexOf("\n", lastEnd - 1) + 1;
    const indent = /^[ \t]*/.exec(text.slice(lastLineStart))![0];
    const withComma = comma ? text.slice(0, lineStart) : `${text.slice(0, lastEnd)},${text.slice(lastEnd, lineStart)}`;
    return `${withComma}${indent}${quoted},${eol}${text.slice(lineStart)}`;
  }
  if (comma) return `${text.slice(0, close)}${quoted}, ${text.slice(close)}`;
  return `${text.slice(0, lastEnd)}, ${quoted}${text.slice(lastEnd)}`;
}
