// Section-by-section comparison of lib/script output with the World Editor's war3map.j.
// Run from a folder with ws/<n>/map (unpacked maps) and the game tables (see README.md).
// Args: <path to app/src/lib> [section to show diffs for] [number of diffs]
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
const L = process.argv[2];
const only = process.argv[3] ?? "";
const showN = Number(process.argv[4] ?? 1);
const mod = (p: string) => import(pathToFileURL(L + p).href);
const { parseTriggerData } = await mod("/triggers/triggerdata.ts");
const W = await mod("/triggers/wtg.ts");
const J = await mod("/script/jass.ts");
const G = await mod("/script/guard.ts");
const R = await mod("/triggers/refs.ts");
const { checkLua } = await mod("/lua/check.ts");
const { StringTable } = await mod("/formats/wts.ts");
const T = await mod("/terrain/w3e.ts");
const { parseIni, parseSlk } = await mod("/formats/text.ts");

const read = (f: string) => readFileSync(f, "utf8");
const data = parseTriggerData(read("TriggerData.txt"));
const wed = parseIni(read("WorldEditData.txt"));
const light = (sec: string, t: string, kind: string) =>
  wed.get(sec)?.get(t.toLowerCase()) ?? `Environment\\DNC\\DNCLordaeron\\DNCLordaeron${kind}\\DNCLordaeron${kind}.mdl`;
const balance = parseSlk(read("UnitBalance.slk"));
const buildings = new Set(balance.filter((r: any) => r.isbldg === "1").map((r: any) => r.unitBalanceID));
const unitIds = new Set(balance.map((r: any) => r.unitBalanceID));
const itemIds = new Set(parseSlk(read("ItemData.slk")).map((r: any) => r.itemID));
const abilityIds = new Set(parseSlk(read("AbilityData.slk")).map((r: any) => r.alias));
const orders = new Map<string, { on: string; off: string }>();
const labels = existsSync("soundinfo") ? J.parseSoundLabels(readdirSync("soundinfo").map((f) => read("soundinfo/" + f))) : new Map();
for (const f of readdirSync("abil")) for (const [id, sec] of parseIni(read("abil/" + f))) { const on = sec.get("orderon"), off = sec.get("orderoff"); if (on && off && !orders.has(id)) orders.set(id, { on, off }); }

const stats: Record<string, [number, number]> = {};
// lib/script/guard: maps the World Editor made must not look as if they had code of their own.
const guarded: [string, string[]][] = [];
let checked = 0;
// The Problems view's trigger references and Lua check: what the World Editor made has no such problems.
const broken: string[] = [];
for (const m of readdirSync("ws")) {
  const f = `ws/${m}/map/war3map.lua`;
  if (!existsSync(f)) continue;
  const p = checkLua(read(f));
  if (p.length) broken.push(`${m} lua: ${p[0].message}`);
}
let shown = 0;
const json = (d: string, n: string) => (existsSync(`${d}/${n}.json`) ? JSON.parse(read(`${d}/${n}.json`)) : null);
const norm = (x: string) => x.replace(/SetSoundDuration\( (\w+), \d+ \)/g, "SetSoundDuration( $1, 0 )").replace(/\s+$/g, "");

