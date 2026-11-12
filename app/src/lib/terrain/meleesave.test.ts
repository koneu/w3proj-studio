import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultTriggerFile, defaultWtg } from "../triggers/defaults";
import { writeWtgJson } from "../triggers/wtg";
import { meleeAfterSave, meleeSetBlockers, readMeleeFacts, savedMelee, startsUnderWater, type MeleeFacts, type MeleeFiles } from "./meleesave";
import { writeW3e, type Corner, type Terrain } from "./w3e";

/** Rows from the north, a char per corner: `w` ground at -100 under water at 50, `.` dry ground at 0. */
function lake(rows: string[]): Terrain {
  const height = rows.length, width = rows[0].length;
  const corners: Corner[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const wet = rows[height - 1 - y][x] === "w";
    corners.push({ layer: 2, ramp: false, height: wet ? -100 : 0, rawHeight: (wet ? -100 : 0) * 4 + 0x2000, hasWater: wet, water: wet ? 50 : -2137.6, texture: 0, variation: 0, cliffVariation: 0, cliffTexture: 0, blight: false, boundary: false, rawWater: wet ? 0x2000 + 200 : 0, texExtra: 0 });
  }
  return { version: 11, tileset: "L", customTilesets: false, groundTiles: ["Ldrt"], cliffTiles: ["CLdi"], width, height, offsetX: 0, offsetY: 0, corners, trailer: new Uint8Array(0) } as unknown as Terrain;
}

/** A project's files: path → text, or an Error for a file that is there but can't be read. */
function files(map: Record<string, string | Uint8Array | Error>): MeleeFiles & { reads: string[] } {
  const reads: string[] = [];
  const get = (p: string) => {
    reads.push(p);
    const v = map[p];
    if (v === undefined) return Promise.reject(new Error(`not found: ${p}`));
    if (v instanceof Error) return Promise.reject(v);
    return Promise.resolve(v);
  };
  return {
    reads,
    files: () => Object.keys(map).map((path) => ({ path })),
    readText: (p) => get(p).then((v) => (typeof v === "string" ? v : new TextDecoder().decode(v))),
    readBytes: (p) => get(p).then((v) => (typeof v === "string" ? new TextEncoder().encode(v) : v)),
  };
}

const MELEE = 0x2fc14;
const start = (x: number, y: number) => ({ id: "sloc", player: 0, position: [x, y, 0] });

test("a start location under water is in an invalid position; one on dry ground isn't", () => {
  const t = lake(["ww..", "ww..", "ww.."]);
  assert.equal(startsUnderWater(t, [start(64, 64)]), true);
  assert.equal(startsUnderWater(t, [start(2 * 128 + 64, 64)]), false, "control: dry ground");
  assert.equal(startsUnderWater(t, [{ id: "hfoo", player: 0, position: [64, 64, 0] }]), false, "only start locations count");
  assert.equal(startsUnderWater(t, [{ id: "sloc", player: 0 }]), false, "no position");
});

test("the save's melee rules take the facts: constants, starts under water, a player's unit", () => {
  const t = lake(["ww..", "ww..", "ww.."]);
  const dry = { customConstants: false, terrain: t };
  assert.deepEqual(meleeAfterSave({ flags: MELEE }, [start(320, 64)], dry), { flags: MELEE, reasons: [] }, "control: nothing applies");
  assert.deepEqual(meleeAfterSave({ flags: MELEE }, [start(64, 64)], dry), { flags: MELEE & ~4, reasons: ["Start locations are in invalid positions"] });
  assert.deepEqual(meleeAfterSave({ flags: MELEE }, [start(320, 64)], { ...dry, customConstants: true }).reasons, ["Custom gameplay constants have been specified"]);
  assert.deepEqual(meleeAfterSave({ flags: MELEE }, [start(320, 64), { id: "hfoo", player: 0, position: [0, 0, 0] }], dry).reasons, ["Player-owned units have been placed"]);
  assert.deepEqual(meleeAfterSave({ flags: MELEE }, [start(64, 64)], { customConstants: false, terrain: null }).flags, MELEE, "unknown ground: no reason");
  assert.deepEqual(meleeAfterSave({ flags: MELEE & ~4 }, [start(64, 64)], dry), { flags: MELEE & ~4, reasons: [] }, "never back on");
});

