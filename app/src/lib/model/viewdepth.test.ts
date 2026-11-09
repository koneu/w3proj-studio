import assert from "node:assert/strict";
import { test } from "node:test";
import { mat4 } from "./renderer";
import { eyeDistance, ViewDepth, waterSeenDepth } from "./viewdepth";

test("a depth picture's value gives back the eye distance it was drawn at, for the terrain view's projection", () => {
  // The terrain view's near and far planes at a camera distance of 1500 (renderer.ts drawFrame).
  const near = Math.max(10, 1500 / 50), far = 1500 * 10;
  const p = mat4.perspective(Math.PI / 4, 1184 / 844, near, far);
  for (const z of [near, 200, 1369, 4000, far]) {
    // A point z in front of the eye (eye space looks along -z): its depth as the GPU writes it (0–1).
    const clipZ = p[10] * -z + p[14], clipW = p[11] * -z + p[15];
    const d = (clipZ / clipW + 1) / 2;
    assert.ok(Math.abs(eyeDistance(d, near, far) - z) < z * 1e-5, `${z}: ${eyeDistance(d, near, far)}`);
  }
});

test("the water a pixel shows is the bed's, or less where a model under the surface is nearer", () => {
  // A swimming naga's tail 20 under the surface of water 440 deep: 20 of water in front of it.
  assert.equal(waterSeenDepth(440, 0, -20), 20);
  // Nothing behind the surface but the bed: the bed's depth, as before.
  assert.equal(waterSeenDepth(38, 120, null), 38);
  // A model's point deeper than the bed under the surface (seen at a slant, past a slope): never more than the bed's.
  assert.equal(waterSeenDepth(38, 120, 0), 38);
  // A point at or above the surface: no water in front of it.
  assert.equal(waterSeenDepth(100, 50, 60), 0);
});

/** A WebGL context that records the calls that make and free the depth picture's texture and framebuffer. */
function recordingGl(opts: { complete?: () => boolean; lost?: () => boolean } = {}) {
  const made: string[] = [], freed: string[] = [], sizes: number[][] = [];
  const listeners = new Map<string, () => void>();
  let n = 0;
  const gl = new Proxy({
    canvas: { addEventListener: (k: string, f: () => void) => listeners.set(k, f), removeEventListener: (k: string) => listeners.delete(k) },
    isContextLost: () => opts.lost?.() ?? false,
    createTexture: () => { const t = `tex${n++}`; made.push(t); return t; },
    createFramebuffer: () => { const f = `fbo${n++}`; made.push(f); return f; },
    deleteTexture: (t: string) => freed.push(t),
    deleteFramebuffer: (f: string) => freed.push(f),
    texStorage2D: (_t: number, _l: number, _f: number, w: number, h: number) => sizes.push([w, h]),
    checkFramebufferStatus: () => (opts.complete?.() ?? true ? 36053 : 0),
    FRAMEBUFFER_COMPLETE: 36053,
  } as Record<string, unknown>, {
    get: (t, k) => (k in t ? t[k as string] : typeof k === "string" && /^[A-Z_0-9]+$/.test(k) ? 1 : () => undefined),
  }) as unknown as WebGL2RenderingContext;
  return { gl, made, freed, sizes, lose: () => listeners.get("webglcontextlost")?.(), listeners };
}

test("the depth picture is made at the view's size, made again when it changes, and freed on dispose", () => {
  const r = recordingGl();
  const depth = new ViewDepth(r.gl);
  assert.equal(depth.begin(1184, 844), true);
  const first = depth.end();
  assert.ok(first);
  assert.equal(depth.begin(1184, 844), true, "the same size again: kept");
  assert.equal(depth.end(), first);
  assert.deepEqual(r.sizes, [[1184, 844]]);
  assert.equal(depth.begin(800, 600.4), true);
  assert.notEqual(depth.end(), first, "another size: a new texture");
  assert.deepEqual(r.sizes, [[1184, 844], [800, 600]]);
  assert.equal(r.freed.length, 2, "the old texture and framebuffer were freed");
  depth.dispose();
  assert.deepEqual([...r.freed].sort(), [...r.made].sort(), "everything made is freed");
  assert.equal(r.listeners.size, 0, "the context-loss listener is gone");
});

test("a lost context makes the picture again once it's back; a GPU that refuses the framebuffer turns it off", () => {
  let lost = false;
  const r = recordingGl({ lost: () => lost });
  const depth = new ViewDepth(r.gl);
  assert.equal(depth.begin(100, 100), true);
  depth.end();
  lost = true;
  r.lose();
  assert.equal(depth.begin(100, 100), false, "nothing to draw into meanwhile");
  lost = false;
  assert.equal(depth.begin(100, 100), true, "made again");
  assert.equal(r.sizes.length, 2);

  let complete = false;
  const refused = recordingGl({ complete: () => complete });
  const off = new ViewDepth(refused.gl);
  assert.equal(off.begin(100, 100), false);
  assert.deepEqual([...refused.freed].sort(), [...refused.made].sort(), "the incomplete framebuffer is freed");
  complete = true;
  assert.equal(off.begin(100, 100), false, "not tried again every frame");
  assert.equal(refused.made.length, 2);
});
