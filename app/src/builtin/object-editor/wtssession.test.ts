import assert from "node:assert/strict";
import { test } from "node:test";
import { StringTable } from "../../lib/formats/wts";
import { WtsSession } from "./wtssession";

const wts = (a: string, b: string) => `STRING 1\n{\n${a}\n}\n\nSTRING 2\n{\n${b}\n}\n`;

/** A disk with the file; editor B is played by writing the file as another editor would. */
function setup() {
  const disk = { text: wts("one", "two") };
  const a = new WtsSession(disk.text);
  const save = () => a.save(async () => disk.text, async (t) => { disk.text = t; });
  return { disk, a, save };
}

test("undo past a save keeps the strings another editor saved since", async () => {
  const { disk, a, save } = setup();
  const s0 = a.snapshot();
  a.set(1, "ONE");
  const s1 = a.snapshot();
  await save();
  disk.text = wts("ONE", "TWO by B"); // editor B saved string 2
  a.restore(s0); // undo in A, past its save
  await save();
  const t = new StringTable(disk.text);
  assert.equal(t.get(1), "one", "A's own change is undone");
  assert.equal(t.get(2), "TWO by B", "B's string survives");
  a.restore(s1); // redo
  await save();
  assert.equal(new StringTable(disk.text).get(1), "ONE");
  assert.equal(new StringTable(disk.text).get(2), "TWO by B");
});

test("undo restores several of the editor's own strings, and dirty follows", async () => {
  const { disk, a, save } = setup();
  const s0 = a.snapshot();
  a.set(1, "x");
  const s1 = a.snapshot();
  a.set(2, "y");
  const s2 = a.snapshot();
  assert.equal(a.dirty, true);
  a.restore(s1);
  assert.equal(a.table.get(2), "two");
  assert.equal(a.table.get(1), "x");
  a.restore(s0);
  assert.equal(a.dirty, false);
  a.restore(s2);
  await save();
  assert.equal(disk.text, wts("x", "y"));
});
