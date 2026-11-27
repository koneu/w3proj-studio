// How app-smoke.mjs's checks are dealt to the apps of a split run (--part=k/n): the list, in its order, cut into n runs
// that take about as long. The gate says how many (tests/gate.mjs, SMOKE_PARTS).
//
//   node scripts/smoke-times.mjs <app smoke logs>   writes the checks' seconds as the logs have them (`took X s: <check>`)
//                                                   into app-smoke-times.json, e.g. target/gate-logs/batch-*/appsmoke*.log
//
// A check the table doesn't know counts as UNKNOWN_SECONDS, so new checks need no entry; write the table again when the
// parts' lengths drift apart (the gate's summary shows each part's time).

/** More apps than this at once is a typing mistake, not a plan (each takes a core and a few GB). */
export const MAX_PARTS = 16;
/** A check without a measured time. */
export const UNKNOWN_SECONDS = 15;

/** `--part`'s value "<k>/<n>" as [k, n], or null when it isn't one (k from 1 to n, n up to MAX_PARTS). */
export function parsePart(text) {
  const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(text);
  if (!m) return null;
  const k = Number(m[1]), n = Number(m[2]);
  return k <= n && n <= MAX_PARTS ? [k, n] : null;
}

/**
 * The list `names` cut into `n` runs in its order, as lists of indexes: the cut whose longest run is the shortest, by
 * `seconds[name]` (UNKNOWN_SECONDS for a name it doesn't have). `first`: seconds the first run takes before its
 * checks (the project checks). No run is empty unless there are fewer names than runs (the last ones are empty then).
 */
export function splitParts(names, n, seconds = {}, { first = 0 } = {}) {
  const cost = names.map((name) => (Number.isFinite(seconds[name]) && seconds[name] >= 0 ? seconds[name] : UNKNOWN_SECONDS));
  const m = names.length, runs = Math.min(n, m);
  const sum = [0];
  for (const c of cost) sum.push(sum.at(-1) + c);
  // best[k][i]: the longest run's length when the first i names make k runs (none empty); cut[k][i]: where the last starts.
  const best = [new Array(m + 1).fill(Infinity)], cut = [[]];
  best[0][0] = 0;
  for (let k = 1; k <= runs; k++) {
    best.push(new Array(m + 1).fill(Infinity));
    cut.push([]);
    for (let i = k; i <= m; i++) {
      for (let j = k - 1; j < i; j++) {
        const longest = Math.max(best[k - 1][j], sum[i] - sum[j] + (k === 1 ? first : 0));
        if (longest < best[k][i]) { best[k][i] = longest; cut[k][i] = j; }
      }
    }
  }
  const parts = [];
  for (let k = runs, i = m; k >= 1; k--) {
    const j = cut[k][i];
    parts.unshift(Array.from({ length: i - j }, (_, x) => j + x));
    i = j;
  }
  while (parts.length < n) parts.push([]);
  return parts;
}

/** The checks' seconds in app smoke logs (`  took 12.3 s: <check>`): the longest seen of each, in whole seconds. */
export function secondsFromLogs(texts) {
  const out = {};
  for (const text of texts) {
    for (const m of text.matchAll(/^\s*took ([0-9.]+) s: (\w+)$/gm)) out[m[2]] = Math.max(out[m[2]] ?? 0, Math.round(Number(m[1])));
  }
  return out;
}
