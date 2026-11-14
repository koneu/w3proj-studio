// New sounds as the game's maps have them: every sound without a dialogue there has the word after the facial
// animation file ("unknown2") at 1 (counted over the game's 326 maps: plain, labelled, imported and music sounds alike;
// 0 only on dialogue). The generated script goes by it: at 0 a sound given a dialogue key later writes both keys, an
// unset one as "TRIGSTR_-1".

import assert from "node:assert/strict";
import { test } from "node:test";
import { newSound, sortSounds, stepVolume, type Sound } from "./sounds";
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
