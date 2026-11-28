import assert from "node:assert/strict";
import { test } from "node:test";
import { countingGl, tinyMdx, tinyTga } from "../../lib/testhelpers/countinggl";
import type { ModelGpu } from "../../lib/model/renderer";
import { ObjectLoader, type Placed, type Skin } from "./objects";

// What ObjectLoader.reset() forgets is deleted from the GPU once nothing draws it (release): models' buffers and arrays
// at once, a texture only when no drawn model has it.

const skin = (file: string): Skin => ({
  kind: "w3d", file, numVar: 1, texId: -1, texFile: "", modelScale: 1, minScale: 1, maxScale: 1, randScale: false, fixedRot: null, uberSplat: "",
});
const placed = (id: string): Placed => ({ id, variation: 0, position: [0, 0, 0], angle: 0, scale: [1, 1, 1] });
const skins = new Map([["AAAA", skin("Doodads\\A")], ["BBBB", skin("Doodads\\B")]]);

/** A loader whose models A and B both draw the texture "shared.tga", and C draws its own. */
function setup() {
  const c = countingGl();
  const files: Record<string, Uint8Array> = {
    "Doodads\\A.mdx": tinyMdx("shared.tga"), "Doodads\\B.mdx": tinyMdx("shared.tga", 2),
    "shared.tga": tinyTga(), "own.tga": tinyTga(),
  };
  let shown: ModelGpu[] = [];
  const loader = new ObjectLoader(c.gl, (p) => (files[p] ? Promise.resolve(files[p]) : Promise.reject(new Error(`not found: ${p}`))), () => {});
  loader.live = () => ({ gpus: shown, effects: [] });
  const load = async (ids: string[]) => (await loader.load("doodads", ids.map(placed), skins, () => 0, { placeholders: false })).batches.map((b) => b.gpu);
  return { c, loader, load, show: (g: ModelGpu[]) => { shown = g; }, files };
}

const textures = (c: ReturnType<typeof countingGl>) => c.live.texture.size;

test("reset keeps what is still drawn; release deletes it once the objects are rebuilt", async () => {
  const { c, loader, load, show } = setup();
  const first = await load(["AAAA", "BBBB"]);
  await loader.settled();
  show(first);
  const made = c.snapshot();
  const textureBefore = textures(c);

  loader.reset();
  await loader.release();
  assert.equal(c.since(made).length, 0, "nothing was made by reset");
  assert.equal(c.snapshot().size, made.size, "the old models are still drawn: nothing is deleted");
  assert.equal(first.some((g) => g.disposed), false);

  // The objects are rebuilt: new models and textures, and the old ones are no longer drawn.
  const second = await load(["AAAA", "BBBB"]);
  await loader.settled();
  show(second);
  assert.equal(c.snapshot().size > made.size, true, "both generations are on the GPU for a moment");
  await loader.release();
  assert.equal(c.snapshot().size, made.size, "back to one generation's objects");
  assert.equal(textures(c), textureBefore);
  assert.equal(first.every((g) => g.disposed), true);
  assert.equal(second.some((g) => g.disposed), false);
  assert.deepEqual(c.bad, [], "nothing deleted twice");
});

test("a retired model that is still drawn (cliffs, shoreline, sky) keeps its texture, which a model forgotten with it shares", async () => {
  const { c, loader, load, show } = setup();
  const [a, b] = await load(["AAAA", "BBBB"]);
  await loader.settled();
  // B stays drawn like a cliff model after the reset; A (an object) is rebuilt.
  show([b]);
  const shared = b.textures[0];
  assert.ok(shared, "the model has its texture");
  assert.equal(a.textures[0], shared, "one texture for both models");
  loader.reset();
  await loader.release();
  assert.equal(a.disposed, true, "the model nothing draws is deleted");
  assert.equal(b.disposed, false);
  assert.equal(c.live.texture.has(shared), true, "its texture stays: B is drawn with it");
  // Later B is replaced too.
  show([]);
  await loader.release();
  assert.equal(b.disposed, true);
  assert.equal(c.live.texture.has(shared), false, "now the shared texture goes");
  assert.deepEqual(c.bad, []);
  const deletes = { ...c.deletes };
  await loader.release();
  assert.deepEqual(c.deletes, deletes, "nothing is left to delete");
});

test("many resets don't grow the GPU's objects", async () => {
  const { c, loader, load, show } = setup();
  show(await load(["AAAA", "BBBB"]));
  await loader.settled();
  const base = c.snapshot().size;
  for (let i = 0; i < 5; i++) {
    loader.reset();
    show(await load(["AAAA", "BBBB"]));
    await loader.settled();
    await loader.release();
    assert.equal(c.snapshot().size, base, `after reset ${i + 1}`);
  }
  assert.deepEqual(c.bad, []);
});

test("a load cut off by reset is deleted too, once it has finished", async () => {
  const { c, loader, load, files } = setup();
  // The context's shared objects exist after one model; with that one gone, they are all that is left.
  await load(["AAAA"]);
  await loader.settled();
  loader.reset();
  await loader.release();
  const base = c.snapshot();
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const slow = new ObjectLoader(c.gl, (p) => (files[p] ? gate.then(() => files[p]) : Promise.reject(new Error(`not found: ${p}`))), () => {});
  slow.live = () => ({ gpus: [], effects: [] });
  const pending = slow.load("doodads", [placed("AAAA")], skins, () => 0, { placeholders: false });
  slow.reset();
  const done = slow.release();
  open();
  const { batches } = await pending;
  await done;
  await slow.settled();
  await slow.release();
  assert.equal(batches[0].gpu.disposed, true, "the model nothing draws is deleted");
  // Its texture was asked for after the reset: the new generation's (another model may share it), gone at the next reset.
  slow.reset();
  await slow.release();
  assert.equal(c.snapshot().size, base.size, "nothing of it is left");
  assert.deepEqual(c.bad, []);
});

test("without a view to say what is drawn, nothing is deleted", async () => {
  const { c, loader, load } = setup();
  const gpus = await load(["AAAA"]);
  await loader.settled();
  loader.live = null;
  loader.reset();
  const deletes = { ...c.deletes };
  await loader.release();
  assert.deepEqual(c.deletes, deletes);
  assert.equal(gpus[0].disposed, false);
});
