import assert from "node:assert/strict";
import { test } from "node:test";
import { artKeys, artValue, reforgedArt } from "./artset";

/** A skin entry as a lookup of its keys. */
const entry = (keys: Record<string, string>) => (k: string) => keys[k];

test("each mode reads its own key, then the plain one, then Classic's; the 3.0 art reads the HD key after its own", () => {
  assert.deepEqual(artKeys("file", "sd"), ["file:sd", "file"]);
  assert.deepEqual(artKeys("file", "hd"), ["file:hd", "file", "file:sd"]);
  assert.deepEqual(artKeys("file", "de"), ["file:de", "file", "file:sd"]);
  assert.deepEqual(artKeys("file", "de", true), ["file:de", "file:hd", "file", "file:sd"]);
  assert.deepEqual(artKeys("file", "hd", true), ["file:hd", "file", "file:sd"], "hdFirst is the 3.0 art's only");
});

test("the World Editor's DE view draws a type's HD model when it names no DE one (the Ruins canopy tree ZTtc)", () => {
  const ztTc = entry({ file: "Doodads\\Ashenvale\\Plants\\AshenCanopyTree\\AshenCanopyTree", "file:hd": "Doodads\\Ruins\\Plants\\RuinsCanopyTree\\RuinsCanopyTree", numvar: "3", "numvar:hd": "0" });
  assert.equal(artValue(ztTc, "file", "de", true), "Doodads\\Ruins\\Plants\\RuinsCanopyTree\\RuinsCanopyTree");
  assert.equal(artValue(ztTc, "numvar", "de", true), "0", "the HD model's one model, not the classic three");
  assert.equal(artValue(ztTc, "file", "sd"), "Doodads\\Ashenvale\\Plants\\AshenCanopyTree\\AshenCanopyTree");
  // The classic model is the fallback, read when the HD one's file isn't stored in the DE set.
  assert.equal(reforgedArt(ztTc, "file", "de", true), "Doodads\\Ashenvale\\Plants\\AshenCanopyTree\\AshenCanopyTree");
  assert.equal(reforgedArt(ztTc, "file", "hd", true), undefined);
  // An entry with its own DE art reads that, with no fallback; one without HD art has nothing to fall back from.
  const own = entry({ file: "A", "file:hd": "B", "file:de": "C" });
  assert.deepEqual([artValue(own, "file", "de", true), reforgedArt(own, "file", "de", true)], ["C", undefined]);
  assert.equal(reforgedArt(entry({ file: "A" }), "file", "de", true), undefined);
  // Units (no hdFirst) keep Classic first, the HD model as the fallback: nogl names only file:hd and file:sd.
  const nogl = entry({ "file:hd": "H", "file:sd": "S" });
  assert.deepEqual([artValue(nogl, "file", "de"), reforgedArt(nogl, "file", "de")], ["S", "H"]);
});
