import assert from "node:assert/strict";
import { test } from "node:test";
import { runLayerJobs } from "./layerjobs";

/** The label and the refreshes, as the terrain viewer keeps them. */
function viewer() {
  let seq = 0;
  const label = { busy: false };
  const refresh = (start: () => Promise<unknown>[]) => {
    const mine = ++seq;
    return runLayerJobs(start, () => mine === seq, (busy) => { label.busy = busy; });
  };
  return { label, refresh };
}

const later = () => {
  let done!: () => void, fail!: (e: unknown) => void;
  const p = new Promise<void>((res, rej) => { done = res; fail = rej; });
  return { p, done, fail };
};

test("the label shows while a layer is worked out and goes once it is in", async () => {
  const v = viewer(), job = later();
  const run = v.refresh(() => [job.p]);
  assert.equal(v.label.busy, true);
  job.done();
  assert.equal(await run, null);
  assert.equal(v.label.busy, false);
});

test("a layer that throws at once still ends with the label hidden, and its error is reported", async () => {
  const v = viewer(), slow = later();
  // An earlier refresh put the label up and is still waiting.
  const first = v.refresh(() => [slow.p]);
  assert.equal(v.label.busy, true);
  const boom = new Error("pathing failed");
  const second = await v.refresh(() => { throw boom; });
  assert.equal(v.label.busy, false, "the latest refresh threw: the label of the earlier one stayed on");
  assert.deepEqual(second, { error: boom });
  // The earlier one finishing doesn't put it up again, and doesn't touch it: it isn't the latest.
  slow.done();
  assert.equal(await first, null);
  assert.equal(v.label.busy, false);
});

test("a rejected layer is reported, and an older refresh doesn't hide the label of a newer one", async () => {
  const v = viewer(), old = later(), current = later();
  const first = v.refresh(() => [old.p]);
  const second = v.refresh(() => [current.p]);
  old.fail(new Error("cameras unreadable"));
  assert.equal(((await first)?.error as Error).message, "cameras unreadable");
  assert.equal(v.label.busy, true, "the newer refresh is still working");
  current.done();
  assert.equal(await second, null);
  assert.equal(v.label.busy, false);
});

test("no late layers: the label isn't shown", async () => {
  const seen: boolean[] = [];
  assert.equal(await runLayerJobs(() => [], () => true, (b) => seen.push(b)), null);
  assert.deepEqual(seen, [false, false]);
});
