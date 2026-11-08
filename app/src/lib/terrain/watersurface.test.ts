import assert from "node:assert/strict";
import { test } from "node:test";
import { heightAt, waterSurfaceAt, type Corner, type Terrain } from "./w3e";

/** Rows from the north, a char per corner: `w` ground at -100 under water at 50, `.` dry ground at 0 (its stored
 *  water level the usual far-below default), `h` dry ground at 200, `s` ground at 80 with water at 50 (water under
 *  the ground: none to see). */
function lake(rows: string[]): Terrain {
  const height = rows.length, width = rows[0].length;
  const corners: Corner[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ch = rows[height - 1 - y][x];
    const ground = ch === "w" ? -100 : ch === "h" ? 200 : ch === "s" ? 80 : 0;
    const hasWater = ch === "w" || ch === "s";
    corners.push({ layer: 2, ramp: false, height: ground, rawHeight: ground * 4 + 0x2000, hasWater, water: hasWater ? 50 : -2137.6 } as Corner);
  }
  return { width, height, offsetX: 0, offsetY: 0, corners } as Terrain;
}

test("the water surface is the level the water is drawn at", () => {
  const t = lake(["www..", "www..", "www.."]);
  assert.equal(waterSurfaceAt(t, 64, 64), 50, "open water");
  // The shore tile: its dry corners keep the wet corners' level, as the drawn water does.
  assert.equal(waterSurfaceAt(t, 128 + 100, 64), 50);
  assert.ok(heightAt(t, 128 + 100, 64) < 50, "the ground there is under it");
});

test("no surface where no water is drawn: dry tiles, and water that lies under the ground", () => {
  const t = lake(["www..", "www..", "sss.."]);
  assert.equal(waterSurfaceAt(t, 3 * 128 + 64, 64), null, "dry tile");
  // A wet tile whose ground is above the water everywhere draws nothing.
  const under = lake(["sss", "sss"]);
  assert.equal(waterSurfaceAt(under, 64, 64), null);
  // The shore where the ground climbs out of the water: the surface stays, the ground rises through it.
  const shore = lake(["wwhh", "wwhh"]);
  assert.equal(waterSurfaceAt(shore, 128 + 10, 64), 50);
  assert.equal(waterSurfaceAt(shore, 2 * 128 + 64, 64), null);
});

test("past the map's edge the nearest tile counts, as heightAt does", () => {
  const t = lake(["www", "www"]);
  assert.equal(waterSurfaceAt(t, -500, -500), 50);
  assert.equal(waterSurfaceAt(t, 5000, 5000), 50);
});
