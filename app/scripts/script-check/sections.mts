// Section-by-section comparison of lib/script output with the World Editor's war3map.j.
// Run from a folder with ws/<n>/map (unpacked maps) and the game tables (see README.md).
// Args: <path to app/src/lib> [section to show diffs for] [number of diffs]
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { printSections } from "./report.mjs";
const L = process.argv[2];
const only = process.argv[3] ?? "";
const showN = Number(process.argv[4] ?? 1);
const mod = (p: string) => import(pathToFileURL(L + p).href);
const { parseTriggerData } = await mod("/triggers/triggerdata.ts");
const W = await mod("/triggers/wtg.ts");
const J = await mod("/script/jass.ts");
const G = await mod("/script/guard.ts");
const O = await mod("/script/objects.ts");
const R = await mod("/triggers/refs.ts");
const { checkLua, luaKnownNames, luaApiFrom } = await mod("/lua/check.ts");
const { envFrom } = await mod("/jass/check.ts");
const { StringTable } = await mod("/formats/wts.ts");
const T = await mod("/terrain/w3e.ts");
const { w3eFromText } = await mod("/terrain/w3etext.ts");
const { parseIni, parseSlk } = await mod("/formats/text.ts");

const { decodeLossless } = await mod("/formats/lossless.ts");

const read = (f: string) => readFileSync(f, "utf8");
/** A map's script or string table as the app reads it (readScriptFile, readWts): any encoding, lossless. */
const readMapText = (f: string): string => decodeLossless(new Uint8Array(readFileSync(f)));
const data = parseTriggerData(read("TriggerData.txt"));
const wed = parseIni(read("WorldEditData.txt"));
const light = (sec: string, t: string, kind: string) =>
  wed.get(sec)?.get(t.toLowerCase()) ?? `Environment\\DNC\\DNCLordaeron\\DNCLordaeron${kind}\\DNCLordaeron${kind}.mdl`;
const balance = parseSlk(read("UnitBalance.slk"));
const buildings = new Set(balance.filter((r: any) => r.isbldg === "1").map((r: any) => r.unitBalanceID));
const unitIds = new Set(balance.map((r: any) => r.unitBalanceID));
const itemRows = parseSlk(read("ItemData.slk"));
const itemIds = new Set(itemRows.map((r: any) => r.itemID));
const gameItemColors = O.gameTeamColors(itemRows, "itemID");
const abilityRows = parseSlk(read("AbilityData.slk"));
const abilityIds = new Set(abilityRows.map((r: any) => r.alias));
const gameHeroAbilities = new Set<string>(abilityRows.filter((r: any) => r.hero === "1").map((r: any) => r.alias));
const labels = existsSync("soundinfo") ? J.parseSoundLabels(readdirSync("soundinfo").map((f) => read("soundinfo/" + f))) : new Map();
const unitUI = parseSlk(read("unitUI.slk"));
const gameColors = O.gameTeamColors(unitUI), gameCustomColors = O.gameCustomColors(unitUI);
const orders = O.abilityOrders(readdirSync("abil").map((f) => parseIni(read("abil/" + f))));

const stats: Record<string, [number, number]> = {};
// lib/script/guard: maps the World Editor made must not look as if they had code of their own.
const guarded: [string, string[]][] = [];
// JASS maps whose script differs from Studio's by more than the order of placed objects: the guard asks before the
// first regeneration.
const asked: string[] = [];
let checked = 0;
// The Problems view's trigger references and Lua check: what the World Editor made has no such problems.
const luaBroken: string[] = [];
const broken: string[] = [];
// SCRIPT_CHECK_SHARD=<i>/<n>: only the i-th of n runs of maps (run.mjs puts the shards together).
const [shardI, shardN] = (process.env.SCRIPT_CHECK_SHARD ?? "0/1").split("/").map(Number);
const allMaps = readdirSync("ws");
const maps = allMaps.slice(Math.floor((shardI * allMaps.length) / shardN), Math.floor(((shardI + 1) * allMaps.length) / shardN));
// Names too, as the Problems view checks them: against the game's Lua API (common.j, Blizzard.j, common.ai's natives).
const luaApi = luaApiFrom(envFrom([read("Blizzard.j")], envFrom([read("common.j")])), read("common.ai"));
let luaChecked = 0, luaNamesJudged = 0;
for (const m of maps) {
  const f = `ws/${m}/map/war3map.lua`;
  if (!existsSync(f)) continue;
  const src = read(f);
  const known = luaKnownNames(luaApi);
  luaChecked++;
  if (luaKnownNames(luaApi, [src])) luaNamesJudged++;
  const p = checkLua(src, known);
  for (const x of p) luaBroken.push(`${m} lua: ${x.message} (line ${src.slice(0, x.from).split("\n").length})`);
}
let shown = 0;
/** A map's object data (`war3map.w3u.json`, … by name) as W3Proj Studio reads it, where the map keeps it in map/objects/
 *  (one file per object): `w3proj objects` assembles it (W3PROJ_BIN, the CLI that unpacked the maps). */
const objectsCache = new Map<string, Record<string, unknown>>();
const objectsOf = (d: string): Record<string, unknown> => {
  let got = objectsCache.get(d);
  if (!got) {
    got = existsSync(`${d}/objects/objects.json`) ? JSON.parse(execFileSync(process.env.W3PROJ_BIN!, ["objects", dirname(d)], { encoding: "utf8", maxBuffer: 1 << 28 })) : {};
    objectsCache.clear();
    objectsCache.set(d, got!);
  }
  return got!;
};
const json = (d: string, n: string) => objectsOf(d)[`${n}.json`] ?? (existsSync(`${d}/${n}.json`) ? JSON.parse(read(`${d}/${n}.json`)) : null);
const norm = (x: string) => x.replace(/\s+$/g, "");

