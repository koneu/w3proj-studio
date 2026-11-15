// New sounds as the game's maps have them: every sound without a dialogue there has the word after the facial
// animation file ("unknown2") at 1 (counted over the game's 326 maps: plain, labelled, imported and music sounds alike;
// 0 only on dialogue). The generated script goes by it: at 0 a sound given a dialogue key later writes both keys, an
// unset one as "TRIGSTR_-1".

import assert from "node:assert/strict";
import { test } from "node:test";
import { findLabel, labelIndex, newSound, sortSounds, stepVolume, UNSET, type Sound } from "./sounds";
import { generateSections, type ScriptInput } from "../../lib/script/jass";
import { parseTriggerData } from "../../lib/triggers/triggerdata";

const label = { name: "Rain", eax: "DefaultEAXON", flags: "LOOPING", files: [] } as unknown as Parameters<typeof newSound>[2]["label"];
const made: [string, Sound][] = [
  ["plain", newSound("gg_snd_a", "Sound\\a.wav", {})],
  ["imported", newSound("gg_snd_b", "war3mapImported\\b.wav", { imported: true })],
  ["music", newSound("gg_snd_c", "Sound\\Music\\c.mp3", { music: true })],
  ["labelled", newSound("gg_snd_d", "Sound\\d.wav", { label })],
];

test("new sounds have unknown2 1, as the game maps' sounds without a dialogue", () => {
  for (const [kind, s] of made) assert.equal(s.unknown2, 1, kind);
});

test("a new sound given a dialogue text key writes that key only (editor 7000 on), not an unset speaker key", () => {
  const s = { ...newSound("gg_snd_S", "Sound\\a.wav", {}), dialogueTextKey: 60 };
  const info = {
    name: "M", author: "A", description: "D", version: 25, editorVersion: 7003, flags: 0, tileset: "L", cameraBounds: [-1024, -1024, 1024, 1024], soundEnvironment: "", lightEnvironment: "",
    players: [{ id: 0, controller: 1, race: 1, fixedStart: 0, name: "P", start: [0, 0], allyLow: 0, allyHigh: 0 }], forces: [{ flags: 0, players: 1, name: "F" }],
  };
  const sections = generateSections({ info, data: parseTriggerData(""), lights: { terrain: "T.mdl", unit: "U.mdl" }, sounds: [s] } as unknown as ScriptInput);
  const text = sections.get("Sound Assets") ?? "";
  assert.match(text, /call SetDialogueTextKey\( gg_snd_S, "TRIGSTR_60" \)/);
  assert.doesNotMatch(text, /TRIGSTR_-1/);
});

test("Sort Sound Variables orders by name regardless of case, keeps equal names in order, and leaves the list alone", () => {
  const list = ["gg_snd_Delta", "gg_snd_alpha", "gg_snd_Charlie", "gg_snd_bravo", "gg_snd_ALPHA"].map((name) => ({ name }));
  const sorted = sortSounds(list);
  assert.deepEqual(sorted.map((s) => s.name), ["gg_snd_alpha", "gg_snd_ALPHA", "gg_snd_bravo", "gg_snd_Charlie", "gg_snd_Delta"]);
  assert.equal(list[0].name, "gg_snd_Delta");
  assert.equal(sorted[0], list[1]);
  assert.deepEqual(sortSounds(sorted), sorted);
});

test("the preview volume steps by a tenth and stays within 0 and 1", () => {
  let v = 1;
  for (let i = 0; i < 3; i++) v = stepVolume(v, -1);
  assert.equal(v, 0.7);
  for (let i = 0; i < 12; i++) v = stepVolume(v, 1);
  assert.equal(v, 1);
  for (let i = 0; i < 12; i++) v = stepVolume(v, -1);
  assert.equal(v, 0);
});

