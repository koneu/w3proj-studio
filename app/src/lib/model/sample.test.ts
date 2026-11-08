import assert from "node:assert/strict";
import { test } from "node:test";
import type { Track } from "./mdx";
import { sample } from "./renderer";

/** What sample() is defined to do, the slow way: the first and last key inside the interval by going
 *  through all of them, then the key at or before t, linearly interpolated (interp 1, size 1). */
function byScan(times: number[], values: number[], start: number, end: number, t: number, fallback: number): number {
  let first = -1, last = -1;
  times.forEach((v, i) => { if (v >= start && v <= end) { if (first < 0) first = i; last = i; } });
  if (first < 0) return fallback;
  if (t <= times[first] || first === last) return values[first];
  if (t >= times[last]) return values[last];
  let i = first;
  while (i < last && times[i + 1] <= t) i++;
  const u = (t - times[i]) / (times[i + 1] - times[i]);
  return values[i] + (values[i + 1] - values[i]) * u;
}

/** Fixed seed, so every run checks the same tracks. */
function random(seed: number) {
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
}

test("sample finds a sequence's keys among all of a track's as going through them all does", () => {
  const r = random(7);
  for (let round = 0; round < 2000; round++) {
    // Keys of several sequences one after the other, some at the same time, now and then out of order.
    const n = 1 + Math.floor(r() * 40);
    let at = Math.floor(r() * 50);
    const times: number[] = [], values: number[] = [];
    for (let i = 0; i < n; i++) { at += Math.floor(r() * 3) === 0 ? 0 : Math.floor(r() * 200); times.push(at); values.push(Math.round(r() * 1000)); }
    if (round % 10 === 0 && n > 2) [times[0], times[n - 1]] = [times[n - 1], times[0]];
    const track = { interp: 1, globalSeq: -1, times: new Uint32Array(times), values: new Float32Array(values), size: 1 } as unknown as Track;
    for (let k = 0; k < 5; k++) {
      // Half the time the interval starts and ends on keys, as sequences do.
      const onKeys = r() < 0.5, pick = () => times[Math.floor(r() * n)];
      let start = onKeys ? pick() : Math.floor(r() * (at + 100)), end = onKeys ? pick() : start + Math.floor(r() * 1500);
      if (end < start) [start, end] = [end, start];
      const t = r() < 0.2 ? pick() : start + r() * (end - start);
      const got = sample(track, { frame: t, seqStart: start, seqEnd: end, time: 0 }, [], [-1])[0];
      const want = byScan(times, Array.from(new Float32Array(values)), start, end, t, -1);
      assert.ok(Math.abs(got - want) < 1e-3, `round ${round}: times ${times.join(",")}, ${start}–${end} at ${t}: ${got}, by going through all ${want}`);
    }
  }
});

test("sampling one track frame after frame, back again and in another sequence gives what going through the keys does", () => {
  // A pose samples the same track each frame a little later, and what it found last is kept: moments
  // forward, then back, then in another sequence and back, must all still find the right keys.
  const r = random(11);
  for (let round = 0; round < 300; round++) {
    const n = 2 + Math.floor(r() * 30);
    let at = 0;
    const times: number[] = [], values: number[] = [];
    for (let i = 0; i < n; i++) { at += Math.floor(r() * 4) === 0 ? 0 : 1 + Math.floor(r() * 100); times.push(at); values.push(Math.round(r() * 1000)); }
    const track = { interp: 1, globalSeq: -1, times: new Uint32Array(times), values: new Float32Array(values), size: 1 } as unknown as Track;
    const mid = times[Math.floor(n / 2)];
    const sequences: [number, number][] = [[0, mid], [mid, at], [0, at]];
    let seq = sequences[0], t = 0;
    for (let step = 0; step < 60; step++) {
      const what = r();
      if (what < 0.1) seq = sequences[Math.floor(r() * sequences.length)];
      if (what < 0.2) t = seq[0] + r() * (seq[1] - seq[0]); // a jump, back or ahead
      else t = Math.min(seq[1] + 5, t + r() * 40); // the next frame
      const got = sample(track, { frame: t, seqStart: seq[0], seqEnd: seq[1], time: 0 }, [], [-1])[0];
      const want = byScan(times, Array.from(new Float32Array(values)), seq[0], seq[1], t, -1);
      assert.ok(Math.abs(got - want) < 1e-3, `round ${round} step ${step}: times ${times.join(",")}, ${seq.join("–")} at ${t}: ${got}, by going through all ${want}`);
    }
  }
});
