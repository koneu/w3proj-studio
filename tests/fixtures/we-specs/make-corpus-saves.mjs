// Inputs for tests/we-compare/corpus-saves.json: real maps (the game's own, the smoketest maps of the main checkout)
// and small variants of them, for the World Editor's open-and-save against Studio's save of the same map, into
// <repo>/target/corpus-saves/<name>.w3x. Nothing is committed: the game's maps and the smoketest maps aren't ours.
//   node tests/fixtures/we-specs/make-corpus-saves.mjs [--only NAME,NAME]
// Needs the game (W3PROJ_GAME / .game-path), the main checkout's smoketest_maps and a fresh release CLI (this
// checkout's, else the main checkout's, as make-studio-paths.mjs).
//
//   melee-<map>-off   a game melee map with its w3i Melee flag (0x4) cleared: the save puts it back where the map
//                     meets the editor's rules (the 9 maps melee-corpus flips to agree): melee-adrenaline-off.w3x,
//                     melee-centaurgrove-off.w3x, melee-banewoodbog-off.w3x, melee-banewoodbog-lv-off.w3x,
//                     melee-murguloasis-off.w3x, melee-vilereef-off.w3x, melee-zandalar-off.w3x,
//                     melee-legendsofthepast-off.w3x, melee-indigokeeper-off.w3x
//   melee-snowblind   (8)Snowblind_S2_v1.2 as the game holds it
//   melee-banewoodbog (8)BanewoodBog as the game holds it (Melee on; its war3mapSkin.w3d holds one entry)
//   melee-banewoodbog-noskin-off  the same with Melee off and war3mapSkin.w3d removed
//   melee-gui-args    flat.w3x (melee) with a second GUI trigger "Hello" whose action has arguments
//                     (DisplayTextToForce(GetPlayersAll(), "hello"))
//   zero-<project>    a build_1 project (an older Studio's save, all-zero ally masks) packed as is (pack_as_is:
//                     `w3proj pack` would work the masks out): zero-meelee-map.w3x, zero-meelee-map-2.w3x,
//                     zero-another-melee-map.w3x
//   zero-crazyherosiege  CrazyHeroSiegeAI_v2.0 (all-zero masks, no war3map.wtg) with flat.w3x's wtg and wct, as is
//   wc2orc04          WC2Orc04.w3x as the campaign file CSW_Tides_Of_Darkness.w3n holds it
//   wc2orc04-pack     the chapter project of build_1/CSW_Tides_Of_Darkness packed by `w3proj pack`
//   lua-sky-or        flat.w3x with a Lua script (w3i scriptType 1, war3map.lua from `w3proj rebuild`) and the GUI
//                     triggers "Sky" (SetSkyModel(SkyModelNone)) and "Or" (an Or condition of two comparisons)
//   lua-or, lua-sky-cond  one trigger each: the Or condition alone; a plain condition and SetSkyModel(SkyModelNone)
//   jass-sky-or       lua-sky-or's triggers in a JASS map (the control)
//   wormwar           (12)WormWar as the game holds it (w3i flag 0x4000; custom units based on Ucrl and nano)
//   wormwar-deftrig   its triggers replaced by the default melee trigger (flat.w3x's wtg and wct)
//   wormwar-now3u     its custom units (war3map.w3u, war3mapSkin.w3u) removed, triggers default
//   wormwar-noobj     every object data file removed, triggers default
//   wormwar-only-<k>  triggers default, only the object data of kind k (t, b, d, a, h) kept: wormwar-only-t.w3x,
//                     wormwar-only-b.w3x, wormwar-only-d.w3x, wormwar-only-a.w3x, wormwar-only-h.w3x
//   tft-cu-<base>-<on|off>  flat.w3x with one custom unit (w3u) based on <base>, w3i flag 0x4000 set (on) or not:
//                     tft-cu-ucrl-on.w3x, tft-cu-ucrl-off.w3x, tft-cu-hfoo-on.w3x, tft-cu-hfoo-off.w3x
//   tft-ca-off, tft-oa-off, tft-ch-off, tft-oq-off  flat.w3x (0x4000 off) with a custom ability, a changed original
//                     ability, a custom buff, a changed original upgrade
//   preview-unlisted  flat.w3x with a war3mapPreview.tga that the import list doesn't name
//   preview-listed    the same with war3map.imp naming it (flags 29, as WormWar's list does)
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chosenGamePath, mainCheckout } from "../../gamepath.mjs";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const main = mainCheckout();
const exe = process.platform === "win32" ? "w3proj.exe" : "w3proj";
const cli = existsSync(join(repo, "target", "release", exe)) ? join(repo, "target", "release", exe) : join(main, "target", "release", exe);
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const game = chosenGamePath();
const env = { ...process.env, W3PROJ_GAME: game };
const maps = join(main, "smoketest_maps");
const argv = process.argv.slice(2).filter((a) => a !== "--allow-stale");
let only = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--only" && argv[i + 1]) only = new Set(argv[++i].split(","));
  else { console.error(`unknown argument ${argv[i]}`); process.exit(2); }
}

