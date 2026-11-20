// MP3 lengths as the World Editor writes them into SetSoundDuration (checked on 869 mp3s of CSW Tides of
// Darkness' chapter maps, see mp3DurationMs).

import assert from "node:assert/strict";
import { test } from "node:test";
import { soundDurationMs } from "./duration";

/** MPEG-1 layer III, 128 kbit/s, 44100 Hz, stereo, no padding: 417 bytes, 1152 samples. */
const FRAME = 417;
function frame(): Uint8Array {
  const b = new Uint8Array(FRAME);
  b.set([0xff, 0xfb, 0x90, 0x00]);
  return b;
}
/** A first frame carrying a Xing (or Info) header that counts `frames` audio frames. */
function xingFrame(frames: number, id = "Xing"): Uint8Array {
  const b = frame(), at = 4 + 32, dv = new DataView(b.buffer);
  for (let i = 0; i < 4; i++) b[at + i] = id.charCodeAt(i);
  dv.setUint32(at + 4, 1);
  dv.setUint32(at + 8, frames);
  return b;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const frames = (n: number) => concat(...Array.from({ length: n }, frame));
const ms = (n: number) => Math.floor((n * 1152 * 1000) / 44100);
/** An ID3v2 tag of `size` bytes of content in front. */
function id3(size: number): Uint8Array {
  const b = new Uint8Array(10 + size);
  b.set([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  return b;
}
function id3v1(): Uint8Array {
  const b = new Uint8Array(128);
  b.set([0x54, 0x41, 0x47]);
  return b;
}

test("an mp3 without a Xing header is a frame longer than its frames, as the World Editor counts it", () => {
  assert.equal(soundDurationMs(frames(100)), ms(101));
  assert.equal(soundDurationMs(concat(id3(1014), frames(100))), ms(101), "an ID3v2 tag in front adds nothing");
});

test("bytes after the last frame (an ID3v1 tag) count as one more frame", () => {
  assert.equal(soundDurationMs(concat(id3(1014), frames(100), id3v1())), ms(102));
});

test("a Xing header's frame count is the length, its own frame not counted; an Info header isn't read", () => {
  assert.equal(soundDurationMs(concat(xingFrame(100), frames(100))), ms(100));
  // The editor's save (we-drive --null-audio, branch we-batch-3): the game's S04Huntress03.mp3, an Info header of 127
  // frames in a file of 128, gave 3369 ms, the frames counted (the header's own included) plus one.
  assert.equal(soundDurationMs(concat(xingFrame(127, "Info"), frames(127))), ms(129));
  assert.equal(soundDurationMs(concat(id3(26), xingFrame(80, "Info"), frames(80))), ms(82));
  // A header without a frame count (flags 0): the frames are counted.
  const noCount = xingFrame(100);
  new DataView(noCount.buffer).setUint32(4 + 32 + 4, 0);
  assert.equal(soundDurationMs(concat(noCount, frames(100))), ms(102));
});

test("a WAV whose fmt chunk is cut off before its byte rate has no length, without throwing", () => {
  const b = new Uint8Array(30), d = new DataView(b.buffer);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WAVEfmt "), 8);
  d.setUint32(16, 16, true);
  assert.equal(soundDurationMs(b), null);
  const whole = new Uint8Array(52), w = new DataView(whole.buffer);
  whole.set(b.subarray(0, 20));
  w.setUint32(28, 1000, true);
  whole.set(new TextEncoder().encode("data"), 36);
  w.setUint32(40, 500, true);
  assert.equal(soundDurationMs(whole), 500, "control: the whole header gives its length");
});

test("bytes that aren't an mp3 have no length", () => {
  assert.equal(soundDurationMs(new Uint8Array(500)), null);
  assert.equal(soundDurationMs(id3v1()), null);
});

test("an ID3v2 tag that claims more bytes than the file has, an empty array and a lone header have no length, without throwing", () => {
  const huge = id3(1014);
  assert.equal(soundDurationMs(huge.subarray(0, 100)), null, "a tag cut short, with no frame after it");
  const claims = concat(id3(5000).subarray(0, 10), frames(3));
  assert.equal(soundDurationMs(claims), null, "a tag whose size runs past the end of the file");
  assert.equal(soundDurationMs(new Uint8Array(0)), null, "an empty array");
  assert.equal(soundDurationMs(id3(0)), null, "a header alone");
  assert.equal(soundDurationMs(id3(0).subarray(0, 9)), null, "a header cut short");
  assert.equal(soundDurationMs(frame()), ms(2), "control: one frame by itself is read (a frame longer than its frames)");
});
