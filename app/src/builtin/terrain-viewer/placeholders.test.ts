import assert from "node:assert/strict";
import { test } from "node:test";
import { ObjectLoader, type Placed, type Skin } from "./objects";

// Apart from objects.test.ts so that it builds against the loader as it was before the cubes, and fails there by
// what it asserts (scripts/fails-without.mjs).

/** A WebGL context that accepts every call (nothing is drawn): enough to make models and textures. */
function fakeGl(extra: Record<string, unknown> = {}): WebGL2RenderingContext {
  return new Proxy({ getError: () => 0, getAttribLocation: () => 0, getExtension: () => null, getParameter: () => 16384, ...extra } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : typeof k === "string" && /^[A-Z_0-9]+$/.test(k) ? 1 : () => ({})),
  }) as unknown as WebGL2RenderingContext;
}

const placed = (id: string, x: number, y: number, extra: Partial<Placed> = {}): Placed => ({ id, variation: 0, position: [x, y, 0], angle: 0, scale: [1, 1, 1], ...extra });
const rockSkin: Skin = {
  kind: "w3d", file: "Doodads\\LordaeronSummer\\Rocks\\SimpleRock\\SimpleRock", numVar: 10, texId: -1, texFile: "", modelScale: 1,
  minScale: 1, maxScale: 1, randScale: false, fixedRot: null, uberSplat: "",
};

test("the loader draws objects whose model doesn't load (or whose id is unknown) as cubes, not markers; start previews stay strays", async () => {
  const rock = placed("LRsr", 64, -64, { angle: 3.19 }), unknown = placed("zzzz", 0, 0), start = placed("sloc", 10, 10);
  const skins = new Map([["LRsr", rockSkin]]);
  const loader = new ObjectLoader(fakeGl(), () => Promise.reject(new Error("not stored")), () => {});
  const out = await loader.load("doodads", [rock, unknown, start], skins, () => 0);
  assert.equal(out.batches.length, 1, "one batch of cubes");
  const [cubes] = out.batches;
  assert.equal(cubes.group, "doodads", "shown and hidden with its group");
  assert.deepEqual(cubes.instances.map((i) => i.pick?.placed), [unknown, rock], "picked like a model (unknown ids are found first)");
  assert.equal(cubes.gpu.model.name, "Placeholder");
  assert.deepEqual(out.unresolved, [start], "only the start location stays a marker");
  assert.deepEqual(out.strays.map((s) => s.inst.pick?.placed), [start], "the start is still clickable, but gets no cube (game view leaves it out)");
  assert.equal(out.problems.length, 2, "both are still reported");
  const previews = await loader.load("units", [rock], skins, () => 0, undefined, undefined, false);
  assert.equal(previews.batches.length, 0, "a start building that doesn't load is left out");
  assert.equal(previews.strays.length, 1);
});

test("with the context lost (the shader doesn't compile) the objects stay markers, and a later load still makes the cube", async () => {
  const rock = placed("LRsr", 64, -64);
  const skins = new Map([["LRsr", rockSkin]]);
  let lost = true;
  const gl = fakeGl({ getShaderParameter: () => !lost, getProgramParameter: () => !lost, getShaderInfoLog: () => "context lost", isContextLost: () => lost });
  const loader = new ObjectLoader(gl, () => Promise.reject(new Error("not stored")), () => {});
  const out = await loader.load("doodads", [rock], skins, () => 0);
  assert.equal(out.batches.length, 0);
  assert.deepEqual(out.unresolved, [rock], "a marker, no unhandled rejection");
  assert.equal(out.strays.length, 1, "still selectable");
  lost = false;
  const again = await new ObjectLoader(gl, () => Promise.reject(new Error("not stored")), () => {}).load("doodads", [rock], skins, () => 0);
  assert.equal(again.batches.length, 1);
});