test("the generated script declares and sets up the sounds in the list's order", () => {
  const info = {
    name: "M", author: "A", description: "D", version: 25, editorVersion: 7003, flags: 0, tileset: "L", cameraBounds: [-1024, -1024, 1024, 1024], soundEnvironment: "", lightEnvironment: "",
    players: [{ id: 0, controller: 1, race: 1, fixedStart: 0, name: "P", start: [0, 0], allyLow: 0, allyHigh: 0 }], forces: [{ flags: 0, players: 1, name: "F" }],
  };
  const text = (names: string[]) => generateSections({ info, data: parseTriggerData(""), lights: { terrain: "T.mdl", unit: "U.mdl" },
    sounds: names.map((n) => newSound(`gg_snd_${n}`, `Sound\\${n}.wav`, {})) } as unknown as ScriptInput).get("Sound Assets") ?? "";
  const order = (t: string) => [...t.matchAll(/set gg_snd_(\w+) = CreateSound/g)].map((m) => m[1]);
  assert.deepEqual(order(text(["b", "a", "c"])), ["b", "a", "c"]);
  assert.deepEqual(order(text(["a", "c", "b"])), ["a", "c", "b"]);
});

// The World Editor's own save (we-compare spec sound-flags-we, 2026-11-15): AchievementEarned and AAGAREK_Death1 by
// Use As Sound, war3mapImported\beep.wav imported and used. The label rows as UISounds.slk and DialogSounds.slk have them.
const ROWS = [[
  { SoundName: "AchievementEarned", FileNames: "Sound/Interface/AchievementEarned.flac", Volume: "127", Pitch: "1", PitchVariance: "1", Priority: "1000",
    Channel: "8", Flags: "0", MinDistance: "0", MaxDistance: "0", DistanceCutoff: "10000", EAXFlags: "0" },
  { SoundName: "AAGarek_Death1", FileNames: "Sound/Dialogue/Extra/AAGAREK_Death1.ogg", Volume: "120", Pitch: "1", PitchVariance: "1", Priority: "1000",
    Channel: "0", Flags: "CHANNELFULLPREEMPT,LISTFULLPREEMPT,DIALOG", MinDistance: "3000", MaxDistance: "10000", DistanceCutoff: "100000", EAXFlags: "DefaultEAXON" },
]];
const pick = (s: Sound, keys: string[]) => Object.fromEntries(keys.map((k) => [k, s[k]]));
const KEYS = ["file", "assetFile", "eaxEffect", "flags", "fadeInRate", "fadeOutRate", "volume", "pitch", "pitchVariance", "priority", "channel",
  "minDistance", "maxDistance", "distanceCutoff", "coneInside", "coneOutside", "coneOutsideVolume", "coneOrientation", "assetLabel"];

test("a labelled game sound takes the label's values as the World Editor saves them (the game's defaults unset)", () => {
  const index = labelIndex(ROWS);
  // The editor's file list names it with `\`; the sound is stored with `/`.
  const a = newSound("gg_snd_AchievementEarned", "Sound\\Interface\\AchievementEarned.flac", { label: findLabel(index, "Sound\\Interface\\AchievementEarned.flac") });
  assert.deepEqual(pick(a, KEYS), {
    file: "Sound/Interface/AchievementEarned.flac", assetFile: "Sound/Interface/AchievementEarned.flac", eaxEffect: "DefaultEAXON", flags: 0,
    fadeInRate: 0, fadeOutRate: 0, volume: 127, pitch: UNSET, pitchVariance: 1, priority: 1000, channel: 8, minDistance: UNSET, maxDistance: 0,
    distanceCutoff: 10000, coneInside: UNSET, coneOutside: UNSET, coneOutsideVolume: -1, coneOrientation: [UNSET, UNSET, UNSET], assetLabel: "AchievementEarned",
  });
  const g = newSound("gg_snd_AAGAREK_Death1", "Sound\\Dialogue\\Extra\\AAGAREK_Death1.ogg", { label: findLabel(index, "Sound\\Dialogue\\Extra\\AAGAREK_Death1.ogg") });
  assert.deepEqual(pick(g, KEYS), {
    file: "Sound/Dialogue/Extra/AAGAREK_Death1.ogg", assetFile: "Sound/Dialogue/Extra/AAGAREK_Death1.ogg", eaxEffect: "DefaultEAXON", flags: 0,
    fadeInRate: 0, fadeOutRate: 0, volume: 120, pitch: UNSET, pitchVariance: 1, priority: 1000, channel: -1, minDistance: 3000, maxDistance: UNSET,
    distanceCutoff: 100000, coneInside: UNSET, coneOutside: UNSET, coneOutsideVolume: -1, coneOrientation: [UNSET, UNSET, UNSET], assetLabel: "AAGarek_Death1",
  });
});

