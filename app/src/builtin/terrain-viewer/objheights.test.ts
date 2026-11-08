import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHeight, pastedFlags, pastedHeight, resetFixedHeight, uniformHeight, unitDrawHeight } from "./objheights";
import { FIXED_HEIGHT } from "./selectionkeys";

test("ships float on the water surface, whatever height the placement file gives them", () => {
  // 03_Water_Ford_Lake_Boats: the transport (hbot), destroyer and battleship are stored at z 0, the sea bed;
  // UnitData.slk gives them movetp "float". In the game they sit on the water.
  assert.equal(unitDrawHeight("float", 0, 38.4), 38.4);
  assert.equal(unitDrawHeight("float", -120, -51.2), -51.2, "a surface below zero");
  // Naga and sea turtles (amph) swim on the surface where there is water, and walk on the ground elsewhere.
  assert.equal(unitDrawHeight("amph", -60, 38.4), 38.4);
  assert.equal(unitDrawHeight("amph", 12, null), 12);
  // Others stay where they are stored: a footman wades along the river bed, a flyer keeps its height.
  for (const m of ["foot", "horse", "fly", "hover", "_", "", undefined]) assert.equal(unitDrawHeight(m, -20, 38.4), -20, String(m));
  // A ship on dry ground (no surface, or the surface under the ground) stays on the ground.
  assert.equal(unitDrawHeight("float", 64, null), 64);
  assert.equal(unitDrawHeight("float", 64, 38.4), 64);
});

test("a pasted fixed-height object keeps its height over the ground, only when preserving", () => {
  assert.equal(pastedHeight(100, 40, true, true), 140);
  assert.equal(pastedHeight(100, 40, true, false), 100);
  assert.equal(pastedHeight(100, 40, false, true), 100, "an object without a height of its own sits on the ground");
  assert.equal(pastedHeight(100, -25, true, true), 75);
});

test("pasting without preserving drops the fixed height; the other flags stay", () => {
  assert.equal(pastedFlags(2 | FIXED_HEIGHT, true), 2 | FIXED_HEIGHT);
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

test("resetting a fixed height puts the object on the ground and lets it follow again", () => {
  const r = resetFixedHeight({ position: [10, 20, 300], flags: 2 | FIXED_HEIGHT | 1 }, 96);
  assert.deepEqual(r, { position: [10, 20, 96], flags: 2 | 1 });
  assert.equal(resetFixedHeight({ position: [10, 20, 300], flags: 2 }, 96), null, "no fixed height, nothing to reset");
  assert.equal(resetFixedHeight({ position: [10, 20, 300] }, 96), null);
});
