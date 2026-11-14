import assert from "node:assert/strict";
import { test } from "node:test";
import { movedHeight, parseHeight, pastedFlags, pastedHeight, resetFixedHeight, savedUnitZ, uniformDefaultHeight, uniformHeight, unitDrawHeight } from "./objheights";
import { FIXED_HEIGHT } from "./selectionkeys";
import { heightAt, parseW3e, waterSurfaceAt } from "../../lib/terrain/w3e";
import { w3eFromText } from "../../lib/terrain/w3etext";
import { fragmentOf, turnFragment, type Turn } from "../../lib/terrain/fragment";
import { copyCentre, pasteCentreAt } from "./placement";

test("ships float on the water surface, whatever height the placement file gives them", () => {
  // 03_Water_Ford_Lake_Boats: the transport (hbot), destroyer and battleship are stored at z 0, the sea bed;
  // UnitData.slk gives them movetp "float". In the game they sit on the water.
  assert.equal(unitDrawHeight("float", 0, 38.4), 38.4);
  assert.equal(unitDrawHeight("float", -120, -51.2), -51.2, "a surface below zero");
  // Naga and sea turtles (amph) swim on the surface where there is water, and walk on the ground elsewhere.
  assert.equal(unitDrawHeight("amph", -60, 38.4), 38.4);
  assert.equal(unitDrawHeight("amph", 12, null), 12);
  // Without the ground (a type not known as a unit) the others stay where they are stored.
  for (const m of ["foot", "horse", "fly", "hover", "_", "", undefined]) assert.equal(unitDrawHeight(m, -20, 38.4), -20, String(m));
  // A ship on dry ground (no surface, or the surface under the ground) stays on the ground.
  assert.equal(unitDrawHeight("float", 64, null), 64);
  assert.equal(unitDrawHeight("float", 64, 38.4), 64);
  assert.equal(unitDrawHeight("float", 0, null, { ground: 64, height: 0 }), 64, "on the ground, whatever was stored");
  assert.equal(unitDrawHeight("float", 0, 38.4, { ground: -100, height: 0 }), 38.4, "on the surface over its bed");
});

test("units are drawn at their flying height over the ground, whatever height is stored", () => {
  // we-drive on copies of map 03 (2026-11-09): gryphons (moveHeight 240) stored at 0, 256 and 600 on ground 256 all
  // flew 240 over it; footmen stored at 0, 256 and 600 all stood on it; a footman given 300 flew.
  for (const stored of [0, 256, 600]) {
    assert.equal(unitDrawHeight("fly", stored, null, { ground: 256, height: 240 }), 496, `gryphon stored at ${stored}`);
    assert.equal(unitDrawHeight("foot", stored, null, { ground: 256, height: 0 }), 256, `footman stored at ${stored}`);
  }
  assert.equal(unitDrawHeight("foot", 256, null, { ground: 256, height: 300 }), 556, "a footman with a flying height");
  assert.equal(unitDrawHeight("hover", 0, null, { ground: 256, height: 50 }), 306, "a banshee hovers");
  assert.equal(unitDrawHeight("_", 7, null, { ground: 128, height: 0 }), 128, "a building on the ground");
  // Over water a flyer is over the bed, not the surface (its shadow lies close under it on the lake).
  assert.equal(unitDrawHeight("fly", 0, 38.4, { ground: -300, height: 240 }), -60);
  // A flying ship higher than the surface stays at its height.
  assert.equal(unitDrawHeight("float", 0, 38.4, { ground: -100, height: 200 }), 100);
  // A broken flying height (NaN from a damaged table) counts as none.
  assert.equal(unitDrawHeight("fly", 0, null, { ground: 10, height: NaN }), 10);
  // An object that isn't a unit type (no movement type) keeps its stored height.
  assert.equal(unitDrawHeight(undefined, 77, null, { ground: 10, height: 240 }), 77);
});

