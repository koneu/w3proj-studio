import test from "node:test";
import assert from "node:assert/strict";
import { Turns } from "./turns";

const later = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test("jobs run one at a time, in the order they were queued", async () => {
  const t = new Turns(), log: string[] = [];
  let inFlight = 0, most = 0;
  const job = (name: string, ms: number) => async () => {
    inFlight++; most = Math.max(most, inFlight); log.push(`${name} start`);
    await later(ms);
    inFlight--; log.push(`${name} end`);
    return name;
  };
  const results = await Promise.all([t.run(job("a", 30)), t.run(job("b", 5)), t.runWithin(job("c", 1), 1000)]);
  assert.equal(most, 1);
  assert.deepEqual(log, ["a start", "a end", "b start", "b end", "c start", "c end"]);
  assert.deepEqual(results, ["a", "b", { ran: true, value: "c" }]);
});

test("a failed job doesn't hold the next, and its caller gets the failure", async () => {
  const t = new Turns();
  const failed = t.run(async () => { throw new Error("broken"); });
  const next = t.runWithin(async () => "ok", 1000);
  await assert.rejects(failed, /broken/);
  assert.deepEqual(await next, { ran: true, value: "ok" });
  await assert.rejects(t.runWithin(async () => { throw new Error("own"); }, 1000), /own/);
  assert.equal(await t.run(async () => 1), 1);
});

test("runWithin gives up on jobs before it that don't end in time: its job never runs, later ones don't wait for it", async () => {
  const t = new Turns();
  let release!: () => void;
  const hung = t.run(() => new Promise<void>((r) => { release = r; }));
  let ran = false;
  const r = await t.runWithin(async () => { ran = true; }, 20);
  assert.deepEqual(r, { ran: false });
  const after = t.run(async () => "after");
  release();
  await hung;
  assert.equal(await after, "after");
  assert.equal(ran, false);
});

test("a job that has started is waited for past the time limit", async () => {
  const t = new Turns();
  const r = await t.runWithin(async () => { await later(40); return "slow"; }, 10);
  assert.deepEqual(r, { ran: true, value: "slow" });
});
