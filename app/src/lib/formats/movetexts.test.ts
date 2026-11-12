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

test("references as the World Editor writes them, and as they're found", () => {
  assert.deepEqual([stringRef(3), stringRef(1234)], ["TRIGSTR_003", "TRIGSTR_1234"]);
  assert.deepEqual([...refsIn("TRIGSTR_007 TRIGSTR_7 TRIGSTR_12x")], [7, 12]);
});