test("a pasted doodad keeps the height it was copied at when preserving, else stands on the ground", () => {
  // we-drive 2026-11-12: a fixed rock at 200 (copied over ground 0) pasted onto ground 64 stayed at 200, not 264;
  // one at 64 (over ground 64) pasted onto ground 0 stayed at 64; a plain one at 0 stayed at 0 in ground 64.
  assert.equal(pastedHeight(64, 200, true), 200);
  assert.equal(pastedHeight(0, 64, true), 64);
  assert.equal(pastedHeight(64, 0, true), 0, "a doodad that had no height of its own keeps its height too");
  // Off (the editor's default): the ground, fixed or not.
  assert.equal(pastedHeight(64, 200, false), 64);
  assert.equal(pastedHeight(-25, 0, false), -25);
});

test("preserving gives every pasted doodad a fixed height, not preserving takes it away; the other flags stay", () => {
  assert.equal(pastedFlags(2 | FIXED_HEIGHT, true), 2 | FIXED_HEIGHT);
  assert.equal(pastedFlags(2, true), 2 | FIXED_HEIGHT, "a plain doodad pasted with Preserve on is fixed (the editor saved 6)");
  assert.equal(pastedFlags(2 | FIXED_HEIGHT | 1, false), 2 | 1);
  assert.equal(pastedFlags(2, false), 2);
});

test("a height is typed as a plain number", () => {
  assert.equal(parseHeight(" 128 "), 128);
  assert.equal(parseHeight("-16,5"), -16.5);
  assert.equal(parseHeight("+.5"), 0.5);
  for (const bad of ["", "abc", "1e9", "12px", "NaN", "Infinity", "1.2.3", "--4"]) assert.equal(parseHeight(bad), null, bad);
});

test("uniform heights give every doodad the one height and a fixed flag", () => {
  const a = uniformHeight({ position: [10, 20, 5], flags: 2 }, 64);
  assert.deepEqual(a, { position: [10, 20, 64], flags: 2 | FIXED_HEIGHT });
  const noFlags = uniformHeight({ position: [1, 2, 3] }, 64);
  assert.equal(noFlags?.flags, 2 | FIXED_HEIGHT, "a doodad read without flags is a placed one");
  assert.equal(uniformHeight({ position: [1, 2, 64], flags: 2 | FIXED_HEIGHT }, 64), null, "already there");
  assert.deepEqual(uniformHeight({ position: [1, 2, 64], flags: 2 }, 64)?.flags, 2 | FIXED_HEIGHT, "same z, but it followed the ground: now it holds");
});

test("uniform heights default to the selection's mean height, as the World Editor sets them", () => {
  const at = (z: number) => ({ position: [0, 0, z] });
  assert.equal(uniformDefaultHeight([at(100), at(150), at(170.9375)]), 140.3125, "the mean, not the first doodad's height");
  assert.equal(uniformDefaultHeight([at(-32)]), -32);
  assert.equal(uniformDefaultHeight([]), null, "nothing selected");
});

test("resetting a fixed height puts the object on the ground and lets it follow again", () => {
  const r = resetFixedHeight({ position: [10, 20, 300], flags: 2 | FIXED_HEIGHT | 1 }, 96);
  assert.deepEqual(r, { position: [10, 20, 96], flags: 2 | 1 });
  assert.equal(resetFixedHeight({ position: [10, 20, 300], flags: 2 }, 96), null, "no fixed height, nothing to reset");
  assert.equal(resetFixedHeight({ position: [10, 20, 300] }, 96), null);
});

// we-drive 2026-11-12: a rock with flags 6 at 300 over ground 256, nudged right once: on (the default) it was saved at
// 256 with flags 2, off at 300 with flags 6.
test("moving a fixed doodad with Reset Fixed Object Heights on puts it on the ground and clears the flag", () => {
  const rock = { position: [0, 0, 300], flags: 2 | FIXED_HEIGHT };
  assert.deepEqual(movedHeight(rock, 256, true, true), { z: 256, flags: 2 });
  assert.deepEqual(movedHeight({ position: [0, 0, 300], flags: 2 | FIXED_HEIGHT | 1 }, 256, true, true), { z: 256, flags: 2 | 1 }, "other flags stay");
  assert.deepEqual(movedHeight({ position: [0, 0, 300], flags: FIXED_HEIGHT }, 256, true, true), { z: 256, flags: 0 });
});