for (const m of readdirSync("ws")) {
  const d = `ws/${m}/map`;
  const scriptFile = existsSync(`${d}/war3map.j`) ? `${d}/war3map.j` : `${d}/war3map.lua`;
  if (!existsSync(scriptFile) || !existsSync(`${d}/war3map.wtg`)) continue;
  const info = json(d, "war3map.w3i");
  if (!info) continue;
  let triggers, custom;
  try {
    triggers = W.parseWtg(new Uint8Array(readFileSync(`${d}/war3map.wtg`)), data);
    custom = existsSync(`${d}/war3map.wct`) ? W.parseWct(new Uint8Array(readFileSync(`${d}/war3map.wct`)), W.textTriggers(triggers).length) : null;
  } catch { continue; }
  // The trigger files read and written again, byte for byte.
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
  const wtgBytes = new Uint8Array(readFileSync(`${d}/war3map.wtg`));
  const rt = (stats["(wtg byte-exact)"] ??= [0, 0]); rt[1]++; if (same(W.writeWtg(triggers), wtgBytes)) rt[0]++;
  if (custom) {
    const wctBytes = new Uint8Array(readFileSync(`${d}/war3map.wct`));
    const rc = (stats["(wct byte-exact)"] ??= [0, 0]); rc[1]++; if (same(W.writeWct(custom), wctBytes)) rc[0]++;
    const rx = (stats["(wct via text)"] ??= [0, 0]); rx[1]++;
    try { if (same(W.writeWct(W.parseWctText(W.writeWctText(custom))), wctBytes)) rx[0]++; } catch { /* counted as different */ }
  }
  const wj = (stats["(wtg via JSON)"] ??= [0, 0]); wj[1]++; if (same(W.writeWtg(W.parseWtgJson(W.writeWtgJson(triggers))), wtgBytes)) wj[0]++;
  const wts = existsSync(`${d}/war3map.wts`) ? new StringTable(read(`${d}/war3map.wts`)) : null;
  const terrain = existsSync(`${d}/war3map.w3e`) ? T.parseW3e(new Uint8Array(readFileSync(`${d}/war3map.w3e`))) : null;
  // Custom objects: their base decides, unless the map sets "is a building" (ubdg).
  const customUnits = new Map<string, { base: string; bldg?: boolean }>();
  for (const f of ["war3map.w3u", "war3mapSkin.w3u"]) {
    for (const o of json(d, f)?.custom ?? []) {
      const b = o.mods?.find((x: any) => x.field === "ubdg");
      customUnits.set(o.id, { base: o.base, bldg: b ? b.value === 1 : undefined });
    }
  }
  const customAbilities = new Set<string>((json(d, "war3map.w3a")?.custom ?? []).map((o: any) => o.id));
  const customItems = new Set<string>((json(d, "war3map.w3t")?.custom ?? []).map((o: any) => o.id));
  const kindOf = (id: string): any => {
    if (id === "sloc") return "sloc";
    if (abilityIds.has(id) || customAbilities.has(id)) return "ability";
    if (itemIds.has(id) || customItems.has(id)) return "item";
    const c = customUnits.get(id);
    if (c) return (c.bldg ?? buildings.has(c.base)) ? "building" : "unit";
    return buildings.has(id) ? "building" : "unit";
  };
  const lt = (info.lightEnvironment || info.tileset) as string;
  const input = {
    info, data, triggers, custom, kindOf, autocastOrders: (a: string) => orders.get(a),
    lights: { terrain: light("TerrainLights", lt, "Terrain"), unit: light("UnitLights", lt, "Unit") },
    groundHeight: terrain ? (x: number, y: number) => T.heightAt(terrain, x, y) : undefined,
    units: json(d, "war3mapUnits.doo")?.units, doodads: json(d, "war3map.doo")?.doodads,
    regions: json(d, "war3map.w3r")?.regions, cameras: json(d, "war3map.w3c")?.cameras, sounds: json(d, "war3map.w3s")?.sounds,
    soundDuration: () => 0, soundLabel: (l: string) => labels.get(l), string: (v: string) => wts?.resolve(v) ?? v,
  };
  // The whole file, exactly (only sound durations are left out: they need the game's sound files).
  const whole = J.generateScript(input), file = read(scriptFile);
  const inList = (a: any[] | undefined, f: (x: any) => string) => (a ?? []).map(f);
  const units = json(d, "war3mapUnits.doo")?.units ?? [], doodads = json(d, "war3map.doo")?.doodads ?? [];
  const known = new Set<string>([
    ...triggers.items.filter((i: any) => "ecas" in i && i.type !== 16).map((i: any) => `gg_trg_${J.ident(i.name)}`),
    ...inList(json(d, "war3map.w3r")?.regions, (r) => `gg_rct_${J.ident(r.name)}`), ...inList(json(d, "war3map.w3c")?.cameras, (c) => `gg_cam_${J.ident(c.name)}`),
    ...inList(json(d, "war3map.w3s")?.sounds, (s) => s.name),
    ...units.flatMap((p: any) => [J.placedName(p, "unit"), J.placedName(p, "item")]), ...doodads.flatMap((p: any) => [J.placedName(p, "dest"), J.placedName(p, "doodad")]),
  ]);
  for (const x of R.missingRefs(R.triggerRefs(triggers), known, triggers.variables)) broken.push(`${m} ${x.ref} (${x.triggers[0]})`);
  const lost = G.lostFunctions(file, whole);
  if (lost.length) guarded.push([m, lost]);
  checked++;
  // Sections are compared for JASS only (the World Editor's Lua comes with other spacing).
  if (scriptFile.endsWith(".lua")) continue;
  const gen = J.generateSections(input), orig = J.splitSections(file);
  const fs = (stats["(whole file)"] ??= [0, 0]); fs[1]++; if (norm(whole) === norm(file)) fs[0]++;
  if (only === "(whole file)" && norm(whole) !== norm(file) && shown < showN) {
    const a = norm(whole).split(/\r?\n/), b = norm(file).split(/\r?\n/);
    const k = a.findIndex((l: string, j: number) => l !== b[j]);
    // Only report files whose sections all match (an ordering problem then).
    if ([...gen].every(([s, v]) => norm(v) === norm(orig.get(s) ?? ""))) { shown++; console.log(`--- ${m} line ${k}\n gen: ${JSON.stringify(a.slice(k, k + 2))}\n orig: ${JSON.stringify(b.slice(k, k + 2))}`); }
  }
  for (const [k, v] of gen) {
    const o = orig.get(k) ?? "";
    const same = norm(v) === norm(o);
    const s = (stats[k] ??= [0, 0]); s[1]++; if (same) s[0]++;
    if (!same && k === only && shown < showN) {
      shown++;
      const a = norm(v).split(/\r?\n/), b = norm(o).split(/\r?\n/);
      const i = a.findIndex((l: string, j: number) => l !== b[j]);
      console.log(`--- ${m} line ${i}\n gen: ${JSON.stringify(a.slice(i, i + 3))}\n orig: ${JSON.stringify(b.slice(i, i + 3))}`);
    }
  }
}
for (const [k, [ok, n]] of Object.entries(stats)) console.log(`${(k || "(header)").padEnd(20)} ${ok}/${n}`);
console.log(`problems: ${broken.length} in the game's maps`);
for (const b of broken.slice(0, 20)) console.log(`  ${b}`);
console.log(`guard: ${guarded.length} of ${checked} maps would keep their script`);
for (const [m, lost] of guarded) console.log(`  ${m}: ${lost.length} (${lost.slice(0, 6).join(", ")})`);
