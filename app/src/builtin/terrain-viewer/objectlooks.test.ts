import assert from "node:assert/strict";
import { test } from "node:test";
import { drawsParticles, ObjectLoader, type Placed, type Skin } from "./objects";
import type { ParticleEmitter2, RibbonEmitter } from "../../lib/model/mdx";
import { unitLooks, unitSwims } from "./objheights";
import { standClock } from "../../lib/model/renderer";

/** A WebGL context that accepts every call (nothing is drawn): enough to make models and textures. */
function fakeGl(): WebGL2RenderingContext {
  return new Proxy({ getError: () => 0, getAttribLocation: () => 0, getExtension: () => null, getParameter: () => 16384 } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : typeof k === "string" && /^[A-Z_0-9]+$/.test(k) ? 1 : () => ({})),
  }) as unknown as WebGL2RenderingContext;
}

/** An MDX model of nothing but these animations (name, start, end). */
function mdxOfSequences(seqs: [string, number, number][]): Uint8Array {
  const size = 132 * seqs.length;
  const buf = new Uint8Array(4 + 12 + 8 + size);
  const dv = new DataView(buf.buffer);
  const tag = (p: number, s: string) => { for (let i = 0; i < 4; i++) buf[p + i] = s.charCodeAt(i); };
  tag(0, "MDLX");
  tag(4, "VERS"); dv.setUint32(8, 4, true); dv.setUint32(12, 800, true);
  tag(16, "SEQS"); dv.setUint32(20, size, true);
  seqs.forEach(([name, start, end], i) => {
    const p = 24 + 132 * i;
    for (let k = 0; k < name.length; k++) buf[p + k] = name.charCodeAt(k);
    dv.setUint32(p + 80, start, true);
    dv.setUint32(p + 84, end, true);
  });
  return buf;
}

const placed = (x: number): Placed => ({ id: "nmyr", variation: 0, position: [x, 0, 0], angle: 0, scale: [1, 1, 1] });
const nagaSkin: Skin = {
  kind: "w3u", file: "units\\naga\\NagaMyrmidon\\NagaMyrmidon", numVar: 1, texId: -1, texFile: "", modelScale: 1,
  minScale: 1, maxScale: 1, randScale: false, fixedRot: null, uberSplat: "", moveType: "amph",
};

test("a unit given the swim look stands in its model's Stand Swim, apart from the same type on land", async () => {
  // The naga myrmidon's animations, in the order of the game's model.
  const model = mdxOfSequences([["Stand", 0, 1000], ["Stand Ready", 2000, 3000], ["Stand Swim", 4000, 5000], ["Walk Swim", 6000, 7000], ["Stand Ready Swim", 8000, 9000]]);
  const loader = new ObjectLoader(fakeGl(), () => Promise.resolve(model), () => {});
  const land = placed(0), water = placed(1000);
  const out = await loader.load("units", [land, water], new Map([["nmyr", nagaSkin]]), () => 0, undefined, undefined, true, undefined,
    (p) => (p === water ? ["swim"] : []));
  assert.equal(out.batches.length, 2, "one model per look");
  const look = (p: Placed) => {
    const b = out.batches.find((x) => x.instances.some((i) => i.pick?.placed === p))!;
    return b.gpu.model.sequences.find((s) => s.start === standClock(b.gpu.model, b.gpu.props).seqStart)?.name;
  };
  assert.equal(look(water), "Stand Swim");
  assert.equal(look(land), "Stand");
});

test("a type of several variations whose numbered file isn't stored is drawn from its plain file, not as a cube", async () => {
  // YSw5 (City wall endcap): numVar 2, but the classic storage has only CityWallEndcap.mdx.
  const endcap: Skin = { ...nagaSkin, kind: "w3d", file: "Doodads\\Cityscape\\Structures\\CityWallEndcap\\CityWallEndcap", numVar: 2, moveType: undefined };
  const read: string[] = [];
  const loader = new ObjectLoader(fakeGl(), (path) => {
    read.push(path);
    return path === "Doodads\\Cityscape\\Structures\\CityWallEndcap\\CityWallEndcap.mdx" ? Promise.resolve(mdxOfSequences([["Stand", 0, 1000]])) : Promise.reject(new Error("not stored"));
  }, () => {});
  const wall = { ...placed(0), id: "YSw5", variation: 1 };
  const out = await loader.load("doodads", [wall], new Map([["YSw5", endcap]]), () => 0);
  assert.deepEqual(read, ["Doodads\\Cityscape\\Structures\\CityWallEndcap\\CityWallEndcap1.mdx", "Doodads\\Cityscape\\Structures\\CityWallEndcap\\CityWallEndcap.mdx"]);
  assert.equal(out.batches.length, 1);
  assert.notEqual(out.batches[0].gpu.model.name, "Placeholder", "the wall's model, not the checkered cube");
  assert.deepEqual(out.problems, []);
});

test("a Reforged model's empty placeholder emitters count as no effects, so the classic ones stand in", () => {
  const emitter = (segmentAlpha: number[]) => ({ segmentAlpha }) as unknown as ParticleEmitter2;
  // The HD Lordaeron brazier (LObr): two emitters, colours and alphas all 0, beside its PopcornFX fire.
  assert.equal(drawsParticles({ particleEmitters2: [emitter([0, 0, 0]), emitter([0, 0, 0])], ribbons: [] }), false);
  assert.equal(drawsParticles({ particleEmitters2: [emitter([0, 0, 0]), emitter([21, 78, 0])], ribbons: [] }), true);
  assert.equal(drawsParticles({ particleEmitters2: [], ribbons: [{} as RibbonEmitter] }), true);
  assert.equal(drawsParticles({ particleEmitters2: [], ribbons: [] }), false);
});

test("an uprooted Ancient stands in its Alternate look, a swimming unit in its Swim one", () => {
  assert.deepEqual(unitLooks(false, false), []);
  assert.deepEqual(unitLooks(true, false), ["alternate"]);
  assert.deepEqual(unitLooks(false, true), ["swim"]);
});

test("amphibious units swim where the water is deeper than units walk; ships and walkers never", () => {
  // Map 03 with naga at several depths (we-drive): standing at 24 and 45, swimming at 62, 66 and 102.
  for (const depth of [24, 45]) assert.equal(unitSwims("amph", 200, 200 + depth), false, `depth ${depth}`);
  for (const depth of [62, 66, 102]) assert.equal(unitSwims("amph", 146, 146 + depth), true, `depth ${depth}`);
  assert.equal(unitSwims("AMPH", 0, 100), true, "the table's case doesn't matter");
  assert.equal(unitSwims("amph", 0, null), false, "no water");
  for (const m of ["float", "foot", "fly", "", undefined]) assert.equal(unitSwims(m, 0, 100), false, String(m));
});
