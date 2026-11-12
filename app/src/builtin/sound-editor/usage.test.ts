// Where the map's sounds are used, and the unused ones: GUI triggers, Custom Script actions, script texts, regions.

import assert from "node:assert/strict";
import { test } from "node:test";
import { soundUsages, unusedSounds, withoutSoundSetup, type SoundUsageInput } from "./sounds";
import type { TriggerFile } from "../../lib/triggers/wtg";

const eca = (name: string, params: { type: number; value: string }[]) => ({ kind: 2, name, enabled: true, params, children: [] });
const trigger = (name: string, ecas: ReturnType<typeof eca>[]) => ({
  type: 8, id: 1, name, description: "", isComment: 0, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent: 0, ecas,
});
const file = (...items: ReturnType<typeof trigger>[]) => ({ reforged: false, version: 7, counts: [], unknown: 2, variables: [], items }) as unknown as TriggerFile;

// What the generator writes for two sounds, plus a hand-written use of the second.
const SCRIPT = [
  "globals", "    sound gg_snd_Bell = null", "    sound gg_snd_Horn = null", "endglobals",
  "function InitSounds takes nothing returns nothing", "    set gg_snd_Bell = CreateSound( \"a.wav\", false, false, false, 10, 10, \"\" )",
  "    call SetSoundVolume( gg_snd_Bell, 127 )", "endfunction",
  "function Honk takes nothing returns nothing", "    call StartSound( gg_snd_Horn )", "endfunction",
].join("\n");

const NAMES = ["gg_snd_Bell", "gg_snd_Horn", "gg_snd_Wind", "gg_snd_Rain", "gg_snd_Lua"];

test("the generator's own sound lines don't count as use, the rest of a script does (and keeps its line)", () => {
  const stripped = withoutSoundSetup(SCRIPT);
  assert.equal(stripped.split("\n").length, SCRIPT.split("\n").length);
  assert.doesNotMatch(stripped, /gg_snd_Bell/);
  assert.match(stripped, /StartSound\( gg_snd_Horn \)/);
  const lua = "gg_snd_Lua = nil\nfunction InitSounds()\n  gg_snd_Lua = CreateSound(\"x\")\nend\nPlaySound(gg_snd_Lua)";
  assert.match(withoutSoundSetup(lua), /^\n\n\n\nPlaySound\(gg_snd_Lua\)$/);
});

test("used, unused and script-only sounds", () => {
  const input: SoundUsageInput = {
    triggers: file(
      trigger("Ring", [eca("PlaySoundBJ", [{ type: 1, value: "gg_snd_Bell" }])]),
      trigger("Custom", [eca("CustomScriptCode", [{ type: 3, value: "call StartSound(gg_snd_Wind)" }])]),
    ),
    scripts: [{ where: "map/war3map.j", text: SCRIPT, generated: true }, { where: "Custom script header", text: "// gg_snd_Rain_old is not gg_snd_Rain2" }],
    regions: [],
  };
  const uses = soundUsages(NAMES, input);
  assert.deepEqual(uses.get("gg_snd_Bell"), [{ kind: "trigger", where: "Ring" }]);
  assert.deepEqual(uses.get("gg_snd_Wind"), [{ kind: "trigger", where: "Custom" }]);
  // Only in script text (not in a trigger): used.
  assert.deepEqual(uses.get("gg_snd_Horn"), [{ kind: "script", where: "map/war3map.j", line: 10 }]);
  // Whole identifiers only: gg_snd_Rain_old and gg_snd_Rain2 are other names.
  assert.deepEqual(uses.get("gg_snd_Rain"), []);
  assert.deepEqual(unusedSounds(NAMES, input), ["gg_snd_Rain", "gg_snd_Lua"]);
});

test("a region's ambient sound is a use; case and a missing trigger file don't matter", () => {
  const input: SoundUsageInput = { triggers: null, scripts: [{ where: "x", text: null }], regions: [{ name: "Forest", sound: "gg_snd_wind" }, { name: "Plain" }] };
  assert.deepEqual(soundUsages(["gg_snd_Wind"], input).get("gg_snd_Wind"), [{ kind: "region", where: "Forest" }]);
  assert.deepEqual(unusedSounds(["gg_snd_Wind", "gg_snd_Other"], input), ["gg_snd_Other"]);
  assert.deepEqual(unusedSounds([], {}), []);
});

test("control: with the setup lines kept (not generated), nothing would be unused", () => {
  const kept: SoundUsageInput = { scripts: [{ where: "map/war3map.j", text: SCRIPT }] };
  assert.deepEqual(unusedSounds(["gg_snd_Bell"], kept), []);
});
