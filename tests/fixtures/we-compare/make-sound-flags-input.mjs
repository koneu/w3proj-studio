// Makes the inputs of tests/we-compare/sound-flags-we.json: beep.wav (a 0.25 s 440 Hz tone, 16-bit mono PCM at
// 22050 Hz: the file the World Editor's Import Sound / Replace Internal Sound and Studio take from disk) and
// sound-flags.w3m, a copy of random-group.w3m (a map the editor saved, with no sounds and no import list).
//
//   node tests/fixtures/we-compare/make-sound-flags-input.mjs
import { copyFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** A RIFF WAVE file of `ms` milliseconds of a sine tone. */
export function toneWav(ms = 250, hz = 440, rate = 22050) {
  const n = Math.round((rate * ms) / 1000);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), 44 + i * 2);
  return buf;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(here, "beep.wav"), toneWav());
  copyFileSync(join(here, "random-group.w3m"), join(here, "sound-flags.w3m"));
}
