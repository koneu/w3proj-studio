import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { toClassicMdx } from "../../lib/model/classic";
import { encodeBlp1Jpeg } from "../../lib/image/encode";
import { parseMdx, type Model } from "../../lib/model/mdx";
import { newTerrain, type NewMapOptions } from "./newmap";
import { loadSkins, withObjectArt, type Placed } from "./objects";
import { doodadTypes, predictShadows, shadowVerdict, specialShadows, type ShadowStats } from "./shadowmap";
import { terrainShadows } from "./shadows";
import { writeDerived } from "./derive";

/** A model of one opaque box, 100 wide and `h` high, standing on its origin. `filterMode` 2 (blended): it casts nothing. */
function towerModel(filterMode = 0, h = 1000): Uint8Array {
  const w = 50;
  const positions: number[] = [];
  for (const z of [0, h]) for (const [x, y] of [[-w, -w], [w, -w], [w, w], [-w, w]]) positions.push(x, y, z);
  // The four sides and the top, two triangles each.
  const quads = [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]];
  const faces = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  const extent = { radius: h, min: [-w, -w, 0] as [number, number, number], max: [w, w, h] as [number, number, number] };
  const model = {
    version: 800, name: "tower", extent, sequences: [], globalSequences: [], textures: [], textureAnims: [], geosetAnims: [],
    materials: [{ priorityPlane: 0, flags: 0, layers: [{ filterMode, shadingFlags: 0, textureIds: [0], textureAnimId: -1, coordId: 0, alpha: 1 }] }],
    geosets: [{
      positions: new Float32Array(positions), normals: new Float32Array(positions.length), uvs: new Float32Array((positions.length / 3) * 2),
      faces: new Uint16Array(faces), vertexGroups: new Uint8Array(positions.length / 3), groups: [[0]], materialId: 0, lod: 0, lodName: "", extent,
    }],
    nodes: [{ name: "root", objectId: 0, parentId: -1, flags: 0, kind: "bone" }], pivots: new Float32Array(3),
    particleEmitters2: [], ribbons: [], skipped: [], warnings: [],
  } as unknown as Model;
  return toClassicMdx(model, () => null);
}

test("doodads the skin table says cast no shadow (shadow=0, as corn) stay out of war3map.shd, and the map's object data decides over it", async () => {
  // DoodadSkins.txt as the game has it: a rock casts, corn doesn't.
  const files: Record<string, string> = {
    "Doodads\\DoodadSkins.txt": "[LOrk]\nfile=Doodads\\Rock\nshadow=1\n[LPcr]\nfile=Doodads\\Corn\nshadow=0",
    "Units\\DestructableSkin.txt": "", "Units\\UnitSkin.txt": "", "Units\\ItemSkin.txt": "", "Units\\UnitData.slk": "ID;P\nE",
  };
  const w3 = { settings: { get: () => "sd-baked-shadow-test" }, game: { readText: async (p: string) => files[p] ?? "" } } as unknown as W3Api;
  const skins = withObjectArt(await loadSkins(w3), [{
    kind: "w3d",
    custom: [{ base: "LPcr", id: "D000", mods: [{ field: "dshd", value: 1 }] }, { base: "LOrk", id: "D001", mods: [{ field: "dshd", value: 0 }] }],
  }]);
  assert.equal(skins.get("LPcr")?.bakesShadow, false);
  assert.equal(skins.get("LOrk")?.bakesShadow, undefined, "shadow=1 casts");

  const terrain = newTerrain({ width: 32, height: 32, tileset: "L", groundTiles: ["Ldrt"], cliffTiles: [], baseTile: "Ldrt", layer: 2, water: "none", noise: false, customTiles: false } as unknown as NewMapOptions);
  const tower = towerModel();
  const asked: string[] = [];
  const read = async (p: string) => {
    asked.push(p);
    if (/\.mdx$/i.test(p)) return tower;
    throw new Error(`no ${p}`);
  };
  const at = (id: string): Placed => ({ id, variation: 0, position: [terrain.offsetX + 16 * 128, terrain.offsetY + 16 * 128, 0], angle: 0, scale: [1, 1, 1] });
  const ground = terrainShadows(terrain);
  const shadowed = (m: Uint8Array) => m.reduce((n, v, i) => n + (v !== ground[i] ? 1 : 0), 0);
  const predict = (id: string) => predictShadows(terrain, [at(id)], skins, () => undefined, read);

  const rock = await predict("LOrk");
  assert.ok(shadowed(rock) > 10, `the rock casts (the control): ${shadowed(rock)} cells`);
  asked.length = 0;
  assert.equal(shadowed(await predict("LPcr")), 0, "corn casts nothing");
  assert.deepEqual(asked, [], "corn's model isn't even read");
  assert.deepEqual(await predict("D000"), rock, "corn whose object data turns its shadow on casts");
  assert.equal(shadowed(await predict("D001")), 0, "a rock whose object data turns it off doesn't");
});

