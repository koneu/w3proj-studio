import assert from "node:assert/strict";
import { test } from "node:test";
import { conversionSources, layerOrder, missingTextures, readLayered, refuseUnlikeClassic, sourcesText, uniqueName } from "./reforged";
import { textureCandidates } from "../../lib/model/texpath";
import { toClassicMdx } from "../../lib/model/classic";
import type { Model } from "../../lib/model/mdx";
import { blpPath, reforgedModel } from "../../lib/model/testbox";

/** A game with these full paths stored. */
const game = (stored: string[]) => async (full: string) => {
  if (!stored.includes(full)) throw new Error(`not found: ${full}`);
  return new Uint8Array([stored.indexOf(full)]);
};

test("a build machine's texture path is found where the game stores it", async () => {
  const raw = "C:/Users/ksizemore/Box/Classic Games/Warcraft3/assets/Art/HD//Doodads/Terrain/CityBridgeExtraLarge0/StoneBridgeWide_Diffuse.tif";
  const read = game(["War3.w3mod:_HD.w3mod:Doodads/Terrain/CityBridgeExtraLarge0/StoneBridgeWide_Diffuse.dds"]);
  const got = await readLayered(textureCandidates(raw), "de", read);
  assert.equal(got.name, "Doodads/Terrain/CityBridgeExtraLarge0/StoneBridgeWide_Diffuse.dds");
  // Control: the path read verbatim, as the bug did, finds nothing.
  await assert.rejects(readLayered([raw], "de", read));
});

test("the chosen set wins, the other one and Classic follow", async () => {
  const both = ["War3.w3mod:_DE.w3mod:a.dds", "War3.w3mod:_HD.w3mod:a.dds", "War3.w3mod:a.dds"];
  assert.equal((await readLayered(["a.dds"], "hd", game(both))).layer, "War3.w3mod:_HD.w3mod:");
  assert.equal((await readLayered(["a.dds"], "de", game(both))).layer, "War3.w3mod:_DE.w3mod:");
  assert.equal((await readLayered(["a.dds"], "de", game(both.slice(1)))).layer, "War3.w3mod:_HD.w3mod:");
  assert.equal((await readLayered(["a.dds"], "de", game(both.slice(2)))).layer, "War3.w3mod:");
  assert.deepEqual(layerOrder("hd"), ["War3.w3mod:_HD.w3mod:", "War3.w3mod:_DE.w3mod:", "War3.w3mod:"]);
});

test("sources: the sets that have every model of the type, DE first", () => {
  const has = new Set(["de:x0.mdx", "de:x1.mdx", "hd:x0.mdx"]);
  const f = (s: string, k: string) => has.has(`${s}:${k}`);
  assert.deepEqual(conversionSources(["X0.mdx", "X1.mdx"], f), ["de"]);
  assert.deepEqual(conversionSources(["X0.mdx"], f), ["de", "hd"]);
  assert.deepEqual(conversionSources(["Y.mdx"], f), []);
  assert.deepEqual(conversionSources([], f), []);
});

test("the message says which model Classic is made from", () => {
  assert.equal(sourcesText(["de", "hd"], "Doodads/A/B0.mdx"), "Classic can be made from the DE model Doodads\\A\\B0.mdx (or the HD one)");
  assert.equal(sourcesText(["hd"], "B.mdx"), "Classic can be made from the HD model B.mdx");
  assert.equal(sourcesText([], "B.mdx"), "");
});

test("two textures with one file name get two names", () => {
  const used = new Set<string>();
  assert.equal(uniqueName("d", "A.blp", used), "d\\A.blp");
  assert.equal(uniqueName("d", "a.BLP", used), "d\\a_2.BLP");
  assert.equal(uniqueName("d", "A.blp", used), "d\\A_3.blp");
});

test("missingTextures names the colour textures the map lacks", () => {
  const have = new Set(["d\\a.blp"]);
  const t = [{ path: "d\\A.blp", replaceableId: 0 }, { path: "C:/x/b.blp", replaceableId: 0 }, { path: "", replaceableId: 0 }, { path: "ReplaceableTextures\\TeamColor\\TeamColor00.blp", replaceableId: 1 }];
  assert.deepEqual(missingTextures(t, (n) => have.has(n)), ["C:/x/b.blp"]);
});

test("Convert to Classic refuses a converted model with nothing to draw, saying why", () => {
  /** What refuseUnlikeClassic says of `m` converted, with its textures written beside it ("" when it passes). */
  const refusal = (m: Model) => {
    const files = new Map([["war3mapImported\\Classic\\Box\\box.mdx", toClassicMdx(m, blpPath(m))], ...m.textures.map((_, i) => [blpPath(m)(i), new Uint8Array(4)] as const)]);
    try { refuseUnlikeClassic(files); } catch (e) { return (e as Error).message; }
    return "";
  };
  // The control: the box passes.
  assert.equal(refusal(reforgedModel([0, 0])), "");
  // Its geosets all removed.
  assert.equal(refusal({ ...reforgedModel(), geosets: [], geosetAnims: [] } as Model),
    "war3mapImported\\Classic\\Box\\box.mdx came out unusable for Classic graphics (GEOS holds no geoset: the model has nothing to draw), nothing changed");
  // Its geosets all without faces.
  const faceless = reforgedModel([0, 0]);
  faceless.geosets.forEach((g) => { g.faces = new Uint16Array(0); });
  assert.match(refusal(faceless), /unusable for Classic graphics \(none of its 2 geosets has a face: the model has nothing to draw\), nothing changed$/);
  // One without faces beside one with: refused as unlike the game's models (a warning).
  const half = reforgedModel([0, 0]);
  half.geosets[1].faces = new Uint16Array(0);
  assert.match(refusal(half), /came out unlike the game's Classic models \(geoset 1 has no faces\)/);
});
