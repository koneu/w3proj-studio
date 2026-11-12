// Name help for Lua map scripts: where the cursor is, and what a text declares. The game's natives
// and Blizzard.j functions are the same ones JASS has (see jass/env), so only Lua's own side is here.

import type { CodeSpot } from "../jass/callsite";
import type { JassEnv } from "../jass/check";
import { jassSymbols, type JassSymbol } from "../jass/env";

/** Looks back at most this far for the call. */
const WINDOW = 4000;

/** The cursor in Lua text: strings use either quote, and a string given to FourCC is a rawcode. */
export function luaSpot(text: string, pos: number): CodeSpot & { quote?: string } {
  let start = Math.max(0, pos - WINDOW);
  if (start > 0) start = text.indexOf("\n", start) + 1 || pos;
  const stack: { name: string | null; argIndex: number }[] = [];
  let lastIdent: string | null = null;
  const none = { inString: false, inRawcode: false, prefix: "", from: pos };
  let i = start;
  while (i < pos) {
    const c = text[i];
    if (c === "-" && text[i + 1] === "-") {
      const long = /^--\[(=*)\[/.exec(text.slice(i, i + 40));
      const end = long ? text.indexOf(`]${long[1]}]`, i) : text.indexOf("\n", i);
      if (end < 0 || end >= pos) return none; // the cursor is in a comment
      i = end + (long ? long[1].length + 2 : 1);
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < pos && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      if (j >= pos) {
        const rawcode = stack[stack.length - 1]?.name === "FourCC";
        // A rawcode is an argument of the call around FourCC: that says which kind of object.
        const top = stack[stack.length - (rawcode ? 2 : 1)];
        return { inString: !rawcode, inRawcode: rawcode, prefix: text.slice(i + 1, pos).replace(/\\(.)/g, "$1"), from: i + 1, quote: c,
          call: top?.name ? { name: top.name, argIndex: top.argIndex } : undefined };
      }
      i = j + 1;
      lastIdent = null;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < pos && /[\w.:]/.test(text[j])) j++;
      lastIdent = text.slice(i, j);
      i = j;
      continue;
    }
    if (c === "(") stack.push({ name: lastIdent, argIndex: 0 });
    else if (c === ")") stack.pop();
    else if (c === "," && stack.length) stack[stack.length - 1].argIndex++;
    if (!/\s/.test(c)) lastIdent = null;
    i++;
  }
  const word = /\w*$/.exec(text.slice(start, pos))?.[0] ?? "";
  const top = stack[stack.length - 1];
  return { inString: false, inRawcode: false, prefix: word, from: pos - word.length, call: top?.name ? { name: top.name, argIndex: top.argIndex } : undefined };
}

const KEYWORDS = ["and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while"];
/** Lua's own globals that map scripts can use. */
const STANDARD = ["FourCC", "assert", "coroutine", "error", "getmetatable", "io", "ipairs", "math", "next", "os", "pairs", "pcall", "print", "rawequal", "rawget", "rawlen",
  "rawset", "require", "select", "setmetatable", "string", "table", "tonumber", "tostring", "type", "utf8", "xpcall"];
/** Lua 5.3's standard libraries: their members (offered after `math.`). */
const LIBRARIES: Record<string, string[]> = {
  math: ["abs", "ceil", "cos", "deg", "exp", "floor", "fmod", "huge", "log", "max", "maxinteger", "min", "mininteger", "modf", "pi", "rad", "random",
    "randomseed", "sin", "sqrt", "tan", "tointeger", "type", "ult", "acos", "asin", "atan"],
  string: ["byte", "char", "dump", "find", "format", "gmatch", "gsub", "len", "lower", "match", "pack", "packsize", "rep", "reverse", "sub", "unpack", "upper"],
  table: ["concat", "insert", "move", "pack", "remove", "sort", "unpack"],
  os: ["clock", "date", "difftime", "time"],
  io: ["close", "flush", "input", "lines", "open", "output", "read", "stderr", "stdin", "stdout", "tmpfile", "type", "write"],
  coroutine: ["create", "isyieldable", "resume", "running", "status", "wrap", "yield"],
  utf8: ["char", "charpattern", "codepoint", "codes", "len", "offset"],
};
const VALUES = new Set(["math.huge", "math.maxinteger", "math.mininteger", "math.pi", "io.stderr", "io.stdin", "io.stdout", "utf8.charpattern"]);
/** Warcraft III's Lua leaves io out (the game's sandbox): offered, but said so. */
const NOT_IN_GAME = new Set(["io"]);

/** What a text declares: functions, with their parameters inside them, locals and globals. */
export function luaDeclarations(text: string): JassSymbol[] {
  const out: JassSymbol[] = [];
  const seen = new Set<string>();
  const add = (s: JassSymbol) => { const key = `${s.name}@${s.scope?.[0] ?? ""}`; if (!seen.has(key)) { seen.add(key); out.push(s); } };
  // Comments and strings don't declare anything: blanked, keeping every offset.
  const code = text.replace(/--\[(=*)\[[\s\S]*?\]\1\]|--[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => m.replace(/[^\n]/g, " "));
  for (const m of code.matchAll(/^([ \t]*)(local[ \t]+)?function[ \t]+([\w.:]+)[ \t]*\(([^)]*)\)/gm)) {
    const at = m.index + m[0].indexOf(m[3]);
    add({ name: m[3], kind: "function", detail: `function ${m[3]}(${m[4].trim()})`, at });
    // Its body runs to the "end" at the function's own indentation.
    const close = new RegExp(`^${m[1]}end\\b`, "m").exec(code.slice(m.index + m[0].length));
    const scope: [number, number] = [m.index, close ? m.index + m[0].length + close.index + 3 : code.length];
    for (const p of m[4].split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z_]\w*$/.test(s))) add({ name: p, kind: "param", detail: `parameter ${p}`, scope });
  }
  for (const m of code.matchAll(/^[ \t]*local[ \t]+(?!function\b)([A-Za-z_][\w \t,]*)/gm)) {
    let at = m.index + m[0].indexOf(m[1]);
    for (const name of m[1].split(",")) {
      const n = name.trim();
      if (/^[A-Za-z_]\w*$/.test(n)) add({ name: n, kind: "local", detail: `local ${n}`, at: at + name.indexOf(n) });
      at += name.length + 1;
    }
  }
  for (const m of code.matchAll(/^([A-Za-z_]\w*)[ \t]*=[^=]/gm)) add({ name: m[1], kind: "global", detail: `global ${m[1]}`, at: m.index });
  return out;
}

