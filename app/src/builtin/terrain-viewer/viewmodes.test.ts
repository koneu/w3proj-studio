import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { WHEEL_ZOOM } from "./wheelzoom";
import { anyGroundLayer, CAMERA_COMMANDS, CAMERA_STEPS, cameraBoundsCorners, cameraMoveOf, DROP_RING, EDGE_SCROLL, edgeScroll, groundLayersDrawn, lineAlong, dropRings, lightRings, nextTerrainLook, shownView, type ViewSet } from "./viewmodes";
import { HELD_COMMANDS, KEY_COMMANDS, runsAsCommand } from "./selectionkeys";
import { commandsFor, defaultBindings, eventChord, keyLabel, primaryKey } from "../../lib/keybindings";

// The View and camera keys are the terrain viewer's default key bindings (extension.json), read as the view reads them:
// what a key is bound to under terrainFocus (lib/keybindings.ts commandsFor), then the View command (any that isn't
// one of the view's own key commands) or the camera move.
const manifest = JSON.parse(readFileSync("src/builtin/terrain-viewer/extension.json", "utf8")) as { contributes: { commands: { id: string; title: string }[]; keybindings: { key: string; command: string; when?: string }[] } };
const bindings = defaultBindings([], manifest.contributes.keybindings);
type Ev = { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };
const bound = (e: Ev) => { const c = eventChord(e); return c ? commandsFor(bindings, c, { terrainFocus: true }) : []; };
const viewKeyCommand = (e: Ev) => bound(e).find(runsAsCommand) ?? null;
const cameraKey = (e: Ev) => cameraMoveOf(bound(e));
const keyOf = (command: string) => { const k = primaryKey(bindings, command); return k ? keyLabel(k) : undefined; };

const chosen: ViewSet = {
  terrain: "wireframe", doodads: false, units: true, water: false, blight: false, cliffs: false, effects: false, weather: false,
  lighting: false, fog: false, grid: "small", naval: true, heights: true, cameras: true, pathing: true, regions: true, lightRanges: true,
  cameraBounds: true, info: true,
};

test("shownView: without game view, what was chosen, start locations included", () => {
  assert.deepEqual(shownView(chosen, false), { ...chosen, starts: true });
});

test("shownView: Info Display off hides the start locations, and nothing else", () => {
  assert.deepEqual(shownView({ ...chosen, info: false }, false), { ...chosen, info: false, starts: false });
  assert.equal(shownView({ ...chosen, info: true }, true).info, false, "game view draws no info");
});

test("groundLayersDrawn: the layer an open tab draws itself is left out, the Cameras tab's too", () => {
  const all = { naval: true, heights: true, cameras: true, pathing: true, regions: true };
  assert.deepEqual(groundLayersDrawn(all, null), all);
  assert.deepEqual(groundLayersDrawn(all, "select"), all);
  assert.deepEqual(groundLayersDrawn(all, "regions"), { ...all, regions: false });
  assert.deepEqual(groundLayersDrawn(all, "pathing"), { ...all, pathing: false });
  // Else the layer's camera stays behind while one is dragged in the tab (it follows finished edits only).
  assert.deepEqual(groundLayersDrawn(all, "cameras"), { ...all, cameras: false });
  assert.deepEqual(groundLayersDrawn({ ...all, heights: false }, "cameras"), { ...all, heights: false, cameras: false });
});

test("dropRings: a ring round each unit with an item table or item sets, none for others or start locations", () => {
  const rings = dropRings([
    { id: "hfoo", position: [100, 200, 0], itemTable: -1, itemSets: [[{ id: "ratc", chance: 100 }]] },
    { id: "hfoo", position: [300, 400, 0], itemTable: 0, itemSets: [] },
    { id: "hfoo", position: [500, 600, 0], itemTable: -1, itemSets: [] },
    { id: "hkni", position: [700, 800, 0] },
    { id: "sloc", position: [0, 0, 0], itemTable: 3 },
    { id: "hfoo", position: [NaN, 0, 0], itemTable: 1 },
  ]);
  assert.deepEqual(rings.map((r) => [r.x, r.y]), [[100, 200], [300, 400]]);
  assert.ok(rings.every((r) => r.r === DROP_RING.r && r.rgb.every((c) => c === 255)));
  assert.equal(viewKeyCommand(key("i")), "w3.terrain.toggleInfoDisplay");
});

