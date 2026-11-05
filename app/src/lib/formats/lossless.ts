// Strings of map files for any bytes: what isn't valid UTF-8 (old maps' Chinese, Korean or other
// code pages) becomes private-use characters (U+10FF00 + byte), which turn back into the same bytes.
// The same as crates/w3proj/src/lossless.rs, so both read each other's text.

const FIRST = 0x10ff00;
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const te = new TextEncoder();
const isEscape = (cp: number) => cp >= FIRST && cp < FIRST + 0x100;
const ESCAPES = /[\u{10FF00}-\u{10FFFF}]/u;

/** The valid UTF-8 sequence at `i`: its code point and length, or null. */
function sequence(b: Uint8Array, i: number): [number, number] | null {
  const c = b[i];
  if (c < 0x80) return [c, 1];
  const n = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : 2;
  if (c < 0xc2 || c > 0xf4 || i + n > b.length) return null;
  let cp = c & (0xff >> (n + 1));
  for (let k = 1; k < n; k++) {
    if ((b[i + k] & 0xc0) !== 0x80) return null;
    cp = (cp << 6) | (b[i + k] & 0x3f);
  }
  const overlong = cp < (n === 4 ? 0x10000 : n === 3 ? 0x800 : 0x80);
  return overlong || (cp >= 0xd800 && cp < 0xe000) || cp > 0x10ffff ? null : [cp, n];
}

/** Text for any bytes; `encodeLossless` gives exactly these bytes back. */
export function decodeLossless(bytes: Uint8Array): string {
  try {
    const s = strict.decode(bytes);
    if (!ESCAPES.test(s)) return s;
  } catch { /* not UTF-8: byte by byte */ }
  let out = "";
  for (let i = 0; i < bytes.length;) {
    const seq = sequence(bytes, i);
    if (seq && !isEscape(seq[0])) {
      out += String.fromCodePoint(seq[0]);
      i += seq[1];
    } else {
      // A real U+10FFxx (next to no file has it) goes as its bytes, or it would come back as one.
      for (const b of bytes.subarray(i, i + (seq?.[1] ?? 1))) out += String.fromCodePoint(FIRST + b);
      i += seq?.[1] ?? 1;
    }
  }
  return out;
}

/** The bytes of a string from `decodeLossless` (or typed text, which is plain UTF-8). */
export function encodeLossless(s: string): Uint8Array {
  if (!ESCAPES.test(s)) return te.encode(s);
  const parts: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (isEscape(cp)) parts.push(cp - FIRST);
    else parts.push(...te.encode(ch));
  }
  return new Uint8Array(parts);
}