test("a doodad's shadow is baked at its drawn size: defScale (in HD defScale:hd) times the placed scale (we-compare shadow-defscale-*)", async () => {
  const files: Record<string, string> = {
    "Doodads\\DoodadSkins.txt": "[LOrk]\nfile=Doodads\\Rock\nshadow=1\n[ZOfo]\nfile=Doodads\\Rock\nshadow=1\ndefScale:hd=2\n[BRsp]\nfile=Doodads\\Rock\nshadow=1\ndefScale=0.5",
    "Units\\DestructableSkin.txt": "", "Units\\UnitSkin.txt": "", "Units\\ItemSkin.txt": "", "Units\\UnitData.slk": "ID;P\nE",
  };
  const skinsIn = async (mode: string) => loadSkins({ settings: { get: () => mode }, game: { readText: async (p: string) => files[p] ?? "" } } as unknown as W3Api);
  const terrain = newTerrain({ width: 32, height: 32, tileset: "L", groundTiles: ["Ldrt"], cliffTiles: [], baseTile: "Ldrt", layer: 2, water: "none", noise: false, customTiles: false } as unknown as NewMapOptions);
  const tower = towerModel();
  const read = async (p: string) => { if (/\.mdx$/i.test(p)) return tower; throw new Error(`no ${p}`); };
  const at = (id: string, s: number): Placed => ({ id, variation: 0, position: [terrain.offsetX + 16 * 128, terrain.offsetY + 16 * 128, 0], angle: 0, scale: [s, s, s] });
  const predict = async (mode: string, id: string, s: number) => predictShadows(terrain, [at(id, s)], await skinsIn(mode), () => undefined, read, undefined, undefined, () => mode);
  const ground = terrainShadows(terrain);
  const shadowed = (m: Uint8Array) => m.reduce((n, v, i) => n + (v !== ground[i] ? 1 : 0), 0);
  const twice = await predict("hd", "ZOfo", 1);
  assert.deepEqual(twice, await predict("hd", "LOrk", 2), "HD: defScale:hd 2 at scale 1 casts as scale 2");
  assert.ok(shadowed(twice) > shadowed(await predict("hd", "LOrk", 1)), "the control: scale 1 casts less");
  // SD doesn't draw defScale:hd: as placed.
  assert.deepEqual(await predict("sd", "ZOfo", 1), await predict("sd", "LOrk", 1));
  // The plain defScale, in SD and (without defScale:hd) in HD: BRsp's 0.5 at scale 2 casts as scale 1 (we-compare
  // shadow-defscale-sd: the Barrens spires, 0.36, 26 cells where Studio had 200).
  for (const mode of ["sd", "hd"]) {
    const half = await predict(mode, "BRsp", 2);
    assert.deepEqual(half, await predict(mode, "LOrk", 1), `${mode}: defScale 0.5 at scale 2 casts as scale 1`);
    assert.ok(shadowed(half) < shadowed(await predict(mode, "LOrk", 2)), `${mode}: the control, scale 2 casts more`);
  }
});

