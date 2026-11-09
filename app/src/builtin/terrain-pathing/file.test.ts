// .w3proj/pathing.json as the Pathing Editor finds it: a file that is there and can't be used is never taken for
// one that isn't there (which painting may start anew), and replacing it needs a choice and a free backup name.

import assert from "node:assert/strict";
import { test } from "node:test";
import { backupPath, mayPaint, readPathingFile, replaceQuestion } from "./file";

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
