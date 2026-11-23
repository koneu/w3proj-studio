// The project's check settings: a `[checks]` section in w3proj.toml, read by the Problems view and `w3proj check`.
//
//   [checks]
//   disable = ["imports", "melee/camps"]   # check ids (the Problems view's, `melee/<rule>` for check_melee, or "melee")
//
//   melee = "auto"                         # "on": the melee checks run on any map, "off": on none, "auto" (default): on maps
//                                          # whose war3map.w3i has the Melee flag
//
//   [checks.severity]                      # a check's findings all reported as "error", "warning" or "info"; "off" is like disable
//   imports = "warning"
//   "melee/camps" = "error"
//
// A disabled Problems check isn't run; a disabled melee rule's findings aren't listed. This is for whole checks;
// the per-report ignore (.w3proj/problems-ignore.json) is for single reports of a check that stays on.
// Only this one section is read (the rest of the manifest is Rust's, which leaves it alone when writing). A section
// that is there but can't be read is an error the caller reports; nothing is disabled then, and nothing is written.

export const MANIFEST_FILE = "w3proj.toml";

/** What a project without a manifest gets before its first setting is added: Rust's `Manifest` needs only `format`
 *  (tests/fixtures/manifest-minimal-checks/w3proj.toml is this plus a disable, loaded by crates/w3proj tests). */
export const MINIMAL_MANIFEST = "format = 1\n";

export type SeverityOverride = "error" | "warning" | "info" | "off";
export const SEVERITIES: readonly SeverityOverride[] = ["error", "warning", "info", "off"];
/** Whether the melee checks run: "on" on any map, "off" on none, "auto" on maps with the w3i's Melee flag. */
export type MeleeSetting = "on" | "off" | "auto";
export const MELEE_SETTINGS: readonly MeleeSetting[] = ["auto", "on", "off"];
export interface ChecksConfig { disable: string[]; /** check id -> severity its findings get ("off": not run, as in disable) */ severity: Record<string, SeverityOverride>; /** `melee = "on" | "off" | "auto"`; absent is auto */ melee: MeleeSetting }
export const noChecksConfig = (): ChecksConfig => ({ disable: [], severity: {}, melee: "auto" });

/** What decides whether check_melee runs: "on", "off", or "flag" (look at the w3i's Melee flag). `force` is the
 *  command line's own (`--melee`), which wins; else a section asked for by name (`--only=melee`) is on; else the
 *  project's `melee` setting. `by` names the one that decided, for the report. */
export function meleeMode(o: { force?: MeleeSetting | null; asked: boolean; setting: MeleeSetting }): { mode: "on" | "off" | "flag"; by: string } {
  const pick = (m: MeleeSetting, by: string) => ({ mode: m === "auto" ? "flag" as const : m, by });
  if (o.force) return pick(o.force, "--melee");
  if (o.asked) return { mode: "on", by: "--only=melee" };
  return pick(o.setting, `${MANIFEST_FILE} [checks] melee`);
}

/** The melee tools' (check_melee over MCP) gate, by the same decision as `w3proj check` (meleeMode): null to run, else
 *  the reason it is refused. Off refuses, naming the setting; on runs whatever the w3i's Melee flag says; auto runs as
 *  the tool always did (asked for by name, so no flag look-up). A manifest that can't be read refuses too. */