test("the facts come from the project; missing and unreadable files set nothing", async () => {
  const t = lake(["ww..", "ww..", "ww.."]);
  const w3e = writeW3e(t);
  const set = await readMeleeFacts(files({ "map/war3mapMisc.txt": "[Misc]\nScaledAnimTime=75.0\n", "map/war3map.w3e": w3e }));
  assert.equal(set.customConstants, true);
  assert.equal(set.terrain?.width, 4);
  assert.equal(startsUnderWater(set.terrain!, [start(64, 64)]), true, "the saved ground, as written");
  // The file's name as the project has it (case differs on disk).
  assert.equal((await readMeleeFacts(files({ "map/War3MapMisc.txt": "[Misc]\nA=1\n" }))).customConstants, true);
  const none = await readMeleeFacts(files({}));
  assert.deepEqual(none, { customConstants: false, terrain: null });
  const broken = await readMeleeFacts(files({ "map/war3mapMisc.txt": new Error("EACCES"), "map/war3map.w3e": new Uint8Array([1, 2, 3]) }));
  assert.deepEqual(broken, { customConstants: false, terrain: null }, "unreadable: not known, so the flag stays");
  // The ground being saved wins over the project's.
  const given = await readMeleeFacts(files({ "map/war3map.w3e": new Uint8Array([1]) }), t);
  assert.equal(given.terrain, t);
});

test("nothing is read when the map isn't a melee map and war3map.w3i or the units tell why", async () => {
  const ws = files({ "map/war3mapMisc.txt": "[Misc]\nA=1\n" });
  const footman = { id: "hfoo", player: 0, position: [0, 0, 0] };
  assert.deepEqual(await savedMelee(ws, { flags: MELEE & ~4 }, [footman]), { flags: MELEE & ~4, reasons: [] });
  assert.deepEqual(await savedMelee(ws, { flags: (MELEE & ~4) | 0x40 }, []), { flags: (MELEE & ~4) | 0x40, reasons: [] }, "custom forces");
  assert.deepEqual(ws.reads, []);
  assert.equal((await savedMelee(ws, { flags: MELEE }, [])).flags, MELEE & ~4, "control: read when it is");
});

// The World Editor's save puts Melee back on a map that meets its rules (we-drive, 2026-11-09 and this branch's saves).
// Studio does that only when it can tell every rule; else the flag stays off.

/** A flat dry map of `size` corners a side, every corner on level 2 with tile `tiles[0]`; `edit` changes corners. */
function flat(size = 17, edit?: (c: Corner, x: number, y: number) => void): Terrain {
  const t = lake(Array.from({ length: size }, () => ".".repeat(size)));
  t.groundTiles = ["Ldrt", "Lrok"];
  if (edit) t.corners.forEach((c, i) => edit(c, i % size, Math.floor(i / size)));
  return t;
}
/** TerrainArt's Terrain.slk with Ldrt buildable and Lrok not. */
const TERRAIN_SLK = 'ID;PWXL;N;E\nC;Y1;X1;K"tileID"\nC;X2;K"buildable"\nC;Y2;X1;K"Ldrt"\nC;X2;K1\nC;Y3;X1;K"Lrok"\nC;X2;K0\nE\n';
/** Units' UnitData.slk: a creep without pathing, a tavern and a gold mine with. */
const UNIT_SLK = 'ID;PWXL;N;E\nC;Y1;X1;K"unitID"\nC;X2;K"pathTex"\nC;Y2;X1;K"nftk"\nC;X2;K"_"\nC;Y3;X1;K"ntav"\nC;X2;K"PathTextures\\8x8SimpleSolid.tga"\nC;Y4;X1;K"ngol"\nC;X2;K"PathTextures\\16x16Goldmine.tga"\nE\n';
const GAME: Record<string, string> = { "TerrainArt\\Terrain.slk": TERRAIN_SLK, "Units\\UnitData.slk": UNIT_SLK };
/** The start locations' surroundings: `doodads`, the tile Ldrt buildable, the creep nftk without pathing. */
const around = (doodads: { x: number; y: number; reach: number }[] = []) => ({ doodads, buildable: new Set(["Ldrt"]), unpathed: new Set(["nftk"]) });
const OFF = MELEE & ~4;
/** The middle of flat()'s map, and a start there. */
const MID = 8 * 128, startMid = start(MID, MID);
/** Everything known, nothing in the way. */
const clean = (): MeleeFacts => ({ customConstants: false, terrain: flat(), constantsKnown: true, customData: false, defaultTriggers: true, around: around() });

