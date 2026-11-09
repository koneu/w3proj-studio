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

/** A model with one light per entry of `lights`: `words` 18 is the Reforged layout (the game's 1800 models: type, a
 *  word, start, end, …), 12 the classic one (type, start, end, …); `track` adds an intensity track after the values;
 *  `size` overrides the light's stated size. */
function lightModel(lights: { words: 12 | 18; start: number; end: number; track?: boolean; size?: number }[]): Uint8Array {
  const parts: number[] = [];
  const u32 = (v: number) => parts.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const f32 = (v: number) => { const b = new Uint8Array(new Float32Array([v]).buffer); parts.push(...b); };
  const tag = (s: string) => parts.push(...[...s].map((c) => c.charCodeAt(0)));
  tag("MDLX");
  tag("VERS"); u32(4); u32(1800);
  tag("LITE");
  const chunk = parts.length; u32(0);
  lights.forEach((l, i) => {
    const at = parts.length; u32(0);
    u32(96); parts.push(...new Array(80).fill(0)); u32(i); u32(0xffffffff); u32(0x200); // node: size, name, id, parent, flags
    u32(0); if (l.words === 18) u32(i % 2);
    f32(l.start); f32(l.end);
    const rest = l.words === 18 ? 14 : 9;
    for (let k = 0; k < rest; k++) f32(1);
    if (l.track) { tag("KLAI"); u32(1); u32(0); u32(0xffffffff); u32(0); f32(10); }
    const n = l.size ?? parts.length - at;
    parts.splice(at, 4, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24);
  });
  const n = parts.length - chunk - 4;
  parts.splice(chunk, 4, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24);
  return new Uint8Array(parts);
}

test("lights: how far each reaches, in the Reforged layout and the classic one, with or without tracks", () => {
  const m = parseMdx(lightModel([{ words: 18, start: 80, end: 200 }, { words: 18, start: 0, end: 10, track: true }, { words: 12, start: 50, end: 300 }, { words: 12, start: 5, end: 60, track: true }]));
  assert.deepEqual(m.lights?.map((l) => [l.attenuationStart, l.attenuationEnd]), [[80, 200], [0, 10], [50, 300], [5, 60]]);
  assert.deepEqual(m.lights?.map((l) => l.node.objectId), [0, 1, 2, 3]);
  assert.deepEqual(m.warnings, []);
  assert.equal(parseMdx(model(["a.blp"])).lights, undefined, "a model without lights has none");
});

test("lights: a damaged one is left out or warned about, never read past its end", () => {
  // Too short to hold the values: no light, but the node is there and the model reads.
  const short = parseMdx(lightModel([{ words: 12, start: 1, end: 2, size: 4 + 96 + 20 }]));
  assert.equal(short.lights, undefined);
  assert.ok(short.warnings.length > 0, "the light's stated size doesn't match the chunk");
  // Values that make no sense.
  assert.equal(parseMdx(lightModel([{ words: 18, start: -5, end: NaN }])).lights, undefined);
  // A stated size under the size field itself.
  const tiny = parseMdx(lightModel([{ words: 18, start: 1, end: 2, size: 2 }]));
  assert.equal(tiny.lights, undefined);
  assert.ok(tiny.warnings.some((w) => w.startsWith("LITE")));
});

/** A chunk `tag` of objects with an outer size (attachments, emitters, cameras' kin): each a node numbered `i` and
 *  8 bytes of the object's own after it; `sizes[i]` overrides an object's stated size. */
function objectModel(tag: string, count: number, sizes: Record<number, number> = {}): Uint8Array {
  const parts: number[] = [];
  const u32 = (v: number) => parts.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
  const put = (s: string) => parts.push(...[...s].map((c) => c.charCodeAt(0)));
  put("MDLX");
  put("VERS"); u32(4); u32(800);
  put(tag);
  const chunk = parts.length; u32(0);
  for (let i = 0; i < count; i++) {
    const at = parts.length; u32(0);
    u32(96); parts.push(...new Array(80).fill(0)); u32(i); u32(0xffffffff); u32(0); // node: size, name, id, parent, flags
    u32(7); u32(7);
    const n = sizes[i] ?? parts.length - at;
    parts.splice(at, 4, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24);
  }
  const n = parts.length - chunk - 4;
  parts.splice(chunk, 4, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24);
  return new Uint8Array(parts);
}

test("objects with an outer size: their nodes are read and the rest skipped; a size of 0 or past the chunk is refused", () => {
  for (const tag of ["ATCH", "PREM", "CORN", "LITE"]) {
    const sane = parseMdx(objectModel(tag, 2));
    assert.deepEqual(sane.nodes.map((n) => n.objectId), [0, 1], tag);
    assert.deepEqual(sane.warnings, [], tag);
    // A size of 0 (or under the size field) sent the reader back to the object's start for ever; past the chunk
    // it read the next chunk as this one's objects. Either way the chunk is left out with a warning.
    for (const size of [0, 3, 4 + 104 + 4]) {
      const bad = parseMdx(objectModel(tag, 2, { 1: size }));
      assert.ok(bad.warnings.some((w) => w.startsWith(`${tag}: `)), `${tag}, size ${size}: ${bad.warnings}`);
    }
  }
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
