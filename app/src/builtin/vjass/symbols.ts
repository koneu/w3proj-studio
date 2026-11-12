// vJASS declarations for editing (outline, completion, hover, go to definition): a line scanner,
// not a parser. Libraries, scopes, structs, modules, interfaces, textmacros, functions, methods,
// globals, struct members, parameters and locals, with their positions. Names are as written
// (private/public prefixes that JassHelper adds aren't applied).

import type { CodeSymbol } from "../../extensions/services";

/** `src` with comments, string/rawcode contents and //! novjass blocks (documentation JassHelper
 *  skips) blanked (same length, line breaks kept); other //! lines stay (textmacro directives). */
function blank(src: string): string {
  const out = src.split("");
  const fill = (from: number, to: number) => { for (let k = from; k < to; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " "; };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      const stop = end < 0 ? src.length : end;
      if (/^\/\/!\s*novjass\b/.test(src.slice(i, stop))) {
        const close = /\/\/!\s*endnovjass\b.*$/m.exec(src.slice(stop));
        const after = close ? stop + close.index + close[0].length : src.length;
        fill(i, after);
        i = after;
        continue;
      }
      if (src[i + 2] !== "!") fill(i, stop);
      i = stop;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      fill(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      fill(i + 1, Math.min(j, src.length));
      i = j + 1;
    } else i++;
  }
  return out.join("");
}

const ACCESS = String.raw`(?:(?:private|public|readonly)\s+)*`;
const BLOCK = new RegExp(String.raw`^\s*${ACCESS}(library|library_once|scope|struct|module|interface)\s+(\w+)(.*)$`);
const END = /^\s*end(library|scope|struct|module|interface|function|method|globals)\b/;
const FUNCTION = new RegExp(String.raw`^\s*${ACCESS}(?:static\s+)?(?:constant\s+)?(?:stub\s+)?(function(?:\s+interface)?|method)\s+(operator\s*\S+?|\w+)\s+takes\s+(.*?)\s+returns\s+(\w+)`);
const TEXTMACRO = /^\s*\/\/!\s*textmacro(?:_once)?\s+(\w+)(.*)$/;
const VARIABLE = new RegExp(String.raw`^\s*${ACCESS}(?:static\s+)?(?:constant\s+)?(?:stub\s+)?(\w+)\s+(?:array\s+)?(\w+)`);
const LOCAL = /^\s*local\s+(\w+)\s+(array\s+)?(\w+)/;
const NOT_A_TYPE = new Set(["set", "call", "if", "elseif", "else", "endif", "loop", "endloop", "exitwhen", "return", "implement", "delegate",
  "method", "function", "struct", "library", "scope", "module", "interface", "globals", "endglobals", "debug", "hook", "type", "native", "key"]);

interface Open { kind: "library" | "struct" | "function" | "globals"; name: string; at: number; symbols: CodeSymbol[] }