test("moving a fixed doodad with Reset Fixed Object Heights off keeps its height and flags", () => {
  const rock = { position: [0, 0, 300], flags: 2 | FIXED_HEIGHT };
  assert.deepEqual(movedHeight(rock, 256, true, false), { z: 300, flags: 6 });
});

// Verification round 3 and we-drive 2026-11-13: a 64 x 64 map with a plateau at 256 (x 512..1664, y 256..1408), a ramp
// rising 64 per 128 east (x -1536..-512), a lake with its bed at -128 and its water at the default level (x -1536..-256,
// y -1664..-512); units stored at the heights below, the map saved by the World Editor and read back.
test("savedUnitZ: the World Editor saves every unit on the ground, a ship in water on the surface", () => {
  const N = 65, H = Array.from({ length: N }, () => new Array<number>(N).fill(0)), F = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  const ix = (x: number) => (x + 4096) / 128, row = (y: number) => 64 - (y + 4096) / 128;
  for (let y = 256; y <= 1408; y += 128) for (let x = 512; x <= 1664; x += 128) H[row(y)][ix(x)] = 1024;
  for (let y = 256; y <= 1408; y += 128) for (let x = -1536; x <= -512; x += 128) H[row(y)][ix(x)] = ((x + 1536) / 128) * 64;
  for (let y = -1664; y <= -512; y += 128) for (let x = -1536; x <= -256; x += 128) { H[row(y)][ix(x)] = -512; F[row(y)][ix(x)] = 4; }
  const text = ["W3E version 12", "tileset L", "custom-tilesets 0", "ground Ldrt", "cliffs CLdi", "corners 65 65", "offset -4096 -4096",
    "[height]", ...H.map((r) => r.join(" ")), "[water] all 0", "[water-bits] all 0", "[texture] all 0", "[variation] all 0",
    "[cliff-variation] all 0", "[cliff-texture] all f", "[layer] all 2", "[flags]", ...F.map((r) => r.map(String).join(""))].join("\n");
  const terrain = parseW3e(w3eFromText(text));
  const saved = (moveType: string | undefined, x: number, y: number) => Math.fround(savedUnitZ(moveType, heightAt(terrain, x, y), waterSurfaceAt(terrain, x, y)));
  // [movetp, x, y, the height the World Editor wrote] (the stored heights, 0, 300 or 500, don't count).
  const cases: [string | undefined, number, number, number][] = [
    ["foot", 768, 1024, 256], ["foot", -1024, 768, 64], ["foot", -896, -1024, -128], ["foot", 2048, -1792, 0], ["foot", 128, -128, 0],
    ["fly", 1024, 640, 256], ["fly", -512, -640, -128],
    ["float", -768, -1152, -89.6], ["float", 2048, 2048, 0],
    ["amph", -1152, -1280, -128], ["amph", -640, -768, -128],
    ["_", 1152, 896, 256], ["_", 2560, -2048, 0],
    // An item, a start location: no movement type.
    [undefined, -512, -1408, -128], [undefined, 1280, 1280, 256], [undefined, -2176, 640, 0],
  ];
  for (const [m, x, y, z] of cases) assert.equal(saved(m, x, y), Math.fround(z), `${m} at ${x}, ${y}`);
});

// we-drive 2026-11-12 again, in a prefix of its own (the item checked by default): an empty 64 x 64 map whose ground rises
// 32 per 128 east of x 512, doodads with flags 6 moved 64 right by Edit > Nudge Selection > Move Right. On: saved at the
// ground where they stopped, 80 at x 832 and 144 at x 1088, flags 2; off: at 400 and 350 with flags 6.
test("on a slope, a moved fixed doodad lands on the ground where it stops, as the World Editor's", () => {
  const row = Array.from({ length: 65 }, (_, c) => Math.max(0, Math.min(1536, (c - 36) * 128))).join(" ");
  const text = ["W3E version 12", "tileset L", "custom-tilesets 0", "ground Ldrt", "cliffs CLdi", "corners 65 65", "offset -4096 -4096",
    "[height]", ...Array.from({ length: 65 }, () => row), "[water] all 0", "[water-bits] all 0", "[texture] all 0", "[variation] all 0",
    "[cliff-variation] all 0", "[cliff-texture] all f", "[layer] all 2", "[flags] all 0"].join("\n");
  const terrain = parseW3e(w3eFromText(text));
  const crate = { position: [768, -128, 400], flags: 6 }, rock = { position: [1024, 128, 350], flags: 6 };
  assert.deepEqual(movedHeight(crate, heightAt(terrain, 832, -128), true, true), { z: 80, flags: 2 });
  assert.deepEqual(movedHeight(rock, heightAt(terrain, 1088, 128), true, true), { z: 144, flags: 2 });
  assert.deepEqual(movedHeight(crate, heightAt(terrain, 832, -128), true, false), { z: 400, flags: 6 });
  assert.deepEqual(movedHeight({ position: [1024, -128, 128], flags: 2 }, heightAt(terrain, 1088, -128), true, false), { z: 144, flags: 2 }, "a plain doodad follows the ground");
});

