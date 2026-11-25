// A check for map scripts in Lua: what a broken script looks like at a glance (blocks that don't close,
// unbalanced brackets, unfinished strings and comments), without parsing expressions; and, given the
// names known outside the text (luaKnownNames: the game's natives and Blizzard functions, Lua's own,
// the map script's globals), calls of plain names that nothing defines ("Unknown function X", a
// warning). That part is conservative: a miss is better than a wrong report on a valid map (see
// unknownCalls). Offsets are into the text.

import type { JassEnv } from "../jass/check";

export interface LuaProblem { from: number; to: number; message: string; severity: "error" | "warning" }

// Maps: scripts have words like "constructor", which every plain object has.
const OPENS = new Map([["function", "end"], ["do", "end"], ["then", "end"], ["repeat", "until"]]);
const BRACKETS = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);

/** The level of a long bracket opening at `i` ("[[" is 0, "[==[" is 2), or -1. */
function longOpen(s: string, i: number): number {
  let n = i + 1;
  while (s[n] === "=") n++;
  return s[n] === "[" ? n - i - 1 : -1;
}

/** Problems of the Lua text `s`. With `known` (luaKnownNames), also calls of plain names that neither the text nor
 *  `known` defines; null or absent: the syntax check only (null is what luaKnownNames gives when it can't tell). */
export function checkLua(s: string, known?: ReadonlySet<string> | null): LuaProblem[] {
  const out: LuaProblem[] = checkSyntax(s).map((p) => ({ ...p, severity: "error" }));
  // Scopes come from the blocks: with a block that doesn't close they aren't known, so names aren't judged.
  if (known && !out.length) out.push(...unknownCalls(s, known));
  return out;
}

function checkSyntax(s: string): { from: number; to: number; message: string }[] {
  const out: { from: number; to: number; message: string }[] = [];
  const open: { want: string; from: number; to: number; word: string }[] = [];
  const close = (word: string, from: number, to: number) => {
    const top = open[open.length - 1];
    if (top?.want === word) { open.pop(); return; }
    out.push({ from, to, message: top ? `Expected "${top.want}" for the "${top.word}" before it, found "${word}"` : `"${word}" without anything to close` });
    // The error is reported: forget what it meant to close, so one mistake gives one report.
    const at = open.map((o) => o.want).lastIndexOf(word);
    if (at >= 0) open.length = at;
    // A block closed with the wrong word ("repeat … end") is closed all the same.
    else if (top && /^[a-z]/.test(top.want) && /^[a-z]/.test(word)) open.pop();
  };
  /** The token before this one, comments aside, when it's a single dot or colon. */
  let last = "";
  let i = 0;
  while (i < s.length && out.length < 50) {
    const c = s[i];
    if (c === "-" && s[i + 1] === "-") {
      const level = s[i + 2] === "[" ? longOpen(s, i + 2) : -1;
      if (level >= 0) {
        const end = s.indexOf(`]${"=".repeat(level)}]`, i);
        if (end < 0) { out.push({ from: i, to: i + 4, message: "Comment isn't closed" }); return out; }
        i = end + level + 2;
      } else {
        const end = s.indexOf("\n", i);
        i = end < 0 ? s.length : end;
      }
    } else if (c === '"' || c === "'") {
      last = "";
      const from = i++;
      while (i < s.length && s[i] !== c && s[i] !== "\n") i += s[i] === "\\" ? 2 : 1;
      if (s[i] !== c) out.push({ from, to: Math.min(i, from + 40), message: "String isn't closed" });
      else i++;
    } else if (c === "[" && longOpen(s, i) >= 0) {
      last = "";
      const level = longOpen(s, i);
      const end = s.indexOf(`]${"=".repeat(level)}]`, i);
      if (end < 0) { out.push({ from: i, to: i + 2 + level, message: "String isn't closed" }); return out; }
      i = end + level + 2;
    } else if (BRACKETS.has(c)) {
      last = "";
      open.push({ want: BRACKETS.get(c)!, from: i, to: i + 1, word: c });
      i++;
    } else if (c === ")" || c === "]" || c === "}") {
      last = "";
      close(c, i, i + 1);
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      const from = i;
      while (i < s.length && /\w/.test(s[i])) i++;
      const word = s.slice(from, i);
      // A field after one dot or colon isn't a keyword (".." and "..." and "::" don't count).
      const field = last === "." || last === ":";
      last = "";
      if (field) continue;
      if (word === "if" || word === "while" || word === "for") {
        // "then" and "do" open their blocks.
      } else if (word === "elseif" || word === "else") {
        if (open[open.length - 1]?.word !== "then") out.push({ from, to: i, message: `"${word}" outside an if` });
        else if (word === "elseif") open.pop();
      } else if (OPENS.has(word)) {
        open.push({ want: OPENS.get(word)!, from, to: i, word });
      } else if (word === "end" || word === "until") {
        close(word, from, i);
      }
    } else if (/[0-9]/.test(c)) {
      last = "";
      while (i < s.length && /[\w.]/.test(s[i])) i++;
    } else {
      if (!/s/.test(c)) last = c === s[i + 1] || c === s[i - 1] ? "" : c;
      i++;
    }
  }
  for (const o of open.slice(-5)) out.push({ from: o.from, to: o.to, message: `"${o.word}" isn't closed` });
  return out;
}

