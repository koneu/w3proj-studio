// .w3proj/pathing.json as the Pathing Editor finds it: a file that is there and can't be used is never taken for
// one that isn't there (which painting may start anew), and replacing it needs a choice and a free backup name.

import assert from "node:assert/strict";
import { test } from "node:test";
import { backupPath, importWpmDifferences, mayPaint, readPathingFile, replaceQuestion } from "./file";

const FILE = ".w3proj/pathing.json";
const good = (w: number, h: number) => JSON.stringify({ format: "w3proj.pathing/1", width: w, height: h, cells: [[1, 2, 2, 0]] });
const read = (text: string | Error) => async () => { if (text instanceof Error) throw text; return text; };
const yes = async () => true, no = async () => false;

test("a pathing file is absent, usable, for another size, or unreadable, and only the first two may be painted into", async () => {
  const absent = await readPathingFile(no, read(new Error("never read")), 256, 256);
  assert.deepEqual(absent, { state: "absent" });
  const ok = await readPathingFile(yes, read(good(256, 256)), 256, 256);
  assert.equal(ok.state, "ok");
  const other = await readPathingFile(yes, read(good(128, 128)), 256, 256);
  assert.equal(other.state, "otherSize");
  for (const [label, f] of [
    ["not JSON", await readPathingFile(yes, read("{ cells: oops"), 256, 256)],
    ["not a pathing file", await readPathingFile(yes, read(JSON.stringify({ hello: 1 })), 256, 256)],
    ["a read that fails", await readPathingFile(yes, read(new Error("EACCES")), 256, 256)],
    ["a presence that can't be checked", await readPathingFile(async () => { throw "Permission denied"; }, read(good(256, 256)), 256, 256)],
  ] as const) {
    assert.equal(f.state, "unreadable", label);
    assert.equal(mayPaint(f, false), false, `${label}: painting is off`);
    assert.equal(mayPaint(f, true), true, `${label}: until the user chose to replace it`);
  }
  assert.equal(mayPaint(absent, false), true);
  assert.equal(mayPaint(ok, false), true);
  assert.equal(mayPaint(other, false), false);
  assert.equal(mayPaint(null, true), false, "not looked at yet: nothing is painted");
});

test("replacing a file it can't use is asked, saying a backup is kept; a usable or absent file asks nothing", async () => {
  const bad = await readPathingFile(yes, read("nope"), 256, 256);
  const q = replaceQuestion(bad, FILE, 256, 256)!;
  assert.match(q.message, /isn't valid JSON/);
  assert.match(q.message, /pathing\.json\.bak/);
  assert.equal(q.actions[0], "Start a new file");
  const other = await readPathingFile(yes, read(good(128, 64)), 256, 256);
  const r = replaceQuestion(other, FILE, 256, 256)!;
  assert.match(r.message, /128×64 pathing map; this map's is 256×256/);
  assert.equal(r.actions[0], "Replace");
  assert.equal(replaceQuestion(await readPathingFile(no, read(""), 256, 256), FILE, 256, 256), null);
  assert.equal(replaceQuestion(await readPathingFile(yes, read(good(256, 256)), 256, 256), FILE, 256, 256), null);
});

test("a backup never takes the name of an earlier one, and a name it can't check stops it", async () => {
  const taken = new Set([`${FILE}.bak`, `${FILE}.bak2`]);
  assert.equal(await backupPath(FILE, async (p) => taken.has(p)), `${FILE}.bak3`);
  assert.equal(await backupPath(FILE, no), `${FILE}.bak`);
  await assert.rejects(backupPath(FILE, async () => { throw "Permission denied"; }));
  await assert.rejects(backupPath(FILE, yes), /99 backups/);
});

const wpmOf = (w: number, h: number, cells: number[]) => {
  const b = new Uint8Array(16 + cells.length);
  b.set([0x4d, 0x50, 0x33, 0x57]);
  const v = new DataView(b.buffer);
  v.setUint32(8, w, true); v.setUint32(12, h, true);
  b.set(cells, 16);
  return b;
};

test("importing a wpm's differences makes set and clear masks, leaves equal cells and unsaved overrides, and is idempotent", () => {
  const derived = Uint8Array.from([0, 0x0a, 0x02, 0x40, 0]);
  const wpm = wpmOf(5, 1, [0x08, 0x0a, 0x00, 0x42, 0]);
  const painted = new Map([[4, { set: 2, clear: 0 }]]);
  const r = importWpmDifferences(wpm, derived, 5, 1, painted);
  assert.ok(!("error" in r));
  assert.deepEqual([...r.changed], [[0, { set: 0x08, clear: 0 }], [2, { set: 0, clear: 0x02 }], [3, { set: 0x02, clear: 0 }]]);
  assert.equal(r.differing, 3);
  const again = importWpmDifferences(wpm, derived, 5, 1, new Map([...painted, ...r.changed]));
  assert.ok(!("error" in again));
  assert.equal(again.changed.size, 0, "a second import changes nothing");
  assert.equal(again.differing, 3);
  // control: without the already-imported overrides the same call does change cells
  assert.equal((importWpmDifferences(wpm, derived, 5, 1, new Map()) as { changed: Map<number, unknown> }).changed.size, 3);
});

test("a wpm of another size, cut short or not a wpm is refused", () => {
  const derived = new Uint8Array(4);
  for (const wpm of [wpmOf(2, 3, new Array(6).fill(0)), wpmOf(2, 2, [0, 0]), new Uint8Array(20)]) {
    const r = importWpmDifferences(wpm, derived, 2, 2, new Map());
    assert.ok("error" in r);
  }
  assert.match((importWpmDifferences(wpmOf(2, 3, new Array(6).fill(0)), derived, 2, 2, new Map()) as { error: string }).error, /2×3 cells, this map's pathing is 2×2/);
});
