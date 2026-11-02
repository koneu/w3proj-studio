// Per-function comparison of the Triggers section; prints stats and the most common first-diff patterns.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
const L = process.argv[2], showN = Number(process.argv[3] ?? 8), filter = process.argv[4] ?? "";
const { parseTriggerData } = await import(pathToFileURL(L + "/triggers/triggerdata.ts").href);
const W = await import(pathToFileURL(L + "/triggers/wtg.ts").href);
const J = await import(pathToFileURL(L + "/script/jass.ts").href);
const data = parseTriggerData(readFileSync("TriggerData.txt", "utf8"));
const fns = (s: string) => { const m = new Map<string, string>(); for (const x of s.matchAll(/^function (\w+) takes[\s\S]*?^endfunction/gm)) m.set(x[1], x[0].replace(/\r/g, "")); return m; };
let ok = 0, total = 0, missing = 0, extra = 0, shown = 0;
const kinds: Record<string, number> = {};
for (const m of readdirSync("ws")) {
  const d = `ws/${m}/map`;
  if (!existsSync(`${d}/war3map.j`) || !existsSync(`${d}/war3map.wtg`)) continue;
  let triggers, custom;
  try {
    triggers = W.parseWtg(new Uint8Array(readFileSync(`${d}/war3map.wtg`)), data);
    custom = existsSync(`${d}/war3map.wct`) ? W.parseWct(new Uint8Array(readFileSync(`${d}/war3map.wct`)), W.textTriggers(triggers).length) : null;
  } catch { continue; }
  const info = JSON.parse(readFileSync(`${d}/war3map.w3i.json`, "utf8"));
  const gen = J.generateSections({ info, data, triggers, custom }).get("Triggers") ?? "";
  const orig = J.splitSections(readFileSync(`${d}/war3map.j`, "utf8")).get("Triggers") ?? "";
  const a = fns(gen), b = fns(orig);
  for (const [name, body] of b) {
    if (!name.includes(filter)) continue;
    total++;
    const g = a.get(name);
    if (g === undefined) { missing++; kinds["missing " + name.replace(/^Trig_.*?_(Func\d+|Conditions|Actions)$/, "$1").replace(/Func\d+/, "FuncN").replace(/^InitTrig_.*/, "InitTrig")] = (kinds["missing " + name.replace(/^Trig_.*?_(Func\d+|Conditions|Actions)$/, "$1").replace(/Func\d+/, "FuncN").replace(/^InitTrig_.*/, "InitTrig")] ?? 0) + 1; continue; }
    if (g === body) { ok++; continue; }
    const x = g.split("\n"), y = body.split("\n");
    const i = x.findIndex((l, j) => l !== y[j]);
    const key = (y[i] ?? "<end>").trim().replace(/\w+\(.*$/, (s) => s.split("(")[0] + "(…").slice(0, 60);
    kinds[key] = (kinds[key] ?? 0) + 1;
    if (shown++ < showN) console.log(`--- ${m} ${name}\n gen:  ${x[i]}\n orig: ${y[i]}`);
  }
  for (const name of a.keys()) if (!b.has(name)) extra++;
}
console.log(`functions identical ${ok}/${total}, missing ${missing}, extra ${extra}`);
for (const [k, v] of Object.entries(kinds).sort((p, q) => q[1] - p[1]).slice(0, 25)) console.log(String(v).padStart(6), k);
