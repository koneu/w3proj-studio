// What Classic graphics needs of a converted model (classiccheck.ts), on made-up Reforged models, on the game's own
// Reforged art of the 14a/14c example maps' doodads (converted as the Convert to Classic fix does) and, as the
// control that the checker doesn't refuse what the game draws, on the Classic models of real maps (smoketest_maps).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { toClassicMdx } from "./classic";
import { checkClassicModel } from "./classiccheck";
import { parseMdx, type Model, type Node } from "./mdx";

type V3 = [number, number, number];

/** A Reforged-like model: a box on the bone "arm" (child of "root"), an attachment on "arm" and a sound event on
 *  "root" whose id comes after the attachment's, as in the game's units (events last). Its geosets are at `lods`. */
function reforgedModel(lods = [0]): Model {
  const [w, h] = [50, 200];
  const positions: number[] = [];
  for (const z of [0, h]) for (const [x, y] of [[-w, -w], [w, -w], [w, w], [-w, w]]) positions.push(x, y, z);
  const quads = [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7]];
  const faces = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  const extent = { radius: h, min: [-w, -w, 0] as V3, max: [w, w, h] as V3 };
  const node = (name: string, objectId: number, parentId: number, kind: string): Node => ({ name, objectId, parentId, flags: 0, kind });
  return {
    version: 1000, name: "box", extent, globalSequences: [], textureAnims: [], geosetAnims: [],
    sequences: [{ name: "Stand", start: 0, end: 1000, moveSpeed: 0, flags: 0, rarity: 0, extent }],
    textures: [{ replaceableId: 0, path: "Textures/Box_Diffuse.tif", flags: 0 }, { replaceableId: 0, path: "Textures/Box_Normal.tif", flags: 0 }],
    materials: [{ priorityPlane: 0, flags: 0, layers: [{ filterMode: 0, shadingFlags: 0, textureIds: [0, 1], textureAnimId: -1, coordId: 0, alpha: 1 }] }],
    geosets: lods.map((lod) => ({
      positions: new Float32Array(positions), normals: new Float32Array(positions.length), uvs: new Float32Array((positions.length / 3) * 2),
      faces: new Uint16Array(faces), vertexGroups: new Uint8Array(positions.length / 3), groups: [[1]], materialId: 0, lod, lodName: `LOD${lod}`, extent,
    })),
    nodes: [node("root", 0, -1, "bone"), node("arm", 1, 0, "bone"), node("Origin Ref", 2, 1, "atch"), node("SNDXHFOO", 3, 0, "event")],
    pivots: new Float32Array([0, 0, 0, 0, 0, 100, 0, 0, 150, 0, 0, 5]),
    particleEmitters2: [], ribbons: [], skipped: [], warnings: [],
  } as unknown as Model;
}

const blpPath = (m: Model) => (i: number) => `war3mapImported\\Classic\\Box\\${m.textures[i].path.split("/").pop()!.replace(/\.\w+$/, "")}.blp`;
const clean = (bytes: Uint8Array, what: string) => {
  const { errors, warnings } = checkClassicModel(bytes);
  assert.deepEqual([...errors, ...warnings], [], what);
};

test("a converted model numbers its nodes as Classic does: bones, helpers (an event), attachments; parents, matrices and pivots follow", () => {
  const src = reforgedModel();
  const bytes = toClassicMdx(src, blpPath(src));
  clean(bytes, "the converted box");
  const m = parseMdx(bytes);
  const byName = new Map(m.nodes.filter(Boolean).map((n) => [n.name, n]));
  assert.deepEqual(m.nodes.map((n) => [n.objectId, n.name, n.kind]), [[0, "root", "bone"], [1, "arm", "bone"], [2, "SNDXHFOO", "helper"], [3, "Origin Ref", "atch"]]);
  assert.equal(byName.get("Origin Ref")!.parentId, byName.get("arm")!.objectId, "the attachment still hangs on the arm");
  assert.equal(byName.get("SNDXHFOO")!.parentId, 0);
  assert.deepEqual(m.geosets[0].groups, [[byName.get("arm")!.objectId]], "the box still moves with the arm");
  assert.deepEqual([...m.pivots.subarray(9, 12)], [0, 0, 150], "the attachment's pivot moved with its id");
  assert.deepEqual([...m.pivots.subarray(6, 9)], [0, 0, 5], "the event's pivot moved with its id");
});

