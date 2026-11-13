import assert from "node:assert/strict";
import { test } from "node:test";
import { moveTexts, refsIn, stringRef, type MoveTextsInput, type TextObjectFile } from "./movetexts";
import { StringTable, removeStrings } from "./wts";

const WTS = "﻿STRING 1\r\n{\r\nPlayer 1\r\n}\r\n\r\nSTRING 2\r\n{\r\nForce 1\r\n}\r\n\r\n";

const units = (): TextObjectFile => ({
  format: "w3proj.objects/1", version: 3,
  original: [{ base: "hpea", mods: [{ field: "unam", type: "string", value: "Lit Peasant" }] }],
  custom: [{
    base: "hfoo", id: "h000", mods: [
      { field: "unam", type: "string", value: "Lit Unit" },
      { field: "utip", type: "string", value: "Lit Tip" },
      { field: "utub", type: "string", value: "Lit Ubertip" },
      { field: "upro", type: "string", value: "Lit Proper1,Lit Proper2" },
      { field: "uhot", type: "string", value: "F" },
      { field: "umdl", type: "string", value: "units\\human\\Footman\\Footman" },
      { field: "urac", type: "string", value: "human" },
      { field: "ua1p", type: "string", value: "ground,enemies" },
      { field: "uhpm", type: "int", value: 500 },
    ],
  }],
});
const abilities = (): TextObjectFile => ({
  format: "w3proj.objects/1", version: 3, original: [],
  custom: [{
    base: "AHhb", id: "A000", mods: [
      { field: "anam", type: "string", level: 0, data: 0, value: "Lit Ability" },
      { field: "atp1", type: "string", level: 1, data: 0, value: "Lit AbTip1" },
      { field: "aub1", type: "string", level: 1, data: 0, value: "Lit AbUber1" },
      { field: "ansf", type: "string", level: 0, data: 0, value: "Lit Suffix" },
      { field: "atar", type: "string", level: 1, data: 0, value: "air,ground" },
    ],
  }],
});
const info = () => ({
  name: "Just another Warcraft III map", author: "Unknown", description: "Nondescript", suggestedPlayers: "Any",
  loadingScreen: { text: "Loading text", title: "Title", subtitle: "Sub" }, prologue: { text: "Pro", title: "T", subtitle: "S" },
  players: [{ id: 0, name: "Lit Player" }], forces: [{ flags: 0, name: "Lit Force" }],
});
const input = (over: Partial<MoveTextsInput> = {}): MoveTextsInput => ({
  wts: WTS, info: info(),
  objects: [{ path: "map/war3map.w3u.json", kind: "w3u", skin: false, doc: units() }, { path: "map/war3map.w3a.json", kind: "w3a", skin: false, doc: abilities() }],
  otherTexts: [], ...over,
});

/** The World Editor's war3map.wts for the same map (we-drive, 2026-11-10: Export Strings after its save), after the
 *  two old strings, which nothing refers to any more. */
const WE_BLOCKS = [
  "STRING 3\r\n{\r\nLit Player\r\n}\r\n",
  "STRING 4\r\n{\r\nLit Force\r\n}\r\n",
  "STRING 5\r\n// Units: hpea (Lit Peasant), Name (Name)\r\n{\r\nLit Peasant\r\n}\r\n",
  "STRING 6\r\n// Units: h000 (Lit Unit), Name (Name)\r\n{\r\nLit Unit\r\n}\r\n",
  "STRING 7\r\n// Units: h000 (Lit Unit), Tip (Tooltip - Basic)\r\n{\r\nLit Tip\r\n}\r\n",
  "STRING 8\r\n// Units: h000 (Lit Unit), Ubertip (Tooltip - Extended)\r\n{\r\nLit Ubertip\r\n}\r\n",
  "STRING 9\r\n// Units: h000 (Lit Unit), Propernames (Proper Names)\r\n{\r\nLit Proper1,Lit Proper2\r\n}\r\n",
  "STRING 10\r\n// Units: h000 (Lit Unit), Hotkey (Hotkey)\r\n{\r\nF\r\n}\r\n",
  "STRING 11\r\n// Abilities: A000 (Lit Ability), Name (Name)\r\n{\r\nLit Ability\r\n}\r\n",
  "STRING 12\r\n// Abilities: A000 (Lit Ability), Tip (Tooltip - Normal)\r\n{\r\nLit AbTip1\r\n}\r\n",
  "STRING 13\r\n// Abilities: A000 (Lit Ability), Ubertip (Tooltip - Normal - Extended)\r\n{\r\nLit AbUber1\r\n}\r\n",
  "STRING 14\r\n// Abilities: A000 (Lit Ability), EditorSuffix (Editor Suffix)\r\n{\r\nLit Suffix\r\n}\r\n",
];