test("shownView: game view shows the map as the game does, whatever was chosen, and the choice comes back after", () => {
  const game = shownView(chosen, true);
  // The map's own look: all on, lit and fogged.
  for (const k of ["doodads", "units", "water", "blight", "cliffs", "effects", "weather", "lighting", "fog"] as const) assert.equal(game[k], true, k);
  assert.equal(game.terrain, "textured");
  // None of the editor's marks.
  for (const k of ["naval", "heights", "cameras", "pathing", "regions", "lightRanges", "cameraBounds", "starts"] as const) assert.equal(game[k], false, k);
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
  // The View menu's F, G and B (we-drive --view-menu, 2026-11-10).
  assert.equal(viewKeyCommand(key("f")), "w3.terrain.toggleFogEffects");
  assert.equal(viewKeyCommand(key("f", { ctrlKey: true })), null, "Ctrl+F is Foliage");
  assert.equal(viewKeyCommand(key("g")), "w3.terrain.cycleGrid");
  assert.equal(viewKeyCommand(key("G")), "w3.terrain.cycleGrid", "caps lock");
  assert.equal(viewKeyCommand(key("b")), "w3.terrain.toggleCameraBounds");
  assert.equal(viewKeyCommand(key("b", { ctrlKey: true })), null);
  // Studio's own keys stay: T faces the selection, A selects an area, arrows and Page keys move.
  for (const k of ["t", "a", "ArrowUp", "PageUp", "Home", " "]) assert.equal(viewKeyCommand(key(k)), null, k);
  assert.equal(keyOf("w3.terrain.toggleBlight"), "H");
  assert.equal(keyOf("w3.terrain.viewSelection"), "Backquote", "the key left of 1, named by its place where the layout isn't known");
  assert.equal(keyOf("w3.terrain.viewSelectionPrevious"), "Shift+Backquote");
});

test("View Selection is the World Editor's ~ key (left of 1) on every layout, Shift goes back; each press runs one command", () => {
  const NEXT = "w3.terrain.viewSelection", PREVIOUS = "w3.terrain.viewSelectionPrevious";
  const presses: [string, Ev, string][] = [
    ["US `", key("`"), NEXT],
    ["US Shift+` (~)", key("~", { shiftKey: true }), PREVIOUS],
    ["German ^ (a dead key)", { ...key("Dead"), code: "Backquote" }, NEXT],
    ["German Shift+^ (°)", { ...key("°", { shiftKey: true }), code: "Backquote" }, PREVIOUS],
    ["US International ` (dead)", { ...key("Dead"), code: "Backquote" }, NEXT],
    ["US International Shift+` (dead ~)", { ...key("Dead", { shiftKey: true }), code: "Backquote" }, PREVIOUS],
  ];
  for (const [what, e, command] of presses) {
    const ids = bound(e);
    assert.deepEqual(ids.filter((id) => id === NEXT || id === PREVIOUS), [command], what);
    assert.equal(viewKeyCommand(e), command, what);
  }
  // Control: a dead key elsewhere (the German ´) and Ctrl with the key aren't View Selection.
  assert.deepEqual(bound({ ...key("Dead"), code: "Equal" }), []);
  assert.equal(viewKeyCommand({ ...key("`", { ctrlKey: true }), code: "Backquote" }), null);
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
  // The World Editor's zoom keys step as its wheel does (we-drive, branch key-zoom): 1.1, not about 11%.
  assert.equal(zoomOut.zoom, WHEEL_ZOOM);
  assert.ok(Math.abs(zoomIn.zoom * 1.1 - 1) < 1e-12, `Ctrl+Up zooms by ${1 / zoomIn.zoom}`);
  const left = cameraKey(key("ArrowLeft", { ctrlKey: true })) as { turn: number }, right = cameraKey(key("ArrowRight", { metaKey: true })) as { turn: number };
  assert.ok(left.turn > 0 && right.turn === -left.turn);
  for (const k of [key("ArrowUp", { altKey: true }), key("PageUp"), key("PageDown"), key("Home"), key("End"), key("Insert"), key("Delete")]) assert.equal(cameraKey(k), null, k.key);
});

