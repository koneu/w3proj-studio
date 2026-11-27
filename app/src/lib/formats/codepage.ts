// An old map's texts in its code page (GBK, CP949, Big5), shown readable and typed in it. The map's files keep their
// strings as lossless text (lossless.ts: a byte that isn't UTF-8 is a private-use character), so this only changes what
// an editor shows and what an edit stores: nothing is converted when a map is read, saved or packed, and a text nobody
// edits keeps its bytes whatever is chosen.
//
// - showText: each line of a text that holds such bytes (a line that is UTF-8 stays as it is) read in the code page.
//   A byte sequence the code page doesn't have, or one whose character it would write with other bytes, stays the
//   private-use character it was, so the line turns back into its bytes.
// - storeText: what was typed into a box that showed a text, as that text is stored. The text itself when nothing
//   changed; a line that didn't change keeps its bytes; a changed or new line is written in the code page, and a
//   character the code page doesn't have refuses the edit (UnencodableError) rather than store a string the map would
//   show wrong.
//
// The tables come from the webview's TextDecoder (the WHATWG decoders "gbk", "euc-kr", which is CP949, and "big5"),
// two bytes at a time; the encoder is their inverse, without the characters two byte pairs share.

import { decodeLossless, encodeLossless, hasRawBytes, rawByteChar, rawByteOf } from "./lossless";

export type CodePage = "gbk" | "cp949" | "big5";

/** The setting that holds a project's choice ("utf-8" or a code page): a project setting, in .w3proj/settings.json. */
export const TEXT_ENCODING_SETTING = "map.textEncoding";

interface PageInfo { label: string; description: string; decoder: string; trails: [number, number][] }

export const CODE_PAGES: Record<CodePage, PageInfo> = {
  gbk: { label: "GBK", description: "Simplified Chinese (code page 936)", decoder: "gbk", trails: [[0x40, 0x7e], [0x80, 0xfe]] },
  cp949: { label: "CP949", description: "Korean (code page 949)", decoder: "euc-kr", trails: [[0x41, 0xfe]] },
  big5: { label: "Big5", description: "Traditional Chinese (code page 950)", decoder: "big5", trails: [[0x40, 0x7e], [0xa1, 0xfe]] },
};

/** The code page a setting's value names, or null (UTF-8: texts as they are). */
export function codePageOf(value: unknown): CodePage | null {
  return typeof value === "string" && Object.hasOwn(CODE_PAGES, value) ? value as CodePage : null;
}

/** What the status bar and the picker call a choice. */
export const encodingLabel = (cp: CodePage | null): string => (cp ? CODE_PAGES[cp].label : "UTF-8");

interface Table {
  /** lead << 8 | trail → its character. */
  decode: Map<number, string>;
  /** code point → lead << 8 | trail. */
  encode: Map<number, number>;
}

const tables = new Map<CodePage, Table>();

function tableOf(cp: CodePage): Table {
  const known = tables.get(cp);
  if (known) return known;
  const info = CODE_PAGES[cp];
  const decoder = new TextDecoder(info.decoder, { fatal: true });
  const pairsOf = new Map<number, number[]>();
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (const [lo, hi] of info.trails) {
      for (let trail = lo; trail <= hi; trail++) {
        pair[0] = lead;
        pair[1] = trail;
        let s: string;
        try { s = decoder.decode(pair); } catch { continue; }
        const c = s.codePointAt(0);
        // One character, not ASCII, not a private-use one (the user-defined areas: as a box either way, and the
        // lossless form keeps their bytes plainly).
        if (c === undefined || s !== String.fromCodePoint(c) || c < 0x80 || (c >= 0xe000 && c <= 0xf8ff) || c >= 0xf0000) continue;
        const list = pairsOf.get(c);
        if (list) list.push(pair[0] << 8 | pair[1]);
        else pairsOf.set(c, [pair[0] << 8 | pair[1]]);
      }
    }
  }
  const table: Table = { decode: new Map(), encode: new Map() };
  for (const [c, pairs] of pairsOf) {
    // A character two byte pairs give would come back as one of them: both stay as their bytes.
    if (pairs.length !== 1) continue;
    table.decode.set(pairs[0], String.fromCodePoint(c));
    table.encode.set(c, pairs[0]);
  }
  tables.set(cp, table);
  return table;
}