test("a special doodad's footprint is read from its model: a tall one on flat ground casts, placed in the footprint's middle", async () => {
  const files: Record<string, string> = {
    "Doodads\\DoodadSkins.txt": "[YCr2]\nfile=Doodads\\Terrain\\Cave\nshadow=1",
    "Units\\DestructableSkin.txt": "", "Units\\UnitSkin.txt": "", "Units\\ItemSkin.txt": "", "Units\\UnitData.slk": "ID;P\nE",
  };
  const w3 = { settings: { get: () => "sd-special-shadow-test" }, game: { readText: async (p: string) => files[p] ?? "" } } as unknown as W3Api;
  const skins = await loadSkins(w3);
  const terrain = newTerrain({ width: 32, height: 32, tileset: "L", groundTiles: ["Ldrt"], cliffTiles: [], baseTile: "Ldrt", layer: 2, water: "none", noise: false, customTiles: false } as unknown as NewMapOptions);
  const tower = towerModel();
  const asked: string[] = [];
  const read = async (p: string) => { asked.push(p); if (/\.mdx$/i.test(p)) return tower; throw new Error(`no ${p}`); };
  // Placed by its footprint's bottom-left tile (10, 10), 3 x 3 tiles: the tower (100 wide) stands in the middle tile.
  const specials = specialShadows([{ id: "YCr2", x: 10, y: 10 }], skins, () => ({ width: 12, height: 12 }));
  assert.deepEqual(specials, [{ path: "Doodads\\Terrain\\Cave.mdx", tiles: { x0: 10, y0: 10, x1: 12, y1: 12 } }]);
  const mode = () => "sd-special-shadow-test";
  const ground = terrainShadows(terrain);
  const shd = await predictShadows(terrain, [], skins, () => undefined, read, undefined, undefined, mode, undefined, specials);
  assert.deepEqual(asked, ["Doodads\\Terrain\\Cave.mdx"]);
  // The tower's cells (the middle tile's, cells 44 to 47) stand 1000 high: the cells north-east of it are dark, far.
  const w = (terrain.width - 1) * 4;
  assert.equal(shd[50 * w + 50], 0xff, "next to it");
  assert.equal(shd[70 * w + 70], 0xff, "24 steps off (1000 / (80/3) is 37)");
  assert.equal(shd[46 * w + 46], 0, "its own top is lit");
  assert.equal(shd[40 * w + 40], 0, "south-west of it lit");
  assert.equal(shd.reduce((n, v, i) => n + (v !== ground[i] ? 1 : 0), 0) > 100, true);
  // Without the special the ground is flat and lit.
  assert.deepEqual(await predictShadows(terrain, [], skins, () => undefined, read, undefined, undefined, mode), ground);
});

test("an alpha-tested geoset whose texture is clear casts nothing in HD and whole in Classic, as the editor's calculation", async () => {
  const files: Record<string, string> = {
    "Doodads\\DoodadSkins.txt": "[LOcl]\nfile=Doodads\\ClearPillar\nshadow=1",
    "Units\\DestructableSkin.txt": "", "Units\\UnitSkin.txt": "", "Units\\ItemSkin.txt": "", "Units\\UnitData.slk": "ID;P\nE",
  };
  const w3 = { settings: { get: () => "hd" }, game: { readText: async (p: string) => files[p] ?? "" } } as unknown as W3Api;
  const skins = await loadSkins(w3);
  const terrain = newTerrain({ width: 32, height: 32, tileset: "L", groundTiles: ["Ldrt"], cliffTiles: [], baseTile: "Ldrt", layer: 2, water: "none", noise: false, customTiles: false } as unknown as NewMapOptions);
  // The tower with an alpha-tested (filter mode 1) material on a texture whose alpha is 0 everywhere.
  const model = parseMdx(towerModel(1));
  model.textures = [{ replaceableId: 0, path: "Doodads\\Clear.blp", flags: 0 }];
  const tower = toClassicMdx(model, (i) => model.textures[i].path);
  const clear = encodeBlp1Jpeg(8, 8, new Uint8Array(8 * 8 * 4), 85, { alpha: true });
  const read = async (p: string) => {
    if (/ClearPillar\.mdx$/i.test(p)) return tower;
    if (/Clear\.blp$/i.test(p)) return clear;
    throw new Error(`no ${p}`);
  };
  const at: Placed = { id: "LOcl", variation: 0, position: [terrain.offsetX + 16 * 128, terrain.offsetY + 16 * 128, 0], angle: 0, scale: [1, 1, 1] };
  const ground = terrainShadows(terrain);
  const shadowed = (m: Uint8Array) => m.reduce((n, v, i) => n + (v !== ground[i] ? 1 : 0), 0);
  const predict = (mode: string) => predictShadows(terrain, [at], skins, () => undefined, read, undefined, undefined, () => mode);
  assert.equal(shadowed(await predict("hd")), 0, "HD: the alpha test leaves nothing of the clear texture");
  assert.ok(shadowed(await predict("sd")) > 10, "Classic: the editor casts the geoset whole");
});

