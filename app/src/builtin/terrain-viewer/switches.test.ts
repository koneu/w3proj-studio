import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SWITCH_DEFAULTS, switchedOn } from "./switches";

const manifest = JSON.parse(readFileSync("src/builtin/terrain-viewer/extension.json", "utf8")) as {
  contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
};
const declared = (key: string) => manifest.contributes.configuration.properties[key]?.default;

/**
 * The World Editor's values after its first start in a new, empty Wine prefix (we-drive with W3PROJ_WE_DIR,
 * 2026-11-12): the check marks of its menus (screenshots of each) and WorldEditPreferences.txt as it wrote it on
 * closing. Only the settings Studio has; the view items that aren't settings here (grid, camera bounds) are in the
 * terrain view's own state.
 */
const FRESH_WE: Record<string, boolean | string> = {
  // Advanced > Preserve Copied Object Height: unchecked; "Preserve Z When Copying Objects=0".
  "terrain.preserveCopiedHeight": false,
  // Advanced > Enforce Water Height Limits: checked; "Enforce Water Limits=1".
  "terrain.enforceWaterLimits": true,
  // Advanced > Enforce Camera Bounds: checked; "Enforce Camera Boundaries=1".
  "terrain.enforceCameraBounds": true,
  // Advanced > Reset Fixed Object Heights: checked; "Reset Fixed Z When Moving Objects=1".
  "terrain.resetFixedHeights": true,
  // No menu item: opening a map always puts its doodads on their grids (we-drive 2026-11-13, doodadgrid.ts).
  "terrain.doodads.snapOnLoad": true,
  // No menu item: its save puts every doodad's scale in its type's range and sets its flags (we-drive 2026-11-13,
  // doodadrules.ts).
  "terrain.doodads.fixOnLoad": true,
  // No menu item: its save writes every unit at the ground (a ship in water at the surface), whatever the file had,
  // with Reset Fixed Object Heights on or off (verification round 3, 2026-11-13; objheights.ts savedUnitZ).
  "terrain.units.groundOnSave": true,
  // View > Lock to Game View Settings: unchecked.
  "terrain.gameView": false,
  // View > Fog Effects: unchecked.
  "terrain.fog": false,
  // View > Lighting: checked.
  "terrain.lighting.enabled": true,
  // View > Shadows: checked.
  "terrain.shadows.visible": true,
  // View > Sky: unchecked; "Sky Model=0".
  "terrain.sky": "",
  // Window > Minimap: checked.
  "terrain.minimap.panel": true,
};

test("the settings Studio shares with the World Editor start as a fresh World Editor's", () => {
  for (const [key, value] of Object.entries(FRESH_WE)) assert.equal(declared(key), value, key);
  for (const [key, value] of Object.entries(SWITCH_DEFAULTS)) assert.equal(FRESH_WE[key], value, key);
});

test("the settings' declared defaults are the switches' defaults", () => {
  for (const [key, value] of Object.entries(SWITCH_DEFAULTS)) assert.equal(declared(key), value, key);
});

test("a switch that isn't set is its default; a set one is what was set", () => {
  const unset = { settings: { get: <T,>(_key: string, fallback?: T) => fallback as T } };
  for (const [key, value] of Object.entries(SWITCH_DEFAULTS)) {
    assert.equal(switchedOn(unset, key, value), value, key);
    for (const set of [true, false]) assert.equal(switchedOn({ settings: { get: <T,>() => set as T } }, key, value), set, `${key} set ${set}`);
  }
});

test("the object placer starts as a fresh World Editor's Tools menu: Randomly Rotate Doodads, Randomly Scale Doodads Symmetric", () => {
  const objects = JSON.parse(readFileSync("src/builtin/terrain-objects/extension.json", "utf8")) as typeof manifest;
  const placed = (key: string) => objects.contributes.configuration.properties[key]?.default;
  assert.equal(placed("terrain.placement.randomRotation"), true);
  assert.equal(placed("terrain.placement.randomScale"), "symmetric");
});

test("the terrain view starts with the medium grid and the camera bounds, as a fresh World Editor", () => {
  const source = readFileSync("src/builtin/terrain-viewer/index.ts", "utf8");
  assert.match(source, /const viewState = \{\s*grid: "medium" as GridSize,[^}]*cameraBounds: true,/);
});
