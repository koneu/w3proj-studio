// Colour codes in the texts Warcraft III shows: `|cAARRGGBB` starts a colour, `|r` goes back to the default,
// `|n` is a line break (the letters in either case). The alpha pair is ignored by the game (the World Editor writes ff). Pure functions on strings;
// whatever they don't edit stays as it was (the same characters, the same case).

export interface TextRun {
  /** Visible text of this run (empty for a line break). */
  text: string;
  /** RRGGBB (as written), absent for the default colour. */
  color?: string;
  /** The alpha pair as written, with `color`. */
  alpha?: string;
  newline?: boolean;
  /** The source text of this run with the tags before it, exactly as written (case, `\r\n`); `serializeRuns` writes it
   *  back so an unedited text comes out byte-identical. Absent on runs made by code. */
  raw?: string;
}

export interface Edit { text: string; selStart: number; selEnd: number }

/** The 24 player colours, then neutral. */
export const PLAYER_COLORS: readonly { name: string; rgb: string }[] = [
  { name: "Red", rgb: "FF0303" }, { name: "Blue", rgb: "0042FF" }, { name: "Teal", rgb: "1CE6B9" }, { name: "Purple", rgb: "540081" },
  { name: "Yellow", rgb: "FFFC01" }, { name: "Orange", rgb: "FEBA0E" }, { name: "Green", rgb: "20C000" }, { name: "Pink", rgb: "E55BB0" },
  { name: "Gray", rgb: "959697" }, { name: "Light Blue", rgb: "7EBFF1" }, { name: "Dark Green", rgb: "106246" }, { name: "Brown", rgb: "4E2A04" },
  { name: "Maroon", rgb: "9C0000" }, { name: "Navy", rgb: "0000C3" }, { name: "Turquoise", rgb: "00EBFF" }, { name: "Violet", rgb: "BD00FF" },
  { name: "Wheat", rgb: "ECCE87" }, { name: "Peach", rgb: "F7A58B" }, { name: "Mint", rgb: "BFFF81" }, { name: "Lavender", rgb: "DBB8EB" },
  { name: "Coal", rgb: "4F5055" }, { name: "Snow", rgb: "ECF0FF" }, { name: "Emerald", rgb: "00781E" }, { name: "Peanut", rgb: "A56F34" },
  { name: "Neutral", rgb: "2E2D2E" },
];

interface Token { index: number; end: number; kind: "c" | "r" | "n"; alpha?: string; rgb?: string }

function tokens(text: string): Token[] {
  const out: Token[] = [];
  const re = /\|c([0-9a-f]{2})([0-9a-f]{6})|\|r|\|n/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const k = m[0][1].toLowerCase();
    out.push(k === "c" ? { index: m.index, end: m.index + m[0].length, kind: "c", alpha: m[1], rgb: m[2] } : { index: m.index, end: m.index + m[0].length, kind: k as "r" | "n" });
  }
  return out;
}

/** Splits a text into runs of one colour and line breaks (`|n`, `|N` or a real line break). A colour never closed lasts
 *  to the end; a new colour tag replaces the one before it. Each run keeps its source text in `raw`. */
export function parseColorTags(text: string): TextRun[] {
  const runs: TextRun[] = [];
  let color: { rgb: string; alpha: string } | null = null;
  let pending = ""; // source of the tags (and empty pieces) not yet in a run
  const push = (s: string) => {
    for (const [i, part] of s.split(/(\r\n|\r|\n)/).entries()) {
      if (i % 2 === 1) { runs.push({ text: "", newline: true, raw: pending + part }); pending = ""; }
      else if (part) { runs.push({ ...(color ? { text: part, color: color.rgb, alpha: color.alpha } : { text: part }), raw: pending + part }); pending = ""; }
    }
  };
  let pos = 0;
  for (const t of tokens(text)) {
    push(text.slice(pos, t.index));
    pos = t.end;
    if (t.kind === "c") { color = { rgb: t.rgb!, alpha: t.alpha! }; pending += text.slice(t.index, t.end); }
    else if (t.kind === "r") { color = null; pending += text.slice(t.index, t.end); }
    else { runs.push({ text: "", newline: true, raw: pending + text.slice(t.index, t.end) }); pending = ""; }
  }
  push(text.slice(pos));
  if (pending) runs.push({ text: "", raw: pending });
  return runs;
}

/** Runs back to text. Runs that came from `parseColorTags` are written as they were read (byte-identical). Runs made by
 *  code get `|cAARRGGBB…|r` around coloured runs (neighbours of one colour share a tag) and `|n` for breaks, in lower
 *  case. */
export function serializeRuns(runs: readonly TextRun[]): string {
  if (runs.every((r) => r.raw !== undefined)) return runs.map((r) => r.raw).join("");
  let out = "";
  let open: string | null = null;
  for (const r of runs) {
    const key = r.color ? `${r.alpha ?? "ff"}${r.color}` : null;
    if (r.newline) { out += "|n"; continue; }
    if (key !== open) {
      if (open) out += "|r";
      if (key) out += `|c${key}`;
      open = key;
    }
    out += r.text;
  }
  return open ? out + "|r" : out;
}