test("the World Editor's strings: the same numbers, comments and texts, the old strings dropped", () => {
  const r = moveTexts(input());
  assert.equal(r.wts, "﻿" + WE_BLOCKS.join("\r\n") + "\r\n");
  assert.deepEqual(r.added, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.deepEqual(r.dropped, [1, 2]);
  assert.deepEqual(r.kept, []);
});

test("the moved fields refer to their strings; the rest stays literal", () => {
  const r = moveTexts(input());
  const u = r.objects.find((f) => f.path === "map/war3map.w3u.json")!.doc;
  const values = Object.fromEntries(u.custom![0].mods!.map((m) => [m.field, m.value]));
  assert.deepEqual(values, {
    unam: "TRIGSTR_006", utip: "TRIGSTR_007", utub: "TRIGSTR_008", upro: "TRIGSTR_009", uhot: "TRIGSTR_010",
    umdl: "units\\human\\Footman\\Footman", urac: "human", ua1p: "ground,enemies", uhpm: 500,
  });
  assert.equal(u.original![0].mods![0].value, "TRIGSTR_005");
  const a = r.objects.find((f) => f.path === "map/war3map.w3a.json")!.doc.custom![0].mods!;
  assert.deepEqual(a.map((m) => m.value), ["TRIGSTR_011", "TRIGSTR_012", "TRIGSTR_013", "TRIGSTR_014", "air,ground"]);
  // The map's own texts stay literal: name, author, description, suggested players, loading screen, prologue.
  const i = r.info as ReturnType<typeof info>;
  assert.deepEqual([i.players[0].name, i.forces[0].name], ["TRIGSTR_003", "TRIGSTR_004"]);
  const { players: _p, forces: _f, ...rest } = i;
  const { players: _p0, forces: _f0, ...was } = info();
  assert.deepEqual(rest, was);
});

test("the input stays as it was", () => {
  const given = input();
  const copy = structuredClone({ info: given.info, objects: given.objects });
  moveTexts(given);
  assert.deepEqual({ info: given.info, objects: given.objects }, copy);
});

test("a second run changes nothing", () => {
  const r = moveTexts(input());
  const again = moveTexts(input({ wts: r.wts, info: r.info, objects: r.objects.map((f) => ({ path: f.path, kind: f.path.includes("w3a") ? "w3a" : "w3u", skin: false, doc: f.doc })) }));
  assert.deepEqual([again.wts, again.info, again.objects, again.added, again.dropped], [null, null, [], [], []]);
});

test("new numbers go on after the highest string, and after the highest reference", () => {
  const wts = "STRING 7\n{\nKept\n}\n";
  const kept = (n: number) => [`call SetPlayerName(Player(0), "TRIGSTR_${n}")`];
  const r = moveTexts(input({ wts, objects: [], otherTexts: kept(7) }));
  assert.deepEqual(r.added, [8, 9]);
  assert.deepEqual(r.dropped, []);
  // A reference past the table: its number isn't taken by a new string.
  const past = moveTexts(input({ wts, objects: [], otherTexts: [...kept(7), "TRIGSTR_0020"] }));
  assert.deepEqual(past.added, [21, 22]);
  // Kept LF line ends; the new blocks after a blank line.
  assert.equal(r.wts, "STRING 7\n{\nKept\n}\n\nSTRING 8\n{\nLit Player\n}\n\nSTRING 9\n{\nLit Force\n}\n\n");
});

test("new numbers go on after the strings an earlier drop recorded, which nothing refers to now", () => {
  const wts = "STRING 7\n{\nKept\n}\n";
  const kept = [`call SetPlayerName(Player(0), "TRIGSTR_7")`];
  // The control: without the record, 8 and 9 are free.
  assert.deepEqual(moveTexts(input({ wts, objects: [], otherTexts: kept })).added, [8, 9]);
  const r = moveTexts(input({ wts, objects: [], otherTexts: kept, reserved: [3, 12] }));
  assert.deepEqual(r.added, [13, 14]);
  assert.deepEqual(r.dropped, [], "a recorded number isn't a string of the table to drop");
});

test("strings something still refers to stay; the others go", () => {
  const wts = "STRING 1\r\n{\r\nIn the script\r\n}\r\n\r\nSTRING 2\r\n{\r\nIn a raw file\r\n}\r\n\r\nSTRING 3\r\n{\r\nNobody's\r\n}\r\n\r\nSTRING 4\r\n// Units: h001 (x), Name (Name)\r\n{\r\nIn object data\r\n}\r\n";
  const objects = [{ path: "map/war3mapSkin.w3u.json", kind: "w3u", skin: true, doc: { original: [], custom: [{ base: "hfoo", id: "h001", mods: [{ field: "unam", type: "string", value: "TRIGSTR_004" }] }] } }];
  const r = moveTexts({ wts, info: null, objects, otherTexts: ["DisplayText(\"TRIGSTR_001\")"], otherRefs: [2] });
  assert.deepEqual([r.added, r.dropped], [[], [3]]);
  assert.equal(r.wts, wts.replace("STRING 3\r\n{\r\nNobody's\r\n}\r\n\r\n", ""));
  // Nothing to move, nothing to drop: no new file.
  assert.equal(moveTexts({ wts: r.wts, info: null, objects, otherTexts: ["TRIGSTR_001"], otherRefs: [2] }).wts, null);
});

test("empty texts and references stay as they are", () => {
  const doc = { original: [], custom: [{ base: "hfoo", id: "h000", mods: [{ field: "utip", type: "string", value: "" }, { field: "unam", type: "string", value: "TRIGSTR_001" }] }] };
  const r = moveTexts({ wts: "STRING 1\n{\nNamed\n}\n", info: { players: [{ name: "" }], forces: [{ name: "TRIGSTR_001" }] }, objects: [{ path: "u", kind: "w3u", skin: false, doc }], otherTexts: [] });
  assert.deepEqual([r.wts, r.info, r.objects], [null, null, []]);
});

test("the Skin file's fields move too, after the main file's, with the Skin file's name in the comment", () => {
  const main = { original: [], custom: [{ base: "hfoo", id: "h000", mods: [{ field: "unam", type: "string", value: "Main name" }, { field: "uhpm", type: "int", value: 5 }] }] };
  const skin = { original: [], custom: [{ base: "hfoo", id: "h000", mods: [{ field: "unam", type: "string", value: "Skin name" }, { field: "utip", type: "string", value: "Skin tip" }] }, { base: "hkni", id: "h001", mods: [{ field: "utip", type: "string", value: "Knight tip" }] }] };
  const r = moveTexts({
    wts: null, info: null, otherTexts: [],
    objects: [{ path: "s", kind: "w3u", skin: true, doc: skin }, { path: "m", kind: "w3u", skin: false, doc: main }],
    baseName: (kind, base) => (kind === "w3u" && base === "hkni" ? "Knight" : undefined),
  });
  const t = new StringTable(r.wts!);
  assert.deepEqual([...t.entries()], [[1, "Main name"], [2, "Skin name"], [3, "Skin tip"], [4, "Knight tip"]]);
  assert.match(r.wts!, /^﻿STRING 1\r\n\/\/ Units: h000 \(Skin name\), Name \(Name\)\r\n/);
  assert.match(r.wts!, /STRING 4\r\n\/\/ Units: h001 \(Knight\), Tip \(Tooltip - Basic\)\r\n/);
  assert.deepEqual(r.objects.map((f) => f.path).sort(), ["m", "s"]);
});

test("every level gets its own string, under the same comment; flagged sets too", () => {
  const doc = { original: [], custom: [{ base: "AHhb", id: "A001", sets: [{ flag: 0, mods: [
    { field: "atp1", type: "string", level: 1, data: 0, value: "One" }, { field: "atp1", type: "string", level: 2, data: 0, value: "Two" },
  ] }] }] };
  const r = moveTexts({ wts: null, info: null, otherTexts: [], objects: [{ path: "a", kind: "w3a", skin: false, doc }], describe: (_k, f) => (f === "atp1" ? { field: "Tip", label: "Tooltip - Normal" } : undefined) });
  assert.equal((r.wts!.match(/\/\/ Abilities: A001 \(AHhb\), Tip \(Tooltip - Normal\)\r\n/g) ?? []).length, 2);
  assert.deepEqual(r.objects[0].doc.custom![0].sets![0].mods.map((m) => m.value), ["TRIGSTR_001", "TRIGSTR_002"]);
});

test("a text of several lines keeps them; one the game would cut stays literal", () => {
  const doc = { original: [], custom: [{ base: "hfoo", id: "h000", mods: [
    { field: "utub", type: "string", value: "Line one\nLine two" }, { field: "utip", type: "string", value: "Cut\n} here" },
  ] }] };
  const r = moveTexts({ wts: null, info: null, otherTexts: [], objects: [{ path: "u", kind: "w3u", skin: false, doc }] });
  assert.equal(new StringTable(r.wts!).get(1), "Line one\r\nLine two");
  assert.deepEqual(r.objects[0].doc.custom![0].mods!.map((m) => m.value), ["TRIGSTR_001", "Cut\n} here"]);
  assert.equal(r.kept.length, 1);
  assert.match(r.kept[0].where, /h000 utip/);
});

test("a name with a line break makes a one-line comment", () => {
  const doc = { original: [], custom: [{ base: "hfoo", id: "h000", mods: [{ field: "unam", type: "string", value: "Two\nlines" }] }] };
  const r = moveTexts({ wts: null, info: null, otherTexts: [], objects: [{ path: "u", kind: "w3u", skin: false, doc }] });
  assert.match(r.wts!, /\/\/ Units: h000 \(Two lines\), Name \(Name\)\r\n\{\r\nTwo\r\nlines\r\n\}/);
});

test("removeStrings takes a block and the blank line after it, the last one too", () => {
  const t = "﻿STRING 1\r\n{\r\nA\r\n}\r\n\r\nSTRING 2\r\n// c\r\n{\r\nB\r\n}\r\n\r\nSTRING 3\r\n{\r\nC\r\n}\r\n";
  assert.equal(removeStrings(t, new Set([2])), "﻿STRING 1\r\n{\r\nA\r\n}\r\n\r\nSTRING 3\r\n{\r\nC\r\n}\r\n");
  assert.equal(removeStrings(t, new Set([3])), "﻿STRING 1\r\n{\r\nA\r\n}\r\n\r\nSTRING 2\r\n// c\r\n{\r\nB\r\n}\r\n\r\n");
  assert.equal(removeStrings(t, new Set([1, 2, 3])), "﻿");
  assert.equal(removeStrings(t, new Set()), t);
});

// The we-drive test of every text field (2026-11-13, evidence in target/evidence/moveto-fields): an empty map saved by
// the World Editor (players and force named by strings 1 and 2) with a literal in every candidate field.
const str = (field: string, value: string, level?: number, data = 0) =>
  (level === undefined ? { field, type: "string", value } : { field, type: "string", level, data, value });
const lit = (id: string, fields: string[], level?: number) => fields.map((f) => str(f, `LIT ${id} ${f}${level ? ` L${level}` : ""}`, level));
const objFile = (custom: TextObjectFile["custom"], original: TextObjectFile["original"] = []): TextObjectFile =>
  ({ format: "w3proj.objects/1", version: 3, original, custom });
const RHME = "Iron Forged Swords,Steel Forged Swords,Mithril Forged Swords";
const allFields = (): MoveTextsInput["objects"] => [
  { path: "u", kind: "w3u", skin: false, doc: objFile([
    { base: "hfoo", id: "h000", mods: [...lit("h000", ["unam", "utip", "utub", "ides", "unsf", "ucun", "ucut", "uepa"]), str("uhot", "Q")] },
    { base: "Hpal", id: "H000", mods: [...lit("H000", ["unam", "upro", "utpr", "uawt", "utip", "utub", "ides", "unsf"]), str("uhot", "W")] },
  ], [{ base: "hfoo", mods: lit("hfoo", ["unam", "utip"]) }]) },
  { path: "t", kind: "w3t", skin: false, doc: objFile([{ base: "ratc", id: "I000", mods: [...lit("I000", ["unam", "utip", "utub", "ides", "unsf"]), str("uhot", "E")] }]) },
  { path: "b", kind: "w3b", skin: false, doc: objFile([{ base: "LTlt", id: "B000", mods: lit("B000", ["bnam", "bsuf"]) }]) },
  { path: "d", kind: "w3d", skin: false, doc: objFile([{ base: "APms", id: "D000", mods: [str("dnam", "LIT D000 dnam", 0)] }]) },
  { path: "a", kind: "w3a", skin: false, doc: objFile([
    { base: "AHhb", id: "A000", mods: [
      ...lit("A000", ["anam", "ansf"], 0), ...lit("A000", ["atp1"], 1), ...lit("A000", ["atp1"], 2),
      ...lit("A000", ["aut1", "aub1", "auu1", "aret", "arut"], 1), str("arhk", "R", 0), str("ahky", "T", 0), str("auhk", "Y", 0),
      ...lit("A000", ["aord", "aoru", "aoro", "aorf"], 0),
    ] },
    { base: "AAns", id: "A001", mods: [...lit("A001", ["anam"], 0), str("Ans5", "LIT A001 Ans5 L1", 1, 5)] },
  ]) },
  { path: "h", kind: "w3h", skin: false, doc: objFile([{ base: "BHbd", id: "B001", mods: lit("B001", ["fnam", "fnsf", "ftip", "fube"]) }]) },
  { path: "q", kind: "w3q", skin: false, doc: objFile([{ base: "Rhme", id: "R000", mods: [...lit("R000", ["gnam", "gnsf", "gtp1", "gub1"], 1), str("ghk1", "U", 1)] }]) },
];
/** The World Editor's new strings for allFields: number, comment, text. */
const WE_ALL: [number, string, string][] = [
  [3, "Units: hfoo (LIT hfoo unam), Name (Name)", "LIT hfoo unam"],
  [4, "Units: hfoo (LIT hfoo unam), Tip (Tooltip - Basic)", "LIT hfoo utip"],
  [5, "Units: h000 (LIT h000 unam), Name (Name)", "LIT h000 unam"],
  [6, "Units: h000 (LIT h000 unam), Tip (Tooltip - Basic)", "LIT h000 utip"],
  [7, "Units: h000 (LIT h000 unam), Ubertip (Tooltip - Extended)", "LIT h000 utub"],
  [8, "Units: h000 (LIT h000 unam), Description (Description)", "LIT h000 ides"],
  [9, "Units: h000 (LIT h000 unam), EditorSuffix (Name - Editor Suffix)", "LIT h000 unsf"],
  [10, "Units: h000 (LIT h000 unam), Casterupgradename (Caster Upgrade Names)", "LIT h000 ucun"],
  [11, "Units: h000 (LIT h000 unam), Casterupgradetip (Caster Upgrade Tips)", "LIT h000 ucut"],
  [12, "Units: h000 (LIT h000 unam), Hotkey (Hotkey)", "Q"],
  [13, "Units: H000 (LIT H000 unam), Name (Name)", "LIT H000 unam"],
  [14, "Units: H000 (LIT H000 unam), Propernames (Proper Names)", "LIT H000 upro"],
  [15, "Units: H000 (LIT H000 unam), Revivetip (Tooltip - Revive)", "LIT H000 utpr"],
  [16, "Units: H000 (LIT H000 unam), Awakentip (Tooltip - Awaken)", "LIT H000 uawt"],
  [17, "Units: H000 (LIT H000 unam), Tip (Tooltip - Basic)", "LIT H000 utip"],
  [18, "Units: H000 (LIT H000 unam), Ubertip (Tooltip - Extended)", "LIT H000 utub"],
  [19, "Units: H000 (LIT H000 unam), Description (Description)", "LIT H000 ides"],
  [20, "Units: H000 (LIT H000 unam), EditorSuffix (Name - Editor Suffix)", "LIT H000 unsf"],
  [21, "Units: H000 (LIT H000 unam), Hotkey (Hotkey)", "W"],
  [22, "Items: I000 (LIT I000 unam), Name (Name)", "LIT I000 unam"],
  [23, "Items: I000 (LIT I000 unam), Tip (Tooltip - Basic)", "LIT I000 utip"],
  [24, "Items: I000 (LIT I000 unam), Ubertip (Tooltip - Extended)", "LIT I000 utub"],
  [25, "Items: I000 (LIT I000 unam), Description (Description)", "LIT I000 ides"],
  [26, "Items: I000 (LIT I000 unam), EditorSuffix (Name - Editor Suffix)", "LIT I000 unsf"],
  [27, "Items: I000 (LIT I000 unam), Hotkey (Hotkey)", "E"],
  [28, "Destructibles: B000 (LIT B000 bnam), Name (Name)", "LIT B000 bnam"],
  [29, "Destructibles: B000 (LIT B000 bnam), EditorSuffix (Editor Suffix)", "LIT B000 bsuf"],
  [30, "Doodads: D000 (LIT D000 dnam), Name (Name)", "LIT D000 dnam"],
  [31, "Abilities: A000 (LIT A000 anam), Name (Name)", "LIT A000 anam"],
  [32, "Abilities: A000 (LIT A000 anam), EditorSuffix (Editor Suffix)", "LIT A000 ansf"],
  [33, "Abilities: A000 (LIT A000 anam), Tip (Tooltip - Normal)", "LIT A000 atp1 L1"],
  [34, "Abilities: A000 (LIT A000 anam), Tip (Tooltip - Normal)", "LIT A000 atp1 L2"],
  [35, "Abilities: A000 (LIT A000 anam), Untip (Tooltip - Turn Off)", "LIT A000 aut1 L1"],
  [36, "Abilities: A000 (LIT A000 anam), Ubertip (Tooltip - Normal - Extended)", "LIT A000 aub1 L1"],
  [37, "Abilities: A000 (LIT A000 anam), Unubertip (Tooltip - Turn Off - Extended)", "LIT A000 auu1 L1"],
  [38, "Abilities: A000 (LIT A000 anam), Researchtip (Tooltip - Learn)", "LIT A000 aret L1"],
  [39, "Abilities: A000 (LIT A000 anam), Researchubertip (Tooltip - Learn - Extended)", "LIT A000 arut L1"],
  [40, "Abilities: A000 (LIT A000 anam), Researchhotkey (Hotkey - Learn)", "R"],
  [41, "Abilities: A000 (LIT A000 anam), Hotkey (Hotkey - Normal)", "T"],
  [42, "Abilities: A000 (LIT A000 anam), Unhotkey (Hotkey - Turn Off)", "Y"],
  [43, "Abilities: A001 (LIT A001 anam), Name (Name)", "LIT A001 anam"],
  [44, "Buffs/Effects: B001 (LIT B001 fnam), EditorName (Name (Editor Only))", "LIT B001 fnam"],
  [45, "Buffs/Effects: B001 (LIT B001 fnam), EditorSuffix (Editor Suffix)", "LIT B001 fnsf"],
  [46, "Buffs/Effects: B001 (LIT B001 fnam), Bufftip (Tooltip)", "LIT B001 ftip"],
  [47, "Buffs/Effects: B001 (LIT B001 fnam), Buffubertip (Tooltip - Extended)", "LIT B001 fube"],
  [48, `Upgrades: R000 (${RHME}), Name (Name)`, "LIT R000 gnam L1"],
  [49, `Upgrades: R000 (${RHME}), EditorSuffix (Editor Suffix)`, "LIT R000 gnsf L1"],
  [50, `Upgrades: R000 (${RHME}), Tip (Tooltip)`, "LIT R000 gtp1 L1"],
  [51, `Upgrades: R000 (${RHME}), Ubertip (Tooltip - Extended)`, "LIT R000 gub1 L1"],
  [52, `Upgrades: R000 (${RHME}), Hotkey (Hotkey)`, "U"],
];
const weTable = (blocks: [number, string, string][]) =>
  WTS + blocks.map(([n, c, t]) => `STRING ${n}\r\n// ${c}\r\n{\r\n${t}\r\n}\r\n`).join("\r\n") + "\r\n";
const baseName = (kind: string, base: string) => (kind === "w3q" && base === "Rhme" ? RHME : undefined);

test("every text field the World Editor moves, with its comments: its war3map.wts byte for byte", () => {
  const r = moveTexts({ wts: WTS, info: { players: [{ name: "TRIGSTR_001" }], forces: [{ name: "TRIGSTR_002" }] }, objects: allFields(), otherTexts: [], baseName });
  assert.equal(r.wts, weTable(WE_ALL));
  assert.deepEqual([r.dropped, r.kept], [[], []]);
  // What it leaves literal: the order strings, the art string, an ability's data.
  const literal = r.objects.flatMap((f) => [...(f.doc.original ?? []), ...(f.doc.custom ?? [])].flatMap((o) => o.mods ?? []))
    .filter((m) => !String(m.value).startsWith("TRIGSTR_")).map((m) => m.field);
  assert.deepEqual(literal, ["uepa", "aord", "aoru", "aoro", "aorf", "Ans5"]);
});

test("an upgrade's comment names the game's upgrade, also when the map renames it; its class and effects move, the rest stays", () => {
  const doc = objFile([{ base: "Rhme", id: "R001", mods: [
    str("gnam", "Upg Two", 1), str("grac", "orc", 0), str("gar1", "BTNFootman.blp", 1), str("gcls", "melee", 0),
    str("gef1", "ratx", 0), str("gef2", "rats", 0), str("gef3", "rmov", 0), str("gef4", "rhpx", 0), str("gco1", "AHhb", 0), str("greq", "hbla", 1),
  ] }]);
  const r = moveTexts({ wts: WTS, info: null, objects: [{ path: "q", kind: "w3q", skin: false, doc }], otherTexts: [], otherRefs: [1, 2], baseName });
  const up = (n: number, field: string, text: string): [number, string, string] => [n, `Upgrades: R001 (${RHME}), ${field}`, text];
  assert.equal(r.wts, weTable([
    up(3, "Name (Name)", "Upg Two"), up(4, "class (Class)", "melee"), up(5, "effect1 (Effect 1)", "ratx"),
    up(6, "effect2 (Effect 2)", "rats"), up(7, "effect3 (Effect 3)", "rmov"), up(8, "effect4 (Effect 4)", "rhpx"),
  ]));
  assert.deepEqual(r.objects[0].doc.custom![0].mods!.map((m) => m.value),
    ["TRIGSTR_003", "orc", "BTNFootman.blp", "TRIGSTR_004", "TRIGSTR_005", "TRIGSTR_006", "TRIGSTR_007", "TRIGSTR_008", "AHhb", "hbla"]);
  // Without the game's name, the base's id.
  const bare = moveTexts({ wts: WTS, info: null, objects: [{ path: "q", kind: "w3q", skin: false, doc }], otherTexts: [], otherRefs: [1, 2] });
  assert.match(bare.wts!, /\/\/ Upgrades: R001 \(Rhme\), Name \(Name\)\r\n/);
});

test("references as the World Editor writes them, and as they're found", () => {
  assert.deepEqual([stringRef(3), stringRef(1234)], ["TRIGSTR_003", "TRIGSTR_1234"]);
  assert.deepEqual([...refsIn("TRIGSTR_007 TRIGSTR_7 TRIGSTR_12x")], [7, 12]);
});
