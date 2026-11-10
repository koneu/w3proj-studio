// The question before a sync from a map deletes files of the project the map doesn't have.

import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteQuestion, replaceQuestion, wouldDelete } from "./syncdeletes";

test("the list is read from the backend's refusal, as a string or an Error", () => {
  const list = ["map/Imports/a.txt", "maps/Old.w3x/"];
  assert.deepEqual(wouldDelete(`WOULD_DELETE: ${JSON.stringify(list)}`), list);
  assert.deepEqual(wouldDelete(new Error(`WOULD_DELETE: ${JSON.stringify(list)}`)), list);
});

test("no other error is taken for one", () => {
  assert.equal(wouldDelete("INCOMPLETE: 1 unnamed and 0 unreadable files (protected map?)"), null);
  assert.equal(wouldDelete("WOULD_DELETE: not json"), null);
  assert.equal(wouldDelete("WOULD_DELETE: [1, 2]"), null);
});

test("the question names the files, and its first answer deletes", () => {
  const one = deleteQuestion(["map/a.txt"], "My Map");
  assert.match(one.message, /removes 1 file of the project/);
  assert.match(one.message, /map\/a\.txt/);
  assert.equal(one.actions[0], "Remove and sync");
  const many = deleteQuestion(["map/a", "map/b", "map/c", "map/d", "map/e"], "My Map");
  assert.match(many.message, /map\/a, map\/b, map\/c and 2 more/);
  assert.match(many.message, /Remove them and sync\?/);
});

test("Replace Map's question names the files, says where they go, and its first answer replaces", () => {
  const q = replaceQuestion(["maps/One.w3x/map/a.txt", "maps/One.w3x/map/b", "maps/One.w3x/map/c", "maps/One.w3x/map/d"], "One.w3x", "Other.w3x");
  assert.match(q.message, /^Other\.w3x doesn't have 4 files of One\.w3x's project: maps\/One\.w3x\/map\/a\.txt, .* and 1 more\./);
  assert.match(q.message, /build\/campaign-maps/);
  assert.deepEqual(q.actions, ["Replace", "Cancel"]);
});