test("the flag goes back on when Studio can tell every rule is met", () => {
  const placed = [startMid, { id: "ngol", player: 27, position: [MID + 700, MID, 0] }];
  assert.deepEqual(meleeSetBlockers({ flags: OFF }, placed, clean()), []);
  assert.deepEqual(meleeAfterSave({ flags: OFF }, placed, clean()), { flags: MELEE, reasons: [] });
  // A doodad, a tree, a unit just outside the starts' surroundings.
  assert.equal(meleeAfterSave({ flags: OFF }, [...placed, { id: "ntav", player: 27, position: [MID, MID - 600, 0] }], { ...clean(), around: around([{ x: MID + 520, y: MID, reach: 0 }]) }).flags, MELEE);
});

test("the flag stays off for a reason, and where Studio can't tell", () => {
  const placed = [startMid];
  const left = (facts: Partial<MeleeFacts>, more: object[] = [], info: { flags?: number } = {}) => {
    const r = meleeAfterSave({ flags: OFF, ...info }, [...placed, ...more] as never[], { ...clean(), ...facts });
    return r.flags === (info.flags ?? OFF) && r.reasons.length === 0;
  };
  assert.equal(left({}), false, "control: it goes on");
  // The World Editor's reasons.
  assert.equal(left({}, [{ id: "hfoo", player: 0, position: [0, 0, 0] }]), true, "a player's unit");
  assert.equal(left({}, [], { flags: OFF | 0x40 }), true, "custom forces");
  assert.equal(left({ customConstants: true }), true, "custom gameplay constants");
  assert.equal(left({ customData: true }), true, "custom object data");
  assert.equal(left({ defaultTriggers: false }), true, "custom triggers");
  // Start locations in invalid positions: trees about 200 away and a tavern at 250 made them so in the World Editor.
  assert.equal(left({ around: around([{ x: MID + 200, y: MID, reach: 0 }]) }), true, "a tree 200 away");
  assert.equal(left({ around: around([{ x: MID + 400, y: MID, reach: 256 }]) }), true, "a special doodad reaching in");
  assert.equal(left({}, [{ id: "ntav", player: 27, position: [MID + 250, MID, 0] }]), true, "a tavern 250 away");
  assert.equal(left({}, [start(MID + 300, MID)]), true, "another start close by");
  assert.equal(left({}, [{ id: "nftk", player: 24, position: [MID + 12, MID, 0] }]), false, "control: a creep (no pathing) doesn't count");
  assert.equal(left({}, [{ id: "ratf", player: 27, position: [MID + 300, MID, 0] }]), true, "an item (not a unit type) counts");
  assert.equal(left({ terrain: flat(17, (c, x) => { if (x === 11) c.layer = 3; }) }), true, "a cliff 384 away");
  assert.equal(left({ terrain: flat(17, (c, x) => { if (x === 12) c.ramp = true; }) }), true, "a ramp");
  assert.equal(left({ terrain: flat(17, (c, x, y) => { if (x === 9 && y === 9) c.blight = true; }) }), true, "blight");
  assert.equal(left({ terrain: flat(17, (c, x, y) => { if (x === 10 && y === 8) c.texture = 1; }) }), true, "an unbuildable tile");
  assert.equal(left({ terrain: flat(17, (c, x) => { if (x === 4) { c.hasWater = true; c.water = 50; } }) }), true, "water");
  assert.equal(left({ terrain: flat(17, (c) => { c.hasWater = true; }) }), false, "control: the water flag with the surface below the ground");
  assert.equal(left({ terrain: flat(9) }), true, "close to the map's edge");
  assert.equal(left({ terrain: flat(17, (c, x) => { if (x === 0) c.layer = 3; }) }), false, "control: a cliff far away doesn't count");
  // Not known.
  assert.equal(left({ constantsKnown: false }), true, "gameplay constants unreadable");
  assert.equal(left({ defaultTriggers: undefined }), true, "triggers not read");
  assert.equal(left({ around: null }), true, "doodads or the game's tables not known");
  assert.equal(left({ terrain: null }), true, "ground not known");
  assert.equal(left({ customData: undefined }), true, "object data not looked at");
  assert.equal(meleeAfterSave({ flags: OFF }, [], clean()).flags, OFF, "no start location");
  assert.equal(meleeAfterSave({ flags: OFF }, [startMid, { id: "ngol", player: 27 }], clean()).flags, OFF, "a unit without a position");
});

