import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultTriggerFile, defaultWtg } from "../triggers/defaults";
import { writeWtgJson } from "../triggers/wtg";
import { meleeAfterSave, meleeSetBlockers, readMeleeFacts, savedMelee, startPathing, startsPastPlayable, startsPlainlyValid, startsUnderWater, validStartPlace, type MeleeFacts, type MeleeFiles } from "./meleesave";
import { NO_WALK, type PathingStamp } from "./pathing";
import { markMapEdge, writeW3e, type Corner, type Terrain } from "./w3e";

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

test("a start on a tile past the playable map is in an invalid position; one on the playable edge isn't", () => {
  const t = lake(["....", "....", "....", "...."]);
  // The rightmost tile column is past the playable map (its lower left corners carry the map-edge bit).
  markMapEdge(t, [0, 1, 0, 0]);
  assert.equal(startsPastPlayable(t, [start(320, 64)]), true, "in the marked column");
  assert.equal(startsPastPlayable(t, [start(256, 64)]), false, "on the playable edge: inside");
  assert.equal(startsPastPlayable(t, [start(200, 64)]), false, "control: inside");
  assert.equal(startsPastPlayable(t, [start(-10, 64)]), true, "off the map");
  assert.equal(startsPastPlayable(t, [{ id: "hfoo", player: 0, position: [320, 64, 0] }]), false, "only start locations count");
  // we-drive 2026-11-14: a start left 768 past the playable edge by a Map Size cut took Melee off at the save.
  assert.deepEqual(meleeAfterSave({ flags: MELEE }, [start(320, 64)], { customConstants: false, terrain: t }), { flags: MELEE & ~4, reasons: ["Start locations are in invalid positions"] });
  assert.ok(meleeSetBlockers({ flags: MELEE & ~4 }, [start(320, 64)], { customConstants: false, terrain: t }).includes("Start locations are in invalid positions"), "nor put back on");
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
  assert.deepEqual(none, { customConstants: false, terrain: null, customData: false, triggersKnown: true });
  // A melee map with custom triggers loses its flag (the World Editor's save does: melee-flag-we); without them, or
  // with a trigger file nobody can read, it keeps it.
  const two = defaultTriggerFile("x");
  two.items.push({ ...structuredClone(two.items.find((i) => i.type === 8)!), name: "Second", id: 0x03000001 } as never);
  const keptWith = async (own: Record<string, string | Uint8Array | Error>) => (await savedMelee(files(own), { flags: MELEE }, [], null)).flags;
  assert.equal(await keptWith({ "map/war3map.wtg.json": writeWtgJson(defaultTriggerFile("x")) }), MELEE, "control: the default triggers");
  assert.equal(await keptWith({ "map/war3map.wtg.json": writeWtgJson(two) }), OFF, "a second trigger");
  assert.equal(await keptWith({ "map/war3map.wtg.json": new Error("EACCES") }), MELEE, "triggers unreadable");
  assert.equal(await keptWith({}), MELEE, "no trigger file");
  const broken = await readMeleeFacts(files({ "map/war3mapMisc.txt": new Error("EACCES"), "map/war3map.w3e": new Uint8Array([1, 2, 3]) }));
  assert.deepEqual(broken, { customConstants: false, terrain: null, customData: false, triggersKnown: true }, "unreadable: not known, so the flag stays");
  assert.equal((await readMeleeFacts(files({ "map/war3map.wtg.json": new Error("EACCES") }))).triggersKnown, undefined, "triggers unreadable: not known");
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
/** Doodads.slk: a flower (no pathing), a rock (4 × 4), a cave (special doodad, 4 × 4); DestructableData.slk: a cage
 *  (empty), a tree (4 × 4). */
const DOODADS_SLK = 'ID;PWXL;N;E\nC;Y1;X1;K"doodID"\nC;X2;K"pathTex"\nC;Y2;X1;K"APms"\nC;X2;K"none"\nC;Y3;X1;K"LOrk"\nC;X2;K"PathTextures\\4x4Default.tga"\nC;Y4;X1;K"DTg1"\nC;X2;K"PathTextures\\4x4Default.tga"\nE\n';
const DESTS_SLK = 'ID;PWXL;N;E\nC;Y1;X1;K"DestructableID"\nC;X2;K"pathTex"\nC;Y2;X1;K"YTc1"\nC;X2;K""\nC;Y3;X1;K"LTlt"\nC;X2;K"PathTextures\\4x4Default.tga"\nE\n';
const GAME: Record<string, string> = { "TerrainArt\\Terrain.slk": TERRAIN_SLK, "Doodads\\Doodads.slk": DOODADS_SLK, "Units\\DestructableData.slk": DESTS_SLK };
/** An uncompressed 24-bit TGA of n × n white pixels: a pathing texture that blocks everything. */
function tga(n: number): Uint8Array {
  const b = new Uint8Array(18 + n * n * 3).fill(255);
  b.set([0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, n, 0, n, 0, 24, 0]);
  return b;
}
const GAME_FILES: Record<string, Uint8Array> = { "PathTextures\\4x4Default.tga": tga(4) };
const gameBytes = async (p: string) => { if (!(p in GAME_FILES)) throw new Error(`not found: ${p}`); return GAME_FILES[p]; };
const RULES = new Map([["Ldrt", { walkable: true, buildable: true, flyable: true }], ["Lrok", { walkable: true, buildable: false, flyable: true }]]);
/** A 4 × 4 pathing texture (a tree) at x, y. */
const tree = (x: number, y: number): PathingStamp => ({ x, y, angle: 0, width: 4, height: 4, rgba: new Uint8Array(64).fill(255) });
/** The start locations' surroundings on `t`: its pathing with `stamps`, and doodads of unknown pathing. */
const around = (t: Terrain, stamps: PathingStamp[] = [], unknown: { x: number; y: number }[] = []) => ({ pathing: startPathing(t, RULES, stamps), unknown });
const OFF = MELEE & ~4;
/** The middle of flat()'s map (corner 8, cell 32), and a start there. */
const MID = 8 * 128, startMid = start(MID, MID);
/** Everything known, nothing in the way; `t` the ground, `stamps` what stands on it. */
const clean = (t = flat(), stamps: PathingStamp[] = [], unknown: { x: number; y: number }[] = []): MeleeFacts =>
  ({ customConstants: false, terrain: t, constantsKnown: true, customData: false, defaultTriggers: true, around: around(t, stamps, unknown) });

test("the flag goes back on when Studio can tell every rule is met", () => {
  const placed = [startMid, { id: "ngol", player: 27, position: [MID + 750, MID, 0] }];
  assert.deepEqual(meleeSetBlockers({ flags: OFF }, placed, clean()), []);
  assert.deepEqual(meleeAfterSave({ flags: OFF }, placed, clean()), { flags: MELEE, reasons: [] });
  // What the World Editor's save measured as valid (tests/we-compare/melee-valid-we.json), each alone.
  const on = (facts: MeleeFacts, more: object[] = []) => meleeAfterSave({ flags: OFF }, [startMid, ...more] as never[], facts).flags === MELEE;
  assert.ok(on(clean(flat(), [tree(MID + 320, MID)])), "a tree 320 away: its cells touch the square");
  assert.ok(on(clean(flat(), [tree(MID - 320, MID)])), "a tree 320 to the west");
  assert.ok(on(clean(flat(), [tree(MID + 320, MID + 256)])), "a tree at (320, 256)");
  assert.ok(on(clean(), [{ id: "ngol", player: 27, position: [MID + 530.5, MID + 530.5, 0] }]), "a gold mine 750.2 away on the diagonal");
  assert.ok(on(clean(), [{ id: "ntav", player: 24, position: [MID, MID, 0] }]), "a tavern on the start: other units don't count");
  assert.ok(on(clean(), [{ id: "ratc", player: 27, position: [MID + 64, MID, 0] }]), "an item 64 away");
  for (const [dx, dy] of [[496, 0], [504, 0], [512, 0], [512, 480], [-504, 0]]) assert.ok(on(clean(), [{ ...start(MID + dx, MID + dy), player: 1 }]), `another start at (${dx}, ${dy}): rounded to the cells, the squares don't overlap`);
  assert.ok(on(clean(flat(17, (c, x) => { if (x >= 9) c.blight = true; }))), "blight from 128 away");
  assert.ok(on(clean(flat(17, (c, x) => { if (x >= 11) c.texture = 1; }))), "Lrok from corner 11: its cells from 320");
  assert.ok(on(clean(flat(17, (c, x) => { if (x >= 11) c.layer = 3; }))), "a cliff up at corner 11: its cells from 256");
  assert.ok(on(clean(flat(17, (c, x) => { if (x >= 11) { c.hasWater = true; c.water = 25; } }))), "shallow water from corner 11");
  assert.ok(on(clean(flat(), [], [{ x: MID + 768, y: MID }])), "a doodad of unknown pathing 768 away");
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
  // Start locations in invalid positions, as the World Editor's save measured them (melee-valid-we.json): a cell of the
  // start's 16 × 16 square (cells 24..39 here) not buildable, another start's square overlapping, a mine within 750.
  const at = (t: Terrain, stamps: PathingStamp[] = []) => ({ terrain: t, around: around(t, stamps) });
  assert.equal(left(at(flat(), [tree(MID + 256, MID)])), true, "a tree 256 away");
  assert.equal(left(at(flat(), [tree(MID - 256, MID)])), true, "a tree 256 to the west");
  assert.equal(left(at(flat(), [tree(MID + 256, MID + 256)])), true, "a tree at (256, 256): a square, not a circle");
  assert.equal(left({}, [{ id: "ngol", player: 27, position: [MID + 749, MID, 0] }]), true, "a gold mine 749 away");
  assert.equal(left({}, [{ id: "ngol", player: 27, position: [MID + 528, MID + 528, 0] }]), true, "a gold mine 746.7 away on the diagonal");
  assert.equal(left({}, [{ ...start(MID + 488, MID), player: 1 }]), true, "another start 488 away (cell 15)");
  assert.equal(left({}, [{ ...start(MID + 480, MID + 480), player: 1 }]), true, "another start at (480, 480)");
  assert.equal(left({}, [{ ...start(MID - 496, MID), player: 1 }]), true, "another start 496 to the west: halves round up, to cell 17");
  assert.equal(left({}, [{ id: "nftk", player: 24, position: [MID + 12, MID, 0] }]), false, "control: a creep doesn't count");
  assert.equal(left(at(flat(17, (c, x) => { if (x >= 10) c.layer = 3; }))), true, "a cliff up at corner 10: its cells from 128");
  assert.equal(left(at(flat(17, (c, x) => { if (x >= 10) c.texture = 1; }))), true, "Lrok from corner 10: its cells from 192");
  assert.equal(left(at(flat(17, (c, x) => { if (x >= 10) { c.hasWater = true; c.water = 25; } }))), true, "shallow water from corner 10: the shore's cells from 192");
  assert.equal(left(at(flat(17, (c, x) => { if (x === 7) { c.hasWater = true; c.water = 50; } }))), true, "a line of water 128 away");
  assert.equal(left(at(flat(17, (c) => { c.hasWater = true; }))), false, "control: the water flag with the surface below the ground");
  assert.equal(left(at(flat(17, (c, x, y) => { if (x === 9 && y === 9) c.boundary = true; }))), true, "Boundary painted on the square");
  assert.equal(left(at(flat(9))), true, "the square past the map's edge");
  const edged = flat();
  markMapEdge(edged, [0, 7, 0, 0]);
  assert.equal(left(at(edged)), true, "the square on tiles past the playable map (from tile 9)");
  const edgedFar = flat();
  markMapEdge(edgedFar, [0, 6, 0, 0]);
  assert.equal(left(at(edgedFar)), false, "control: from tile 10, outside the square");
  assert.equal(left(at(flat(17, (c, x) => { if (x === 0) c.layer = 3; }))), false, "control: a cliff far away doesn't count");
  assert.equal(left({ around: { ...around(flat()), unknown: [{ x: MID + 700, y: MID - 700 }] } }), true, "a doodad of unknown pathing within reach");
  assert.equal(left({ around: { pathing: new Uint8Array(16) } }), true, "a pathing map of another size");
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
  const doo = (list: { id?: string; position: number[] }[], specials: object[] = []) => JSON.stringify({ doodads: list, specials });
  const project = (own: Record<string, string | Uint8Array | Error> = {}) => ({
    ...files({ "map/war3map.w3e": writeW3e(t), "map/war3map.wtg.json": writeWtgJson(defaultTriggerFile("x")), "map/war3map.doo.json": doo([{ id: "LTlt", position: [MID + 600, MID, 0] }]), ...own }),
    gameText: async (p: string) => { if (!(p in GAME)) throw new Error(p); return GAME[p]; },
    gameBytes,
  });
  const flags = async (ws: MeleeFiles) => (await savedMelee(ws, { flags: OFF }, units)).flags;
  assert.equal(await flags(project()), MELEE, "everything known and met");
  assert.equal(await flags(project({ "map/war3map.wtg.json": "", "map/war3map.wtg": defaultWtg("x") })), OFF, "an empty trigger JSON wins over the raw file");
  const rawOnly = { ...files({ "map/war3map.w3e": writeW3e(t), "map/war3map.wtg": defaultWtg("x"), "map/war3map.doo.json": doo([]) }), gameText: async (p: string) => GAME[p], gameBytes };
  assert.equal(await flags(rawOnly), MELEE, "a raw default war3map.wtg");
  const renamed = defaultTriggerFile("x");
  renamed.items.find((i) => i.type === 8)!.name = "Mine";
  assert.equal(await flags(project({ "map/war3map.wtg.json": writeWtgJson(renamed) })), OFF, "custom triggers");
  assert.equal(await flags(project({ "map/war3map.wtg.json": new Error("EACCES") })), OFF, "triggers unreadable");
  assert.equal(await flags(project({ "map/war3map.w3u.json": JSON.stringify({ custom: [{ id: "h000" }] }) })), OFF, "custom unit data");
  assert.equal(await flags(project({ "map/war3mapSkin.txt": "[Misc]\r\nFoo=1\r\n" })), OFF, "a custom game interface");
  assert.equal(await flags(project({ "map/war3mapMisc.txt": new Error("EACCES") })), OFF, "gameplay constants unreadable");
  assert.equal(await flags(project({ "map/war3mapMisc.txt": "" })), MELEE, "control: an empty war3mapMisc.txt sets none");
  assert.equal(await flags(project({ "map/war3map.doo.json": doo([{ id: "LTlt", position: [MID + 256, MID, 0] }]) })), OFF, "a tree 256 away");
  assert.equal(await flags(project({ "map/war3map.doo.json": doo([{ id: "LTlt", position: [MID + 320, MID, 0] }]) })), MELEE, "control: a tree 320 away");
  assert.equal(await flags(project({ "map/war3map.doo.json": doo([], [{ id: "DTg1", x: 9, y: 8, z: 0 }]) })), OFF, "a special doodad on the square");
  assert.equal(await flags(project({ "map/war3map.doo.json": doo([], [{ id: "DTg1", x: 13, y: 8, z: 0 }]) })), MELEE, "control: a special doodad beside it");
  assert.equal(await flags(project({ "map/war3map.doo.json": doo([], [{ id: "Xzzz", x: 13, y: 8, z: 0 }]) })), OFF, "a special doodad of a type the tables don't have");
  assert.equal(await flags(project({ "map/war3map.doo.json": "{" })), OFF, "doodads unreadable");
  assert.equal(await flags(project({ "map/war3map.doo.json": doo([{ id: "LTlt", position: [MID + 600, Number.NaN, 0] }]) })), OFF, "a doodad without a position");
  const noDoo = project();
  assert.equal(await flags({ ...noDoo, files: () => noDoo.files().filter((f) => !f.path.endsWith(".doo.json")) }), OFF, "no doodad file");
  assert.equal(await flags({ ...project(), gameText: undefined }), OFF, "no game to read the tables from");
  assert.equal(await flags({ ...project(), gameText: async (p: string) => (p === "TerrainArt\\Terrain.slk" ? "" : GAME[p]) }), OFF, "an empty Terrain.slk");
  // A doodad whose pathing can't be told (its type or texture unknown) counts within reach of a start, and only there.
  assert.equal(await flags({ ...project(), gameText: async (p: string) => (p === "Units\\DestructableData.slk" ? "" : GAME[p]) }), OFF, "the tree's type unknown, 600 away");
  assert.equal(await flags({ ...project(), gameBytes: undefined }), OFF, "no game to read the pathing texture from");
  assert.equal(await flags({ ...project(), gameBytes: async () => { throw new Error("EIO"); } }), OFF, "the texture unreadable");
  const far = project({ "map/war3map.doo.json": doo([{ id: "LTlt", position: [MID + 800, MID, 0] }]) });
  assert.equal(await flags({ ...far, gameBytes: undefined }), MELEE, "a texture that can't be read 800 away doesn't count");
  const creep = { id: "nftk", player: 24, position: [MID + 100, MID, 0] }, tavern = { ...creep, id: "ntav" };
  assert.equal((await savedMelee(project(), { flags: OFF }, [...units, creep])).flags, MELEE, "a creep close by");
  assert.equal((await savedMelee(project(), { flags: OFF }, [...units, tavern])).flags, MELEE, "a tavern close by: buildings don't count");
  assert.equal((await savedMelee(project(), { flags: OFF }, [...units, { ...creep, id: "ngol", position: [MID + 700, MID, 0] }])).flags, OFF, "a gold mine 700 away");
  // A map that is melee reads what taking it off needs: the ground, the triggers and what stands round the starts.
  const on = project();
  await savedMelee(on, { flags: MELEE }, units);
  assert.deepEqual(on.reads.filter((p) => !p.endsWith(".w3e")), ["map/war3map.wtg.json", "map/war3map.doo.json"]);
  // Custom triggers take it off anyway: the doodads aren't read.
  const custom = project({ "map/war3map.wtg.json": writeWtgJson(renamed) });
  await savedMelee(custom, { flags: MELEE }, units);
  assert.deepEqual(custom.reads.filter((p) => !p.endsWith(".w3e")), ["map/war3map.wtg.json"]);
});

test("a melee map loses the flag when a start is surely in an invalid position, and keeps it where Studio can't tell", async () => {
  // we-drive 2026-11-17 (tests/we-compare/melee-valid-we.json melee-valid-melee-tree-256): the tree of tree-256 on a
  // map that is melee: the World Editor's save takes Melee off.
  const kept = (facts: Partial<MeleeFacts>, more: object[] = []) => meleeAfterSave({ flags: MELEE }, [startMid, ...more] as never[], { ...clean(), ...facts });
  const at = (t: Terrain, stamps: PathingStamp[] = [], unknown: { x: number; y: number }[] = []) => ({ terrain: t, around: around(t, stamps, unknown) });
  const INVALID = { flags: OFF, reasons: ["Start locations are in invalid positions"] };
  assert.deepEqual(kept({}), { flags: MELEE, reasons: [] }, "control: nothing near");
  assert.deepEqual(kept(at(flat(), [tree(MID + 256, MID)])), INVALID, "a tree 256 away");
  assert.deepEqual(kept(at(flat(), [tree(MID + 320, MID)])), { flags: MELEE, reasons: [] }, "control: a tree 320 away");
  assert.deepEqual(kept({}, [{ id: "ngol", player: 27, position: [MID + 749, MID, 0] }]), INVALID, "a gold mine 749 away");
  assert.deepEqual(kept({}, [{ ...start(MID + 488, MID), player: 1 }]), INVALID, "another start 488 away");
  assert.deepEqual(kept(at(flat(17, (c, x) => { if (x >= 10) c.texture = 1; }))), INVALID, "Lrok from corner 10");
  assert.deepEqual(kept(at(flat(9))), INVALID, "the square past the map's edge");
  // Surely invalid wins over what can't be told elsewhere.
  assert.deepEqual(kept(at(flat(), [tree(MID + 256, MID)], [{ x: MID + 100, y: MID }]), [{ id: "ngol", player: 27 }]), INVALID, "a tree 256 away beside unknowns");
  // Not known: kept.
  assert.equal(kept(at(flat(), [], [{ x: MID + 100, y: MID }])).flags, MELEE, "a doodad of unknown pathing on the square");
  assert.equal(kept({ around: null }).flags, MELEE, "the surroundings unreadable");
  assert.equal(kept({ around: undefined }).flags, MELEE, "the surroundings not read");
  assert.equal(kept({ around: { pathing: new Uint8Array(16) } }).flags, MELEE, "a pathing map of another size");
  const walk = around(flat());
  walk.pathing[16 + (MID / 32) * 64 + MID / 32 + 2] = NO_WALK;
  assert.equal(kept({ around: walk }).flags, MELEE, "a cell only unwalkable (not measured alone)");
  assert.equal(meleeAfterSave({ flags: OFF }, [startMid], { ...clean(), around: walk }).flags, OFF, "nor put back on");
  // From the project, as a save reads it.
  const project = (doodads: object[]) => ({
    ...files({ "map/war3map.w3e": writeW3e(flat()), "map/war3map.doo.json": JSON.stringify({ doodads, specials: [] }) }),
    gameText: async (p: string) => { if (!(p in GAME)) throw new Error(p); return GAME[p]; },
    gameBytes,
  });
  const saved = async (doodads: object[], ws: MeleeFiles = project(doodads)) => savedMelee(ws, { flags: MELEE }, [startMid]);
  assert.deepEqual(await saved([{ id: "LTlt", position: [MID + 256, MID, 0] }]), INVALID, "a tree 256 away in war3map.doo.json");
  assert.equal((await saved([{ id: "LTlt", position: [MID + 320, MID, 0] }])).flags, MELEE, "control: 320 away");
  assert.equal((await saved([], { ...project([{ id: "LTlt", position: [MID + 256, MID, 0] }]), gameText: undefined })).flags, MELEE, "without the game's tables: kept");
  assert.equal((await saved([], { ...project([{ id: "LTlt", position: [MID + 256, MID, 0] }]), gameBytes: undefined })).flags, MELEE, "pathing texture unreadable: kept");
});

test("doodads and destructables without a pathing texture (flowers) near a start don't block the flag", async () => {
  // Doodads.slk: a flower (no pathing) and a rock (pathing); DestructableData.slk: a cage (empty) and a tree (pathing).
  const near = (id: string) => ({ id, position: [MID + 150, MID, 0] });
  const flags = async (doodads: object[], tables = GAME) => (await savedMelee({
    ...files({ "map/war3map.w3e": writeW3e(flat()), "map/war3map.wtg.json": writeWtgJson(defaultTriggerFile("x")), "map/war3map.doo.json": JSON.stringify({ doodads, specials: [] }) }),
    gameText: async (p: string) => { if (!(p in tables)) throw new Error(p); return tables[p]; },
    gameBytes,
  }, { flags: OFF }, [startMid])).flags;
  assert.equal(await flags([near("APms")]), MELEE, "a flower 150 away");
  assert.equal(await flags([near("YTc1")]), MELEE, "a destructable with an empty pathing texture");
  assert.equal(await flags([near("APms"), near("YTc1")]), MELEE, "both");
  assert.equal(await flags([near("LOrk")]), OFF, "control: a rock with pathing");
  assert.equal(await flags([near("LTlt")]), OFF, "control: a tree with pathing");
  assert.equal(await flags([near("Xzzz")]), OFF, "a type the tables don't have counts");
  const { "Doodads\\Doodads.slk": _, ...noDoodads } = GAME;
  assert.equal(await flags([near("APms")], noDoodads), OFF, "without Doodads.slk the flower counts");
  assert.equal(await flags([near("APms"), near("LOrk")]), OFF, "a flower doesn't hide a rock");
});

test("with the custom tilesets flag 0 the start's ground is buildable by the tile drawn, the tileset's own list", async () => {
  // Terrain.slk's Lordaeron tiles are Ldrt (buildable), Lrok (not). The file lists them the other way round: with
  // the flag 0 slot 0 is drawn as Ldrt, the tileset's first, whatever the file says (w3e.ts drawnGroundTiles).
  const saved = async (custom: number) => {
    const t = flat();
    t.groundTiles = ["Lrok", "Ldrt"];
    t.customTilesetsRaw = custom;
    t.customTilesets = custom !== 0;
    const ws = { ...files({ "map/war3map.w3e": writeW3e(t), "map/war3map.wtg.json": writeWtgJson(defaultTriggerFile("x")), "map/war3map.doo.json": JSON.stringify({ doodads: [], specials: [] }) }),
      gameText: async (p: string) => GAME[p] };
    return (await savedMelee(ws, { flags: OFF }, [startMid])).flags;
  };
  assert.equal(await saved(0), MELEE, "drawn as Ldrt: buildable");
  // (custom tilesets on also sets w3i flag 0x0008: tilesetflag.ts)
  assert.equal(await saved(1), OFF | 0x0008, "control: with the flag set the file's Lrok, not buildable");
});

test("custom object data and interface files count only when they change something, in both directions", async () => {
  const t = flat();
  const entry = JSON.stringify({ original: [{ base: "hfoo", mods: [] }], custom: [] });
  const header = (originals: number, customs: number) => { const b = new Uint8Array(12); const v = new DataView(b.buffer); v.setUint32(0, 2, true); v.setUint32(4, originals, true); v.setUint32(8, customs, true); return b; };
  const empty: [string, string | Uint8Array][] = [];
  for (const ext of ["w3u", "w3t", "w3b", "w3d", "w3a", "w3h", "w3q"]) {
    empty.push([`map/war3map.${ext}.json`, JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [], custom: [] })], [`map/war3map.${ext}`, header(0, 0)]);
  }
  empty.push(["map/war3map.w3u.json", "{}"], ["map/war3mapSkin.txt", ""], ["map/war3mapSkin.txt", "// nothing\r\n[Misc]\r\n"]);
  const base = { "map/war3map.w3e": writeW3e(t), "map/war3map.wtg.json": writeWtgJson(defaultTriggerFile("x")), "map/war3map.doo.json": JSON.stringify({ doodads: [], specials: [] }) };
  const project = (own: Record<string, string | Uint8Array | Error>) => ({ ...files({ ...base, ...own }), gameText: async (p: string) => { if (!(p in GAME)) throw new Error(p); return GAME[p]; } });
  const units = [startMid];
  const putBack = async (own: Record<string, string | Uint8Array | Error>) => (await savedMelee(project(own), { flags: OFF }, units)).flags;
  const kept = async (own: Record<string, string | Uint8Array | Error>) => (await savedMelee(project(own), { flags: MELEE }, units));
  for (const [path, body] of empty) {
    assert.equal(await putBack({ [path]: body }), MELEE, `${path} without entries doesn't keep the flag off`);
    assert.equal((await kept({ [path]: body })).flags, MELEE, `${path} without entries doesn't take it off`);
  }
  const changing: [string, string | Uint8Array][] = [
    ["map/war3map.w3t.json", entry], ["map/war3map.w3u", header(1, 0)], ["map/war3map.w3q", header(0, 2)], ["map/war3mapSkin.txt", "[Misc]\nA=1"],
    ["map/war3map.w3b.json", JSON.stringify({ custom: [{ id: "B000" }] })],
  ];
  for (const [path, body] of changing) {
    assert.equal(await putBack({ [path]: body }), OFF, `${path} with entries: stays off`);
    const r = await kept({ [path]: body });
    assert.equal(r.flags, OFF, `${path} with entries takes the flag off`);
    assert.ok(r.reasons.includes("Custom object data or game interface"), path);
  }
  // Not known: the flag is never put back, and never taken off by it.
  for (const bad of ["{", "[]", '{"custom":3}']) {
    assert.equal(await putBack({ "map/war3map.w3u.json": bad }), OFF, `unreadable ${bad}: not put back`);
    assert.equal((await kept({ "map/war3map.w3u.json": bad })).flags, MELEE, `unreadable ${bad}: not taken off`);
  }
  assert.equal(await putBack({ "map/war3map.w3u.json": new Error("EACCES") }), OFF, "unreadable file: not put back");
  assert.equal((await kept({ "map/war3map.w3u.json": new Error("EACCES") })).flags, MELEE, "unreadable file: not taken off");
  assert.equal(await putBack({ "map/war3map.w3u": new Uint8Array(5) }), OFF, "a short raw file");
});

