// waitQuiet (we-idle.mjs) on a fake clock: no editor needed.
import test from "node:test";
import assert from "node:assert/strict";
import { waitQuiet } from "./we-idle.mjs";

function clock() {
  const c = { t: 0, now: () => c.t, sleep: async (ms) => { c.t += ms; } };
  return c;
}

/** A sample function that shows `states[i]` at the i-th call, the last one forever. */
const script = (states, calls = { n: 0 }) => () => states[Math.min(calls.n++, states.length - 1)];

test("waitQuiet returns after the quiet time, not before the minimum", async () => {
  const c = clock();
  const r = await waitQuiet({ sample: script([{ key: "a", pic: "1" }]), clock: c, minMs: 1000, quietMs: 400, pollMs: 50 });
  assert.equal(r.ms, 1000, "quiet from the start, held back by the minimum");
  const c2 = clock();
  const r2 = await waitQuiet({ sample: script([{ key: "a", pic: "1" }]), clock: c2, minMs: 100, quietMs: 400, pollMs: 50 });
  assert.equal(r2.ms, 400);
});

test("waitQuiet counts from the last change in the windows or in a picture", async () => {
  const c = clock();
  // Change at the 3rd and 7th poll (t = 150 and 350 after the first sample at t = 0): the picture, then the windows.
  const calls = { n: 0 };
  const sample = () => {
    const n = calls.n++;
    return { key: n >= 7 ? "dialog" : "main", pic: n >= 3 ? `p${n >= 7 ? 7 : 3}` : "p0" };
  };
  const r = await waitQuiet({ sample, clock: c, minMs: 0, quietMs: 400, pollMs: 50 });
  assert.equal(r.ms, 350 + 400, "400 ms after the last change at 350");
});

test("waitQuiet gives up with an error naming what it waited for and what kept changing", async () => {
  const c = clock();
  let n = 0;
  await assert.rejects(
    waitQuiet({ sample: () => ({ key: "main", pic: String(n++) }), clock: c, what: "the Sound Editor's list", timeoutMs: 2000, pollMs: 100 }),
    /timed out after 2 s waiting for the Sound Editor's list: the picture was still changing 0 ms ago/,
  );
  const c2 = clock();
  n = 0;
  await assert.rejects(
    waitQuiet({ sample: () => ({ key: `w${n++}`, pic: "" }), clock: c2, timeoutMs: 1000, pollMs: 100 }),
    /waiting for the editor to go quiet: the windows \(w\d+\) was still changing/,
  );
});

test("waitQuiet does not return early on a picture that changes every poll (control: it can fail)", async () => {
  const c = clock();
  let n = 0;
  // Changes until poll 20 (t = 1000), then stands: the result must come 400 ms after that, not before.
  const r = await waitQuiet({ sample: () => ({ key: "k", pic: String(Math.min(n++, 20)) }), clock: c, minMs: 0, quietMs: 400, pollMs: 50 });
  assert.equal(r.ms, 1400);
});

test("waitQuiet counts the quiet time only from when the window waited for is there", async () => {
  const c = clock();
  const calls = { n: 0 };
  // The window appears at poll 40 (t = 2000) and draws until poll 44; before that the screen stands still.
  const sample = () => { const n = calls.n++; return { key: "main", pic: n < 40 ? "0" : String(Math.min(n, 44)), ready: n >= 40 }; };
  const r = await waitQuiet({ sample, clock: c, minMs: 0, quietMs: 400, pollMs: 50, what: 'a window titled "Sound Editor"' });
  assert.equal(r.ms, 44 * 50 + 400, "not 400 ms after the start, which would be before the window");
  const c2 = clock();
  await assert.rejects(
    waitQuiet({ sample: () => ({ key: "main", pic: "0", ready: false }), clock: c2, timeoutMs: 1000, what: 'a window titled "Object Editor"' }),
    /timed out after 1 s waiting for a window titled "Object Editor": the window wasn't there yet/,
  );
});
