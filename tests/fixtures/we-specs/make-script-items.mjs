// Makes script-items.w3x for the map script spec (tests/we-compare/script-items.json) from flat.w3x (World Editor 7003,
// build 24371, game data version 2):
//
//   node tests/fixtures/we-specs/make-script-items.mjs <w3proj cli> [game folder]   (the game folder defaults to the checkout's)
//
// One map holds the open map-script questions of test.md (branch we-script-items), so one open and save in the editor
// answers them all; its war3map.j is then held against Studio's (`w3proj rebuild --only=script --force`):
// - gold mines: n000 (ngol, own ability list Avul without Agld), n001 (ngol, no change), n002 (ngol, Avul,Agld), n003
//   (hfoo given Agld): which get SetResourceAmount?
// - colours and skills: H000 (Hpal allowing a custom team colour, utcc 1) placed with colour 5, level 6, attributes
//   30/20/25, life 50 %, mana 100, acquisition range 500, learned custom abilities A000 (on AHtb: no autocast), A001 and
//   A002 (on AHfa: autocast on and off), A003 (on AHab: passive), A004 (on AHds, not learned) and the game's AHhb; h000
//   (hfoo, utcc 1, colour 7, life 80 %, range 300) with A005 (on Ahea, on), A006 (on Aslo, off), A007 (on Adef, off),
//   A008 (on Asal: passive); a plain Hpal with colour 5 (no utcc). Where does SetUnitColor go, which get an empty order?
// - items: ecgh (teamColor 8), ehhi (3), ratc (24), I000 (ratc with itco 5), ckng (its original given itco 12), I001
//   (ecgh, no change).
// - sounds: dialogue keys in six combinations of the word after the facial animation file (unknown2), speaker unit type
//   and keys.
// - the custom script header is three spaces (a JASS whitespace-only header).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gamePath } from "../../gamepath.mjs";
import { requireFresh } from "../../binfresh.mjs";
import { setHeader } from "./trigger-folder.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const cli = args[0] ? resolve(args[0]) : null;
if (!cli) { console.error("usage: make-script-items.mjs <w3proj cli> [game folder]"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const game = args[1] ? resolve(args[1]) : gamePath();
const run = (...a) => {
  const r = spawnSync(cli, a, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${a.join(" ")}: ${r.stderr}${r.stdout}`);
};

const int = (field, value) => ({ field, type: "int", value });
const str = (field, value) => ({ field, type: "string", value });
const objects = (custom, original = []) => ({ format: "w3proj.objects/1", version: 2, original, custom });
const W3U = objects([
  { id: "n000", base: "ngol", mods: [str("uabi", "Avul")] },
  { id: "n001", base: "ngol", mods: [] },
  { id: "n002", base: "ngol", mods: [str("uabi", "Avul,Agld")] },
  { id: "n003", base: "hfoo", mods: [str("uabi", "Agld")] },
  { id: "H000", base: "Hpal", mods: [int("utcc", 1), str("uhab", "A000,A001,A002,A003,A004,AHhb")] },
  { id: "h000", base: "hfoo", mods: [int("utcc", 1), str("uabi", "A005,A006,A007,A008")] },
]);
const W3A = objects(["A000:AHtb", "A001:AHfa", "A002:AHfa", "A003:AHab", "A004:AHds", "A005:Ahea", "A006:Aslo", "A007:Adef", "A008:Asal"]
  .map((s) => { const [id, base] = s.split(":"); return { id, base, mods: [] }; }));
const W3T = objects([{ id: "I000", base: "ratc", mods: [int("itco", 5)] }, { id: "I001", base: "ecgh", mods: [] }], [{ base: "ckng", mods: [int("itco", 12)] }]);

let editorId = 0;
const place = (id, x, y, more = {}) => ({
  id, variation: 0, position: [x, y, 0], angle: 4.712389, scale: [1, 1, 1], skinId: id, preFlags: 4294967295, flags: 2,
  player: 0, unknown1: 0, unknown2: 0, hp: -1, mana: -1, itemTable: -1, itemSets: [], gold: 0, targetAcquisition: -1,
  level: 1, strength: 0, agility: 0, intelligence: 0, inventory: [], abilities: [], randomType: 0, randomLevel: "010000",
  randomClass: 0, color: -1, waygate: -1, editorId: editorId++, trailer: [0, 0], extras: [], ...more,
});
const skill = (id, level, autocast = 0) => ({ id, autocast, level });
const neutral = { player: 27, level: 0 };
const UNITS = [
  place("sloc", 0, -256, { level: 0, targetAcquisition: 0 }),
  place("n000", -1536, 1536, { ...neutral, gold: 7000 }),
  place("n001", -768, 1536, { ...neutral, gold: 8000 }),
  place("n002", 0, 1536, { ...neutral, gold: 9000 }),
  place("n003", 768, 1536, { ...neutral, gold: 6000 }),
  place("H000", -1024, -1024, {
    color: 5, level: 6, strength: 30, agility: 20, intelligence: 25, hp: 50, mana: 100, targetAcquisition: 500,
    abilities: [skill("A000", 1), skill("A001", 1, 1), skill("A002", 1, 0), skill("A003", 1), skill("A004", 0), skill("AHhb", 1)],
  }),
  place("h000", 0, -1024, {
    color: 7, hp: 80, targetAcquisition: 300,
    abilities: [skill("A005", 1, 1), skill("A006", 1, 0), skill("A007", 1, 0), skill("A008", 1, 0)],
  }),
  place("Hpal", 1024, -1024, { color: 5, level: 2, abilities: [skill("AHhb", 1)] }),
  ...[["ecgh", -1024], ["ehhi", -768], ["ratc", -512], ["I000", -256], ["ckng", 0], ["I001", 256]]
    .map(([id, x]) => place(id, x, 512, { ...neutral, angle: 0 })),
];

// Dialogue: [name, unknown2, speakerUnitType, speakerNameKey, dialogueTextKey]; the keys point at strings 900..905.
const SOUNDS = [
  ["TextOnly", 1, "", -1, 900], ["SpokenUnit", 0, "Hjai", 901, -1], ["ZeroNone", 0, "", -1, -1],
  ["BothKeys", 1, "Hpal", 902, 903], ["SpokenKey", 0, "", 904, -1], ["UnitNoKeys", 1, "Hjai", -1, -1],
].map(([name, unknown2, speakerUnitType, speakerNameKey, dialogueTextKey]) => ({
  name: `gg_snd_${name}`, file: "Abilities\\Spells\\Human\\Heal\\HealTarget.wav", eaxEffect: "DefaultEAXON", flags: 0,
  fadeInRate: 10, fadeOutRate: 10, volume: -1, pitch: 1, pitchVariance: 0, priority: 0, channel: -1,
  minDistance: 4294967296, maxDistance: 4294967296, distanceCutoff: 4294967296, coneInside: 4294967296,
  coneOutside: 4294967296, coneOutsideVolume: -1, coneOrientation: [4294967296, 4294967296, 4294967296],
  variableName: `gg_snd_${name}`, assetLabel: "", assetFile: "Abilities\\Spells\\Human\\Heal\\HealTarget.wav",
  dialogueTextKey, dialogueText: "", speakerNameKey, speakerName: "", unknown1: 0, speakerUnitType,
  facialAnimationLabel: "", facialAnimationGroupLabel: "", facialAnimationSetFile: "", unknown2,
}));

// script-items-2.w3x: what decides the dialogue keys (and the length) of a sound, and more abilities.
// - sounds with keys 900/901, the word 0 and a speaker unit type, by file: a .wav the game holds only as .ogg, the .ogg
//   itself, a dialogue file under its .flac (the HD and SD storage hold .ogg and .mp3) and .mp3 name; then on the .ogg:
//   the word 1 and a text key only, the word 0 with a speaker key and text -1, no keys at all; with facial animation
//   (label, group and file): both keys, a text key only, no keys; the group alone, the file alone.
// - abilities: the game's Adef on a footman switched on, the game's AHfa learned on a Priestess of the Moon switched on
//   and off (Order and Unorder, no Orderon/Orderoff), custom ones not learned (level 0) on a unit: A009 (on Ahea, on),
//   A00A (on Asal), A00C (on Ahea, off); A00B (on Adef) switched on.
const HEAL = "Abilities\\Spells\\Human\\Heal\\HealTarget";
const HUNTRESS = "Sound\\Dialogue\\NightElfExpCamp\\NightElf04x\\S04Huntress03";
const sound = ([name, file, unknown2, speakerUnitType, speakerNameKey, dialogueTextKey, facial]) => ({
  ...SOUNDS[0], name: `gg_snd_${name}`, variableName: `gg_snd_${name}`, file, assetFile: file, unknown2, speakerUnitType,
  speakerNameKey, dialogueTextKey, channel: 0,
  ...(facial === "all" || facial === "label" ? { facialAnimationLabel: "S04Huntress03" } : {}),
  ...(facial === "all" || facial === "group" ? { facialAnimationGroupLabel: "Map-Huntress" } : {}),
  ...(facial === "all" || facial === "file" ? { facialAnimationSetFile: "Sound/Dialogue/FaceAnimation/NightElfX04/FacialAnimation/Huntress.animset" } : {}),
});
const SOUNDS_2 = [
  ["WavOnlyOgg", `${HEAL}.wav`, 0, "Hjai", 901, 900], ["OggExact", `${HEAL}.ogg`, 0, "Hjai", 901, 900],
  ["DialogueFlac", `${HUNTRESS}.flac`, 0, "Hjai", 901, 900], ["DialogueMp3", `${HUNTRESS}.mp3`, 0, "Hjai", 901, 900],
  ["OggTextOnly", `${HEAL}.ogg`, 1, "", -1, 902], ["OggSpokenUnit", `${HEAL}.ogg`, 0, "Hjai", 903, -1],
  ["OggZeroNone", `${HEAL}.ogg`, 0, "", -1, -1], ["OggFacial", `${HEAL}.ogg`, 0, "Hjai", 905, 904, "all"],
  ["FacialTextOnly", `${HEAL}.ogg`, 1, "", -1, 902, "all"], ["FacialNoKeys", `${HEAL}.ogg`, 1, "", -1, -1, "all"],
  ["FacialGroupOnly", `${HEAL}.ogg`, 0, "Hjai", 901, 900, "group"], ["FacialFileOnly", `${HEAL}.ogg`, 0, "Hjai", 901, 900, "file"],
].map(sound);
editorId = 0;
const W3U_2 = objects([
  { id: "h001", base: "hfoo", mods: [str("uabi", "Ahea,A009,A00A")] },
  { id: "h002", base: "hfoo", mods: [str("uabi", "A00B,A00C")] },
]);
const W3A_2 = objects(["A009:Ahea", "A00A:Asal", "A00B:Adef", "A00C:Ahea"].map((s) => { const [id, base] = s.split(":"); return { id, base, mods: [] }; }));
const UNITS_2 = [
  place("sloc", 0, -256, { level: 0, targetAcquisition: 0 }),
  place("hfoo", -1024, -1024, { abilities: [skill("Adef", 1, 1)] }),
  place("Emoo", 0, -1024, { level: 3, abilities: [skill("AHfa", 1, 1)] }),
  place("Emoo", 512, -1024, { level: 3, abilities: [skill("AHfa", 1, 0)] }),
  place("h001", 1024, -1024, { abilities: [skill("Ahea", 1, 1), skill("A009", 0, 1), skill("A00A", 0, 0)] }),
  place("h002", 1536, -1024, { abilities: [skill("A00B", 1, 1), skill("A00C", 0, 0)] }),
];

// script-items-3.w3x: placed random items (iDNR, any by level) whose randomLevel holds other bytes after the level: do
// the two bytes the level leaves carry the editor's equipment type and tag (ChooseRandomItemExWithFilter)?
editorId = 0;
const UNITS_3 = [
  place("sloc", 0, -256, { level: 0, targetAcquisition: 0 }),
  ...["020000", "020100", "020001", "020504", "020908", "02ffff", "ff0000", "ffffff", "ffff00", "030091"].map((randomLevel, k) =>
    place("iDNR", -1024 + 256 * k, 512, { ...neutral, angle: 0, randomLevel, randomClass: 1 })),
];

// script-items-4.w3x: how the editor writes a dialogue key below 100 ("TRIGSTR_7" or "TRIGSTR_007"), with keys of
// three and four digits beside them.
const SOUNDS_4 = [
  ["KeysSeven", `${HEAL}.ogg`, 0, "Hjai", 30, 7, "all"], ["KeysTwoDigits", `${HEAL}.ogg`, 0, "Hjai", 99, 47, "all"],
  ["KeysThree", `${HEAL}.ogg`, 0, "Hjai", 101, 100, "all"], ["KeysFour", `${HEAL}.ogg`, 0, "Hjai", 1001, 1000, "all"],
].map(sound);
const KEYS_4 = [7, 30, 47, 99, 100, 101, 1000, 1001];

const MAPS = {
  "script-items-4.w3x": { units: [UNITS[0]], sounds: SOUNDS_4, strings: KEYS_4.map((key) => [key, `Dialogue ${key}`]) },
  "script-items.w3x": { units: UNITS, w3u: W3U, w3a: W3A, w3t: W3T, sounds: SOUNDS, header: "   " },
  "script-items-2.w3x": { units: UNITS_2, w3u: W3U_2, w3a: W3A_2, sounds: SOUNDS_2 },
  "script-items-3.w3x": { units: UNITS_3 },
};
for (const [out, m] of Object.entries(MAPS)) {
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-script-items-"));
  try {
    const dir = join(scratch, "p");
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    const map = join(dir, "map");
    const unitsFile = join(map, "war3mapUnits.doo.json");
    const units = JSON.parse(readFileSync(unitsFile, "utf8"));
    units.subversion = 11; // hero attributes and item tables
    units.units = m.units;
    writeFileSync(unitsFile, JSON.stringify(units, null, 1));
    for (const kind of ["w3u", "w3a", "w3t"]) if (m[kind]) writeFileSync(join(map, `war3map.${kind}.json`), JSON.stringify(m[kind], null, 1));
    if (m.sounds?.length) writeFileSync(join(map, "war3map.w3s.json"), JSON.stringify({ format: "w3proj.sounds/1", version: 3, sounds: m.sounds }, null, 1));
    const wtsFile = join(map, "war3map.wts");
    const strings = (m.strings ?? ["Subtitle 900", "Speaker 901", "Speaker 902", "Subtitle 903", "Speaker 904", "Speaker 905"].map((t, k) => [900 + k, t]))
      .map(([key, text]) => `STRING ${key}\r\n{\r\n${text}\r\n}\r\n\r\n`).join("");
    writeFileSync(wtsFile, readFileSync(wtsFile, "utf8") + strings);
    if (existsSync(join(map, "triggers", "header.j"))) throw new Error("flat.w3x has a custom script header");
    if (m.header) setHeader(dir, m.header);
    rmSync(join(map, "war3map.j"), { force: true }); // Studio writes one from the triggers, the editor too
    run("pack", dir, "-o", join(here, out), "--force-stale");
    console.log(`made ${join(here, out)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
