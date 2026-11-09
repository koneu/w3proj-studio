import { test } from "node:test";
import assert from "node:assert/strict";
import { Listeners } from "./listeners";

test("fire reaches every listener, past one that throws; dispose takes one out", () => {
  const l = new Listeners<number>();
  const got: string[] = [];
  const error = console.error;
  console.error = () => {};
  try {
    l.add((v) => got.push(`a${v}`));
    l.add(() => { throw new Error("boom"); });
    const c = l.add((v) => got.push(`c${v}`));
    l.fire(1);
    c.dispose();
    l.fire(2);
  } finally { console.error = error; }
  assert.deepEqual(got, ["a1", "c1", "a2"]);
  assert.equal(l.size, 2);
});

test("a listener added while firing waits for the next fire", () => {
  const l = new Listeners();
  let late = 0;
  l.add(() => { l.add(() => { late++; }); });
  l.fire();
  assert.equal(late, 0);
  l.fire();
  assert.equal(late, 1);
});
