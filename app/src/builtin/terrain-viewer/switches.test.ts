import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SWITCH_DEFAULTS } from "./switches";

const manifest = JSON.parse(readFileSync("src/builtin/terrain-viewer/extension.json", "utf8")) as {
  contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
};
const declared = (key: string) => manifest.contributes.configuration.properties[key]?.default;

test("the Advanced switches start as the World Editor's: Preserve Copied Object Height off, Enforce Camera Bounds on", () => {
  assert.equal(SWITCH_DEFAULTS["terrain.preserveCopiedHeight"], false);
  assert.equal(SWITCH_DEFAULTS["terrain.enforceCameraBounds"], true);
  assert.equal(SWITCH_DEFAULTS["terrain.enforceWaterLimits"], false);
});

test("the settings' declared defaults are the switches' defaults", () => {
  for (const [key, value] of Object.entries(SWITCH_DEFAULTS)) assert.equal(declared(key), value, key);
});