test("the facts for putting the flag back come from the project; unreadable ones leave it", async () => {
  const t = flat();
  const units = [startMid];
  const doo = (list: { position: number[] }[], specials: object[] = []) => JSON.stringify({ doodads: list, specials });
  const project = (own: Record<string, string | Uint8Array | Error> = {}) => ({
    ...files({ "map/war3map.w3e": writeW3e(t), "map/war3map.wtg.json": writeWtgJson(defaultTriggerFile("x")), "map/war3map.doo.json": doo([{ position: [MID + 600, MID, 0] }]), ...own }),
    gameText: async (p: string) => { if (!(p in GAME)) throw new Error(p); return GAME[p]; },
  });
  const flags = async (ws: MeleeFiles) => (await savedMelee(ws, { flags: OFF }, units)).flags;
  assert.equal(await flags(project()), MELEE, "everything known and met");
  assert.equal(await flags(project({ "map/war3map.wtg.json": "", "map/war3map.wtg": defaultWtg("x") })), OFF, "an empty trigger JSON wins over the raw file");
  const rawOnly = { ...files({ "map/war3map.w3e": writeW3e(t), "map/war3map.wtg": defaultWtg("x"), "map/war3map.doo.json": doo([]) }), gameText: async (p: string) => GAME[p] };
  assert.equal(await flags(rawOnly), MELEE, "a raw default war3map.wtg");
  const renamed = defaultTriggerFile("x");
  renamed.items.find((i) => i.type === 8)!.name = "Mine";
  assert.equal(await flags(project({ "map/war3map.wtg.json": writeWtgJson(renamed) })), OFF, "custom triggers");
  assert.equal(await flags(project({ "map/war3map.wtg.json": new Error("EACCES") })), OFF, "triggers unreadable");
  assert.equal(await flags(project({ "map/war3map.w3u.json": "{}" })), OFF, "custom unit data");
  assert.equal(await flags(project({ "map/war3mapSkin.txt": "" })), OFF, "a custom game interface");
  assert.equal(await flags(project({ "map/war3mapMisc.txt": new Error("EACCES") })), OFF, "gameplay constants unreadable");
  assert.equal(await flags(project({ "map/war3mapMisc.txt": "" })), MELEE, "control: an empty war3mapMisc.txt sets none");
  assert.equal(await flags(project({ "map/war3map.doo.json": doo([{ position: [MID + 150, MID, 0] }]) })), OFF, "a tree close by");
  assert.equal(await flags(project({ "map/war3map.doo.json": doo([], [{ id: "DTg1", x: 9, y: 8, z: 0 }]) })), OFF, "a special doodad close by");
  assert.equal(await flags(project({ "map/war3map.doo.json": "{" })), OFF, "doodads unreadable");
  const noDoo = project();
  assert.equal(await flags({ ...noDoo, files: () => noDoo.files().filter((f) => !f.path.endsWith(".doo.json")) }), OFF, "no doodad file");
  assert.equal(await flags({ ...project(), gameText: undefined }), OFF, "no game to read the tables from");
  assert.equal(await flags({ ...project(), gameText: async (p: string) => (p === "Units\\UnitData.slk" ? UNIT_SLK : "") }), OFF, "an empty Terrain.slk");
  assert.equal(await flags({ ...project(), gameText: async (p: string) => (p === "Units\\UnitData.slk" ? "" : TERRAIN_SLK) }), OFF, "an empty UnitData.slk");
  const creep = { id: "nftk", player: 24, position: [MID + 100, MID, 0] }, tavern = { ...creep, id: "ntav" };
  assert.equal((await savedMelee(project(), { flags: OFF }, [...units, creep])).flags, MELEE, "a creep close by, as UnitData.slk tells");
  assert.equal((await savedMelee(project(), { flags: OFF }, [...units, tavern])).flags, OFF, "a tavern close by");
  // A map that is melee reads only what taking it off needs.
  const on = project();
  await savedMelee(on, { flags: MELEE }, units);
  assert.deepEqual(on.reads.filter((p) => !p.endsWith(".w3e")), []);
});
