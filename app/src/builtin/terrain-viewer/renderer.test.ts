import assert from "node:assert/strict";
import { test } from "node:test";
import { withGroup } from "./renderer";

const b = (group: string, name: string) => ({ group, name });
const names = (list: { name: string }[]) => list.map((x) => x.name).join(" ");

test("each object group keeps its place in the drawing order, whichever finished loading first", () => {
  // Units first, then cliffs, then doodads, as a slow cliff plan and a fast unit load can land.
  let list = withGroup([], "units", [b("units", "u1")]);
  list = withGroup(list, "cliffs", [b("cliffs", "c1"), b("cliffs", "c2")]);
  list = withGroup(list, "doodads", [b("doodads", "d1")]);
  list = withGroup(list, "shoreline", [b("shoreline", "s1")]);
  assert.equal(names(list), "c1 c2 s1 d1 u1");
  // The other order of arrival draws the same.
  let again = withGroup([], "shoreline", [b("shoreline", "s1")]);
  again = withGroup(again, "doodads", [b("doodads", "d1")]);
  again = withGroup(again, "cliffs", [b("cliffs", "c1"), b("cliffs", "c2")]);
  again = withGroup(again, "units", [b("units", "u1")]);
  assert.equal(names(again), names(list));
});

test("replacing a group swaps only its batches, in their own order", () => {
  const list = [b("cliffs", "c1"), b("doodads", "d1"), b("doodads", "d2"), b("units", "u1")];
  assert.equal(names(withGroup(list, "doodads", [b("doodads", "d3")])), "c1 d3 u1");
  assert.equal(names(withGroup(list, "doodads", [])), "c1 u1");
  assert.equal(names(withGroup(list, "cliffs", [b("cliffs", "c9"), b("cliffs", "c8")])), "c9 c8 d1 d2 u1");
  // A group without a place goes last; the input isn't changed.
  assert.equal(names(withGroup(list, "extra", [b("extra", "x1")])), "c1 d1 d2 u1 x1");
  assert.equal(names(list), "c1 d1 d2 u1");
});
