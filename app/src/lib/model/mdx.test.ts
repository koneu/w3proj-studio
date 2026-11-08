import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMdx, renameTextures } from "./mdx";

/** A minimal model: version, two textures. */
function model(paths: string[]): Uint8Array {
  const parts: number[] = [];
  const u32 = (v: number) => parts.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const tag = (s: string) => parts.push(...[...s].map((c) => c.charCodeAt(0)));
  tag("MDLX");
  tag("VERS"); u32(4); u32(1800);
  tag("TEXS"); u32(paths.length * 268);
  for (const p of paths) {
    u32(0);
    const b = new Array(260).fill(0);
    [...p].forEach((c, i) => { b[i] = c.charCodeAt(0); });
    parts.push(...b);
    u32(3);
  }
  return new Uint8Array(parts);
}

/** A v1800 model with one material of one Reforged layer: textures 0 (stone) to 4, slots diffuse 0, normal 1,
 *  ORM 2; the diffuse slot plays textures 3, 4 and the normal slot 1, 2 when `flipbook` is set (as the HD City
 *  Fountain's water does), on global sequence 0. */
function reforgedLayer(flipbook: boolean): Uint8Array {
  const parts: number[] = [];
  const u32 = (v: number) => parts.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const f32 = (v: number) => { const b = new Uint8Array(new Float32Array([v]).buffer); parts.push(...b); };
  const tag = (s: string) => parts.push(...[...s].map((c) => c.charCodeAt(0)));
  const kmtf = (ids: number[]) => { tag("KMTF"); u32(ids.length); u32(0); u32(0); ids.forEach((id, i) => { u32(i * 33); u32(id); }); };
  const sizeAt = (at: number) => { const n = parts.length - at; parts.splice(at, 4, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24); };
  tag("MDLX");
  tag("VERS"); u32(4); u32(1800);
  tag("GLBS"); u32(4); u32(1633);
  tag("TEXS"); u32(5 * 268);
  for (let t = 0; t < 5; t++) { u32(0); parts.push(...new Array(260).fill(0)); u32(3); }
  tag("MTLS");
  const chunk = parts.length; u32(0);
  const material = parts.length; u32(0); u32(0); u32(0);
  tag("LAYS"); u32(1);
  const layer = parts.length; u32(0);
  u32(2); u32(0); u32(0); u32(0xffffffff); u32(0); f32(0.5); // filter, shading, texture, no TXAN, coord, alpha
  f32(1); f32(0); f32(0); f32(0); f32(0); f32(0); // emissive gain, fresnel colour, opacity, team colour
  u32(1); u32(3); // HD, three slots
  u32(0); u32(0); if (flipbook) kmtf([3, 4]);
  u32(0); u32(1); if (flipbook) kmtf([1, 2]);
  u32(2); u32(2);
  sizeAt(layer); sizeAt(material);
  const n = parts.length - chunk - 4; parts.splice(chunk, 4, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24);
  return new Uint8Array(parts);
}

test("a Reforged layer's diffuse flipbook is its texture track; the normal slot's is kept per slot", () => {
  const layer = parseMdx(reforgedLayer(true)).materials[0].layers[0];
  assert.deepEqual(layer.textureIds, [0, 0, 2], "the stone's diffuse is what the layer names");
  assert.deepEqual([...(layer.textureTrack?.values ?? [])], [3, 4], "the water's frames");
  assert.equal(layer.textureTrack?.globalSeq, 0);
  assert.deepEqual([...(layer.slotTracks?.[1]?.values ?? [])], [1, 2]);
  assert.equal(layer.slotTracks?.[2], undefined);
  const still = parseMdx(reforgedLayer(false)).materials[0].layers[0];
  assert.equal(still.textureTrack, undefined);
  assert.equal(still.slotTracks, undefined);
});

test("texture paths are renamed in place; the rest of the file stays", () => {
  const src = model(["Doodads/X/Rock_Diffuse.tif", "ReplaceableTextures/EnvironmentMap.blp"]);
  const out = renameTextures(src, (p) => p.replace(/\.tif$/, ".dds"));
  assert.equal(out.length, src.length);
  const m = parseMdx(out);
  assert.deepEqual(m.textures.map((t) => t.path), ["Doodads/X/Rock_Diffuse.dds", "ReplaceableTextures/EnvironmentMap.blp"]);
  assert.deepEqual(m.textures.map((t) => t.flags), [3, 3]);
  // The source is untouched.
  assert.equal(parseMdx(src).textures[0].path, "Doodads/X/Rock_Diffuse.tif");
  assert.throws(() => renameTextures(src, () => "x".repeat(300)));
});
