import test from "node:test";
import assert from "node:assert/strict";
import { timeLimit } from "./timelimit";

test("timeLimit: an answer that never comes is a rejection; a prompt one passes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const never = assert.rejects(timeLimit(new Promise<string>(() => {}), 20), /no answer in 20 ms/);
  t.mock.timers.tick(20);
  await never;
  assert.equal(await timeLimit(Promise.resolve("x"), 1000), "x");
  await assert.rejects(timeLimit(Promise.reject(new Error("boom")), 1000), /boom/);
  // Control: a prompt answer isn't turned into a rejection when the time passes afterwards.
  const prompt = timeLimit(Promise.resolve("late"), 1000);
  assert.equal(await prompt, "late");
  t.mock.timers.tick(5000);
});