test("a model with only lower levels of detail keeps its most detailed one instead of coming out empty", () => {
  const src = reforgedModel([2, 3]);
  const bytes = toClassicMdx(src, blpPath(src));
  clean(bytes, "a level 2 and 3 model");
  assert.equal(parseMdx(bytes).geosets.length, 1);
  // Level 0 where there is one: the others are left out.
  assert.equal(parseMdx(toClassicMdx(reforgedModel([1, 0, 2]), blpPath(reforgedModel()))).geosets.length, 1);
});

test("the checker finds what would keep Classic from reading or drawing a model (controls)", () => {
  const src = reforgedModel();
  const good = toClassicMdx(src, blpPath(src));
  const find = (bytes: Uint8Array, tag: string) => {
    for (let o = 4; o + 8 <= bytes.length; o += 8 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(o + 4, true)) {
      if (String.fromCharCode(...bytes.subarray(o, o + 4)) === tag) return o;
    }
    throw new Error(`no ${tag}`);
  };
  const edit = (fn: (b: Uint8Array, dv: DataView) => void) => { const b = good.slice(); fn(b, new DataView(b.buffer)); return checkClassicModel(b); };
  assert.match(edit((b, dv) => dv.setUint32(find(b, "VERS") + 8, 1000, true)).errors.join(), /version 1000/);
  assert.match(edit((b, dv) => dv.setUint32(find(b, "GEOS") + 4, 1 << 30, true)).errors.join(), /runs past the end/);
  // The first face index of the first geoset: past its eight vertices.
  assert.match(edit((b, dv) => { let p = find(b, "GEOS") + 12; for (const each of [12, 12, 4, 4]) p += 8 + dv.getUint32(p + 4, true) * each; dv.setUint16(p + 8, 99, true); }).errors.join(), /a face uses vertex 99 of 8/);
  assert.match(edit((b) => b.set(new TextEncoder().encode("dds"), b.indexOf(0x2e, find(b, "TEXS") + 12) + 1)).warnings.join(), /isn't a BLP/);
  // The helper's object id set to the attachment's: the order is off.
  assert.match(edit((b, dv) => dv.setUint32(find(b, "HELP") + 8 + 4 + 80, 3, true)).warnings.join(), /object id 3 where 2 is next/);
  assert.match(checkClassicModel(good, { hasTexture: () => false }).warnings.join(), /Box_Diffuse\.blp is not in the map/);
  assert.deepEqual(checkClassicModel(good, { hasTexture: (p) => p === "war3mapImported\\Classic\\Box\\Box_Diffuse.blp" }), { errors: [], warnings: [] });
  // Hostile bytes: every cut of the file is answered, never thrown.
  for (let n = 0; n < good.length; n += 7) checkClassicModel(good.subarray(0, n));
});

// --- the game's own art and real maps, when they are here --------------------------------------------------------

function mainCheckout(): { repo: string; main: string } | null {
  const git = (arg: string) => { const r = spawnSync("git", ["rev-parse", arg], { encoding: "utf8" }); return r.status === 0 ? r.stdout.trim() : null; };
  const repo = git("--show-toplevel"), common = git("--git-common-dir");
  return repo ? { repo, main: common ? dirname(resolve(common)) : repo } : null;
}

/** The game's files by full storage path (War3.w3mod:_HD.w3mod:…), read with the release CLI; those it has. */
function gameFiles(names: string[]): { name: string; bytes: Uint8Array }[] {
  const where = mainCheckout();
  if (!where) return [];
  const exe = `w3proj${process.platform === "win32" ? ".exe" : ""}`;
  const bin = [process.env.W3PROJ_BIN, join(where.repo, "target", "release", exe), join(where.main, "target", "release", exe)].find((p) => p && existsSync(p));
  const gameFile = join(where.main, ".game-path");
  const listed = existsSync(gameFile) ? readFileSync(gameFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
  const game = process.env.W3PROJ_GAME ?? listed.find((p) => existsSync(p)) ?? listed[0];
  if (!bin) return [];
  const out: { name: string; bytes: Uint8Array }[] = [];
  for (const name of names) {
    const r = spawnSync(bin, ["game", "cat", name, ...(game ? ["--install", game] : [])], { maxBuffer: 1 << 28 });
    if (r.status === 0 && r.stdout.length) out.push({ name, bytes: new Uint8Array(r.stdout) });
  }
  return out;
}

test("the Reforged art of the 14a/14c doodads, converted as Convert to Classic does, has the shape of Classic models", (ctx) => {
  const lc = (n: string) => `War3.w3mod:_HD.w3mod:Doodads/LordaeronCapital/Structures/${n}/${n}.mdx`;
  const models = gameFiles([
    "War3.w3mod:_HD.w3mod:Doodads/Cityscape/Props/IronGateA/IronGateA.mdx",
    ...["CapitalTower", "PalaceWallShort", "PillarShort", "CapitalBridge", "PalaceWallTall", "ArchWithPillar"].map(lc),
    "War3.w3mod:_HD.w3mod:Doodads/Cityscape/Structures/CityWallEndcap/CityWallEndcap0.mdx",
    "War3.w3mod:_HD.w3mod:Doodads/Cityscape/Structures/CityWallEndcap/CityWallEndcap1.mdx",
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((v) => `War3.w3mod:_DE.w3mod:Doodads/LordaeronCapital/Structures/PillarTall/PillarTall${v}.mdx`),
    ...[0, 9].map((v) => `War3.w3mod:_DE.w3mod:Doodads/Undercity/Props/Bones/Bones${v}.mdx`),
    // Units: lights, events and emitters among the nodes (they become helpers and are renumbered).
    "War3.w3mod:_HD.w3mod:Units/Human/Footman/Footman.mdx",
    "War3.w3mod:_HD.w3mod:Units/Creeps/Owl/Owl.mdx",
    "War3.w3mod:_HD.w3mod:Doodads/Cityscape/Structures/MoreCityBuilding3/MoreCityBuilding3.mdx",
  ]);
  if (!models.length) return ctx.skip("no game or release CLI (.game-path, target/release/w3proj)");
  assert.ok(models.length >= 20, `only ${models.length} of the game's models read`);
  for (const { name, bytes } of models) {
    const src = parseMdx(bytes);
    const out = toClassicMdx(src, (i) => (src.textures[i].path ? `war3mapImported\\Classic\\X\\${i}.blp` : null));
    clean(out, name);
    assert.ok(parseMdx(out).geosets.length > 0, `${name}: no geoset left`);
  }
});

test("the Classic models of real maps (MDX 800 files of smoketest_maps, drawn by the game) read without an error", (ctx) => {
  const where = mainCheckout();
  const corpus = process.env.W3PROJ_CORPUS ?? (where ? join(where.main, "smoketest_maps") : "");
  if (!corpus || !existsSync(corpus)) return ctx.skip("no smoketest_maps (W3PROJ_CORPUS)");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "checkpoints") walk(p); } else if (/\.mdx$/i.test(e.name) && statSync(p).size >= 16) files.push(p);
    }
  };
  walk(corpus);
  const classic = files.map((p) => ({ p, bytes: new Uint8Array(readFileSync(p)) })).filter(({ bytes }) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true) === 800);
  if (!classic.length) return ctx.skip("no MDX 800 file in smoketest_maps");
  const bad = classic.map(({ p, bytes }) => ({ p, errors: checkClassicModel(bytes).errors })).filter((x) => x.errors.length);
  assert.deepEqual(bad.slice(0, 5).map((x) => `${x.p}: ${x.errors[0]}`), [], `${bad.length} of ${classic.length} real Classic models`);
});