test("a doodad that was not moved, or has no height of its own, is the same with the switch either way", () => {
  const fixed = { position: [0, 0, 300], flags: 6 };
  for (const on of [true, false]) {
    assert.deepEqual(movedHeight(fixed, 256, false, on), { z: 300, flags: 6 }, `turned in place, switch ${on}`);
    assert.deepEqual(movedHeight({ position: [0, 0, 300], flags: 2 }, 256, true, on), { z: 256, flags: 2 }, `plain, switch ${on}`);
    assert.deepEqual(movedHeight({ position: [0, 0, 300] }, 256, true, on), { z: 256, flags: undefined }, `no flags, switch ${on}`);
  }
});

// we-drive 2026-11-12 (verify round 2, C7): four doodads of a flat map copied and pasted plain, mirrored and turned,
// with Preserve Copied Object Height off (its default) and Reset Fixed Object Heights off and on alike. Each copy was
// saved with flags 2 and height 0 (the ground), and where it went, from the paste's centre, is the turn of where it
// was from the group's; its facing went with it. The group's centre (-512, 0) and the paste centre (384, -576) for the
// pointer at (354, -573.4) are copyCentre's and pasteCentreAt's (placement.test.ts has more pastes).
test("pasted copies, plain, mirrored and turned, as the World Editor's: same offsets turned, flags 2, on the ground", () => {
  const deg = (r: number) => Math.round((r * 180) / Math.PI) % 360;
  const rad = (d: number) => (d * Math.PI) / 180;
  const src = [["LTcr", -640, -128, 300, 30, 6], ["LTbs", -352, -96, 0, 90, 2], ["LRrk", -640, 128, 0, 60, 2], ["LRrk", -384, 128, 150, 120, 6]] as const;
  const fragment = fragmentOf(src.map(([id, x, y, z, a, flags]) => ({ list: "doodads" as const, entry: { id, position: [x, y, z], angle: rad(a), flags } })), () => 0, copyCentre(src.map(([, x, y]) => [x, y])));
  const at = pasteCentreAt(354, -573.4);
  const we: Record<string, [number, number, number][]> = {
    plain: [[256, -704, 30], [544, -672, 90], [256, -448, 60], [512, -448, 120]],
    mirrorY: [[256, -448, 330], [544, -480, 270], [256, -704, 300], [512, -704, 240]],
    mirrorX: [[512, -704, 150], [224, -672, 90], [512, -448, 120], [256, -448, 60]],
    cw: [[256, -448, 300], [288, -736, 0], [512, -448, 330], [512, -704, 30]],
    ccw: [[512, -704, 120], [480, -416, 180], [256, -704, 150], [256, -448, 210]],
  };
  for (const [turn, want] of Object.entries(we)) {
    const f = turn === "plain" ? fragment : turnFragment(fragment, turn as Turn);
    const got = f.objects.map((o) => [at[0] + o.at[0], at[1] + o.at[1], deg(o.angle)]);
    assert.deepEqual(got, want, turn);
    for (const o of f.objects) {
      assert.equal(pastedFlags(Number(o.entry.flags), false), 2, `${turn}: flags`);
      assert.equal(pastedHeight(0, o.z ?? o.at[2], false), 0, `${turn}: height`);
    }
  }
});
