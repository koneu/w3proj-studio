// What Classic graphics needs of a converted model (classiccheck.ts), on made-up Reforged models, on the game's own
// Reforged art of the 14a/14c example maps' doodads (converted as the Convert to Classic fix does) and, as the
// control that the checker doesn't refuse what the game draws, on the Classic models of real maps (smoketest_maps).

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { skipOrFail } from "../testhelpers/testutil";
import { gameFiles, mainCheckout } from "../testhelpers/gamefiles";
import { toClassicMdx } from "./classic";
import { checkClassicModel } from "./classiccheck";
import { parseMdx, type Model } from "./mdx";
import { blpPath, reforgedModel } from "./testbox";

const clean = (bytes: Uint8Array, what: string) => {
  const { errors, warnings } = checkClassicModel(bytes, { drawn: true });
  assert.deepEqual([...errors, ...warnings], [], what);
};

/** Where the chunk `tag` starts (its tag) in an MDX file. */
const find = (bytes: Uint8Array, tag: string) => {
  for (let o = 4; o + 8 <= bytes.length; o += 8 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(o + 4, true)) {
    if (String.fromCharCode(...bytes.subarray(o, o + 4)) === tag) return o;
  }
  throw new Error(`no ${tag}`);
};

/** `bytes` with the contents of chunk `tag` replaced (null: the whole chunk left out). */
const withChunk = (bytes: Uint8Array, tag: string, contents: Uint8Array | null) => {
  const at = find(bytes, tag), end = at + 8 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(at + 4, true);
  const head = new Uint8Array(8);
  head.set(bytes.subarray(at, at + 4));
  new DataView(head.buffer).setUint32(4, contents?.length ?? 0, true);
  const parts = [bytes.subarray(0, at), ...(contents ? [head, contents] : []), bytes.subarray(end)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
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

test("a model with nothing to draw is an error (mutations)", () => {
  const src = reforgedModel([0, 0]);
  const good = toClassicMdx(src, blpPath(src));
  // The control: the two-geoset box is clean.
  clean(good, "the two-geoset box");

  // The GEOS chunk emptied: with or without `drawn`.
  assert.deepEqual(checkClassicModel(withChunk(good, "GEOS", new Uint8Array(0))).errors, ["GEOS holds no geoset: the model has nothing to draw"]);
  // The converter given a model whose geosets were all removed writes such a file.
  const none = { ...reforgedModel(), geosets: [], geosetAnims: [] } as Model;
  assert.deepEqual(checkClassicModel(toClassicMdx(none, blpPath(none))).errors, ["GEOS holds no geoset: the model has nothing to draw"]);

  // Every geoset without faces (and one without vertices too).
  const faceless = reforgedModel([0, 0]);
  faceless.geosets.forEach((g) => { g.faces = new Uint16Array(0); });
  faceless.geosets[1].positions = new Float32Array(0); faceless.geosets[1].normals = new Float32Array(0);
  faceless.geosets[1].uvs = new Float32Array(0); faceless.geosets[1].vertexGroups = new Uint8Array(0);
  const facelessOut = toClassicMdx(faceless, blpPath(faceless));
  assert.equal(parseMdx(facelessOut).geosets.length, 2, "the converter keeps the empty geosets");
  assert.deepEqual(checkClassicModel(facelessOut).errors, ["none of its 2 geosets has a face: the model has nothing to draw"]);

  // One geoset without faces beside one with: a warning, not an error.
  const half = reforgedModel([0, 0]);
  half.geosets[1].faces = new Uint16Array(0);
  const halfCheck = checkClassicModel(toClassicMdx(half, blpPath(half)));
  assert.deepEqual(halfCheck, { errors: [], warnings: ["geoset 1 has no faces"] });

  // No GEOS chunk at all: a warning for any model (effects have none), an error for one that must be drawn.
  const noChunk = withChunk(good, "GEOS", null);
  assert.deepEqual(checkClassicModel(noChunk).errors, []);
  assert.match(checkClassicModel(noChunk).warnings.join(), /no GEOS chunk/);
  assert.match(checkClassicModel(noChunk, { drawn: true }).errors.join(), /no GEOS chunk: the model has nothing to draw/);
});

// --- the game's own art and real maps, when they are here --------------------------------------------------------

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
    "War3.w3mod:_HD.w3mod:Units/Human/Peasant/Peasant.mdx",
    "War3.w3mod:_HD.w3mod:Units/Human/Knight/Knight.mdx",
    "War3.w3mod:_HD.w3mod:Units/Orc/Grunt/Grunt.mdx",
    "War3.w3mod:_HD.w3mod:Units/Creeps/Owl/Owl.mdx",
    "War3.w3mod:_HD.w3mod:Doodads/Cityscape/Structures/MoreCityBuilding3/MoreCityBuilding3.mdx",
  ]);
  if (!models.length) return skipOrFail(ctx, "no game or release CLI (.game-path, target/release/w3proj)");
  assert.ok(models.length >= 23, `only ${models.length} of the game's models read`);
  for (const { name, bytes } of models) {
    const src = parseMdx(bytes);
    const out = toClassicMdx(src, (i) => (src.textures[i].path ? `war3mapImported\\Classic\\X\\${i}.blp` : null));
    clean(out, name);
    assert.ok(parseMdx(out).geosets.length > 0, `${name}: no geoset left`);
  }
});

