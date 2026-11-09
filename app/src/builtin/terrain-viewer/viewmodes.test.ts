import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { anyGroundLayer, CAMERA_STEPS, cameraKey, keyOf, lightRings, nextTerrainLook, shownView, VIEW_KEYS, viewKeyCommand, type ViewSet } from "./viewmodes";

const chosen: ViewSet = {
  terrain: "wireframe", doodads: false, units: true, water: false, blight: false, cliffs: false, effects: false, weather: false,
  lighting: false, fog: false, grid: "small", naval: true, heights: true, cameras: true, pathing: true, regions: true, lightRanges: true,
};

test("shownView: without game view, what was chosen, start locations included", () => {
  assert.deepEqual(shownView(chosen, false), { ...chosen, starts: true });
});

test("shownView: game view shows the map as the game does, whatever was chosen, and the choice comes back after", () => {
  const game = shownView(chosen, true);
  // The map's own look: all on, lit and fogged.
  for (const k of ["doodads", "units", "water", "blight", "cliffs", "effects", "weather", "lighting", "fog"] as const) assert.equal(game[k], true, k);
  assert.equal(game.terrain, "textured");
  // None of the editor's marks.
  for (const k of ["naval", "heights", "cameras", "pathing", "regions", "lightRanges", "starts"] as const) assert.equal(game[k], false, k);
  assert.equal(game.grid, "none");
  assert.equal(anyGroundLayer(game), false);
  // The same whatever the choice was: the opposite choice gives the same picture.
  const opposite = Object.fromEntries(Object.entries(chosen).map(([k, v]) => [k, typeof v === "boolean" ? !v : v])) as unknown as ViewSet;
  assert.deepEqual(shownView({ ...opposite, terrain: "hidden", grid: "large" }, true), game);
  // Off again: the choice as it was (game view doesn't change it).
  assert.deepEqual(shownView(chosen, false), { ...chosen, starts: true });
  assert.equal(anyGroundLayer(chosen), true);
});

test("terrain display goes round: textured, wireframe, hidden", () => {
  assert.equal(nextTerrainLook("textured"), "wireframe");
  assert.equal(nextTerrainLook("wireframe"), "hidden");
  assert.equal(nextTerrainLook("hidden"), "textured");
});

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

test("View keys: the World Editor's, with their modifiers exactly", () => {
  assert.equal(viewKeyCommand(key("v")), "w3.terrain.toggleGameView");
  assert.equal(viewKeyCommand(key("V")), "w3.terrain.toggleGameView", "caps lock");
  assert.equal(viewKeyCommand(key("v", { shiftKey: true })), null, "Shift+V isn't V");
  assert.equal(viewKeyCommand(key("v", { ctrlKey: true })), null, "Ctrl+V pastes");
  assert.equal(viewKeyCommand(key("t", { ctrlKey: true })), "w3.terrain.cycleTerrainDisplay");
  assert.equal(viewKeyCommand(key("t")), null);
  assert.equal(viewKeyCommand(key("d", { metaKey: true })), "w3.terrain.toggleDoodads", "Cmd counts as Ctrl");
  assert.equal(viewKeyCommand(key("L", { ctrlKey: true, shiftKey: true })), "w3.terrain.toggleLightRanges");
  assert.equal(viewKeyCommand(key("l", { ctrlKey: true })), null);
  assert.equal(viewKeyCommand(key("l")), "w3.terrain.toggleLighting");
  assert.equal(viewKeyCommand(key("r", { ctrlKey: true })), "w3.terrain.toggleRegions");
  assert.equal(viewKeyCommand(key("p", { altKey: true })), null, "Alt keys aren't View keys");
  // Studio's own keys stay: F faces the selection, A selects an area, arrows and Page keys move.
  for (const k of ["f", "a", "ArrowUp", "PageUp", "Home", " "]) assert.equal(viewKeyCommand(key(k)), null, k);
  assert.equal(keyOf("w3.terrain.toggleBlight"), "H");
  assert.equal(keyOf("w3.terrain.viewSelection"), undefined);
});

