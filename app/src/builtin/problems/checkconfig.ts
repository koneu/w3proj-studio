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