/** Corpus models that are damaged in their source (the map as it was given), with the checker's error they must give. */
const KNOWN_DAMAGED: { path: string; error: RegExp; why: string }[] = [
  // 36864 bytes, exactly 9 × 4096: the file stops inside its BONE chunk (at 15507 the chunk says 22620 bytes, 21349 are
  // left). The project's checkpoints (the only other copies, packed from it) hold the same 36864 bytes; no original
  // archive of the map is in the corpus. Examined 2026-11-22.
  { path: "wowr4.6/map/war3mapImported/GoblinFemale_Portrait.mdx", error: /chunk at 15507 runs past the end of the file/, why: "cut off at 36864 bytes (9 × 4096) inside its BONE chunk in the source project" },
];

test("the Classic models of real maps (MDX 800 files of smoketest_maps, drawn by the game) read without an error", (ctx) => {
  const where = mainCheckout();
  const corpus = process.env.W3PROJ_CORPUS ?? (where ? join(where.main, "smoketest_maps") : "");
  if (!corpus || !existsSync(corpus)) return skipOrFail(ctx, "no smoketest_maps (W3PROJ_CORPUS)");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "checkpoints") walk(p); } else if (/\.mdx$/i.test(e.name) && statSync(p).size >= 16) files.push(p);
    }
  };
  walk(corpus);
  const classic = files.map((p) => ({ p, bytes: new Uint8Array(readFileSync(p)) })).filter(({ bytes }) => bytes.length >= 16 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(12, true) === 800);
  if (!classic.length) return skipOrFail(ctx, "no MDX 800 file in smoketest_maps");
  const check = (p: string, bytes: Uint8Array) => { try { return checkClassicModel(bytes).errors; } catch (e) { throw new Error(`${p}: the checker threw: ${e instanceof Error ? e.message : e}`); } };
  // Files of the corpus that are damaged where they came from, so the checker is right to refuse them. Each is still
  // checked: it must fail with the error named here (anything else, or no error, fails the test), and it is printed.
  const damaged = classic.filter(({ p }) => KNOWN_DAMAGED.some((d) => p.replace(/\\/g, "/").endsWith(d.path)));
  for (const { p, bytes } of damaged) {
    const d = KNOWN_DAMAGED.find((k) => p.replace(/\\/g, "/").endsWith(k.path))!;
    const errors = check(p, bytes);
    assert.ok(errors.some((e) => d.error.test(e)), `${p} is listed as damaged (${d.why}), but the checker says ${JSON.stringify(errors)}`);
    ctx.diagnostic(`known damaged, not counted: ${p}: ${errors[0]} (${d.why})`);
  }
  const bad = classic.filter((m) => !damaged.includes(m)).map(({ p, bytes }) => ({ p, errors: check(p, bytes) })).filter((x) => x.errors.length);
  assert.deepEqual(bad.slice(0, 5).map((x) => `${x.p}: ${x.errors[0]}`), [], `${bad.length} of ${classic.length} real Classic models`);
});