test("a save sets flag 0x4000 for a placed tavern and clears it without one (tftflag.ts)", async () => {
  // we-drive 2026-11-17, tests/we-compare/tft-flag-we.json tft-tavern, tft-clear.
  const units = 'ID;PWXL;N;E\nC;Y1;X1;K"unitID"\nC;X2;K"version"\nC;Y2;X1;K"ntav"\nC;X2;K1\nC;Y3;X1;K"nfrp"\nC;X2;K0\nE\n';
  const items = 'ID;PWXL;N;E\nC;Y1;X1;K"itemID"\nC;X2;K"version"\nC;Y2;X1;K"ratc"\nC;X2;K0\nE\n';
  const tables: Record<string, string> = { ...GAME, "Units\\UnitData.slk": units, "Units\\ItemData.slk": items };
  const ws = { ...files({ "map/war3map.w3e": writeW3e(flat()), "map/war3map.doo.json": JSON.stringify({ doodads: [], specials: [] }) }),
    gameText: async (p: string) => { if (!(p in tables)) throw new Error(p); return tables[p]; }, gameBytes };
  const TFT = 0x4000;
  const tavern = { id: "ntav", player: 27, position: [MID + 2000, MID, 0] }, frog = { ...tavern, id: "nfrp" };
  const M = MELEE & ~TFT;
  assert.equal((await savedMelee(ws, { flags: M }, [startMid, tavern])).flags, M | TFT, "a tavern sets it");
  assert.equal((await savedMelee(ws, { flags: M | TFT }, [startMid, frog])).flags, M, "a frog of version 0 clears it");
  assert.equal((await savedMelee(ws, { flags: M }, [startMid, frog])).flags, M, "control: a frog leaves it off");
});

