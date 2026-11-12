// A dialogue sound's text and speaker name, edited in the Sound Editor: strings of war3map.wts behind the sound's
// dialogueTextKey / speakerNameKey. Edits go onto the file as it is on disk at save (other editors' strings stay), a
// sound without keys gets speaker name n and text n + 1 after the highest number (as the game's campaign maps have
// them), and nothing changed writes nothing.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DialogueStrings, setDialogueString } from "./dialogue";
import { newSound, type Sound } from "./sounds";
import { StringTable, WtsCutError } from "../../lib/formats/wts";

const WTS = "﻿STRING 1\r\n{\r\nMy Map\r\n}\r\n\r\nSTRING 7\r\n// Units: H000 (Hero), Name (Name)\r\n{\r\nJaina\r\n}\r\n\r\n"
  + "STRING 8\r\n{\r\nWe must hurry.\r\nThe dead are coming.\r\n}\r\n\r\n";

const spoken = (over: Partial<Sound> = {}): Sound => ({ ...newSound("gg_snd_Line", "Sound\\Dialogue\\Line.flac", {}), unknown2: 0, speakerUnitType: "Hjai", ...over });
/** The sounds as the w3s.json holds them after a save: serialized and parsed. */
const roundTrip = (sounds: Sound[]): Sound[] => JSON.parse(JSON.stringify({ format: "w3proj.sounds/1", version: 3, sounds })).sounds;

test("a dialogue sound's text and speaker name read from the table", () => {
  const strings = new DialogueStrings(WTS);
  const s = spoken({ speakerNameKey: 7, dialogueTextKey: 8 });
  assert.equal(strings.text(s.speakerNameKey), "Jaina");
  assert.equal(strings.text(s.dialogueTextKey), "We must hurry.\r\nThe dead are coming.");
  assert.equal(strings.text(-1), "");
  assert.equal(strings.text(99), "", "a key the table lacks");
});

test("edited text: serialized and parsed back, the same text and keys; the rest of the file byte for byte", () => {
  const strings = new DialogueStrings(WTS);
  const s = spoken({ speakerNameKey: 7, dialogueTextKey: 8 });
  assert.equal(setDialogueString(s, "text", "Hurry!\nNow.", strings, [s]), true);
  const out = strings.merge(WTS)!;
  const back = new StringTable(out);
  const [saved] = roundTrip([s]);
  assert.deepEqual([saved.speakerNameKey, saved.dialogueTextKey], [7, 8], "the keys stay");
  assert.equal(back.get(saved.dialogueTextKey!), "Hurry!\r\nNow.", "the file's line ends");
  assert.equal(new DialogueStrings(out).text(saved.speakerNameKey), "Jaina");
  assert.equal(out.slice(0, out.indexOf("STRING 8")), WTS.slice(0, WTS.indexOf("STRING 8")), "the blocks before stay as they were");
});

test("the same text (a textarea's \\n for the file's \\r\\n) is no change, and nothing is written", () => {
  const strings = new DialogueStrings(WTS);
  const s = spoken({ speakerNameKey: 7, dialogueTextKey: 8 });
  assert.equal(setDialogueString(s, "text", "We must hurry.\nThe dead are coming.", strings, [s]), false);
  assert.equal(setDialogueString(s, "speaker", "Jaina", strings, [s]), false);
  assert.equal(strings.merge(WTS), null);
  // Typed and typed back: nothing to write either.
  setDialogueString(s, "speaker", "Arthas", strings, [s]);
  setDialogueString(s, "speaker", "Jaina", strings, [s]);
  assert.equal(strings.pending().size, 0);
  assert.equal(strings.merge(WTS), null);
});