for (const m of maps) {
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
  if (custom && existsSync(`${d}/war3map.wct`)) {
    const wctBytes = new Uint8Array(readFileSync(`${d}/war3map.wct`));
    const rc = (stats["(wct byte-exact)"] ??= [0, 0]); rc[1]++; if (same(W.writeWct(custom), wctBytes)) rc[0]++;
  }
  const wts = existsSync(`${d}/war3map.wts`) ? new StringTable(readMapText(`${d}/war3map.wts`)) : null;
  const terrain = existsSync(`${d}/war3map.w3e.txt`) ? T.parseW3e(w3eFromText(read(`${d}/war3map.w3e.txt`))) : existsSync(`${d}/war3map.w3e`) ? T.parseW3e(new Uint8Array(readFileSync(`${d}/war3map.w3e`))) : null;
  // Custom objects: their base decides, unless the map sets "is a building" (ubdg); as the app reads them.
  const unitFiles = [json(d, "war3map.w3u"), json(d, "war3mapSkin.w3u")];
  const colors = O.teamColors(unitFiles, gameColors), special = O.specialUnits(unitFiles);
  const itemColors = O.teamColors([json(d, "war3map.w3t"), json(d, "war3mapSkin.w3t")], gameItemColors, "itco");
  const isBuilding = O.buildingTypes(unitFiles, buildings);
  const customAbilities = new Set<string>((json(d, "war3map.w3a")?.custom ?? []).map((o: any) => o.id));
  const heroAbility = O.heroAbilities([json(d, "war3map.w3a"), json(d, "war3mapSkin.w3a")], gameHeroAbilities);
  const destructableTint = O.destructableTints([json(d, "war3map.w3b"), json(d, "war3mapSkin.w3b")]);
  const customItems = new Set<string>((json(d, "war3map.w3t")?.custom ?? []).map((o: any) => o.id));
  const kindOf = (id: string): any => {
    if (id === "sloc") return "sloc";
    if (id === "iDNR") return "item";
    if (abilityIds.has(id) || customAbilities.has(id)) return "ability";
    if (itemIds.has(id) || customItems.has(id)) return "item";
    return isBuilding(id) ? "building" : "unit";
  };
  const lt = (info.lightEnvironment || info.tileset) as string;
  const input = {
    info, data, triggers, custom, kindOf, autocastOrders: O.autocastOrdersOf(orders, [json(d, "war3map.w3a"), json(d, "war3mapSkin.w3a")]), heroAbility, destructableTint, teamColor: (id: string) => colors.get(id), itemColor: (id: string) => itemColors.get(id), goldMine: (id: string) => special.goldMines.has(id), waygate: (id: string) => special.waygates.has(id),
    customColor: O.customColorTypes(unitFiles, gameCustomColors),
    lights: { terrain: light("TerrainLights", lt, "Terrain"), unit: light("UnitLights", lt, "Unit") },
    groundHeight: terrain ? (x: number, y: number) => T.heightAt(terrain, x, y) : undefined,
    units: json(d, "war3mapUnits.doo")?.units, doodads: json(d, "war3map.doo")?.doodads,
    regions: json(d, "war3map.w3r")?.regions, cameras: json(d, "war3map.w3c")?.cameras, sounds: json(d, "war3map.w3s")?.sounds,
    // Sound lengths as the app takes them when it can't read the sound files: from the script there is.
    soundDuration: J.scriptSoundDurations(readMapText(scriptFile)), soundLabel: (l: string) => labels.get(l), string: (v: string) => wts?.resolve(v) ?? v,
  };
  // The whole file, exactly (only sound durations are left out: they need the game's sound files).
  const whole = J.generateScript(input), file = readMapText(scriptFile);
  // SCRIPT_CHECK_DUMP=<folder>: both scripts per map, to go through the differences (JASS and Lua).
  if (process.env.SCRIPT_CHECK_DUMP) writeFileSync(`${process.env.SCRIPT_CHECK_DUMP}/${m}.json`, JSON.stringify([norm(whole), norm(file)]));
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
  // Sections are compared for JASS only (war3map.lua has no banners); a Lua script counts as a whole file.
  if (scriptFile.endsWith(".lua")) {
    const fl = (stats["(whole file, Lua)"] ??= [0, 0]); fl[1]++; if (norm(whole) === norm(file)) fl[0]++;
    continue;
  }
  // A fresh import's first regeneration (no stamp yet): which World Editor scripts it would ask about.
  if (G.scriptDecision(norm(file), norm(whole), null).action === "keep") asked.push(m);
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
const detail = { stats, broken: [...luaBroken, ...broken], guarded, asked, checked, luaBroken, otherBroken: broken, lua: { checked: luaChecked, judged: luaNamesJudged } };
// Under run.mjs (SCRIPT_CHECK_SHARD set) nothing is printed here: it puts the shards' details together and prints that.
if (!process.env.SCRIPT_CHECK_SHARD) printSections(detail);
if (process.env.SCRIPT_CHECK_JSON) writeFileSync(process.env.SCRIPT_CHECK_JSON, JSON.stringify(detail));
