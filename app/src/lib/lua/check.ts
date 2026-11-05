// A syntax check for map scripts in Lua: what a broken script looks like at a glance (blocks that
// don't close, unbalanced brackets, unfinished strings and comments), without parsing expressions.
// Function and variable names aren't looked at. Offsets are into the text.

export interface LuaProblem { from: number; to: number; message: string }

// Maps: scripts have words like "constructor", which every plain object has.
const OPENS = new Map([["function", "end"], ["do", "end"], ["then", "end"], ["repeat", "until"]]);
const BRACKETS = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);

/** The level of a long bracket opening at `i` ("[[" is 0, "[==[" is 2), or -1. */
function longOpen(s: string, i: number): number {
  let n = i + 1;
  while (s[n] === "=") n++;
  return s[n] === "[" ? n - i - 1 : -1;
}

export function checkLua(s: string): LuaProblem[] {
  const out: LuaProblem[] = [];
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
