// The pure part of scripts/coverage.mjs, separate so it can be tested.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_VALUE = new Map([...B64].map((c, i) => [c, i]));

/** Every mapping of a source map: [generated line, generated column, source, original line,
 *  original column], all counted from 0. */
export function decodeMappings(mappings) {
  const out = [];
  let source = 0, origLine = 0, origCol = 0;
  mappings.split(";").forEach((group, genLine) => {
    let genCol = 0;
    if (!group) return;
    for (const segment of group.split(",")) {
      const fields = [];
      let value = 0, shift = 0;
      for (const c of segment) {
        const digit = B64_VALUE.get(c);
        value |= (digit & 31) << shift;
        if (digit & 32) { shift += 5; continue; }
        fields.push(value & 1 ? -(value >> 1) : value >> 1);
        value = shift = 0;
      }
      genCol += fields[0];
      if (fields.length < 4) continue;
      source += fields[1];
      origLine += fields[2];
      origCol += fields[3];
      out.push([genLine, genCol, source, origLine, origCol]);
    }
  });
  return out;
}

/** The execution count of each character, from V8's nested ranges: in each function an inner
 *  range comes after the one around it and overrules it. -1: no range covers it. */
export function characterCounts(length, functions) {
  const counts = new Int32Array(length).fill(-1);
  for (const f of functions) {
    for (const r of f.ranges) counts.fill(r.count, r.startOffset, Math.min(r.endOffset, length));
  }
  return counts;
}

/** Per file: line -> (column -> did it run in any bundle). Test bundles tree-shake and run
 *  different code, so positions are merged across bundles before a line is judged. */
export class LineHits {
  files = new Map();
  add(file, line, column, ran) {
    let lines = this.files.get(file);
    if (!lines) this.files.set(file, (lines = new Map()));
    let columns = lines.get(line);
    if (!columns) lines.set(line, (columns = new Map()));
    columns.set(column, ran || columns.get(column) === true);
  }
  /** How many of the file's code lines ran completely; a line no bundle held did not run. */
  covered(file, codeLines) {
    const lines = this.files.get(file);
    if (!lines) return 0;
    let n = 0;
    for (const line of codeLines) {
      const columns = lines.get(line);
      if (columns && [...columns.values()].every(Boolean)) n++;
    }
    return n;
  }
}

export const percent = (a) => (a.lines ? (100 * a.covered) / a.lines : 100);
