import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHeight, pastedFlags, pastedHeight, resetFixedHeight, uniformDefaultHeight, uniformHeight, unitDrawHeight } from "./objheights";
import { FIXED_HEIGHT } from "./selectionkeys";

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
