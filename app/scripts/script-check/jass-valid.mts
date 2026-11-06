// The JASS checker on valid scripts (Blizzard.j, the game maps' war3map.j): every report is a false positive.
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const L = process.argv[2], show = Number(process.argv[3] ?? 10);
const C = await import(pathToFileURL(L + "/jass/check.ts").href);
const common = readFileSync("common.j", "utf8"), blizzard = readFileSync("Blizzard.j", "utf8");
const lineOf = (src: string, pos: number) => src.slice(0, pos).split("\n").length;
const report = (name: string, src: string, d: any[]) => {
  for (const x of d.slice(0, show)) console.log(`  ${name}:${lineOf(src, x.from)} ${x.message} | ${src.slice(x.from, x.to).slice(0, 40)} | ${src.split("\n")[lineOf(src, x.from) - 1].trim().slice(0, 100)}`);
};
const t0 = Date.now();
const commonEnv = C.envFrom([common]);
const dc = C.checkJass(common, C.emptyEnv());
console.log(`common.j: ${dc.length} reports`); report("common.j", common, dc);
const db = C.checkJass(blizzard, commonEnv);
console.log(`Blizzard.j: ${db.length} reports`); report("Blizzard.j", blizzard, db);
const env = C.envFrom([blizzard], commonEnv);
let maps = 0, clean = 0, total = 0;
const kinds = new Map<string, number>();
for (const m of readdirSync("ws")) {
  const f = `ws/${m}/map/war3map.j`;
  if (!existsSync(f)) continue;
  const src = readFileSync(f, "utf8");
  const d = C.checkJass(src, env);
  maps++; total += d.length; if (!d.length) clean++;
  for (const x of d) { const k = x.message.replace(/\b[A-Za-z_]\w*\b(?= is| takes|\))/g, "X").replace(/[A-Z]\w+_\w+/g, "X").slice(0, 60); kinds.set(k, (kinds.get(k) ?? 0) + 1); }
  if (d.length && process.argv[4] === m) report(m, src, d);
}
console.log(`maps ${maps}, without reports ${clean}, reports ${total}, ${Date.now() - t0} ms`);
for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(String(n).padStart(6), k);
if (process.env.SCRIPT_CHECK_JSON) writeFileSync(process.env.SCRIPT_CHECK_JSON, JSON.stringify({ common: dc.length, blizzard: db.length, maps, clean, reports: total }));