test("camera keys: arrows scroll, Shift faster, Ctrl+Up/Down zoom, Ctrl+Left/Right turn; Alt and the Page keys don't", () => {
  const pan = cameraKey(key("ArrowUp")) as { pan: [number, number] };
  assert.deepEqual(pan, { pan: [0, CAMERA_STEPS.pan] });
  assert.deepEqual(cameraKey(key("ArrowLeft")), { pan: [-CAMERA_STEPS.pan, 0] });
  const fast = cameraKey(key("ArrowRight", { shiftKey: true })) as { pan: [number, number] };
  assert.ok(Math.abs(fast.pan[0] - CAMERA_STEPS.pan * CAMERA_STEPS.fast) < 1e-12 && fast.pan[1] === 0);
  // The number pad's arrows, with Num Lock on (digits) or off (arrow keys).
  assert.deepEqual(cameraKey({ ...key("8"), code: "Numpad8" }), pan);
  assert.equal(cameraKey({ ...key("8"), code: "Digit8" }), null, "the digit row isn't an arrow");
  const zoomIn = cameraKey(key("ArrowUp", { ctrlKey: true })) as { zoom: number };
  const zoomOut = cameraKey(key("ArrowDown", { ctrlKey: true })) as { zoom: number };
  assert.ok(zoomIn.zoom < 1 && zoomOut.zoom > 1 && Math.abs(zoomIn.zoom * zoomOut.zoom - 1) < 1e-12, "in and out undo each other");
  const left = cameraKey(key("ArrowLeft", { ctrlKey: true })) as { turn: number }, right = cameraKey(key("ArrowRight", { metaKey: true })) as { turn: number };
  assert.ok(left.turn > 0 && right.turn === -left.turn);
  for (const k of [key("ArrowUp", { altKey: true }), key("PageUp"), key("PageDown"), key("Home"), key("End"), key("Insert"), key("Delete")]) assert.equal(cameraKey(k), null, k.key);
});

test("every View key runs a command the terrain viewer declares", () => {
  const manifest = JSON.parse(readFileSync("src/builtin/terrain-viewer/extension.json", "utf8")) as { contributes: { commands: { id: string; title: string }[] } };
  const ids = new Map(manifest.contributes.commands.map((c) => [c.id, c.title]));
  for (const { key: k, command } of VIEW_KEYS) {
    assert.ok(ids.has(command), `${command} (${k}) isn't declared`);
    assert.ok(ids.get(command)!.includes(`(${k})`), `${command}'s title names its key ${k}`);
  }
  assert.equal(new Set(VIEW_KEYS.map((k) => k.key)).size, VIEW_KEYS.length, "one command per key");
});

test("lightRings: round where the light is, as far as it reaches, scaled with the object", () => {
  // Turned a quarter, twice the size, standing at (1000, 500, 20): the light 10 to the model's +x, 50 up.
  const s = 2, world = [0, s, 0, 0, -s, 0, 0, 0, 0, 0, s, 0, 1000, 500, 20, 1];
  const rings = lightRings(world, [10, 0, 50], { attenuationStart: 80, attenuationEnd: 200 });
  assert.equal(rings.length, 2);
  assert.ok(Math.abs(rings[0].x - 1000) < 1e-9 && Math.abs(rings[0].y - 520) < 1e-9, `${rings[0].x}, ${rings[0].y}`);
  assert.equal(rings[0].r, 400);
  assert.equal(rings[1].r, 160);
  // No start ring when it's zero or past the end; nothing for a light that reaches nowhere.
  assert.equal(lightRings(world, [0, 0, 0], { attenuationStart: 0, attenuationEnd: 10 }).length, 1);
  assert.equal(lightRings(world, [0, 0, 0], { attenuationStart: 300, attenuationEnd: 10 }).length, 1);
  assert.deepEqual(lightRings(world, [0, 0, 0], { attenuationStart: 0, attenuationEnd: 0 }), []);
  assert.deepEqual(lightRings([NaN, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, NaN, 0, 0, 1], [0, 0, 0], { attenuationStart: 0, attenuationEnd: 5 }), []);
});