// ---- Names ----

/** Lua's own globals that map scripts can use (also offered by completion, symbols.ts). */
export const LUA_STANDARD = ["FourCC", "assert", "coroutine", "error", "getmetatable", "io", "ipairs", "math", "next", "os", "pairs", "pcall", "print",
  "rawequal", "rawget", "rawlen", "rawset", "require", "select", "setmetatable", "string", "table", "tonumber", "tostring", "type", "utf8", "xpcall"];
/** Known too, not offered: older Lua's names, the rest of the standard library, and what the game's Lua adds
 *  (__jarray: the World Editor's arrays with a default). A script that defines one of these itself is fine either way. */
const LUA_OTHER = ["_G", "_ENV", "_VERSION", "collectgarbage", "debug", "dofile", "load", "loadfile", "loadstring", "module", "unpack", "gcinfo",
  "getfenv", "setfenv", "newproxy", "package", "__jarray", "self", "arg"];
/** Names that run code or reach globals by a computed name: a script with one may define any name (unknownCalls). */
const DYNAMIC = new Set(["load", "loadstring", "dofile", "loadfile", "setfenv", "getfenv", "module"]);
const LUA_KEYWORDS = new Set(["and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in", "local", "nil", "not",
  "or", "repeat", "return", "then", "true", "until", "while"]);

interface Tok { k: "name" | "str" | "num" | "op"; v: string; from: number; to: number; line: number }
const OPS2 = new Set(["..", "::", "==", "~=", "<=", ">=", "//", "<<", ">>"]);

/** The tokens of `s`, comments left out (a text the syntax check passed: what isn't closed runs to the end). */
function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0, line = 0;
  const lines = (a: number, b: number) => { for (let j = a; j < b; j++) if (s.charCodeAt(j) === 10) line++; };
  while (i < s.length) {
    const c = s[i];
    if (c === "\n") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    const from = i;
    if (c === "-" && s[i + 1] === "-") {
      const level = s[i + 2] === "[" ? longOpen(s, i + 2) : -1;
      const e = level >= 0 ? s.indexOf(`]${"=".repeat(level)}]`, i) : s.indexOf("\n", i);
      i = e < 0 ? s.length : level >= 0 ? e + level + 2 : e;
      lines(from, i);
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < s.length && s[i] !== c && s[i] !== "\n") i += s[i] === "\\" ? 2 : 1;
      i = Math.min(i + 1, s.length);
      out.push({ k: "str", v: s.slice(from + 1, i - 1), from, to: i, line });
      lines(from, i);
      continue;
    }
    if (c === "[" && longOpen(s, i) >= 0) {
      const level = longOpen(s, i);
      const e = s.indexOf(`]${"=".repeat(level)}]`, i);
      i = e < 0 ? s.length : e + level + 2;
      // A long string's text has no escapes; marked with a backslash so it is never taken for a plain name (_G[[[x]]]).
      out.push({ k: "str", v: "\\long", from, to: i, line });
      lines(from, i);
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      while (i < s.length && /\w/.test(s[i])) i++;
      out.push({ k: "name", v: s.slice(from, i), from, to: i, line });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(s[i + 1] ?? ""))) {
      while (i < s.length && (/[\w.]/.test(s[i]) || ((s[i] === "+" || s[i] === "-") && /[eEpP]/.test(s[i - 1])))) i++;
      out.push({ k: "num", v: s.slice(from, i), from, to: i, line });
      continue;
    }
    const v = s.startsWith("...", i) ? "..." : OPS2.has(s.slice(i, i + 2)) ? s.slice(i, i + 2) : c;
    i += v.length;
    out.push({ k: "op", v, from, to: i, line });
  }
  return out;
}

const isOp = (t: Tok | undefined, v: string) => t?.k === "op" && t.v === v;
/** A name after a single dot or colon is a field or method, keywords too (t.end). */
const isField = (t: Tok[], i: number) => isOp(t[i - 1], ".") || isOp(t[i - 1], ":");

