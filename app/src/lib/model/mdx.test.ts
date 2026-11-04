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
