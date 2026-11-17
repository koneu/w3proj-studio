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
      // A value's digits are 5 bits each, the lowest first: summed as numbers, not shifted (a 32-bit shift wraps from
      // the 7th digit on), and its lowest bit is the sign.
      let value = 0, scale = 1;
      for (const c of segment) {
        const digit = B64_VALUE.get(c);
        if (digit === undefined) throw new Error(`source map: ${JSON.stringify(c)} isn't a base64 digit`);
        value += (digit & 31) * scale;
        if (digit & 32) {
          scale *= 32;
          if (scale > 2 ** 50) throw new Error("source map: a value too long");
          continue;
        }
        const half = Math.floor(value / 2);
        fields.push(value % 2 === 1 ? 0 - half : half);
        value = 0;
        scale = 1;
      }
      if (fields.length === 0) continue; // an empty segment (",,") holds no mapping
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
