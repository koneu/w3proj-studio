// The JASS checker on valid scripts (Blizzard.j, the game maps' war3map.j): every report is a false positive.
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { printValid } from "./report.mjs";
const L = process.argv[2], show = Number(process.argv[3] ?? 10);
const C = await import(pathToFileURL(L + "/jass/check.ts").href);
const common = readFileSync("common.j", "utf8"), blizzard = readFileSync("Blizzard.j", "utf8");
const lineOf = (src: string, pos: number) => src.slice(0, pos).split("\n").length;
// A report's lines are printed here when run alone, and kept for run.mjs when run in shards.
const sharded = !!process.env.SCRIPT_CHECK_SHARD;
const commonLines: string[] = [], blizzardLines: string[] = [], mapLines: string[] = [];
const report = (name: string, src: string, d: any[], into: string[]) => {
  for (const x of d.slice(0, show)) into.push(`  ${name}:${lineOf(src, x.from)} ${x.message} | ${src.slice(x.from, x.to).slice(0, 40)} | ${src.split("\n")[lineOf(src, x.from) - 1].trim().slice(0, 100)}`);
  if (!sharded) for (const l of into.splice(0)) console.log(l);
};
const t0 = Date.now();
// SCRIPT_CHECK_SHARD=<i>/<n>: only the i-th of n runs of maps (the first also checks common.j and
// Blizzard.j); run.mjs puts the shards together.
const [shardI, shardN] = (process.env.SCRIPT_CHECK_SHARD ?? "0/1").split("/").map(Number);
const commonEnv = C.envFrom([common]);
let dc: any[] = [], db: any[] = [];
if (shardI === 0) {
  dc = C.checkJass(common, C.emptyEnv());
  if (!process.env.SCRIPT_CHECK_SHARD) console.log(`common.j: ${dc.length} reports`);
  report("common.j", common, dc, commonLines);
  db = C.checkJass(blizzard, commonEnv);
  if (!process.env.SCRIPT_CHECK_SHARD) console.log(`Blizzard.j: ${db.length} reports`);
  report("Blizzard.j", blizzard, db, blizzardLines);
}
const env = C.envFrom([blizzard], commonEnv);
let maps = 0, clean = 0, total = 0;
const kinds = new Map<string, number>();
const allMaps = readdirSync("ws");
for (const m of allMaps.slice(Math.floor((shardI * allMaps.length) / shardN), Math.floor(((shardI + 1) * allMaps.length) / shardN))) {
  const f = `ws/${m}/map/war3map.j`;
  if (!existsSync(f)) continue;
  const src = readFileSync(f, "utf8");
  const d = C.checkJass(src, env);
  maps++; total += d.length; if (!d.length) clean++;
  for (const x of d) { const k = x.message.replace(/\b[A-Za-z_]\w*\b(?= is| takes|\))/g, "X").replace(/[A-Z]\w+_\w+/g, "X").slice(0, 60); kinds.set(k, (kinds.get(k) ?? 0) + 1); }
  if (d.length && process.argv[4] === m) report(m, src, d, mapLines);
}
const detail = { common: dc.length, blizzard: db.length, maps, clean, reports: total, kinds: [...kinds], ms: Date.now() - t0, commonLines, blizzardLines, mapLines };
// Under run.mjs (SCRIPT_CHECK_SHARD set) nothing is printed here: it puts the shards' details together and prints that.
if (!process.env.SCRIPT_CHECK_SHARD) printValid(detail);   // (common.j and Blizzard.j printed above)
if (process.env.SCRIPT_CHECK_JSON) writeFileSync(process.env.SCRIPT_CHECK_JSON, JSON.stringify(detail));