/** The text as the game shows it, without the tags. */
export function plainText(text: string): string {
  return parseColorTags(text).map((r) => (r.newline ? "\n" : r.text)).join("");
}

const colorAt = (toks: Token[], pos: number): Token | null => {
  let c: Token | null = null;
  for (const t of toks) {
    if (t.end > pos) break;
    if (t.kind === "c") c = t;
    else if (t.kind === "r") c = null;
  }
  return c;
};

const clampSel = (text: string, a: number, b: number): [number, number] => {
  let s = Math.max(0, Math.min(text.length, Math.min(a, b)));
  let e = Math.max(0, Math.min(text.length, Math.max(a, b)));
  // A selection edge inside a tag moves out to the tag's edge.
  for (const t of tokens(text)) {
    if (s > t.index && s < t.end) s = t.index;
    if (e > t.index && e < t.end) e = t.end;
  }
  return [s, e];
};

/** A tag that restores the colour in effect (`|r` when none). */
const restore = (c: Token | null) => (c ? `|c${c.alpha}${c.rgb}` : "|r");

const stripColorTags = (s: string) => s.replace(/\|c[0-9a-f]{8}|\|r/gi, "");

const normRgb = (rgb: string) => {
  const v = rgb.replace(/^[#]/, "");
  if (!/^[0-9a-f]{6}$/i.test(v)) throw new Error(`Not an RRGGBB colour: ${rgb}`);
  return v.toUpperCase();
};

/** Puts the selection in a colour. Colour tags inside the selection are dropped (the new colour covers it) and the
 *  colour that was in effect after it comes back. With no selection a `|cAARRGGBB|r` pair goes in at the caret, which
 *  ends up between the two. */
export function wrapColor(text: string, selStart: number, selEnd: number, rgb: string, alpha = "ff"): Edit {
  const [s, e] = clampSel(text, selStart, selEnd);
  const open = `|c${alpha.toLowerCase()}${normRgb(rgb)}`;
  if (s === e) {
    const close = restore(colorAt(tokens(text), s));
    const at = s + open.length;
    return { text: text.slice(0, s) + open + close + text.slice(s), selStart: at, selEnd: at };
  }
  const after = restore(colorAt(tokens(text), e));
  const inner = stripColorTags(text.slice(s, e));
  const out = text.slice(0, s) + open + inner + after + text.slice(e);
  return { text: out, selStart: s + open.length, selEnd: s + open.length + inner.length };
}

/** Takes the colour off the selection (the default colour shows there; an outer colour continues after it). With no
 *  selection the colour run around the caret loses its tag. */
export function removeColor(text: string, selStart: number, selEnd: number): Edit {
  const [s, e] = clampSel(text, selStart, selEnd);
  const toks = tokens(text);
  if (s === e) {
    const c = colorAt(toks, s);
    if (!c) return { text, selStart: s, selEnd: e };
    const end = toks.find((t) => t.index >= s && (t.kind === "r" || t.kind === "c"));
    // The opening tag goes, and the `|r` that closes it (a following colour tag stays).
    const cut = end?.kind === "r" ? end : null;
    let out = text.slice(0, c.index) + text.slice(c.end, cut ? cut.index : text.length);
    if (cut) out += text.slice(cut.end);
    const caret = s - (c.end - c.index) - (cut && s >= cut.end ? cut.end - cut.index : 0);
    return { text: out, selStart: caret, selEnd: caret };
  }
  const before = colorAt(toks, s);
  const after = colorAt(toks, e);
  const inner = stripColorTags(text.slice(s, e));
  const head = before ? "|r" : "";
  const tail = after ? restore(after) : "";
  return { text: text.slice(0, s) + head + inner + tail + text.slice(e), selStart: s + head.length, selEnd: s + head.length + inner.length };
}

/** The two forms of a line break: `|n` in the strings of the string table and the object data, a real line break in the
 *  texts the map's info file stores directly (what the field's own Enter key gives). */
export type BreakForm = "|n" | "\n";

/** Puts a line break in place of the selection. */
export function insertBreak(text: string, selStart: number, selEnd: number, form: BreakForm = "|n"): Edit {
  const s = Math.max(0, Math.min(selStart, selEnd, text.length));
  const e = Math.min(text.length, Math.max(selStart, selEnd));
  return { text: text.slice(0, s) + form + text.slice(e), selStart: s + form.length, selEnd: s + form.length };
}

/** Renders a text into `into` the way the game shows it: coloured spans and `<br>`. Only text nodes are created, so
 *  nothing in the text can become markup. `defaultColor` is the colour of uncoloured text. */
export function renderColorTags(text: string, into: HTMLElement, defaultColor?: string): void {
  const doc = into.ownerDocument;
  into.replaceChildren();
  for (const r of parseColorTags(text)) {
    if (r.newline) { into.append(doc.createElement("br")); continue; }
    if (!r.text) continue; // tags with no text after them
    const span = doc.createElement("span");
    span.textContent = r.text;
    const c = r.color ?? defaultColor;
    if (c) span.style.color = `#${c.replace(/^#/, "")}`;
    into.append(span);
  }
}