test("a model's casting triangles are kept per graphics mode: another mode reads its own model of the same path", async () => {
  const files: Record<string, string> = {
    "Doodads\\DoodadSkins.txt": "[LOpi]\nfile=Doodads\\ModePillar\nshadow=1",
    "Units\\DestructableSkin.txt": "", "Units\\UnitSkin.txt": "", "Units\\ItemSkin.txt": "", "Units\\UnitData.slk": "ID;P\nE",
  };
  const w3 = { settings: { get: () => "hd" }, game: { readText: async (p: string) => files[p] ?? "" } } as unknown as W3Api;
  const skins = await loadSkins(w3);
  const terrain = newTerrain({ width: 32, height: 32, tileset: "L", groundTiles: ["Ldrt"], cliffTiles: [], baseTile: "Ldrt", layer: 2, water: "none", noise: false, customTiles: false } as unknown as NewMapOptions);
  // HD has a tower under the path; Classic has no model there (nothing casts).
  let mode = "hd";
  const tower = towerModel();
  let reads = 0;
  const read = async (p: string) => {
    if (/\.mdx$/i.test(p)) reads++;
    if (/ModePillar\.mdx$/i.test(p) && mode === "hd") return tower;
    throw new Error(`no ${p} in ${mode}`);
  };
  const at: Placed = { id: "LOpi", variation: 0, position: [terrain.offsetX + 16 * 128, terrain.offsetY + 16 * 128, 0], angle: 0, scale: [1, 1, 1] };
  const ground = terrainShadows(terrain);
  const shadowed = (m: Uint8Array) => m.reduce((n, v, i) => n + (v !== ground[i] ? 1 : 0), 0);
  const predict = () => predictShadows(terrain, [at], skins, () => undefined, read, undefined, undefined, () => mode);

  assert.ok(shadowed(await predict()) > 10, "HD's tower casts (the control)");
  mode = "sd";
  assert.equal(shadowed(await predict()), 0, "in Classic, which has no model there, nothing casts: HD's mesh isn't used");
  mode = "hd";
  const before = reads;
  assert.ok(shadowed(await predict()) > 10, "back in HD the tower casts again");
  assert.equal(reads, before, "from the kept mesh: the model isn't read again");
});