/** Everything a Lua script can name: its own, Lua's, and the game's functions and constants. */
export function luaSymbols(env: JassEnv, text: string): JassSymbol[] {
  const game = jassSymbols(env, "").filter((s) => s.kind === "function" || s.kind === "native" || s.kind === "global" || s.kind === "constant");
  return [...luaDeclarations(text),
    ...KEYWORDS.map((name): JassSymbol => ({ name, kind: "keyword", detail: "Lua keyword" })),
    ...STANDARD.map((name): JassSymbol => ({ name, kind: "function", detail: name === "FourCC" ? "FourCC(rawcode) → the id of 'hfoo' as a number" : `Lua: ${name}${NOT_IN_GAME.has(name) ? " (not in Warcraft III's Lua)" : ""}` })),
    ...Object.entries(LIBRARIES).flatMap(([lib, members]) => members.map((m): JassSymbol => {
      const name = `${lib}.${m}`;
      return { name, kind: VALUES.has(name) ? "constant" : "function", detail: `Lua: ${name}${NOT_IN_GAME.has(lib) ? " (not in Warcraft III's Lua)" : ""}` };
    })),
    ...game];
}

/** The table a member is being typed of: "math" in `x = math.fl` (also `a.b.c`, and `obj:` for methods); null elsewhere. */
export function luaMemberBase(before: string): string | null {
  const m = /(?:^|[^\w.:])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)[.:]\w*$/.exec(before);
  return m ? m[1] : null;
}

/** The members of `base` among `symbols` (dotted names: "math.floor", a text's "M.run" or "M:new"), by
 *  their next part; a deeper name ("M.a.b") gives its table ("a") once. */
export function luaMembers<S extends { name: string }>(symbols: S[], base: string): { name: string; symbol: S; table: boolean }[] {
  const out = new Map<string, { name: string; symbol: S; table: boolean }>();
  for (const s of symbols) {
    if (s.name.length <= base.length + 1 || !s.name.startsWith(base) || (s.name[base.length] !== "." && s.name[base.length] !== ":")) continue;
    const rest = s.name.slice(base.length + 1);
    const part = /^\w+/.exec(rest)?.[0];
    if (!part) continue;
    const table = part.length < rest.length;
    const had = out.get(part);
    if (!had || (had.table && !table)) out.set(part, { name: part, symbol: s, table });
  }
  return [...out.values()];
}
