// war3map.lua for Lua maps: the World Editor writes the same functions as for
// JASS, in Lua and without comments or indentation. So the JASS the generator
// makes (with the `lua` flag) is translated line by line:
//   globals → `name = value` (arrays `__jarray(default)` or `{}`), `function N
//   takes … returns …` → `function N(params)`, end* → `end`, `loop`/`exitwhen`
//   → `while (true) do` / `if (…) then break end`, `call`/`set`/types dropped,
//   'hfoo' → FourCC("hfoo"), null → nil, != → ~=, `function F` → `F`, and
//   spacing as the World Editor's Lua writer has it ("f(a, b)", "return ").
// What differs by type (real defaults `0.0`, empty strings `""`) is decided
// before, in jass.ts and triggers.ts with the `lua` flag.
// Lines marked RAW (the map's own Lua: custom script, custom-text triggers)
// are copied as they are; markers stand for `..` and `//`, which have no
// JASS spelling.

const EOL = "\r\n";

/** Starts a line copied unchanged. */
export const RAW = "\u0001";
/** String concatenation (`..`). */
export const CONCAT = "\u0002";
/** Integer division (`//`). */
export const INT_DIV = "\u0003";

/** Default element of a global array by base type. */
const ARRAY_DEFAULT: Record<string, string> = { integer: "__jarray(0)", real: "__jarray(0.0)", boolean: "__jarray(false)", string: "__jarray(\"\")" };

/** An expression or statement outside string literals: operators, literals and spacing. */
function code(s: string): string {
  return s
    .replace(/'((?:[^'\\]|\\.){1,4})'/g, (_, id: string) => `FourCC("${id}")`)
    .replace(/\bfunction\s+(\w+)/g, "$1")
    .replace(/\bnull\b/g, "nil")
    .replace(/!=/g, "~=")
    .replace(CONCAT_RE, "..")
    .replace(INT_DIV_RE, "//")
    .replace(/[ \t]+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")")
    .replace(/ ?, ?/g, ", ");
}
const CONCAT_RE = new RegExp(CONCAT, "g"), INT_DIV_RE = new RegExp(INT_DIV, "g");

/** Translates the parts of a line outside string literals. */
export function expr(line: string): string {
  let out = "", i = 0;
  while (i < line.length) {
    const q = line.indexOf("\"", i);
    if (q < 0) { out += code(line.slice(i)); break; }
    out += code(line.slice(i, q));
    let j = q + 1;
    while (j < line.length && line[j] !== "\"") j += line[j] === "\\" ? 2 : 1;
    out += line.slice(q, j + 1);
    i = j + 1;
  }
  return out.trim();
}

/** One global declaration (`[constant] type [array] name [= value]`). */
function global(decl: string): string | null {
  const m = /^(?:constant\s+)?(\w+)\s+(array\s+)?(\w+)(?:\s*=\s*(.*))?$/.exec(decl);
  if (!m) return null;
  const [, type, array, name, value] = m;
  if (array) return `${name} = ${ARRAY_DEFAULT[type] ?? "{}"}`;
  return `${name} = ${value !== undefined ? expr(value) : "nil"}`;
}

/** The Lua for a whole generated JASS script. */
export function jassToLua(jass: string): string {
  const out: string[] = [];
  let inGlobals = false, depth = 0, locals = false;
  for (const raw of jass.split(/\r?\n/)) {
    if (raw.startsWith(RAW)) { out.push(raw.slice(1)); continue; }
    const line = raw.trim();
    if (!line || line.startsWith("//")) continue;
    if (line === "globals") { inGlobals = true; continue; }
    if (line === "endglobals") { inGlobals = false; continue; }
    if (inGlobals) { const g = global(line); if (g) out.push(g); continue; }

    let m: RegExpExecArray | null;
    // A blank line separates a function's locals from its body.
    const isLocal = line.startsWith("local ");
    if (locals && !isLocal && line !== "endfunction") out.push("");
    locals = false;
    if ((m = /^function\s+(\w+)\s+takes\s+(.*?)\s+returns\s+\w+$/.exec(line))) {
      const params = m[2] === "nothing" ? [] : m[2].split(",").map((p) => p.trim().split(/\s+/).pop()!);
      out.push(`function ${m[1]}(${params.join(", ")})`);
      depth++;
      continue;
    }
    if (isLocal) {
      const l = /^local\s+(\w+)\s+(array\s+)?(\w+)(?:\s*=\s*(.*))?$/.exec(line);
      if (l) out.push(l[2] ? `local ${l[3]} = ${ARRAY_DEFAULT[l[1]] ?? "{}"}` : l[4] !== undefined ? `local ${l[3]} = ${expr(l[4])}` : `local ${l[3]}`);
      locals = true;
      continue;
    }
    if (line === "endfunction" || line === "endif" || line === "endloop") {
      out.push("end");
      if (line === "endfunction") { depth--; if (depth === 0) out.push(""); }
      continue;
    }
    if (line === "loop") { out.push("while (true) do"); continue; }
    if ((m = /^exitwhen\s+(.*)$/.exec(line))) { out.push(`if (${expr(m[1])}) then break end`); continue; }
    // A bare return (Skip Remaining Actions) keeps the space the World Editor writes after it.
    if (line === "return") { out.push("return "); continue; }
    out.push(expr(line.replace(/^(call|set)\s+/, "")));
  }
  return out.join(EOL) + EOL;
}