export function meleeToolRefusal(cfg: { config: ChecksConfig; error: string | null }): string | null {
  if (cfg.error) return `${cfg.error}; fix it (or remove [checks] melee) first.`;
  const d = meleeMode({ asked: false, setting: cfg.config.melee });
  return d.mode === "off" ? `the melee checks are switched off (${d.by} = off); set it to "auto" or "on" to run them.` : null;
}

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
  let inChecks = false, inSeverity = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;
    const header = /^\[\[?\s*([^\]]*?)\s*\]\]?$/.exec(line);
    if (header) {
      const table = !line.startsWith("[[");
      inChecks = header[1] === "checks" && table;
      inSeverity = header[1].replace(/\s+/g, "") === "checks.severity" && table;
      continue;
    }
    if (inSeverity) {
      const sv = /^([A-Za-z0-9_-]+|"([^"]*)"|'([^']*)')\s*=\s*(?:"([^"]*)"|'([^']*)')$/.exec(line);
      if (!sv) throw new Error(`[checks.severity] line ${i + 1} isn't check = "error" | "warning" | "info" | "off"`);
      const id = sv[2] ?? sv[3] ?? sv[1], level = sv[4] ?? sv[5];
      if (!(SEVERITIES as readonly string[]).includes(level)) throw new Error(`[checks.severity] ${id}: "${level}" isn't one of ${SEVERITIES.join(", ")}`);
      config.severity[id] = level as SeverityOverride;
      continue;
    }
    if (!inChecks) continue;
    const kv = /^([A-Za-z0-9_-]+|"[^"]*")\s*=\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`[checks] line ${i + 1} isn't a key = value`);
    if (kv[1] === "severity") throw new Error(`[checks] line ${i + 1}: severity is a table of its own, [checks.severity]`);
    if (kv[1] === "melee") {
      const m = /^(?:"([^"]*)"|'([^']*)')$/.exec(kv[2].trim());
      const v = m ? (m[1] ?? m[2]) : "";
      if (!(MELEE_SETTINGS as readonly string[]).includes(v)) throw new Error(`[checks] line ${i + 1}: melee isn't "on", "off" or "auto"`);
      config.melee = v as MeleeSetting;
      continue;
    }
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

const ids = (id: string) => (id.startsWith("melee/") ? [id, "melee"] : [id]);
/** The severity override for a check id: its own, or (for a melee rule) the one of all of "melee". */
export const severityOverride = (c: ChecksConfig, id: string): SeverityOverride | undefined => ids(id).map((i) => c.severity[i]).find((v) => v !== undefined);
/** Whether a check id is switched off: itself, or (for a melee rule) all of "melee", by disable or severity "off". */
export const isDisabled = (c: ChecksConfig, id: string) => ids(id).some((i) => c.disable.includes(i)) || severityOverride(c, id) === "off";
/** Everything the project switched off, for reports. */
export const disabledIds = (c: ChecksConfig) => [...new Set([...c.disable, ...Object.keys(c.severity).filter((k) => c.severity[k] === "off")])];
/** `severity` as the project's override has it (kept when there is none or the check is off, which isn't run). */
export function applySeverity<T extends string>(c: ChecksConfig, id: string, severity: T): T | "error" | "warning" | "info" {
  const o = severityOverride(c, id);
  return o === "error" || o === "warning" || o === "info" ? o : severity;
}

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

/** The manifest's text with `[checks] melee` set to `value` ("auto" removes the line): the rest stays byte for byte.
 *  Creates the section when it is missing. Throws (writes nothing) on text the parser refuses. */
export function setMelee(text: string, value: MeleeSetting): string {
  const cur = parseChecksConfig(text);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/(?<=\n)/);
  let inChecks = false, found = false, lastContent = -1, offset = 0;
  for (const raw of lines) {
    const start = offset;
    offset += raw.length;
    const line = stripComment(raw).trim();
    if (!line) continue;
    const header = /^\[\[?\s*([^\]]*?)\s*\]\]?$/.exec(line);
    if (header) { inChecks = header[1] === "checks" && !line.startsWith("[["); if (inChecks) { found = true; lastContent = offset; } continue; }
    if (!inChecks) continue;
    // A list of `disable` can span lines; its continuation lines never look like `melee =`.
    if (/^melee\s*=/.test(line)) {
      if (value === "auto") return text.slice(0, start) + text.slice(offset);
      const rest = raw.slice(stripComment(raw).length); // the comment and the line ending
      const note = rest.replace(/\r?\n$/, "");
      const tail = note ? ` ${note}` : "";
      const end = raw.endsWith("\r\n") ? "\r\n" : raw.endsWith("\n") ? "\n" : "";
      return `${text.slice(0, start)}melee = "${value}"${tail}${end}${text.slice(offset)}`;
    }
    lastContent = offset;
  }
  if (value === "auto" || cur.melee === value) return text;
  const key = `melee = "${value}"`;
  if (found) {
    const head = text.slice(0, lastContent), tail = text.slice(lastContent);
    return `${head}${head.endsWith("\n") ? "" : eol}${key}${eol}${tail}`;
  }
  const sep = text === "" ? "" : text.endsWith("\n") ? (text.endsWith("\n\n") || text.endsWith("\n\r\n") ? "" : eol) : eol + eol;
  return `${text}${sep}[checks]${eol}${key}${eol}`;
}
