import assert from "node:assert/strict";
import { test } from "node:test";
import type { Placed, Skin } from "./objects";
import { planSplats, splatTextureFiles, type SplatDef } from "./splats";

const skin = (uberSplat: string): Skin => ({
  kind: "w3u", file: "x", numVar: 1, texId: -1, texFile: "", modelScale: 1, minScale: 1, maxScale: 1, randScale: false, fixedRot: null, uberSplat,
});
const placed = (id: string, x: number, y: number) => ({ id, position: [x, y, 0] }) as unknown as Placed;

test("buildings get their ground mark; custom types their base's; others none", () => {
  const hmed: SplatDef = { texture: "ReplaceableTextures\\Splats\\HumanUberSplat.blp", scale: 190, blend: 0, color: [1, 1, 1, 1] };
  const skins = new Map([["hbar", skin("HMED")], ["hfoo", skin("")]]);
  const table = new Map([["HMED", hmed]]);
  const splats = planSplats([placed("hbar", 100, 200), placed("hfoo", 0, 0), placed("h000", -50, 50)], skins, table, (id) => (id === "h000" ? "hbar" : undefined));
  assert.deepEqual(splats, [{ x: 100, y: 200, def: hmed }, { x: -50, y: 50, def: hmed }]);
});

test("HD reads a mark's Reforged _Diffuse texture first, classic the plain one (the editor's green HD root mark)", () => {
  const tex = "ReplaceableTextures\\Splats\\AncientUberSplat.blp";
  assert.deepEqual(splatTextureFiles(tex, "hd"), ["ReplaceableTextures\\Splats\\AncientUberSplat_Diffuse.blp", tex]);
  assert.deepEqual(splatTextureFiles(tex, "de"), ["ReplaceableTextures\\Splats\\AncientUberSplat_Diffuse.blp", tex]);
  assert.deepEqual(splatTextureFiles(tex, "sd"), [tex]);
});

test("an Ancient placed uprooted has no root mark, as the file has it and as the editor splits it", () => {
  const emda: SplatDef = { texture: "Textures\\RootBase.blp", scale: 160, blend: 0, color: [1, 1, 1, 1] };
  const skins = new Map([["eaom", skin("EMDA")]]);
  const table = new Map([["EMDA", emda]]);
  const rooted = placed("eaom", 0, 0), uprootedRaw = { ...placed("eaom", 300, 0), player: 0x10002 } as Placed;
  const uprootedSplit = { ...placed("eaom", 600, 0), player: 2, playerFlags: 0x10000 } as Placed;
  assert.deepEqual(planSplats([rooted, uprootedRaw, uprootedSplit], skins, table, () => undefined), [{ x: 0, y: 0, def: emda }]);
});
