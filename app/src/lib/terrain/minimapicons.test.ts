import assert from "node:assert/strict";
import { test } from "node:test";
import { iconPixel, minimapIcons, sameIcons, startColor, type MinimapIcon } from "./minimapicons";

/** (2)EchoIsles: its terrain, camera margins, some placed units and the icons the World
 *  Editor wrote for them. */
const ECHO = { width: 129, height: 97, offsetX: -8192, offsetY: -6144, margins: [6, 6, 4, 8] };
const UNITS = [
  { id: "ngol", player: 27, position: [-5632, 3584] },
  { id: "ntav", player: 27, position: [-256, -640] },
  { id: "ngme", player: 27, position: [-256, -3328] },
  { id: "nmer", player: 27, position: [-6400, -768] },
  { id: "nmer", player: 27, position: [5888, -768] },
  { id: "sloc", player: 0, position: [-5184, 2944] },
  { id: "sloc", player: 1, position: [4672, 2944] },
  { id: "hfoo", player: 0, position: [0, 0] },
];
const STORED: [number, number, number][] = [[0, 30, 62], [1, 123, 135], [1, 123, 182], [1, 17, 137], [1, 229, 137], [2, 38, 73], [2, 208, 73]];

test("Echo Isles: the World Editor's icons, gold mines, neutral buildings, then start locations", () => {
  const icons = minimapIcons(ECHO, UNITS, (u) => (u.id === "ngol" ? 0 : u.id.startsWith("n") ? 1 : null));
  // All exact but the Goblin Merchant's y (180.97 rounds up to 181; the World Editor wrote 182).
  assert.deepEqual(icons.map((i) => [i.type, i.x, i.y]), STORED.map((s, k) => (k === 2 ? [1, 123, 181] : s)));
  assert.ok(sameIcons(icons, STORED.map(([type, x, y], k) => ({ type, x, y, color: icons[k].color }))));
  assert.deepEqual(icons[5].color, { blue: 3, green: 3, red: 255, alpha: 255 });
  assert.deepEqual(icons[6].color, startColor(1));
  assert.deepEqual(icons[0].color, { blue: 255, green: 255, red: 255, alpha: 255 });
});

test("off the minimap: pixels wrap like the stored u32", () => {
  const [x, y] = iconPixel(ECHO, -9000, 9000);
  assert.ok(x > 0xffff0000 && y > 0xffff0000);
});

test("sameIcons ignores order and 1-pixel rounding, not a moved or missing icon", () => {
  const icon = (type: number, x: number, y: number): MinimapIcon => ({ type, x, y, color: { blue: 255, green: 255, red: 255, alpha: 255 } });
  const a = [icon(0, 10, 10), icon(1, 20, 20)];
  assert.ok(sameIcons(a, [icon(1, 21, 19), icon(0, 10, 10)]));
  assert.ok(sameIcons([icon(2, 0, 5)], [icon(2, 0xffffffff, 5)]));
  assert.ok(!sameIcons(a, [icon(0, 10, 10), icon(1, 23, 20)]));
  assert.ok(!sameIcons(a, [icon(0, 10, 10)]));
  assert.ok(!sameIcons(a, [icon(0, 10, 10), icon(0, 20, 20)]));
});
