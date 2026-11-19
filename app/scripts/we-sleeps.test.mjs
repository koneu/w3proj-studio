// The sleep inventory (we-sleeps.mjs): which kind of step each fixed pause follows.
import test from "node:test";
import assert from "node:assert/strict";
import { inventory, studioKind, weKind, weStep } from "./we-sleeps.mjs";

test("weKind sorts a --sleep by the step before it, and by a picture after it", () => {
  const steps = [["--sleep", "1"], ["--key", "F5"], ["--sleep", "2000"], ["--click", "1,1"], ["--sleep", "60"], ["--sleep", "9"], ["--view", "Lighting=off"], ["--sleep", "5"], ["--sleep", "7"], ["--shot", "a.png"], ["--map", "m"], ["--sleep", "3"]];
  const kinds = steps.map((s, i) => (s[0] === "--sleep" ? weKind(steps, i) : null)).filter(Boolean);
  assert.deepEqual(kinds, ["other", "key", "click", "sleep", "menu", "picture", "open"]);
});

test("weStep reads both spellings", () => {
  assert.deepEqual(weStep("--key d"), ["--key", "d"]);
  assert.deepEqual(weStep(["--close-modules"]), ["--close-modules", undefined]);
});

test("inventory counts steps and milliseconds on both sides", () => {
  const r = inventory([
    { we: { steps: [["--key", "F5"], ["--sleep", "2000"], "--sleep 300"] }, studio: { steps: [{ open: "x" }, { sleep: 500 }, { command: "c" }, { sleep: 100 }] } },
    { we: { steps: [] }, studio: { steps: [{ eval: "1" }] } },
  ]);
  assert.equal(r.specs, 2);
  assert.equal(r.withSleep, 1);
  assert.deepEqual(r.we, { key: { steps: 1, ms: 2000 }, sleep: { steps: 1, ms: 300 } });
  assert.deepEqual(r.studio, { open: { steps: 1, ms: 500 }, command: { steps: 1, ms: 100 } });
  assert.equal(studioKind([{ sleep: 1 }], 0), "first");
});