/** The declarations `src` makes, in text order. */
export function vjassSymbols(src: string): CodeSymbol[] {
  const text = blank(src);
  const out: CodeSymbol[] = [];
  const stack: Open[] = [];
  const container = () => [...stack].reverse().find((o) => o.kind === "struct" || o.kind === "library")?.name;
  const inStruct = () => stack.at(-1)?.kind === "struct";
  let pos = 0;
  for (const raw of text.split("\n")) {
    // "." doesn't match "\r": CRLF texts are matched without it.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const at = (name: string, from = 0) => pos + line.indexOf(name, from);
    let m: RegExpExecArray | null;
    if ((m = TEXTMACRO.exec(line))) {
      out.push({ name: m[1], kind: "macro", detail: `textmacro ${m[1]}${m[2].trimEnd()}`, at: at(m[1], line.indexOf("textmacro") + 9), container: container() });
    } else if ((m = END.exec(line))) {
      const kind = m[1] === "method" ? "function" : m[1] === "scope" ? "library" : ["module", "interface"].includes(m[1]) ? "struct" : m[1];
      const k = stack.map((o) => o.kind).lastIndexOf(kind as Open["kind"]);
      if (k >= 0) {
        const open = stack[k];
        stack.length = k;
        // Parameters and locals are visible within their function.
        if (open.kind === "function") for (const s of open.symbols) s.scope = [open.at, pos + line.length];
      }
    } else if ((m = BLOCK.exec(line))) {
      const kind = m[1].startsWith("library") || m[1] === "scope" ? "library" : "struct";
      out.push({ name: m[2], kind: kind, detail: `${m[1]} ${m[2]}${m[3].replace(/\s+$/, "")}`, at: at(m[2], line.indexOf(m[1]) + m[1].length), container: container() });
      stack.push({ kind, name: m[2], at: pos, symbols: [] });
    } else if ((m = FUNCTION.exec(line))) {
      const isMethod = m[1] === "method";
      const name = m[2].replace(/\s+/g, " ");
      out.push({
        name, kind: isMethod ? "method" : "function",
        detail: line.trim().replace(/\s+/g, " "), at: at(m[2].split(/\s/)[0], line.indexOf(m[1]) + m[1].length), container: container(),
      });
      if (m[1] !== "function interface") {
        const open: Open = { kind: "function", name, at: pos, symbols: [] };
        if (m[3] !== "nothing") {
          let from = line.indexOf(" takes ") + 7;
          for (const p of m[3].split(",")) {
            const [type, pname] = p.trim().split(/\s+/);
            if (!pname) continue;
            const s: CodeSymbol = { name: pname, kind: "param", detail: `${type} ${pname}`, at: at(pname, from) };
            from = s.at! - pos + pname.length;
            open.symbols.push(s);
            out.push(s);
          }
        }
        stack.push(open);
      }
    } else if (/^\s*globals\b/.test(line)) {
      stack.push({ kind: "globals", name: "", at: pos, symbols: [] });
    } else if (stack.at(-1)?.kind === "function" && (m = LOCAL.exec(line))) {
      const s: CodeSymbol = { name: m[3], kind: "local", detail: `local ${m[1]} ${m[2] ?? ""}${m[3]}`, at: at(m[3], line.indexOf(m[1]) + m[1].length) };
      stack.at(-1)!.symbols.push(s);
      out.push(s);
    } else if ((stack.at(-1)?.kind === "globals" || inStruct()) && (m = VARIABLE.exec(line)) && !NOT_A_TYPE.has(m[1])) {
      const constant = /\bconstant\b/.test(line.slice(0, line.indexOf(m[1])));
      out.push({
        name: m[2], kind: inStruct() ? "field" : constant ? "constant" : "global", detail: line.trim().replace(/\s*=.*$/, "").replace(/\s+/g, " "),
        at: at(m[2], line.indexOf(m[1]) + m[1].length), container: container(),
      });
    }
    pos += raw.length + 1;
  }
  return out;
}

/** What another text declares for the rest of the map, as it is named there (JassHelper's prefixes):
 *  a library's or scope's public functions, globals and structs as `Library_Name`, its plain ones by
 *  name; private ones and struct members not. `location` is where they are declared ("trigger:<name>"). */
export function vjassExports(src: string, location: string): CodeSymbol[] {
  const symbols = vjassSymbols(src);
  const libraries = new Set(symbols.filter((s) => s.kind === "library").map((s) => s.name));
  const out: CodeSymbol[] = [];
  for (const s of symbols) {
    const isStruct = s.kind === "struct" && /^struct\b/.test(s.detail);
    if (!(s.kind === "function" || s.kind === "global" || s.kind === "constant" || isStruct) || s.at === undefined) continue;
    // Inside a struct (static members, nested declarations): reached through the struct.
    if (s.container !== undefined && !libraries.has(s.container)) continue;
    // The access word is on the declaration's line, before its name.
    const head = src.slice(src.lastIndexOf("\n", s.at - 1) + 1, s.at);
    if (/\bprivate\b/.test(head)) continue;
    const name = /\bpublic\b/.test(head) && s.container !== undefined ? `${s.container}_${s.name}` : s.name;
    out.push({ name, kind: s.kind, detail: s.detail, location });
  }
  return out;
}
