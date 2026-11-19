import assert from "node:assert/strict";
import { test } from "node:test";
import { namesToStrings, textsToStrings } from "./infostrings";

test("the save's names: plain players' names, then plain forces' names, numbered on; empty and references stay (plain-names-a, -b)", () => {
  // plain-names-a: the editor saved TRIGSTR_003, _004 for the players, _005 for the force.
  const a = {
    name: "Just another Warcraft III map", description: "Nondescript",
    players: [{ id: 0, name: "Plain player 1" }, { id: 1, name: "" }, { id: 2, name: "Plain player 3" }],
    forces: [{ flags: 0, name: "Plain force" }],
  };
  assert.deepEqual(namesToStrings(a, 3), [{ num: 3, text: "Plain player 1" }, { num: 4, text: "Plain player 3" }, { num: 5, text: "Plain force" }]);
  assert.deepEqual(a.players.map((p) => p.name), ["TRIGSTR_003", "", "TRIGSTR_004"]);
  assert.deepEqual(a.forces.map((f) => f.name), ["TRIGSTR_005"]);
  // The map's own texts stay plain: Map Size takes those, not the save.
  assert.equal(a.name, "Just another Warcraft III map");
  assert.equal(a.description, "Nondescript");
  // plain-names-b: a reference already stays, an empty force name too.
  const b = { players: [{ name: "" }, { name: "Plain player 2" }, { name: "TRIGSTR_001" }], forces: [{ name: "Plain force A" }, { name: "" }, { name: "Plain force C" }] };
  assert.deepEqual(namesToStrings(b, 3).map((s) => s.num), [3, 4, 5]);
  assert.deepEqual([...b.players, ...b.forces].map((x) => x.name), ["", "TRIGSTR_003", "TRIGSTR_001", "TRIGSTR_004", "", "TRIGSTR_005"]);
  // Control: names that are all references or empty give nothing and change nothing.
  const done = { players: [{ name: "TRIGSTR_003" }], forces: [{ name: "" }] };
  assert.deepEqual(namesToStrings(done, 9), []);
  assert.deepEqual(done, { players: [{ name: "TRIGSTR_003" }], forces: [{ name: "" }] });
});

test("the save's names with the table: a text the table has or an earlier name took refers to that string (plain-names-c)", () => {
  // plain-names-c: the table holds 2 "Force 1"; the editor saved TRIGSTR 3, 3, 4, 5 for the players and 3, 2, 6 for the forces.
  const c = { players: [{ name: "Twin" }, { name: "Twin" }, { name: "Player 1" }, { name: "twin" }], forces: [{ name: "Twin" }, { name: "Force 1" }, { name: "Lone" }] };
  assert.deepEqual(namesToStrings(c, 3, [[2, "Force 1"]]), [{ num: 3, text: "Twin" }, { num: 4, text: "Player 1" }, { num: 5, text: "twin" }, { num: 6, text: "Lone" }]);
  assert.deepEqual([...c.players, ...c.forces].map((x) => x.name), ["TRIGSTR_003", "TRIGSTR_003", "TRIGSTR_004", "TRIGSTR_005", "TRIGSTR_003", "TRIGSTR_002", "TRIGSTR_006"]);
  // studio-paths-matrix-masks: player 9 and force 2 both "Horde", one string.
  const m = { players: [{ name: "Defender 1" }, { name: "Horde" }], forces: [{ name: "Defenders" }, { name: "Horde" }] };
  assert.deepEqual(namesToStrings(m, 1, []).map((s) => s.text), ["Defender 1", "Horde", "Defenders"]);
  assert.deepEqual(m.forces.map((f) => f.name), ["TRIGSTR_003", "TRIGSTR_002"]);
  // Of two table strings with one text, the lower number; CRLF breaks count as LF.
  const two = { players: [{ name: "a\r\nb" }], forces: [] };
  assert.deepEqual(namesToStrings(two, 9, [[7, "a\nb"], [4, "a\r\nb"]]), []);
  assert.equal(two.players[0].name, "TRIGSTR_004");
  // Without the table (Map Size's call) a repeated name still gets a string of its own.
  const own = { players: [{ name: "Twin" }, { name: "Twin" }], forces: [] };
  assert.deepEqual(namesToStrings(own, 1).map((s) => s.num), [1, 2]);
});

test("names in a w3i without players or forces, or with odd entries, are left alone", () => {
  assert.deepEqual(namesToStrings({}, 1), []);
  assert.deepEqual(namesToStrings({ players: "x", forces: null }, 1), []);
  const odd = { players: [null, 7, { name: 5 }, { name: "Ok" }] };
  assert.deepEqual(namesToStrings(odd as unknown as Record<string, unknown>, 1000), [{ num: 1000, text: "Ok" }]);
  assert.deepEqual(odd.players[3], { name: "TRIGSTR_1000" });
});

test("texts to strings keep the table's LF breaks", () => {
  const o = { t: "two\r\nlines" };
  assert.deepEqual(textsToStrings([[o, "t"]], 12), [{ num: 12, text: "two\nlines" }]);
  assert.equal(o.t, "TRIGSTR_012");
});