function run(...args) {
  const r = spawnSync(cli, args, { env, encoding: "buffer", maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr.toString()}${r.stdout.toString().slice(0, 2000)}`);
  return r.stdout;
}
function packAsIs(project, output) {
  const r = spawnSync("cargo", ["run", "--release", "--quiet", "-p", "w3proj", "--example", "pack_as_is", "--", project, output], { cwd: repo, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`pack_as_is ${project}: ${r.stderr || r.stdout}`);
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);

const final = join(repo, "target", "corpus-saves");
const out = `${final}.new`;
const work = join(out, ".work");
rmSync(out, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
// With --only the other maps of the last run are kept.
if (only && existsSync(final)) for (const f of readdirSync(final)) if (f.endsWith(".w3x")) cpSync(join(final, f), join(out, f));

/** A game map's bytes out of the game's storage. */
const gameMap = (path) => run("game", "cat", path);
/** Unpacks `src` (a file) into a fresh project folder of the work folder; returns its map folder. */
function unpack(name, src) {
  const dir = join(work, name);
  rmSync(dir, { recursive: true, force: true });
  run("unpack", src, dir, "--game", game);
  return dir;
}
function pack(dir, name) { run("pack", dir, "-o", join(out, `${name}.w3x`), "--force-stale"); }
const want = (name) => !only || only.has(name);

const MELEE_OFF = {
  adrenaline: "Maps/FrozenThrone/(4)Adrenaline.w3x",
  centaurgrove: "Maps/FrozenThrone/(4)CentaurGrove.w3x",
  banewoodbog: "Maps/FrozenThrone/(8)BanewoodBog.w3x",
  "banewoodbog-lv": "Maps/FrozenThrone/(8)BanewoodBog_LV.w3x",
  murguloasis: "Maps/FrozenThrone/(8)Mur'gulOasis.w3x",
  vilereef: "Maps/FrozenThrone/Community/(4)VileReef.w3x",
  zandalar: "Maps/FrozenThrone/Community/(6)Zandalar.w3x",
  legendsofthepast: "Maps/FrozenThrone/Community/(8)LegendsofthePast.w3x",
  indigokeeper: "Maps/FrozenThrone/Community/2023Season2/(8)IndigoKeeper_S2_v1.2.w3x",
};
for (const [name, path] of Object.entries(MELEE_OFF)) {
  if (!want(`melee-${name}-off`)) continue;
  const src = join(work, `${name}.w3x`);
  writeFileSync(src, gameMap(path));
  const dir = unpack(name, src);
  const infoFile = join(dir, "map", "war3map.w3i.json");
  const info = readJson(infoFile);
  if (!(info.flags & 4)) throw new Error(`${path} isn't stored melee`);
  info.flags &= ~4;
  writeJson(infoFile, info);
  pack(dir, `melee-${name}-off`);
}
if (want("melee-snowblind")) writeFileSync(join(out, "melee-snowblind.w3x"), gameMap("Maps/FrozenThrone/Community/2023Season2/(8)Snowblind_S2_v1.2.w3x"));
// BanewoodBog as stored (Melee on), and with Melee off and its war3mapSkin.w3d (one entry, LWw0, no values) removed.
if (want("melee-banewoodbog")) writeFileSync(join(out, "melee-banewoodbog.w3x"), gameMap(MELEE_OFF.banewoodbog));
if (want("melee-banewoodbog-noskin-off")) {
  const src = join(work, "banewood-noskin.w3x");
  writeFileSync(src, gameMap(MELEE_OFF.banewoodbog));
  const dir = unpack("banewood-noskin", src);
  rmSync(join(dir, "map", "war3mapSkin.w3d.json"));
  const infoFile = join(dir, "map", "war3map.w3i.json");
  const info = readJson(infoFile);
  info.flags &= ~4;
  writeJson(infoFile, info);
  pack(dir, "melee-banewoodbog-noskin-off");
}

const eca = (kind, name, params = [], extra = {}) => ({ kind, name, enabled: true, params, children: [], ...extra });
const str = (value) => ({ type: 3, value });
/** flat.w3x's project with GUI triggers added (`items`: trigger items without id and parent). */
function withTriggers(dir, items) {
  const wtgFile = join(dir, "map", "war3map.wtg.json");
  const wtg = readJson(wtgFile);
  const category = wtg.items.find((i) => i.type === 4).id;
  items.forEach((it, n) => wtg.items.push({ type: 8, description: "", isComment: 0, id: (3 << 24) | (n + 1), enabled: true, isCustom: false,
    initiallyOff: false, runOnInit: false, parent: category, ...it }));
  wtg.counts[3].count += items.length;
  writeFileSync(wtgFile, JSON.stringify(wtg, null, 1));
  const wctFile = join(dir, "map", "war3map.wct.txt");
  const wct = readFileSync(wctFile, "utf8").replace(/\r?\n$/, "");
  writeFileSync(wctFile, `${wct}\n${items.map((it, n) => `//== trigger ${n + 1} (no text): ${it.name} ==`).join("\n")}\n`);
}
const flat = join(here, "flat.w3x");
if (want("melee-gui-args")) {
  const dir = unpack("gui-args", flat);
  withTriggers(dir, [{ name: "Hello", ecas: [
    eca(0, "MapInitializationEvent"),
    eca(2, "DisplayTextToForce", [{ type: 2, value: "GetPlayersAll", call: { kind: 3, name: "GetPlayersAll", hasParams: false, params: [], trailer: 0 } }, str("hello")]),
  ] }]);
  pack(dir, "melee-gui-args");
}

for (const project of ["meelee_map", "meelee_map_2", "another melee map"]) {
  const name = `zero-${project.replace(/ /g, "-").replace(/_/g, "-")}`;
  if (!want(name)) continue;
  const dir = join(work, name);
  cpSync(join(maps, "build_1", project), dir, { recursive: true });
  const info = readJson(join(dir, "map", "war3map.w3i.json"));
  if (info.players.some((p) => p.allyLow || p.allyHigh)) throw new Error(`${project}: its ally masks aren't all zero`);
  packAsIs(dir, join(out, `${name}.w3x`));
}

// CrazyHeroSiegeAI_v2.0 has no war3map.wtg (the editor refuses it: "Trigger data missing or invalid"): flat.w3x's wtg
// and wct added, packed as is (its all-zero ally masks kept).
if (want("zero-crazyherosiege")) {
  const dir = unpack("crazy", join(maps, "new(er)_maps", "CrazyHeroSiegeAI_v2.0.w3x"));
  const flatDir = unpack("flat-crazy", join(here, "flat.w3x"));
  for (const f of ["war3map.wtg.json", "war3map.wct.txt"]) cpSync(join(flatDir, "map", f), join(dir, "map", f));
  const info = readJson(join(dir, "map", "war3map.w3i.json"));
  if (info.players.some((p) => p.allyLow || p.allyHigh)) throw new Error("CrazyHeroSiegeAI: its ally masks aren't all zero");
  packAsIs(dir, join(out, "zero-crazyherosiege.w3x"));
}

if (want("wc2orc04")) writeFileSync(join(out, "wc2orc04.w3x"), run("cat", join(maps, "campaign", "CSW_Tides_Of_Darkness.w3n"), "WC2Orc04.w3x"));
if (want("wc2orc04-pack")) run("pack", join(maps, "build_1", "CSW_Tides_Of_Darkness", "maps", "WC2Orc04.w3x"), "-o", join(out, "wc2orc04-pack.w3x"));

// OperatorCompareInteger takes a ComparisonOperator (OperatorEqual); OperatorEqualENE is the EqualNotEqualOperator of
// other comparisons, and with it the editor's compile stops at a syntax error.
const cmp = (a, b, extra) => eca(1, "OperatorCompareInteger", [str(a), { type: 0, value: "OperatorEqual" }, str(b)], extra);
const sky = () => eca(2, "SetSkyModel", [{ type: 0, value: "SkyModelNone" }]);
const timer = () => eca(0, "TriggerRegisterTimerEventSingle", [str("5.00")]);
const orCond = () => eca(1, "OrMultiple", [], { children: [cmp("1", "2", { group: 0 }), cmp("3", "2", { group: 0 })] });
/** flat.w3x with these GUI triggers; `lua`: w3i scriptType 1 and war3map.lua written by `w3proj rebuild`. */
const LUA_MAPS = {
  "lua-sky-or": { lua: true, triggers: [
    { name: "Sky", ecas: [eca(0, "MapInitializationEvent"), sky()] },
    { name: "Or", ecas: [timer(), orCond(), cmp("4", "5"), sky()] },
  ] },
  "lua-or": { lua: true, triggers: [{ name: "Either", ecas: [timer(), orCond(), eca(2, "DoNothing")] }] },
  "lua-sky-cond": { lua: true, triggers: [{ name: "SkyCond", ecas: [timer(), cmp("4", "5"), sky()] }] },
  "jass-sky-or": { lua: false, triggers: [
    { name: "Sky", ecas: [eca(0, "MapInitializationEvent"), sky()] },
    { name: "Or", ecas: [timer(), orCond(), cmp("4", "5"), sky()] },
  ] },
};
for (const [name, { lua, triggers }] of Object.entries(LUA_MAPS)) {
  if (!want(name)) continue;
  const dir = unpack(name, flat);
  withTriggers(dir, triggers);
  if (lua) {
    const infoFile = join(dir, "map", "war3map.w3i.json");
    const info = readJson(infoFile);
    info.scriptType = 1;
    writeJson(infoFile, info);
    rmSync(join(dir, "map", "war3map.j"));
  }
  run("rebuild", dir, "--only", "script", "--force", "--game", game);
  if (!existsSync(join(dir, "map", lua ? "war3map.lua" : "war3map.j"))) throw new Error(`${name}: rebuild wrote no script`);
  pack(dir, name);
}

const WORMWAR = "Maps/FrozenThrone/Scenario/(12)WormWar.w3x";
const OBJECT_KINDS = ["u", "t", "b", "d", "a", "h", "q"];
const objectFiles = (kinds) => kinds.flatMap((k) => [`war3map.w3${k}.json`, `war3mapSkin.w3${k}.json`]);
const WORMWAR_VARIANTS = { "wormwar-deftrig": [], "wormwar-now3u": objectFiles(["u"]), "wormwar-noobj": objectFiles(OBJECT_KINDS) };
// wormwar-only-<k>: triggers default, every object data file gone but the kind k's (war3map.w3k and war3mapSkin.w3k).
for (const k of ["t", "b", "d", "a", "h"]) WORMWAR_VARIANTS[`wormwar-only-${k}`] = objectFiles(OBJECT_KINDS.filter((x) => x !== k));
if (["wormwar", ...Object.keys(WORMWAR_VARIANTS)].some(want)) {
  const src = join(work, "wormwar-src.w3x");
  writeFileSync(src, gameMap(WORMWAR));
  if (want("wormwar")) cpSync(src, join(out, "wormwar.w3x"));
  const flatDir = unpack("flat", flat);
  const variants = WORMWAR_VARIANTS;
  for (const [name, gone] of Object.entries(variants)) {
    if (!want(name)) continue;
    const dir = unpack(name, src);
    for (const f of ["war3map.wtg.json", "war3map.wct.txt"]) cpSync(join(flatDir, "map", f), join(dir, "map", f));
    for (const f of gone) rmSync(join(dir, "map", f), { force: true });
    pack(dir, name);
  }
}

for (const base of ["Ucrl", "hfoo"]) for (const on of [true, false]) {
  const name = `tft-cu-${base.toLowerCase()}-${on ? "on" : "off"}`;
  if (!want(name)) continue;
  const dir = unpack(name, flat);
  const id = base[0] === base[0].toUpperCase() ? "U000" : "h000";
  writeJson(join(dir, "map", "war3map.w3u.json"), { format: "w3proj.objects/1", version: 2, original: [],
    custom: [{ base, id, mods: [{ field: "unam", type: "string", value: `Custom ${base}` }] }] });
  const infoFile = join(dir, "map", "war3map.w3i.json");
  const info = readJson(infoFile);
  info.flags = on ? info.flags | 0x4000 : info.flags & ~0x4000;
  writeJson(infoFile, info);
  pack(dir, name);
}

// tft-<case>-off: flat.w3x (0x4000 off) with one object data file: which kinds make the save set 0x4000.
const objects = (original, custom) => ({ format: "w3proj.objects/1", version: 2, original, custom });
const amod = (field, value, level = 0) => ({ field, type: "string", level, data: 0, value });
const TFT_OBJECTS = {
  "tft-ca-off": ["war3map.w3a.json", objects([], [{ base: "AHhb", id: "A000", mods: [amod("anam", "Custom Holy Light")] }])],
  "tft-oa-off": ["war3map.w3a.json", objects([{ base: "AHhb", mods: [amod("anam", "Holy Light Renamed")] }], [])],
  "tft-ch-off": ["war3map.w3h.json", objects([], [{ base: "BHbd", id: "B000", mods: [] }])],
  "tft-oq-off": ["war3map.w3q.json", objects([{ base: "Rhme", mods: [amod("gnam", "Iron Forged Swords Renamed", 1)] }], [])],
};
for (const [name, [file, doc]] of Object.entries(TFT_OBJECTS)) {
  if (!want(name)) continue;
  const dir = unpack(name, flat);
  writeJson(join(dir, "map", file), doc);
  pack(dir, name);
}

/** A 2x2 uncompressed 24-bit TGA. */
const tga = () => { const b = new Uint8Array(18 + 12).fill(200); b.set([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0, 24, 0]); return b; };
for (const listed of [false, true]) {
  const name = listed ? "preview-listed" : "preview-unlisted";
  if (!want(name)) continue;
  const dir = unpack(name, flat);
  writeFileSync(join(dir, "map", "war3mapPreview.tga"), tga());
  if (listed) writeJson(join(dir, "map", "war3map.imp.json"), { format: "w3proj.imports/1", version: 1, files: [{ flags: 29, path: "war3mapPreview.tga" }] });
  pack(dir, name);
}

rmSync(work, { recursive: true, force: true });
rmSync(final, { recursive: true, force: true });
renameSync(out, final);
console.log(`made ${readdirSync(final).filter((f) => f.endsWith(".w3x")).length} maps in ${final}`);
