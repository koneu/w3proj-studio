import assert from "node:assert/strict";
import { test } from "node:test";
import { outside, rangeNote, rangeOf, rangeText } from "./limits";

test("number fields have the table's range", () => {
  assert.deepEqual(rangeOf("int", "0", "522"), { min: 0, max: 522 });
  assert.deepEqual(rangeOf("unreal", "-1000", "1000"), { min: -1000, max: 1000 });
  assert.deepEqual(rangeOf("real", "0.1", "10"), { min: 0.1, max: 10 });
});

test("one side alone is a range; none, or words, aren't", () => {
  assert.deepEqual(rangeOf("int", undefined, "20"), { max: 20 });
  assert.deepEqual(rangeOf("int", "1", ""), { min: 1 });
  assert.equal(rangeOf("int", undefined, undefined), undefined);
  assert.equal(rangeOf("int", "TTName", "TTDesc"), undefined);
  assert.deepEqual(rangeOf("int", "TTName", "5"), { max: 5 });
});

test("other types use those columns for something else", () => {
  for (const type of ["string", "stringList", "bool", "abilityList", "unitCode", "attackBits", "morphFlags", "detectionType"]) {
    assert.equal(rangeOf(type, "0", "10"), undefined, type);
  }
});

test("the limits themselves are allowed", () => {
  const r = { min: 0, max: 522 };
  for (const v of [0, 522, 300, "300", 0.5]) assert.equal(outside(r, v), false, String(v));
  for (const v of [-1, 523, 1000, "1000", 522.5, -0.1]) assert.equal(outside(r, v), true, String(v));
});

test("a range with one side only limits that side", () => {
  assert.equal(outside({ max: 20 }, -9999), false);
  assert.equal(outside({ max: 20 }, 21), true);
  assert.equal(outside({ min: 1 }, 99999), false);
  assert.equal(outside({ min: 1 }, 0), true);
});

test("what isn't a number is never outside", () => {
  assert.equal(outside(undefined, 5), false);
  assert.equal(outside({ min: 0, max: 1 }, ""), false);
  assert.equal(outside({ min: 0, max: 1 }, "hello"), false);
  assert.equal(outside({ min: 0, max: 1 }, Number.NaN), false);
});

test("the tooltip says the range, and the warning that it's still saved", () => {
  assert.equal(rangeText({ min: 0, max: 522 }), "0 to 522");
  assert.equal(rangeText({ max: 20 }), "at most 20");
  assert.equal(rangeText({ min: 1 }), "at least 1");
  assert.equal(rangeNote(undefined, false), "");
  assert.equal(rangeNote({ min: 0, max: 522 }, false), "World Editor's range: 0 to 522");
  assert.match(rangeNote({ min: 0, max: 522 }, true), /Outside .*0 to 522.*saved as typed/);
});
