import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnimProps, standSequence } from "./stand.ts";

// The sequences of the game's Human tower, in file order.
const tower = ["Birth", "Stand Ready Attack", "Portrait", "Birth Upgrade First Second third", "Stand Upgrade First Ready Attack",
  "Portrait Upgrade First", "Attack Stand  Ready Upgrade Second", "Stand Upgrade Second", "Portrait Upgrade Second",
  "Stand Upgrade Third Attack Ready", "Portrait Upgrade Third", "Death", "Decay"].map((name) => ({ name }));
const pick = (seqs: { name: string }[], props: string) => standSequence(seqs, parseAnimProps(props))?.name;

test("each tower stands in its own look", () => {
  assert.equal(pick(tower, ""), "Stand Ready Attack");
  assert.equal(pick(tower, "upgrade,first"), "Stand Upgrade First Ready Attack");
  assert.equal(pick(tower, "upgrade,second"), "Stand Upgrade Second");
  assert.equal(pick(tower, "upgrade,third"), "Stand Upgrade Third Attack Ready");
});

test("Animprops are read the way the game's tables write them", () => {
  assert.deepEqual(parseAnimProps("Upgrade,Second"), ["upgrade", "second"]);
  assert.deepEqual(parseAnimProps(" swim , upgrade "), ["swim", "upgrade"]);
  assert.deepEqual(parseAnimProps(""), []);
  assert.equal(pick(tower, "Upgrade,Second"), "Stand Upgrade Second");
});

test("a look alone, without the word upgrade, finds its animation", () => {
  assert.equal(pick(tower, "second"), "Stand Upgrade Second");
});

test("the plain look isn't an upgrade's, whatever comes first in the file", () => {
  const seqs = ["Stand Alternate", "Stand Upgrade First", "Stand", "Stand - 2"].map((name) => ({ name }));
  assert.equal(pick(seqs, ""), "Stand");
});

test("alternateex means the Alternate animations, which is all the game's models have", () => {
  const seqs = ["Stand", "Stand 2", "Stand Ready", "Stand Channel", "Stand Alternate", "Stand Ready Alternate"].map((name) => ({ name }));
  assert.equal(pick(seqs, "alternateex"), "Stand Alternate");
  assert.equal(pick(seqs, "alternate,alternateex"), "Stand Alternate");
  assert.deepEqual(parseAnimProps("alternate,alternateex"), ["alternate"]);
});

test("words match whole: Standard isn't Stand, and First isn't Upgrade First", () => {
  assert.equal(pick(["Cinematic Standard One", "Stand 1"].map((name) => ({ name })), ""), "Stand 1");
  const elemental = ["Attack Stand Ready First", "Stand 1", "Attack Stand Ready Upgrade First", "Stand 2", "Attack Stand Ready Second"].map((name) => ({ name }));
  assert.equal(pick(elemental, "first"), "Attack Stand Ready First");
  assert.equal(pick(elemental, "upgrade,first"), "Attack Stand Ready Upgrade First");
  assert.equal(pick(elemental, ""), "Stand 1");
});

test("a look the model lacks falls back to its plainest Stand, then its first animation", () => {
  assert.equal(pick(["Birth", "Stand Upgrade First", "Stand"].map((name) => ({ name })), "alternate"), "Stand");
  assert.equal(pick([{ name: "Birth" }, { name: "Death" }], "upgrade,first"), "Birth");
  assert.equal(pick([], ""), undefined);
});