test("shadows are not written over the stored file when the game data can't be read; partial failures are counted", async () => {
  const files: Record<string, string> = {
    "Doodads\\DoodadSkins.txt": "[LOrk]\nfile=Doodads\\Rock\nshadow=1",
    "Units\\DestructableSkin.txt": "", "Units\\UnitSkin.txt": "", "Units\\ItemSkin.txt": "", "Units\\UnitData.slk": "ID;P\nE",
  };
  const w3 = { settings: { get: () => "sd-unreadable-shadow-test" }, game: { readText: async (p: string) => files[p] ?? "" } } as unknown as W3Api;
  const skins = await loadSkins(w3);
  const terrain = newTerrain({ width: 32, height: 32, tileset: "L", groundTiles: ["Ldrt"], cliffTiles: [], baseTile: "Ldrt", layer: 2, water: "none", noise: false, customTiles: false } as unknown as NewMapOptions);
  const at = (): Placed => ({ id: "LOrk", variation: 0, position: [terrain.offsetX + 16 * 128, terrain.offsetY + 16 * 128, 0], angle: 0, scale: [1, 1, 1] });
  const run = async (read: (p: string) => Promise<Uint8Array>, n: number, mode: string) => {
    const stats: ShadowStats = { wanted: 0, unreadable: 0 };
    await predictShadows(terrain, Array.from({ length: n }, at), skins, () => undefined, read, undefined, undefined, () => mode, stats);
    return shadowVerdict(stats, n, doodadTypes(skins));
  };
  const tower = towerModel();
  const none = await run(async () => { throw new Error("no game"); }, 3, "sd-unreadable-a");
  assert.equal(none.write, false, "no model readable: refused");
  assert.match(none.problem ?? "", /game folder/);
  const ok = await run(async () => tower, 3, "sd-unreadable-b");
  assert.deepEqual([ok.write, ok.leftOut], [true, 0], "the control: readable models write");
  const half = shadowVerdict({ wanted: 4, unreadable: 1 }, 4, doodadTypes(skins));
  assert.deepEqual([half.write, half.leftOut], [true, 1], "some unreadable: written, counted");
  assert.equal(shadowVerdict({ wanted: 0, unreadable: 0 }, 2, 0).write, false, "doodads but no object tables: refused");
  assert.equal(shadowVerdict({ wanted: 0, unreadable: 0 }, 0, 0).write, true, "no doodads at all: cliffs-only is right");
  // The game's tables unread: the skins are the built-in few (start location, random objects) and the map's own custom
  // types, whose base no table gave (no model): never 0 entries, but no doodad type.
  const empty = await loadSkins({ settings: { get: () => "sd-unreadable-shadow-test-empty" }, game: { readText: async () => { throw new Error("no game"); } } } as unknown as W3Api);
  const bare = withObjectArt(empty, [{ kind: "w3d", custom: [{ base: "LOrk", id: "D000", mods: [] }] }, { kind: "w3u", custom: [{ base: "hfoo", id: "h000", mods: [] }] }]);
  assert.ok(bare.size > 0, "skins are there without the game");
  const stats: ShadowStats = { wanted: 0, unreadable: 0 };
  await predictShadows(terrain, [at(), { ...at(), id: "D000" }], bare, () => "LOrk", async () => tower, undefined, undefined, () => "sd-unreadable-d", stats);
  assert.equal(doodadTypes(bare), 0);
  const tablesUnread = shadowVerdict(stats, 2, doodadTypes(bare));
  assert.equal(tablesUnread.write, false, "no doodad type from the tables: refused");
  assert.match(tablesUnread.problem ?? "", /object tables/);
  assert.ok(doodadTypes(skins) > 0, "the control: the game's table gives the rock");
  assert.equal(shadowVerdict(stats, 2, doodadTypes(skins)).write, true);
});

