import assert from "node:assert/strict";
import { test } from "node:test";
import { parseW3e } from "./w3e";
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
  assert.throws(() => w3eFromText(TEXT.replace("hex:00000000", "hex:0000000g")), /war3map\.w3e: tile id "hex:0000000g" isn't 4 characters or hex:XXXXXXXX/);
});

test("a cliff list of three and corners on number 2 round-trip (example map 29: CLdi CLgr CAdi)", () => {
  const text = TEXT.replace("cliffs CLdi hex:00000000", "cliffs CLdi CLgr CAdi").replace("[cliff-texture] all f", "[cliff-texture]\nf2f2f\n01201\nfffff");
  const bytes = w3eFromText(text);
  assert.equal(w3eToText(bytes), text);
  const t = parseW3e(bytes);
  assert.deepEqual(t.cliffTiles, ["CLdi", "CLgr", "CAdi"]);
  // The text's first row is the north one.
  assert.deepEqual(t.corners.slice(10, 15).map((c) => c.cliffTexture), [15, 2, 15, 2, 15]);
});
