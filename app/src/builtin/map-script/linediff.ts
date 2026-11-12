// A line diff for the Script Changes view. The merge view's own diff works on characters and gives up
// (one change over the whole file) on big, different texts; here lines are compared (Myers), common
// start and end trimmed first, and a coarser single hunk is the fallback above MAX_EDITS.

export interface LineHunk { fromA: number; toA: number; fromB: number; toB: number }
export interface TextChange { from: number; to: number; insert: string }

const MAX_EDITS = 3000;

/** Lines of a text as the editor sees them (CRLF, CR and LF all break a line). */
export function splitLines(text: string): string[] { return text.split(/\r\n?|\n/); }

/** The line ranges that differ: a[fromA, toA) is b[fromB, toB) in the other text. */
export function lineHunks(a: string[], b: string[]): LineHunk[] {
  const n = a.length, m = b.length;
  let lo = 0;
  while (lo < n && lo < m && a[lo] === b[lo]) lo++;
  let hiA = n, hiB = m;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) { hiA--; hiB--; }
  if (lo === hiA && lo === hiB) return [];
  const ids = new Map<string, number>();
  const id = (s: string) => { let v = ids.get(s); if (v === undefined) { v = ids.size; ids.set(s, v); } return v; };
  const A = a.slice(lo, hiA).map(id), B = b.slice(lo, hiB).map(id);
  const del = new Uint8Array(A.length), ins = new Uint8Array(B.length);
  if (!myers(A, B, del, ins)) { del.fill(1); ins.fill(1); }
  const out: LineHunk[] = [];
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && !del[i] && !ins[j]) { i++; j++; continue; }
    const fromA = i, fromB = j;
    while ((i < A.length && del[i]) || (j < B.length && ins[j])) { if (i < A.length && del[i]) i++; if (j < B.length && ins[j]) j++; }
    out.push({ fromA: lo + fromA, toA: lo + i, fromB: lo + fromB, toB: lo + j });
  }
  return out;
}

// Marks the deleted lines of A and the inserted lines of B; false when more than MAX_EDITS are needed.
function myers(A: number[], B: number[], del: Uint8Array, ins: Uint8Array): boolean {
  const n = A.length, m = B.length, max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = d; break; }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  if (found < 0) return false;
  let x = n, y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1], at = (k: number) => prev[k + d - 1];
    const k = x - y;
    const pk = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
    const px = at(pk), py = px - pk;
    if (pk === k + 1) ins[py] = 1; else del[px] = 1;
    x = px; y = py;
  }
  return true;
}

/** Changes that turn `b` into `a`, from the line hunks (offsets in b with every break one character). */
export function changesToA(a: string, b: string): TextChange[] {
  const la = splitLines(a), lb = splitLines(b);
  const start: number[] = [];
  let at = 0;
  for (const l of lb) { start.push(at); at += l.length + 1; }
  start.push(at); // one past the end
  const len = at - 1;
  return lineHunks(la, lb).map((h) => {
    const seg = la.slice(h.fromA, h.toA).join("\n");
    if (h.toB < lb.length) return { from: start[h.fromB], to: start[h.toB], insert: h.toA > h.fromA ? `${seg}\n` : "" };
    const lead = h.fromB > 0;
    return { from: start[h.fromB] - (lead ? 1 : 0), to: len, insert: h.toA > h.fromA ? (lead ? "\n" : "") + seg : "" };
  });
}
