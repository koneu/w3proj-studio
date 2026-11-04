import assert from "node:assert/strict";
import { test } from "node:test";
import { w3eFromText, w3eToText } from "./w3etext";

/** The Rust tests' sample (crates/w3proj/src/w3e.rs), with an unprintable cliff id. */
const TEXT = "W3E version 12\ntileset L\ncustom-tilesets 1\nground Ldrt Lgrs Lrok\ncliffs CLdi hex:00000000\ncorners 5 3\noffset -320 bits:3f000000\n"
  + "\n[height]\n0*4 -12\n0 0 -12 0 0\n-12 0*4\n"
  + "\n[water] all 100\n"
  + "\n[water-bits]\n00000\n00000\n00010\n"
  + "\n[texture]\n12012\n20120\n01201\n"
  + "\n[variation]\nins16\npu38d\n05afk\n"
  + "\n[cliff-variation] all 0\n"
  + "\n[cliff-texture] all f\n"
  + "\n[layer] all 2\n"
  + "\n[flags]\n00000\n00000\n00005\n";

test("unprintable tile ids round-trip as hex:XXXXXXXX", () => {
  const bytes = w3eFromText(TEXT);
  // Header 13 bytes, 3 ground ids (+count), the cliff count and CLdi: the zero id follows.
  assert.deepEqual([...bytes.subarray(13 + 4 + 12 + 4 + 4, 13 + 4 + 12 + 4 + 8)], [0, 0, 0, 0]);
  assert.equal(w3eToText(bytes), TEXT);
  assert.throws(() => w3eFromText(TEXT.replace("hex:00000000", "hex:0000000g")));
});
