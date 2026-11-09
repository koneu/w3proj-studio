// What the checks print, from their details. A check run in shards (run.mjs) puts the shards'
// details together in the order of the maps and prints them with these, so that the report reads
// as if one process had gone over all the maps.

/** sections.mts: `stats` per section as [identical, compared], and the problems found. */
export function printSections({ stats, broken, guarded, asked = [], checked }) {
  for (const [k, [ok, n]] of Object.entries(stats)) console.log(`${(k || "(header)").padEnd(20)} ${ok}/${n}`);
  console.log(`problems: ${broken.length} in the game's maps`);
  for (const b of broken.slice(0, 20)) console.log(`  ${b}`);
  console.log(`guard: ${guarded.length} of ${checked} maps would keep their script`);
  for (const [m, lost] of guarded) console.log(`  ${m}: ${lost.length} (${lost.slice(0, 6).join(", ")})`);
  console.log(`guard: asks about ${asked.length} JASS scripts before their first regeneration`);
}

/** jass-valid.mts. With `heads`, also the lines about common.j and Blizzard.j, and the report lines
 * the shards kept (run alone, jass-valid.mts prints those itself as it goes). */
export function printValid({ common, blizzard, maps, clean, reports, kinds, ms, commonLines = [], blizzardLines = [], mapLines = [] }, { heads = false } = {}) {
  if (heads) {
    console.log(`common.j: ${common} reports`);
    for (const l of commonLines) console.log(l);
    console.log(`Blizzard.j: ${blizzard} reports`);
    for (const l of blizzardLines) console.log(l);
    for (const l of mapLines) console.log(l);
  }
  console.log(`maps ${maps}, without reports ${clean}, reports ${reports}, ${ms} ms`);
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(String(n).padStart(6), k);
}

/** The shards' details of sections.mts, in the order of the maps, as one. */
export function mergeSections(shards) {
  const stats = {};
  for (const s of shards) {
    for (const [k, [ok, n]] of Object.entries(s.stats)) {
      const a = (stats[k] ??= [0, 0]);
      a[0] += ok;
      a[1] += n;
    }
  }
  return {
    stats,
    // The Lua check of every map comes before the trigger references of any, as in one process.
    broken: [...shards.flatMap((s) => s.luaBroken), ...shards.flatMap((s) => s.otherBroken)],
    guarded: shards.flatMap((s) => s.guarded),
    asked: shards.flatMap((s) => s.asked ?? []),
    checked: shards.reduce((n, s) => n + s.checked, 0),
  };
}

/** The shards' details of jass-valid.mts, in the order of the maps, as one. */
export function mergeValid(shards) {
  const kinds = new Map();
  for (const s of shards) for (const [k, n] of s.kinds) kinds.set(k, (kinds.get(k) ?? 0) + n);
  const sum = (key) => shards.reduce((n, s) => n + s[key], 0);
  const lines = (key) => shards.flatMap((s) => s[key] ?? []);
  return { commonLines: lines("commonLines"), blizzardLines: lines("blizzardLines"), mapLines: lines("mapLines"), common: sum("common"), blizzard: sum("blizzard"), maps: sum("maps"), clean: sum("clean"), reports: sum("reports"), kinds: [...kinds], ms: Math.max(...shards.map((s) => s.ms)) };
}
