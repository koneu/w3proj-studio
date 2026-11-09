import assert from "node:assert/strict";
import { test } from "node:test";
import { castingSun, fitSunBox, groundInView, LOWEST_SUN, sunAxes, sunShadowFrame, sunViewProj, toSun, viewRays, type ViewGround } from "./sunshadow";
import type { Mat4, Vec3 } from "./renderer";

const apply = (m: Mat4, p: readonly number[]): Vec3 => {
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [0, 1, 2].map((r) => (m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]) / w) as Vec3;
};
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

// cliff.w3m's sun (lightAt of its lighting model): from the south-west, 52° from straight up.
const CLIFF_SUN: Vec3 = [-0.675, -0.406, 0.616];

test("the sun shadows are cast from is a unit direction, raised to LOWEST_SUN when it's lower, the same way round", () => {
  const s = castingSun([-2, -1.2, 1.8]);
  assert.ok(near(Math.hypot(...s), 1));
  assert.ok(near(s[0] / s[1], 2 / 1.2), "same direction across the ground");
  const low = castingSun([1, 1, 0.01]);
  assert.ok(near(low[2], LOWEST_SUN) && near(Math.hypot(...low), 1) && near(low[0], low[1]));
  assert.deepEqual(castingSun([1, 0, -1]).map((v) => +v.toFixed(3)), [+Math.sqrt(1 - LOWEST_SUN ** 2).toFixed(3), 0, LOWEST_SUN], "below the horizon: raised");
  assert.deepEqual(castingSun([0, 0, -1]), [0, 0, 1], "straight up from below: overhead");
  assert.deepEqual(castingSun([NaN, 0, 0]), [0, 0, 1]);
});

test("the sun's axes are at right angles, and a point toward the sun is nearer in the map, at the same spot across it", () => {
  for (const dir of [CLIFF_SUN, [0, 0, 1], [0, 1, 0.3], [0.3, -0.4, 0.85]] as Vec3[]) {
    const a = sunAxes(dir);
    for (const [u, v] of [[a.right, a.up], [a.up, a.toward], [a.toward, a.right]]) assert.ok(near(u[0] * v[0] + u[1] * v[1] + u[2] * v[2], 0), `${dir}`);
    for (const u of [a.right, a.up, a.toward]) assert.ok(near(Math.hypot(...u), 1));
    const ground: Vec3 = [300, -200, 50], above: Vec3 = [300 + a.toward[0] * 500, -200 + a.toward[1] * 500, 50 + a.toward[2] * 500];
    const g = toSun(a, ground), h = toSun(a, above);
    assert.ok(near(g[0], h[0]) && near(g[1], h[1]), "the same spot across the map");
    assert.ok(near(g[2] - h[2], 500), "500 nearer the sun");
  }
});

test("a model's shadow falls away from the sun: what stands on the ground shades the spot behind it, seen from the sun", () => {
  // The top of a 200 high footman at the origin and the ground spot its shadow reaches line up in the map.
  const sun = castingSun(CLIFF_SUN), a = sunAxes(sun);
  const box = fitSunBox(a, [[-1000, -1000, 0], [1000, 1000, 0]], 400, 1024);
  const m = sunViewProj(a, box);
  const top = apply(m, [0, 0, 200]);
  const reach = 200 / sun[2];
  const spot = apply(m, [-sun[0] * reach, -sun[1] * reach, 0]);
  assert.ok(near(top[0], spot[0]) && near(top[1], spot[1]), `${top} ${spot}`);
  assert.ok(top[2] < spot[2], "the top is nearer the sun than the ground behind it");
  // The shadow lies to the north-east, away from a sun in the south-west.
  assert.ok(-sun[0] * reach > 0 && -sun[1] * reach > 0);
});

test("the fitted box holds every ground point in view and anything up to the caster height above them that shades it", () => {
  const a = sunAxes(CLIFF_SUN);
  const ground: Vec3[] = [[-2000, -1500, -100], [2500, -1500, 0], [2500, 1800, 300], [-2000, 1800, 120]];
  const box = fitSunBox(a, ground, 600, 2048);
  const m = sunViewProj(a, box);
  for (const p of ground) {
    for (const lift of [0, 300, 600]) {
      // The point `lift` above the ground on the sun's ray through p: a caster there shades p.
      const k = lift / a.toward[2];
      const c = apply(m, [p[0] + a.toward[0] * k, p[1] + a.toward[1] * k, p[2] + a.toward[2] * k]);
      for (const v of c) assert.ok(v >= -1 && v <= 1, `${p} + ${lift}: ${c}`);
    }
  }
  // A caster above that is out of the box toward the sun: proof the box isn't merely huge.
  const over = apply(m, [ground[0][0] + a.toward[0] * 5000, ground[0][1] + a.toward[1] * 5000, ground[0][2] + a.toward[2] * 5000]);
  assert.ok(over[2] < -1, `${over}`);
});