test("a model read with no casting faces isn't unreadable: only a failed read is counted, and a save isn't refused for it", async () => {
  const files: Record<string, string> = {
    "Doodads\\DoodadSkins.txt": "[LOgl]\nfile=Doodads\\Glow\nshadow=1\n[LOrk]\nfile=Doodads\\Rock\nshadow=1",
    "Units\\DestructableSkin.txt": "", "Units\\UnitSkin.txt": "", "Units\\ItemSkin.txt": "", "Units\\UnitData.slk": "ID;P\nE",
  };
  const w3 = { settings: { get: () => "sd-no-faces-test" }, game: { readText: async (p: string) => files[p] ?? "" } } as unknown as W3Api;
  const skins = await loadSkins(w3);
  const terrain = flatTerrain();
  const at = (id: string): Placed => ({ id, variation: 0, position: [terrain.offsetX + 16 * 128, terrain.offsetY + 16 * 128, 0], angle: 0, scale: [1, 1, 1] });
  // The glow is blended only (filter mode 2): read, nothing casts. The rock's model can't be read.
  const glow = towerModel(2), tower = towerModel();
  let rockReadable = false;
  const read = async (p: string) => {
    if (/Glow\.mdx$/i.test(p)) return glow;
    if (/Rock\.mdx$/i.test(p) && rockReadable) return tower;
    throw new Error(`no ${p}`);
  };
  const ground = terrainShadows(terrain);
  const run = async (ids: string[], mode: string) => {
    const stats: ShadowStats = { wanted: 0, unreadable: 0 };
    const shd = await predictShadows(terrain, ids.map(at), skins, () => undefined, read, undefined, undefined, () => mode, stats);
    return { stats, verdict: shadowVerdict(stats, ids.length, doodadTypes(skins)), cast: shd.reduce((n, v, i) => n + (v !== ground[i] ? 1 : 0), 0) };
  };
  const glows = await run(["LOgl", "LOgl"], "sd-no-faces-a");
  assert.deepEqual(glows.stats, { wanted: 2, unreadable: 0 }, "read with nothing to cast: not unreadable");
  assert.equal(glows.cast, 0, "and it casts nothing");
  assert.deepEqual([glows.verdict.write, glows.verdict.leftOut], [true, 0], "a map of such doodads isn't refused");
  const again = await run(["LOgl"], "sd-no-faces-a");
  assert.deepEqual(again.stats, { wanted: 1, unreadable: 0 }, "from the kept result too");
  const mixed = await run(["LOgl", "LOrk"], "sd-no-faces-b");
  assert.deepEqual(mixed.stats, { wanted: 2, unreadable: 1 }, "the failed read is counted, the faceless model isn't");
  assert.deepEqual([mixed.verdict.write, mixed.verdict.leftOut], [true, 1]);
  const rocks = await run(["LOrk"], "sd-no-faces-c");
  assert.equal(rocks.verdict.write, false, "the control: a model that can't be read still refuses");
  rockReadable = true;
  assert.ok((await run(["LOrk"], "sd-no-faces-d")).cast > 10, "the control: the opaque tower casts");
});

/** A rock skin table (one shadow-casting doodad type), read in its own graphics mode so no other test's meshes are used. */
async function rockSkins(mode: string) {
  const files: Record<string, string> = {
    "Doodads\\DoodadSkins.txt": "[LOrk]\nfile=Doodads\\Rock\nshadow=1",
    "Units\\DestructableSkin.txt": "", "Units\\UnitSkin.txt": "", "Units\\UnitData.slk": "ID;P\nE", "Units\\ItemSkin.txt": "",
  };
  return loadSkins({ settings: { get: () => mode }, game: { readText: async (p: string) => files[p] ?? "" } } as unknown as W3Api);
}
const flatTerrain = () => newTerrain({ width: 32, height: 32, tileset: "L", groundTiles: ["Ldrt"], cliffTiles: [], baseTile: "Ldrt", layer: 2, water: "none", noise: false, customTiles: false } as unknown as NewMapOptions);

test("a failed model read isn't kept for the session: the next prediction reads it again; within one it's read once", async () => {
  const mode = "sd-retry-test";
  const skins = await rockSkins(mode);
  const terrain = flatTerrain();
  const tower = towerModel();
  const at = (): Placed => ({ id: "LOrk", variation: 0, position: [terrain.offsetX + 16 * 128, terrain.offsetY + 16 * 128, 0], angle: 0, scale: [1, 1, 1] });
  let fail = true, reads = 0;
  const read = async (p: string) => {
    if (/\.mdx$/i.test(p)) reads++;
    if (fail) throw new Error("flaky");
    return tower;
  };
  const ground = terrainShadows(terrain);
  const shadowed = (m: Uint8Array) => m.reduce((n, v, i) => n + (v !== ground[i] ? 1 : 0), 0);
  const stats: ShadowStats = { wanted: 0, unreadable: 0 };
  assert.equal(shadowed(await predictShadows(terrain, [at(), at(), at()], skins, () => undefined, read, undefined, undefined, () => mode, stats)), 0, "the failed read casts nothing");
  assert.deepEqual([stats.wanted, stats.unreadable, reads], [3, 3, 1], "three doodads of one failing model: read once in that prediction");
  fail = false;
  assert.ok(shadowed(await predictShadows(terrain, [at()], skins, () => undefined, read, undefined, undefined, () => mode)) > 10,
    "the next prediction reads it again and casts (the control: a kept failure stays without shadow)");
  assert.equal(reads, 2);
});