test("a sound without keys gets speaker name n and text n + 1 after the highest string and key, both strings made", () => {
  const strings = new DialogueStrings(WTS);
  const other = spoken({ name: "gg_snd_Other", speakerNameKey: 20, dialogueTextKey: 21 });
  const s = spoken();
  assert.equal(setDialogueString(s, "speaker", "", strings, [other, s]), false, "nothing typed: no keys");
  assert.equal(s.dialogueTextKey, -1);
  assert.equal(setDialogueString(s, "text", "For Lordaeron!", strings, [other, s]), true);
  assert.deepEqual([s.speakerNameKey, s.dialogueTextKey], [22, 23]);
  const out = strings.merge(WTS)!;
  assert.ok(out.startsWith(WTS), "the old file stays in front");
  assert.equal(out.slice(WTS.length), "STRING 22\r\n{\r\n\r\n}\r\n\r\nSTRING 23\r\n{\r\nFor Lordaeron!\r\n}\r\n\r\n");
  const [saved] = roundTrip([s]);
  const back = new DialogueStrings(out);
  assert.equal(back.text(saved.dialogueTextKey), "For Lordaeron!");
  assert.equal(back.text(saved.speakerNameKey), "");
  assert.equal(new StringTable(out).has(22), true, "the empty speaker name is a string of its own");
  // The second field then edits its string; saved, the new strings are part of the file.
  strings.saved(out);
  assert.equal(setDialogueString(s, "speaker", "Uther", strings, [other, s]), true);
  assert.deepEqual([s.speakerNameKey, s.dialogueTextKey], [22, 23], "no new keys");
  const out2 = strings.merge(out)!;
  assert.equal(new StringTable(out2).get(22), "Uther");
  assert.equal(new StringTable(out2).get(23), "For Lordaeron!");
});

test("a map without war3map.wts: the first text makes the file", () => {
  const strings = new DialogueStrings(null);
  const s = spoken();
  setDialogueString(s, "speaker", "Thrall", strings, [s]);
  assert.deepEqual([s.speakerNameKey, s.dialogueTextKey], [1, 2]);
  const out = strings.merge(null)!;
  assert.equal(out, "﻿STRING 1\r\n{\r\nThrall\r\n}\r\n\r\nSTRING 2\r\n{\r\n\r\n}\r\n\r\n");
});

test("a war3map.wts that was there and is gone now isn't made anew", () => {
  const strings = new DialogueStrings(WTS);
  const s = spoken({ speakerNameKey: 7, dialogueTextKey: 8 });
  setDialogueString(s, "speaker", "Arthas", strings, [s]);
  assert.throws(() => strings.merge(null), /is gone now/);
});

test("other editors' strings saved meanwhile stay; a new number taken meanwhile for another text stops the save", () => {
  const strings = new DialogueStrings(WTS);
  const s = spoken({ speakerNameKey: 7, dialogueTextKey: 8 });
  setDialogueString(s, "speaker", "Arthas", strings, [s]);
  const disk = WTS.replace("My Map", "Their Map");
  const out = new StringTable(strings.merge(disk)!);
  assert.equal(out.get(1), "Their Map");
  assert.equal(out.get(7), "Arthas");

  const fresh = new DialogueStrings(WTS);
  const t = spoken();
  setDialogueString(t, "text", "Mine", fresh, [t]);
  const taken = `${WTS}STRING 10\r\n{\r\nTheirs\r\n}\r\n`;
  assert.throws(() => fresh.merge(taken), /string 10, new here/);
  // The control: the same text there already is fine.
  assert.equal(new StringTable(fresh.merge(`${WTS}STRING 9\r\n{\r\n\r\n}\r\n\r\nSTRING 10\r\n{\r\nMine\r\n}\r\n`)!).get(10), "Mine");
});

test("undo: back to before the first change writes the old text, also after a save; a new string undone isn't written", () => {
  const strings = new DialogueStrings(WTS);
  const s = spoken({ speakerNameKey: 7, dialogueTextKey: 8 });
  const before = strings.state();
  setDialogueString(s, "speaker", "Arthas", strings, [s]);
  const saved = strings.merge(WTS)!;
  strings.saved(saved);
  assert.equal(strings.pending().size, 0);
  strings.restore(before);
  assert.equal(strings.text(7), "Jaina");
  assert.equal(new StringTable(strings.merge(saved)!).get(7), "Jaina");

  const fresh = new DialogueStrings(WTS);
  const t = spoken();
  const start = fresh.state();
  setDialogueString(t, "text", "Gone", fresh, [t]);
  fresh.restore(start);
  assert.equal(fresh.merge(WTS), null);
});

test("a text the game would cut stops the save until changed", () => {
  const strings = new DialogueStrings(WTS);
  const s = spoken({ speakerNameKey: 7, dialogueTextKey: 8 });
  setDialogueString(s, "text", "One\n}two", strings, [s]);
  assert.deepEqual(strings.cuts().map((c) => c.num), [8]);
  assert.throws(() => strings.merge(WTS), WtsCutError);
  assert.equal(strings.fixCuts(), true);
  assert.equal(new StringTable(strings.merge(WTS)!).get(8), "One\r\n }two");
});