test("a start Map Size took off the map goes to the nearest plainly valid place on the 64 grid", () => {
  /** Whether the start at p is plainly valid among `others` (startsPlainlyValid: the oracle), and no grid point nearer to
   *  `from` is: the answer is the nearest valid place. */
  const nearest = (t: Terrain, from: [number, number], others: { id: string; player?: number; position?: number[] }[], a: ReturnType<typeof around>, p: [number, number] | null) => {
    assert.ok(p, "a place is found");
    assert.equal(p[0] % 64, 0); assert.equal(p[1] % 64, 0);
    assert.ok(startsPlainlyValid(t, [...others, start(p[0], p[1])], a), `${p} is valid`);
    const d = Math.hypot(p[0] - from[0], p[1] - from[1]);
    for (let y = 0; y <= (t.height - 1) * 128; y += 64) for (let x = 0; x <= (t.width - 1) * 128; x += 64) {
      if (Math.hypot(x - from[0], y - from[1]) < d) assert.equal(startsPlainlyValid(t, [...others, start(x, y)], a), false, `${x},${y} is nearer and valid`);
    }
  };
  const t = flat();
  assert.deepEqual(validStartPlace(t, [MID, MID], [], around(t)), [MID, MID], "a valid grid point is its own answer");
  // Off the map to the east: the square has to fit inside it (cells up to 64).
  assert.deepEqual(validStartPlace(t, [3000, MID], [], around(t)), [1792, MID]);
  // Unbuildable ground from corner 11 on: the place stays west of it.
  const rock = flat(17, (c, x) => { if (x >= 11) c.texture = 1; });
  const fromEast: [number, number] = [3000, MID];
  nearest(rock, fromEast, [], around(rock), validStartPlace(rock, fromEast, [], around(rock)));
  assert.ok(validStartPlace(rock, fromEast, [], around(rock))![0] < 1408);
  // A gold mine, another start, a tree and a doodad of unknown pathing push it away.
  const mine = [{ id: "ngol", player: 27, position: [1400, MID, 0] }];
  nearest(t, fromEast, mine, around(t), validStartPlace(t, fromEast, mine, around(t)));
  const byMine = validStartPlace(t, fromEast, mine, around(t))!;
  assert.ok(Math.hypot(byMine[0] - 1400, byMine[1] - MID) >= 750);
  const other = [{ ...start(1700, MID), player: 1 }];
  nearest(t, fromEast, other, around(t), validStartPlace(t, fromEast, other, around(t)));
  const trees = around(t, [tree(1600, MID)]);
  nearest(t, fromEast, [], trees, validStartPlace(t, fromEast, [], trees));
  assert.notDeepEqual(validStartPlace(t, fromEast, [], trees), [1792, MID], "control: the tree is in the way of the place without it");
  const unknown = around(t, [], [{ x: 1700, y: MID }]);
  const byUnknown = validStartPlace(t, fromEast, [], unknown)!;
  assert.ok(Math.max(Math.abs(byUnknown[0] - 1700), Math.abs(byUnknown[1] - MID)) >= 768, "a doodad of unknown pathing: kept out of reach");
  nearest(t, fromEast, [], unknown, byUnknown);
  // The tiles past the playable map are no place for it (startPathing blocks them).
  const edged = flat();
  markMapEdge(edged, [2, 2, 2, 2]);
  const p = validStartPlace(edged, fromEast, [], around(edged));
  nearest(edged, fromEast, [], around(edged), p);
  assert.deepEqual(p, [1792 - 256, MID]);
  // Nowhere, or surroundings of another map: null.
  const allRock = flat(17, (c) => { c.texture = 1; });
  assert.equal(validStartPlace(allRock, fromEast, [], around(allRock)), null);
  assert.equal(validStartPlace(t, fromEast, [], around(flat(9))), null, "a pathing map of another size");
});