test("the box keeps its size and texel grid while the view moves a little, so shadows don't crawl", () => {
  const a = sunAxes(CLIFF_SUN), size = 2048;
  const at = (dx: number) => fitSunBox(a, [[-2000 + dx, -1500, 0], [2000 + dx, 1500, 0]], 400, size);
  const b0 = at(0), b1 = at(37), b2 = at(91);
  const w = b0.right - b0.left;
  assert.equal(b1.right - b1.left, w);
  assert.equal(b2.right - b2.left, w);
  for (const b of [b0, b1, b2]) {
    const texel = w / size;
    assert.ok(near(b.left / texel, Math.round(b.left / texel), 1e-6), "the corner on a texel");
  }
  // Sizes go in eighths of an octave: a quarter more ground is a bigger box, a little more isn't.
  const wide = fitSunBox(a, [[-2500, -1500, 0], [2500, 1500, 0]], 400, size);
  assert.ok(wide.right - wide.left > w);
  assert.ok((wide.right - wide.left) / w <= 2 ** (3 / 8) + 1e-9);
});

test("the ground in view: the picture's corners on the ground, inside the map and the reach", () => {
  // The World Editor's opening camera on a 64 × 64 map: 2738 from the middle, 57° down, looking north.
  const target: Vec3 = [0, 0, 0], pitch = (57.2 * Math.PI) / 180, d = 2738;
  const eye: Vec3 = [0, -d * Math.cos(pitch), d * Math.sin(pitch)];
  const view: ViewGround = { eye, rays: viewRays(eye, target, (41.06 * Math.PI) / 180, 1184 / 844), zMin: -200, zMax: 400, reach: 3 * d, rect: [-4096, -4096, 4096, 4096] };
  const pts = groundInView(view);
  assert.equal(pts.length, 11);
  for (const p of pts) assert.ok(p[0] >= -4096 && p[0] <= 4096 && p[1] >= -4096 && p[1] <= 4096 && p[2] >= -200 && p[2] <= 400);
  // The middle ray reaches the ground at the target (between the two heights' crossings).
  const mid = pts.slice(8, 10);
  assert.ok(mid[0][1] < 0 && mid[1][1] > 0, `${mid}`);
  // Seen from the sun the box is a few thousand across: at 2048 texels, a texel is a few units on the ground.
  const f = sunShadowFrame(CLIFF_SUN, view, 400, 2048);
  assert.ok(f && f.texel > 1 && f.texel < 6, `texel ${f?.texel}`);
});

test("a view of nothing but the ground off the map casts no shadows (app-smoke's look at 40000, 40000)", () => {
  const at = (x: number, y: number) => {
    const target: Vec3 = [x, y, 0], eye: Vec3 = [x, y - 1500, 2300];
    return { eye, rays: viewRays(eye, target, Math.PI / 4, 1.4), zMin: 0, zMax: 200, reach: 8000, rect: [-1024, -1024, 1024, 1024] as [number, number, number, number] };
  };
  assert.equal(groundInView(at(40000, 40000)).length, 0);
  assert.equal(sunShadowFrame(CLIFF_SUN, at(40000, 40000), 800, 2048), null);
  // The control: the same camera over the map, and over its edge, does.
  assert.equal(groundInView(at(0, 0)).length, 11);
  assert.ok(sunShadowFrame(CLIFF_SUN, at(1900, 0), 800, 2048), "the map's edge in view");
});

test("a camera looking along the ground reaches no farther than its reach, nor past the map", () => {
  const eye: Vec3 = [0, 0, 300];
  const view: ViewGround = { eye, rays: viewRays(eye, [0, 10000, 290], Math.PI / 4, 1.5), zMin: 0, zMax: 100, reach: 5000, rect: [-20000, -20000, 20000, 20000] };
  for (const p of groundInView(view)) assert.ok(Math.hypot(p[0] - eye[0], p[1] - eye[1]) <= 5000 + 1, `${p}`);
  const small: ViewGround = { ...view, rect: [-1000, -500, 1000, 2000] };
  for (const p of groundInView(small)) assert.ok(p[0] >= -1000 && p[0] <= 1000 && p[1] >= -500 && p[1] <= 2000, `${p}`);
});
