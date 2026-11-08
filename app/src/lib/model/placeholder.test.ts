import assert from "node:assert/strict";
import { test } from "node:test";
import { placeholderImage, placeholderModel, PLACEHOLDER_GREEN, PLACEHOLDER_SIZE } from "./placeholder";
import { bounds } from "./renderer";

test("the placeholder is a cube of the editor's size standing on the ground", () => {
  const m = placeholderModel();
  assert.equal(PLACEHOLDER_SIZE, 128);
  const b = bounds(m);
  assert.deepEqual([b.min, b.max], [[-64, -64, 0], [64, 64, 128]]);
  const g = m.geosets[0];
  assert.equal(g.faces.length, 36, "six faces of two triangles");
  assert.ok(g.uvs.every((v) => v === 0 || v === 1), "each face has the whole texture");
});

test("every triangle of the cube faces outward, as its normal says (back faces are culled)", () => {
  const { positions: p, normals: n, faces } = placeholderModel().geosets[0];
  for (let t = 0; t < faces.length; t += 3) {
    const [a, b, c] = [faces[t], faces[t + 1], faces[t + 2]];
    const e1 = [0, 1, 2].map((k) => p[b * 3 + k] - p[a * 3 + k]), e2 = [0, 1, 2].map((k) => p[c * 3 + k] - p[a * 3 + k]);
    const cross = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const normal = [n[a * 3], n[a * 3 + 1], n[a * 3 + 2]];
    assert.ok(cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2] > 0, `triangle ${t / 3}`);
    // And the normal points away from the cube's centre (0, 0, 64).
    const centre = [0, 1, 2].map((k) => (p[a * 3 + k] + p[b * 3 + k] + p[c * 3 + k]) / 3 - (k === 2 ? 64 : 0));
    assert.ok(centre[0] * normal[0] + centre[1] * normal[1] + centre[2] * normal[2] > 0, `triangle ${t / 3} outward`);
  }
});

test("the texture is a checkerboard of four squares a side, green and black", () => {
  const img = placeholderImage();
  const { width, rgba } = img.mip(0);
  const at = (x: number, y: number) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
  const cell = width / 4;
  for (let cy = 0; cy < 4; cy++) {
    for (let cx = 0; cx < 4; cx++) {
      const want = (cx + cy) % 2 === 0 ? [...PLACEHOLDER_GREEN, 255] : [0, 0, 0, 255];
      assert.deepEqual(at(cx * cell + cell / 2, cy * cell + cell / 2), want, `square ${cx},${cy}`);
    }
  }
  assert.equal(img.hasAlpha, false);
});
