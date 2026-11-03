// Where the cursor is in JASS (also vJASS) text, for completion: inside a
// string or a rawcode ('hfoo') and what has been typed there, and the
// innermost call it is an argument of ("AddSpecialEffect", argument 0).

export interface CodeSpot {
  inString: boolean;
  inRawcode: boolean;
  /** What is typed inside the string/rawcode (string escapes resolved), else the word before. */
  prefix: string;
  /** Where that typed text starts (completion replaces from here). */
  from: number;
  call?: { name: string; argIndex: number };
}

/** Looks back at most this far for the call (calls rarely span more). */
const WINDOW = 4000;

export function codeSpot(text: string, pos: number): CodeSpot {
  // Start at a line beginning: strings and rawcodes don't span lines.
  let start = Math.max(0, pos - WINDOW);
  if (start > 0) start = text.indexOf("\n", start) + 1 || pos;
  const stack: { name: string | null; argIndex: number }[] = [];
  let lastIdent: string | null = null;
  let i = start;
  while (i < pos) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") { // line comment
      const nl = text.indexOf("\n", i);
      if (nl < 0 || nl >= pos) {
        // The cursor is in a comment: nothing to complete.
        return { inString: false, inRawcode: false, prefix: "", from: pos };
      }
      i = nl + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      // Find the end (\" escapes in strings); unclosed before the cursor: the cursor is inside.
      let j = i + 1;
      while (j < pos && text[j] !== c && text[j] !== "\n") j += c === '"' && text[j] === "\\" ? 2 : 1;
      if (j >= pos) {
        const raw = text.slice(i + 1, pos);
        const top = stack[stack.length - 1];
        return {
          inString: c === '"', inRawcode: c === "'",
          prefix: c === '"' ? raw.replace(/\\(.)/g, "$1") : raw, from: i + 1,
          call: top?.name ? { name: top.name, argIndex: top.argIndex } : undefined,
        };
      }
      i = j + 1;
      lastIdent = null;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < pos && /\w/.test(text[j])) j++;
      lastIdent = text.slice(i, j);
      i = j;
      continue;
    }
    if (c === "(") stack.push({ name: lastIdent, argIndex: 0 });
    else if (c === ")") stack.pop();
    else if (c === "," && stack.length) stack[stack.length - 1].argIndex++;
    // A call's name is the identifier right before "(" (spaces allowed between).
    if (!/\s/.test(c)) lastIdent = null;
    i++;
  }
  const word = /\w*$/.exec(text.slice(start, pos))?.[0] ?? "";
  const top = stack[stack.length - 1];
  return { inString: false, inRawcode: false, prefix: word, from: pos - word.length, call: top?.name ? { name: top.name, argIndex: top.argIndex } : undefined };
}

/** Parameter `index` of a signature ("native X takes string modelName, real x returns effect"). */
export function paramOf(signature: string, index: number): { name: string; type: string } | undefined {
  const m = /\btakes\s+(.*?)\s+returns\b/.exec(signature);
  if (!m || m[1].trim() === "nothing") return undefined;
  const p = m[1].split(",")[index]?.trim().split(/\s+/);
  return p && p.length >= 2 ? { type: p[0], name: p[1] } : undefined;
}