/** Whether this webview can read the code page (its TextDecoder knows it). */
export function canRead(cp: CodePage): boolean {
  try { new TextDecoder(CODE_PAGES[cp].decoder); return true; } catch { return false; }
}

function showLine(line: string, cp: CodePage): string {
  if (!hasRawBytes(line)) return line;
  const b = encodeLossless(line);
  const { decode } = tableOf(cp);
  const out: string[] = [];
  for (let i = 0; i < b.length;) {
    const c = b[i];
    if (c < 0x80) { out.push(String.fromCharCode(c)); i++; continue; }
    const ch = i + 1 < b.length ? decode.get(c << 8 | b[i + 1]) : undefined;
    if (ch) { out.push(ch); i += 2; } else { out.push(rawByteChar(c)); i++; }
  }
  return out.join("");
}

/** A stored text (lossless) as an editor shows it with `cp` chosen; with none, the text itself. */
export function showText(stored: string, cp: CodePage | null): string {
  if (!cp || !hasRawBytes(stored)) return stored;
  return stored.split("\n").map((l) => showLine(l, cp)).join("\n");
}

/** Thrown for an edit with characters the code page can't write: nothing of it is stored. */
export class UnencodableError extends Error {
  readonly chars: string[];
  readonly codePage: CodePage;
  constructor(chars: string[], codePage: CodePage) {
    super(unencodableMessage(chars, codePage));
    this.name = "UnencodableError";
    this.chars = chars;
    this.codePage = codePage;
  }
}

/** Says which characters `cp` can't write, and what to do. */
export function unencodableMessage(chars: string[], cp: CodePage): string {
  const list = chars.slice(0, 8).map((c) => `"${c}" (U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")})`).join(", ");
  const label = CODE_PAGES[cp].label;
  return `Not taken: ${list}${chars.length > 8 ? ` and ${chars.length - 8} more` : ""} can't be written in ${label}, the map's text `
    + `encoding, so the text would come back wrong. Remove ${chars.length === 1 ? "it" : "them"}, or change the map's text encoding `
    + "(Change Map Text Encoding).";
}

function encodeLine(line: string, cp: CodePage, bad: Set<string>): string {
  const { encode } = tableOf(cp);
  const bytes: number[] = [];
  for (const ch of line) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) { bytes.push(c); continue; }
    const raw = rawByteOf(c);
    if (raw !== null) { bytes.push(raw); continue; }
    const p = encode.get(c);
    if (p === undefined) bad.add(ch);
    else bytes.push(p >> 8, p & 0xff);
  }
  return decodeLossless(new Uint8Array(bytes));
}

/** What was typed into a box that showed `stored` (showText with `cp`), as the text to store. See the top; throws
 *  UnencodableError. With no code page, what was typed. */
export function storeText(typed: string, stored: string, cp: CodePage | null): string {
  if (!cp) return typed;
  const shown = showText(stored, cp);
  if (typed === shown) return stored;
  const before = stored.split("\n"), shownLines = shown.split("\n");
  // A line moved by an edit above it keeps its bytes too, unless two lines that show alike differ in their bytes.
  const byShown = new Map<string, string | null>();
  before.forEach((s, i) => {
    const was = byShown.get(shownLines[i]);
    byShown.set(shownLines[i], was === undefined || was === s ? s : null);
  });
  const bad = new Set<string>();
  const out = typed.split("\n").map((t, i) => {
    if (i < before.length && shownLines[i] === t) return before[i];
    const known = byShown.get(t);
    return known != null ? known : encodeLine(t, cp, bad);
  });
  if (bad.size) throw new UnencodableError([...bad], cp);
  return out.join("\n");
}

/** A text typed where nothing was before (a new string), as stored: written in the code page. */
export const storeNewText = (typed: string, cp: CodePage | null): string => storeText(typed, "", cp);

/** The open project's choice, fixed for one editor while it is open (a change of the choice opens the editors again:
 *  one that has unsaved changes keeps the choice it showed them with, so what it stores matches what it showed). */
export interface TextCodec {
  readonly cp: CodePage | null;
  show(stored: string): string;
  /** Throws UnencodableError. */
  store(typed: string, stored: string): string;
}

/** The codec of the choice in the settings now (`get`: Settings.get). */
export function textCodec(get: (key: string) => unknown): TextCodec {
  const cp = codePageOf(get(TEXT_ENCODING_SETTING));
  return { cp, show: (s) => showText(s, cp), store: (t, s) => storeText(t, s, cp) };
}