test("the save's shadow update leaves the stored war3map.shd as it is when the models can't be read, and says so", async () => {
  const tower = towerModel();
  /** One save (writeDerived with shadows only) from a flat terrain to one with a spike, a rock standing in the middle. */
  const save = async (mode: string, read: (p: string) => Promise<Uint8Array>, shdUnreadable = false) => {
    const skins = await rockSkins(mode);
    const base = flatTerrain();
    const now = flatTerrain();
    // A spike far from the rock: its terrain shadow changes cells, so an update has something to write.
    for (const [x, y] of [[8, 8], [9, 8], [8, 9], [9, 9]]) now.corners[y * now.width + x].height += 1500;
    assert.ok(terrainShadows(now).some((v, i) => v !== terrainShadows(base)[i]), "the spike casts");
    const rock: Placed = { id: "LOrk", variation: 0, position: [base.offsetX + 22 * 128, base.offsetY + 22 * 128, 0], angle: 0, scale: [1, 1, 1] };
    // What the World Editor baked: the flat terrain with the rock's shadow.
    const stored = await predictShadows(base, [rock], skins, () => undefined, async () => tower, undefined, undefined, () => `${mode}-baked`);
    const writes: Uint8Array[] = [], warnings: string[] = [], errors: string[] = [], invoked: string[] = [];
    const settings: Record<string, unknown> = {
      "terrain.shadows.update": true, "terrain.pathing.regenerate": false, "terrain.minimap.regenerate": "never", "game.graphicsMode": mode,
      "terrain.shadows.sunAzimuth": 225, "terrain.shadows.sunElevation": 30,
    };
    const w3 = {
      settings: { get: (k: string) => settings[k] },
      workspace: {
        project: () => ({ root: "/project" }),
        files: () => [{ path: "map/war3map.shd" }],
        readBytes: async (p: string) => { if (p === "map/war3map.shd" && !shdUnreadable) return stored.slice(); throw new Error(`can't read ${p}`); },
        writeBytes: async (p: string, b: Uint8Array) => { assert.equal(p, "map/war3map.shd"); writes.push(b); },
      },
      backend: { invoke: async (cmd: string) => { invoked.push(cmd); return cmd === "derived_sources" ? { "map/war3map.w3e": "x" } : undefined; } },
      window: { showWarning: (m: string) => { warnings.push(m); }, showError: (m: string) => { errors.push(m); } },
    } as unknown as W3Api;
    await writeDerived(w3, {
      now, doodads: [rock], specials: [], baseTerrain: base, baseDoodads: [rock], units: null,
      skins, baseOf: () => undefined, read, filterPathing: () => {}, minimapStale: false,
    });
    return { stored, writes, warnings, errors, recorded: invoked.includes("derived_record") };
  };

  const ok = await save("sd-save-ok", async () => tower);
  assert.equal(ok.writes.length, 1, "the control: readable models, the spike's cells are written");
  assert.ok(ok.writes[0].some((v, i) => v !== ok.stored[i]));
  const flatGround = terrainShadows(flatTerrain());
  const baked = [...ok.stored.keys()].filter((i) => ok.stored[i] !== flatGround[i]);
  assert.ok(baked.length > 10 && baked.every((i) => ok.writes[0][i] === ok.stored[i]), "the rock's baked cells stay");
  assert.deepEqual([ok.warnings, ok.errors, ok.recorded], [[], [], true]);

  // A stored file that's there but can't be read isn't taken for absent and written over.
  const unreadable = await save("sd-save-ok", async () => tower, true);
  assert.deepEqual(unreadable.writes, []);
  assert.match(unreadable.errors.join(" "), /war3map\.shd.*can't read/);

  const none = await save("sd-save-none", async () => { throw new Error("the game's files can't be opened"); });
  assert.deepEqual(none.writes, [], "unreadable models: the stored file isn't touched");
  assert.equal(none.warnings.length, 1, "said once");
  assert.match(none.warnings[0], /war3map\.shd.*left as it is.*none of the 1 doodad models/);
  assert.deepEqual([none.errors, none.recorded], [[], false], "not recorded as following the terrain");

  // Flaky: the first read fails, later ones would go through. Before and after agree on the model (one read), so the
  // diff doesn't stamp in the after's shadow alone: refused as above, not half-updated.
  let calls = 0;
  const flaky = await save("sd-save-flaky", async (p) => { if (/\.mdx$/i.test(p) && calls++ === 0) throw new Error("flaky"); return tower; });
  assert.deepEqual(flaky.writes, [], "a flaky read doesn't half-update the file");
  assert.equal(flaky.warnings.length, 1);
});

test("predictShadows in DE falls back to the HD model when the plain Classic file is missing (EW00, ET00, EMt0)", async () => {
  const files: Record<string, string> = {
    "Doodads\\DoodadSkins.txt": [
      "[EW00]", "numVar=1", "file=Doodads\\TestDeShared\\Shared", "file:hd=Doodads\\TestDeWall\\Wall", "shadow=1",
      "[ET00]", "numVar=1", "file=Doodads\\TestDeShared\\Shared", "file:hd=Doodads\\TestDeTower\\Tower", "shadow=1",
    ].join("\n"),
    "Units\\DestructableSkin.txt": "", "Units\\UnitSkin.txt": "", "Units\\ItemSkin.txt": "", "Units\\UnitData.slk": "ID;P\nE",
  };
  const terrain = flatTerrain();
  const wallModel = towerModel(0, 300), tallModel = towerModel(0, 1500);
  const reads: string[] = [];
  const read = async (p: string) => {
    reads.push(p);
    if (/TestDeWall[\\/]Wall\.mdx$/i.test(p)) return wallModel;
    if (/TestDeTower[\\/]Tower\.mdx$/i.test(p)) return tallModel;
    throw new Error(`not found: ${p}`);
  };
  const ground = terrainShadows(terrain);
  const shadowed = (m: Uint8Array) => m.reduce((n, v, i) => n + (v !== ground[i] ? 1 : 0), 0);
  const placed = (id: string, tx: number): Placed => ({
    id, variation: 0, position: [terrain.offsetX + tx * 128, terrain.offsetY + 16 * 128, 0], angle: 0, scale: [1, 1, 1],
  });
  const skinsFor = (mode: string) =>
    loadSkins({ settings: { get: () => mode }, game: { readText: async (p: string) => files[p] ?? "" } } as unknown as W3Api);

  const deSkins = await skinsFor("de");
  const stats: ShadowStats = { wanted: 0, unreadable: 0 };
  const both = await predictShadows(terrain, [placed("EW00", 10), placed("ET00", 22)], deSkins, () => undefined, read, undefined, undefined, () => "de", stats);
  assert.deepEqual(stats, { wanted: 2, unreadable: 0 });
  assert.equal(reads.filter((p) => /TestDeShared[\\/]Shared\.mdx$/i.test(p)).length, 1, "missing Classic path is failed once");
  const wallOnly = shadowed(await predictShadows(terrain, [placed("EW00", 10)], deSkins, () => undefined, read, undefined, undefined, () => "de"));
  const towerOnly = shadowed(await predictShadows(terrain, [placed("ET00", 22)], deSkins, () => undefined, read, undefined, undefined, () => "de"));
  assert.ok(wallOnly > 0 && towerOnly > wallOnly, `wall=${wallOnly}, tower=${towerOnly}`);
  assert.equal(shadowed(both), wallOnly + towerOnly, "EW00 and ET00 each cast their own HD model");

  // Control: SD has no HD fallback, so both remain unreadable and cast nothing.
  const sdSkins = await skinsFor("sd");
  const sdStats: ShadowStats = { wanted: 0, unreadable: 0 };
  const sdOut = await predictShadows(terrain, [placed("EW00", 10), placed("ET00", 22)], sdSkins, () => undefined, read, undefined, undefined, () => "sd", sdStats);
  assert.deepEqual(sdStats, { wanted: 2, unreadable: 2 });
  assert.equal(shadowed(sdOut), 0);
});
