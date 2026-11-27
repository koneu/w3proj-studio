import assert from "node:assert/strict";
import { test } from "node:test";
import { describeSound, emptySounds, removeSound, setSound, type SoundFacts } from "./tools";
import { IMPORTED, LOOPING, MUSIC, THREE_D, UNSET, type SoundLabel } from "./sounds";

const rain: SoundLabel = { name: "RainAmbience", files: ["Sound\\Ambient\\Rain.flac"], eax: "DefaultEAXON", channel: 0, volume: 100, flags: "LOOPING", pitch: 1, priority: 50 };
const facts: SoundFacts = {
  fileKind: (p) => (/^sound[\\/]/i.test(p) ? "game" : /^war3mapimported[\\/]/i.test(p) ? "map" : null),
  label: (p) => (/rain/i.test(p) ? rain : undefined),
  channels: [0, 5, 8], effects: ["DefaultEAXON", "CombatSoundsEAX"],
};

test("set_sound adds a sound as the Sound Editor does: named after its file, a labelled game sound with the label's values", () => {
  const doc = emptySounds();
  const r = setSound(doc, { file: "Sound\\Ambient\\Rain.flac" }, facts);
  assert.deepEqual([r.created, r.sound.name, r.sound.file, r.sound.assetLabel, r.sound.volume, r.sound.flags & LOOPING, r.sound.channel], [true, "gg_snd_Rain", "Sound/Ambient/Rain.flac", "RainAmbience", 100, LOOPING, -1]);
  assert.equal(r.sound.pitch, UNSET, "the label's default pitch stays unset");
  // An imported file carries the imported flag; music is music.
  const horn = setSound(doc, { name: "Horn", file: "war3mapImported\\Horn.mp3", volume: 90 }, facts).sound;
  assert.deepEqual([horn.name, horn.flags, horn.volume, horn.assetFile], ["gg_snd_Horn", IMPORTED, 90, "war3mapImported/Horn.mp3"]);
  const theme = setSound(doc, { name: "gg_snd_Theme", file: "Sound\\Music\\mp3Music\\Orc1.mp3", music: true }, facts).sound;
  assert.equal(theme.flags, MUSIC);
  assert.deepEqual(describeSound(theme), { name: "gg_snd_Theme", file: "Sound/Music/mp3Music/Orc1.mp3", music: true, volume: 127, fadeInRate: 0, fadeOutRate: 0 });
  assert.equal(doc.sounds.length, 3);
});

test("set_sound changes the sound of that name, and says when nothing changed", () => {
  const doc = emptySounds();
  setSound(doc, { name: "Horn", file: "war3mapImported\\Horn.mp3" }, facts);
  const r = setSound(doc, { name: "Horn", looping: true, is3d: true, pitch: 1.5, channel: 5, effect: "CombatSoundsEAX", maxDistance: 5000, volume: null }, facts);
  assert.deepEqual([r.created, r.changed], [false, true]);
  assert.deepEqual(describeSound(doc.sounds[0]), { name: "gg_snd_Horn", file: "war3mapImported/Horn.mp3", looping: true, is3d: true, stopOutOfRange: false, channel: 5, effect: "CombatSoundsEAX",
    fadeInRate: 0, fadeOutRate: 0, pitch: 1.5, minDistance: 0, maxDistance: 5000, distanceCutoff: 3000 });
  assert.equal(doc.sounds[0].flags & THREE_D, THREE_D);
  assert.equal(setSound(doc, { name: "gg_snd_Horn", looping: true }, facts).changed, false);
  // Another file: the asset file follows.
  setSound(doc, { name: "Horn", file: "war3mapImported\\Horn2.mp3" }, facts);
  assert.deepEqual([doc.sounds[0].file, doc.sounds[0].assetFile], ["war3mapImported/Horn2.mp3", "war3mapImported/Horn2.mp3"]);
});

test("what the Sound Editor refuses is refused, and nothing changes", () => {
  const doc = emptySounds();
  setSound(doc, { name: "Horn", file: "war3mapImported\\Horn.mp3" }, facts);
  setSound(doc, { name: "Theme", file: "Sound\\Music\\Orc1.mp3", music: true }, facts);
  const before = JSON.stringify(doc);
  assert.throws(() => setSound(doc, { name: "Horn", volume: 200 }, facts), /Not changed: Volume must be a whole number from 0 to 127/);
  assert.throws(() => setSound(doc, { name: "Horn", pitch: 5 }, facts), /Pitch must be a number from 0.1 to 2/);
  assert.throws(() => setSound(doc, { name: "Horn", fadeInRate: null }, facts), /can't be unset/);
  assert.throws(() => setSound(doc, { name: "Horn", channel: 3 }, facts), /one of the game's channels \(0, 5, 8\)/);
  assert.throws(() => setSound(doc, { name: "Horn", effect: "Nope" }, facts), /DefaultEAXON, CombatSoundsEAX/);
  assert.throws(() => setSound(doc, { name: "Horn", file: "Nowhere\\X.wav" }, facts), /Neither the game nor the map's imports have/);
  assert.throws(() => setSound(doc, { name: "Horn", music: true }, facts), /is a sound: remove it and add it again/);
  assert.throws(() => setSound(doc, { name: "Theme", looping: true }, facts), /looping is for sounds; gg_snd_Theme is music/);
  assert.throws(() => setSound(doc, { name: "Theme", pitch: 1 }, facts), /pitch is for sounds/);
  assert.throws(() => setSound(doc, { name: "New" }, facts), /no sound gg_snd_New: to make it, give file. Sounds: gg_snd_Horn, gg_snd_Theme/);
  assert.throws(() => setSound(doc, { name: "9lives", file: "Sound\\A.wav" }, facts), /starts with a letter/);
  assert.throws(() => setSound(doc, {}, facts), /needs a name, or a file/);
  assert.equal(JSON.stringify(doc), before);
});

test("remove_sound takes a sound away by its name, with or without gg_snd_", () => {
  const doc = emptySounds();
  setSound(doc, { name: "Horn", file: "war3mapImported\\Horn.mp3" }, facts);
  assert.throws(() => removeSound(doc, "Nope"), /no sound gg_snd_Nope. Sounds: gg_snd_Horn/);
  assert.equal(removeSound(doc, "Horn").name, "gg_snd_Horn");
  assert.equal(doc.sounds.length, 0);
});
