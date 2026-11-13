import assert from "node:assert/strict";
import { test } from "node:test";
import { DAY_SECONDS, stepHour } from "./daycycle";

const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test("stepHour advances 24 hours over a game day", () => {
  near(stepHour(0, DAY_SECONDS / 2), 12);
  near(stepHour(12, 20), 13);
});
test("stepHour wraps at 24", () => {
  near(stepHour(23, 40), 1);
  near(stepHour(5, DAY_SECONDS), 5);
  assert.ok(stepHour(23.99, 1) < 24);
});
test("stepHour ignores bad input", () => {
  near(stepHour(NaN, 20), 1);
  assert.equal(stepHour(7, -5), 7);
  assert.equal(stepHour(7, NaN), 7);
  near(stepHour(7, 20, 0), 8);
});
test("control: another day length gives another hour", () => {
  assert.ok(Math.abs(stepHour(0, 20, 240) - 1) > 0.5);
});