/** For each "[" token the index of its "]", -1 where none closes it (and for other tokens): in one pass. */
function closingBrackets(t: Tok[]): Int32Array {
  const out = new Int32Array(t.length).fill(-1);
  const open: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (isOp(t[i], "[")) open.push(i);
    else if (isOp(t[i], "]") && open.length) out[open.pop()!] = i;
  }
  return out;
}

/** The global names a text defines: every plain name assigned anywhere (`a = …`, `a, b = …`, also locals and table keys:
 *  a name counted that isn't global only hides a report), `function Name(…)` (also local), `_G.Name` and `_G["Name"]`.
 *  Null when the text may define names that can't be seen: it uses _ENV, hands _G around or indexes it with a computed
 *  key, or runs code from strings (load, loadstring, …). */
function textGlobals(t: Tok[]): Set<string> | null {
  const out = new Set<string>();
  /** The names of DYNAMIC used: a text may define its own (a bundler's `local module = …`). */
  const dynamic = new Set<string>();
  let closing: Int32Array | null = null;
  for (let i = 0; i < t.length; i++) {
    const tok = t[i];
    if (tok.k !== "name" || isField(t, i)) continue;
    if (DYNAMIC.has(tok.v)) dynamic.add(tok.v);
    if (tok.v === "_G" || tok.v === "_ENV") {
      if (isOp(t[i + 1], ".") && t[i + 2]?.k === "name") out.add(t[i + 2].v);
      else if (isOp(t[i + 1], "[") && t[i + 2]?.k === "str" && /^[A-Za-z_]\w*$/.test(t[i + 2].v) && isOp(t[i + 3], "]")) out.add(t[i + 2].v);
      else if (isOp(t[i + 1], "[")) {
        // A computed key: read (`_G["On" .. x](…)`) is fine, assigned (`_G[name] = f`) defines a name that can't be seen.
        closing ??= closingBrackets(t);
        const j = closing[i + 1];
        if (j < 0 || isOp(t[j + 1], "=") || isOp(t[j + 1], ",")) return null;
      }
      // Anything else (handed on, aliased, a parameter as in `function(_ENV)`) may define any name.
      else return null;
      continue;
    }
    if (tok.v === "function" && t[i + 1]?.k === "name" && isOp(t[i + 2], "(")) { out.add(t[i + 1].v); continue; }
    if (LUA_KEYWORDS.has(tok.v)) continue;
    if (isOp(t[i + 1], "=")) { out.add(tok.v); continue; }
    if (isOp(t[i + 1], ",")) {
      // `a, b.c, d = …`: the plain names of a list of targets.
      const names = [tok.v];
      let j = i + 1;
      // (_G, _ENV and DYNAMIC end it: they are looked at on their own.)
      const plain = (x: Tok | undefined) => x?.k === "name" && !LUA_KEYWORDS.has(x.v) && !DYNAMIC.has(x.v) && x.v !== "_G" && x.v !== "_ENV";
      while (isOp(t[j], ",") && plain(t[j + 1])) {
        let k = j + 2;
        if (isOp(t[k], ".") && t[k + 1]?.k === "name") { while (isOp(t[k], ".") && t[k + 1]?.k === "name") k += 2; }
        else names.push(t[j + 1].v);
        j = k;
      }
      if (isOp(t[j], "=")) for (const n of names) out.add(n);
      // The list's names are looked at once (a long argument list would be gone through again from each).
      i = j - 1;
    }
  }
  for (const n of dynamic) if (!out.has(n)) return null;
  return out;
}

/** textGlobals of recent scripts: the map script is read again for each check of a trigger's text while typing. */
const recent = new Map<string, Set<string> | null>();
function scriptGlobals(s: string): Set<string> | null {
  if (recent.has(s)) {
    // The latest used last: the map script stays while texts come and go.
    const had = recent.get(s)!;
    recent.delete(s);
    recent.set(s, had);
    return had;
  }
  const out = textGlobals(tokenize(s));
  if (recent.size >= 16) recent.delete(recent.keys().next().value!);
  recent.set(s, out);
  return out;
}

/** The game's Lua API: Lua's own names, the natives, Blizzard functions and globals of `env` (common.j and Blizzard.j)
 *  and the natives of common.ai (`commonAi`, its text: a Lua map has every native, also those a JASS map declares
 *  itself, such as UnitAlive). */
export function luaApiFrom(env: JassEnv, commonAi: string): Set<string> {
  const out = new Set<string>([...LUA_STANDARD, ...LUA_OTHER]);
  for (const n of env.functions.keys()) out.add(n);
  for (const n of env.globals.keys()) out.add(n);
  for (const m of commonAi.matchAll(/^[ \t]*(?:constant[ \t]+)?native[ \t]+(\w+)/gm)) out.add(m[1]);
  return out;
}