test("every View key runs a command the terrain viewer declares, one per key; titles don't name keys that can change", () => {
  const ids = new Map(manifest.contributes.commands.map((c) => [c.id, c.title]));
  const view = bindings.filter((b) => runsAsCommand(b.command));
  // 17, View Selection's ~ and Shift+~ by character and by place (5 keys), and Ctrl+Shift+H (Reset Fixed Object Heights).
  assert.equal(view.length, 23, "the World Editor's View keys Studio has");
  for (const b of bindings) assert.ok(ids.has(b.command), `${b.command} (${b.key}) isn't declared`);
  // A key in brackets at the end ("(H)", "(Ctrl+T)", "(Backquote)"); a word that isn't a key ("(Previous)") may be there.
  const namesKey = (title: string, k: string) => {
    const end = /\(([^)]*)\)$/.exec(title)?.[1];
    return !!end && (end.length === 1 || /^(?:ctrl|alt|shift)\+/i.test(end) || end.toLowerCase() === keyLabel(k).toLowerCase());
  };
  for (const b of view) assert.ok(!namesKey(ids.get(b.command)!, b.key), `${b.command}'s title names a key: ${ids.get(b.command)}`);
  assert.ok(namesKey("Toggle Blight (H)", "h") && namesKey("Terrain (Ctrl+T)", "ctrl+t") && namesKey("View (Backquote)", "backquote"), "control: a key in brackets is found");
  assert.equal(new Set(view.map((b) => b.key)).size, view.length, "one View command per key");
  // Each camera command has its keys, and every key command is declared.
  for (const id of Object.keys(CAMERA_COMMANDS)) assert.ok(bindings.some((b) => b.command === id), id);
  for (const id of [...KEY_COMMANDS, ...HELD_COMMANDS]) assert.ok(ids.has(id), `${id} isn't declared`);
  // The tabs' list commands bound here are the tabs', not run as commands (no "the open tab has no list" note).
  for (const b of bindings) if (b.key.startsWith("ctrl+tab") || b.key === "ctrl+shift+tab") assert.equal(runsAsCommand(b.command), false, b.command);
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

test("View and camera keys the webview calls Unidentified (WebKitGTK) go by the physical key (lib/keys.ts)", () => {
  const unnamed = (code: string, mods: Parameters<typeof key>[1] = {}) => ({ ...key("Unidentified", mods), code });
  assert.equal(viewKeyCommand(unnamed("KeyV")), "w3.terrain.toggleGameView");
  assert.equal(viewKeyCommand(unnamed("KeyL", { ctrlKey: true, shiftKey: true })), "w3.terrain.toggleLightRanges");
  assert.deepEqual(cameraKey(unnamed("ArrowLeft")), { pan: [-CAMERA_STEPS.pan, 0] });
  assert.deepEqual(cameraKey(unnamed("Numpad8")), { pan: [0, CAMERA_STEPS.pan] });
  assert.equal(viewKeyCommand(unnamed("KeyG")), "w3.terrain.cycleGrid");
});

test("edgeScroll: the pointer at a side of the view scrolls toward it, corners both ways, inside or outside nothing", () => {
  const e = EDGE_SCROLL.edge, w = 800, h = 600;
  assert.deepEqual(edgeScroll(0, 300, w, h), [-1, 0]);
  assert.deepEqual(edgeScroll(w - 1, 300, w, h), [1, 0]);
  assert.deepEqual(edgeScroll(400, 0, w, h), [0, 1], "top scrolls up (north)");
  assert.deepEqual(edgeScroll(400, h - 1, w, h), [0, -1]);
  assert.deepEqual(edgeScroll(1, 1, w, h), [-1, 1]);
  assert.deepEqual(edgeScroll(e - 1, 300, w, h), [-1, 0]);
  assert.equal(edgeScroll(e, 300, w, h), null, "just past the edge band");
  assert.equal(edgeScroll(400, 300, w, h), null);
  // Outside the view (the pointer left it), or a view too small to have a middle: nothing.
  for (const [x, y] of [[-1, 300], [w, 300], [400, -1], [400, h], [NaN, 0]]) assert.equal(edgeScroll(x, y, w, h), null, `${x},${y}`);
  assert.equal(edgeScroll(0, 0, 10, 10), null);
});

test("camera bounds: the w3i's four corners in the order round, a line along them that can follow the ground", () => {
  // HillsbradCreek's: lower left, upper right, upper left, lower right.
  const corners = cameraBoundsCorners({ cameraBounds: [-7680, -7936, 7680, 7936, -7680, 7936, 7680, -7936] })!;
  assert.deepEqual(corners, [[-7680, -7936], [7680, -7936], [7680, 7936], [-7680, 7936]]);
  assert.equal(cameraBoundsCorners({ cameraBounds: [0, 0, 1, 1] }), null, "too few numbers");
  assert.equal(cameraBoundsCorners({ cameraBounds: [0, 0, 1, 1, 0, 1, NaN, 0] }), null);
  assert.equal(cameraBoundsCorners(null), null);
  const line = lineAlong([[0, 0], [256, 0], [256, 128], [0, 128]], 64);
  assert.equal(line.length, 4 + 2 + 4 + 2);
  assert.deepEqual(line.slice(0, 5), [[0, 0], [64, 0], [128, 0], [192, 0], [256, 0]]);
  for (let i = 0; i < line.length; i++) {
    const [a, b] = [line[i], line[(i + 1) % line.length]];
    assert.ok(Math.hypot(b[0] - a[0], b[1] - a[1]) <= 64 + 1e-9);
  }
  // A huge map stays within the cap.
  assert.ok(lineAlong(corners, 1, 1000).length <= 1004);
});
