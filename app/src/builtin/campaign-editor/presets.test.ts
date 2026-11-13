import assert from "node:assert/strict";
import { test } from "node:test";
import { imagePresetOf, parseImagePresets, parsePresets, presetName, presetNumber, presetOptions } from "./presets";

const we = new Map([["WESTRING_CAMPAIGNSCREEN_HUMAN", "Human"], ["WESTRING_CAMPAIGNSCREEN_ORC", "Orc"]]);
const section = new Map([["NumScreens", "2"], ["00", "0,WESTRING_CAMPAIGNSCREEN_HUMAN,0,a.mdl"], ["01", "0,WESTRING_CAMPAIGNSCREEN_ORC,0,b.mdl"], ["03", "0,Plain,0,c.mdl"]]);
const presets = parsePresets(section, we);

test("a section's entries are named by their number and WESTRING", () => {
  assert.deepEqual(presets, [{ n: 0, name: "Human" }, { n: 1, name: "Orc" }, { n: 3, name: "Plain" }]);
  assert.deepEqual(parsePresets(undefined, we), []);
});

test("number to name: preset, custom file, unknown number", () => {
  assert.equal(presetName(presets, 1), "Orc");
  assert.equal(presetName(presets, -1), "Custom file");
  assert.equal(presetName(presets, 2), "Preset 2");
});

test("name to number is the inverse, also for the unknown number", () => {
  for (const n of [-1, 0, 1, 3, 2, 99]) assert.equal(presetNumber(presets, presetName(presets, n)), n);
  assert.equal(presetNumber(presets, "Nothing"), undefined);
});

test("the options always hold the current number, once", () => {
  assert.deepEqual(presetOptions(presets, 1).map(([n]) => n), [-1, 0, 1, 3]);
  assert.deepEqual(presetOptions(presets, 7).at(-1), [7, "Preset 7"]);
  assert.deepEqual(presetOptions(presets, -1)[0], [-1, "Custom file"]);
});

const images = parseImagePresets(new Map([["NumImages", "2"], ["00", "WESTRING_CAMPAIGNIMAGE_HUMAN,UI\\Widgets\\Glues\\Minimap-CustomCampaign-Human"], ["01", "Plain,a\\b"], ["02", "NoPath"]]),
  new Map([["WESTRING_CAMPAIGNIMAGE_HUMAN", "Human"]]));

test("campaign images: named by WESTRING, the file is the stored value", () => {
  assert.deepEqual(images, [{ path: "UI\\Widgets\\Glues\\Minimap-CustomCampaign-Human", name: "Human" }, { path: "a\\b", name: "Plain" }]);
});

test("a stored picture is a preset by file, ignoring case, slashes and extension; else custom", () => {
  assert.equal(imagePresetOf(images, "ui/widgets/glues/minimap-customcampaign-human.blp")?.name, "Human");
  assert.equal(imagePresetOf(images, "a\\b")?.name, "Plain");
  assert.equal(imagePresetOf(images, "mine.blp"), undefined);
  assert.equal(imagePresetOf(images, ""), undefined);
});