/** The names known outside a text: the game's API (luaApiFrom) and the globals the given scripts define (the map's
 *  war3map.lua, other trigger texts). Null when the API isn't known or one of the scripts may define names that
 *  can't be seen: then no name can be called unknown. */
export function luaKnownNames(api: ReadonlySet<string> | null, scripts: readonly string[] = []): Set<string> | null {
  if (!api) return null;
  const out = new Set<string>(api);
  for (const s of scripts) {
    // A script whose blocks don't close is still read for its names: it's only a guess, but one that hides reports.
    const own = scriptGlobals(s);
    if (!own) return null;
    for (const n of own) out.add(n);
  }
  return out;
}

interface Scope { names: Set<string>; parent: Scope | null; kind: string }

/** Calls `Name(…)`, `Name "…"`, `Name {…}` of a plain name that nothing defines: not the text (textGlobals), not a local,
 *  parameter or loop variable of a block around the call (a local counts in its whole block, also before it), not
 *  `known`. Fields and methods (a.b(), a:b()) aren't judged, nor anything in a text with dynamic globals. */
function unknownCalls(s: string, known: ReadonlySet<string>): LuaProblem[] {
  const t = tokenize(s);
  const defined = textGlobals(t);
  if (!defined) return [];
  let scope: Scope = { names: new Set(), parent: null, kind: "chunk" };
  const push = (kind: string, names: Iterable<string> = []) => { scope = { names: new Set(names), parent: scope, kind }; };
  const pop = () => { if (scope.parent) scope = scope.parent; };
  const calls: { tok: Tok; scope: Scope }[] = [];
  let forVars: string[] | null = null;
  for (let i = 0; i < t.length; i++) {
    const tok = t[i];
    if (tok.k !== "name" || isField(t, i)) continue;
    switch (tok.v) {
      case "local":
        if (t[i + 1]?.v === "function") { if (t[i + 2]?.k === "name") scope.names.add(t[i + 2].v); break; }
        // `local a <const>, b = …`
        for (let j = i + 1; t[j]?.k === "name"; ) {
          scope.names.add(t[j].v);
          j++;
          if (isOp(t[j], "<") && t[j + 1]?.k === "name" && isOp(t[j + 2], ">")) j += 3;
          if (!isOp(t[j], ",")) break;
          j++;
        }
        break;
      case "function": {
        // The name being defined (`a.b:c`) isn't a call; a method has `self`.
        let j = i + 1;
        while (t[j]?.k === "name" && (isOp(t[j + 1], ".") || isOp(t[j + 1], ":"))) j += 2;
        if (t[j]?.k === "name") j++;
        const params = ["self"];
        if (isOp(t[j], "(")) {
          for (j++; j < t.length && !isOp(t[j], ")"); j++) if (t[j].k === "name") params.push(t[j].v);
        }
        push("function", params);
        i = j;
        break;
      }
      case "for": {
        forVars = [];
        let j = i + 1;
        while (t[j]?.k === "name" && t[j].v !== "in") {
          forVars.push(t[j].v);
          j++;
          if (!isOp(t[j], ",")) break;
          j++;
        }
        i = j - 1;
        break;
      }
      case "do": push("do", forVars ?? []); forVars = null; break;
      case "then": push("then"); break;
      case "elseif": if (scope.kind === "then") pop(); break;
      case "else": if (scope.kind === "then") pop(); push("then"); break;
      case "repeat": push("repeat"); break;
      case "until": {
        // The condition sees the block's locals: they stay known in the block around it.
        const names = scope.names;
        pop();
        for (const n of names) scope.names.add(n);
        break;
      }
      case "end": pop(); break;
      case "goto": i++; break;
      default: {
        if (LUA_KEYWORDS.has(tok.v) || isOp(t[i - 1], "::")) break;
        const next = t[i + 1];
        const call = next && next.line === tok.line && (isOp(next, "(") || isOp(next, "{") || next.k === "str");
        if (call) calls.push({ tok, scope });
      }
    }
  }
  const out: LuaProblem[] = [];
  for (const { tok, scope: at } of calls) {
    const name = tok.v;
    if (known.has(name) || defined.has(name)) continue;
    let sc: Scope | null = at;
    while (sc && !sc.names.has(name)) sc = sc.parent;
    if (sc) continue;
    out.push({ from: tok.from, to: tok.to, message: `Unknown function ${name}`, severity: "warning" });
    if (out.length >= 50) break;
  }
  return out;
}
