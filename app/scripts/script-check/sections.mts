import { readFileSync, existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
const L = process.argv[2];
const only = process.argv[3];      // section to show diffs for
const showN = Number(process.argv[4] ?? 1);
const { parseTriggerData } = await import(pathToFileURL(L + "/triggers/triggerdata.ts").href);
const W = await import(pathToFileURL(L + "/triggers/wtg.ts").href);
const J = await import(pathToFileURL(L + "/script/jass.ts").href);
const { StringTable } = await import(pathToFileURL(L + "/formats/wts.ts").href);
const T = await import(pathToFileURL(L + "/terrain/w3e.ts").href);
const data = parseTriggerData(readFileSync("TriggerData.txt", "utf8"));
const { parseSlk } = await import(pathToFileURL(L + "/formats/text.ts").href);
const labels = new Map<string, { channel?: number }>();
for (const f of readdirSync("soundinfo")) for (const r of parseSlk(readFileSync("soundinfo/" + f, "utf8"))) if (r.SoundName && !labels.has(r.SoundName)) labels.set(r.SoundName, { channel: r.Channel === undefined || r.Channel === "" ? undefined : Number(r.Channel) });
const stats: Record<string, [number, number]> = {};
let shown = 0;
const json = (d: string, n: string) => existsSync(`${d}/${n}.json`) ? JSON.parse(readFileSync(`${d}/${n}.json`, "utf8")) : null;
for (const m of readdirSync("ws")) {
  const d = `ws/${m}/map`;
  if (!existsSync(`${d}/war3map.j`) || !existsSync(`${d}/war3map.wtg`)) continue;
  const script = readFileSync(`${d}/war3map.j`, "utf8");
  let triggers, custom;
  try {
    triggers = W.parseWtg(new Uint8Array(readFileSync(`${d}/war3map.wtg`)), data);
    custom = existsSync(`${d}/war3map.wct`) ? W.parseWct(new Uint8Array(readFileSync(`${d}/war3map.wct`)), W.textTriggers(triggers).length) : null;
  } catch { continue; }
  const wts = existsSync(`${d}/war3map.wts`) ? new StringTable(readFileSync(`${d}/war3map.wts`, "utf8")) : null;
  const info = json(d, "war3map.w3i");
  if (!info) continue;
  const terrain = existsSync(`${d}/war3map.w3e`) ? T.parseW3e(new Uint8Array(readFileSync(`${d}/war3map.w3e`))) : null;
  const input = { info, data, groundHeight: terrain ? (x: number, y: number) => T.heightAt(terrain, x, y) : undefined, triggers, custom, units: json(d, "war3mapUnits.doo")?.units, doodads: json(d, "war3map.doo")?.doodads, regions: json(d, "war3map.w3r")?.regions, cameras: json(d, "war3map.w3c")?.cameras,
    sounds: json(d, "war3map.w3s")?.sounds, soundDuration: () => 0, string: (v: string) => wts?.resolve(v) ?? v };
  const gen = J.generateSections(input), orig = J.splitSections(script);
  for (const [k, v] of gen) {
    const o = orig.get(k) ?? "";
    const norm = (x: string) => x.replace(/SetSoundDuration\( (\w+), \d+ \)/g, 'SetSoundDuration( $1, 0 )').replace(/\s+$/g, "");
    const same = norm(v) === norm(o);
    const s = (stats[k] ??= [0, 0]); s[1]++; if (same) s[0]++;
    if (!same && k === only && shown < showN) {
      shown++;
      const a = v.split(/\r?\n/), b = o.split(/\r?\n/);
      const i = a.findIndex((l: string, j: number) => l !== b[j]);
      console.log(`--- ${m} line ${i}\n gen: ${JSON.stringify(a.slice(i, i + 3))}\n orig: ${JSON.stringify(b.slice(i, i + 3))}`);
    }
  }
}
for (const [k, [ok, n]] of Object.entries(stats)) console.log(`${(k || "(header)").padEnd(20)} ${ok}/${n}`);