test("a sound for an imported file is stored as the World Editor saves it", () => {
  const b = newSound("gg_snd_beep", "war3mapImported\\beep.wav", { imported: true });
  assert.deepEqual(pick(b, KEYS), {
    file: "war3mapImported/beep.wav", assetFile: "war3mapImported/beep.wav", eaxEffect: "DefaultEAXON", flags: 16, fadeInRate: 0, fadeOutRate: 0,
    volume: 127, pitch: 1, pitchVariance: 0, priority: 100, channel: 0, minDistance: 0, maxDistance: 10000, distanceCutoff: 3000, coneInside: 0,
    coneOutside: 0, coneOutsideVolume: 127, coneOrientation: [0, 0, 0], assetLabel: "",
  });
});

test("the three sounds' InitSounds lines are the World Editor's (AchievementEarned keeps its label's channel 8: no SetSoundChannel)", () => {
  const index = labelIndex(ROWS);
  const files = ["Sound\\Interface\\AchievementEarned.flac", "war3mapImported\\beep.wav", "Sound\\Dialogue\\Extra\\AAGAREK_Death1.ogg"];
  const names = ["gg_snd_AchievementEarned", "gg_snd_beep", "gg_snd_AAGAREK_Death1"];
  const sounds = files.map((f, i) => newSound(names[i], f, i === 1 ? { imported: true } : { label: findLabel(index, f) }));
  const info = {
    name: "M", author: "A", description: "D", version: 25, editorVersion: 6116, flags: 0, tileset: "L", cameraBounds: [-1024, -1024, 1024, 1024], soundEnvironment: "", lightEnvironment: "",
    players: [{ id: 0, controller: 1, race: 1, fixedStart: 0, name: "P", start: [0, 0], allyLow: 0, allyHigh: 0 }], forces: [{ flags: 0, players: 1, name: "F" }],
  };
  // UI\SoundInfo as lib/script/jass parseSoundLabels reads it.
  const labels: Record<string, { channel: number; pitch: number; minDistance: number; maxDistance: number; distanceCutoff: number }> = {
    AchievementEarned: { channel: 8, pitch: 1, minDistance: 0, maxDistance: 0, distanceCutoff: 10000 },
    AAGarek_Death1: { channel: 0, pitch: 1, minDistance: 3000, maxDistance: 10000, distanceCutoff: 100000 },
  };
  const text = generateSections({ info, data: parseTriggerData(""), lights: { terrain: "T.mdl", unit: "U.mdl" }, sounds, soundLabel: (l: string) => labels[l] } as unknown as ScriptInput)
    .get("Sound Assets") ?? "";
  const body = text.split("\r\n").filter((l) => l.startsWith("    "));
  assert.deepEqual(body, [
    '    set gg_snd_AchievementEarned = CreateSound( "Sound/Interface/AchievementEarned.flac", false, false, false, 0, 0, "DefaultEAXON" )',
    '    call SetSoundParamsFromLabel( gg_snd_AchievementEarned, "AchievementEarned" )',
    "    call SetSoundVolume( gg_snd_AchievementEarned, 127 )",
    '    set gg_snd_beep = CreateSound( "war3mapImported/beep.wav", false, false, false, 0, 0, "DefaultEAXON" )',
    "    call SetSoundChannel( gg_snd_beep, 0 )",
    "    call SetSoundVolume( gg_snd_beep, 127 )",
    "    call SetSoundPitch( gg_snd_beep, 1.0 )",
    '    set gg_snd_AAGAREK_Death1 = CreateSound( "Sound/Dialogue/Extra/AAGAREK_Death1.ogg", false, false, false, 0, 0, "DefaultEAXON" )',
    '    call SetSoundParamsFromLabel( gg_snd_AAGAREK_Death1, "AAGarek_Death1" )',
    "    call SetSoundVolume( gg_snd_AAGAREK_Death1, 120 )",
  ]);
});
