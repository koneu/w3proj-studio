import assert from "node:assert/strict";
import { test } from "node:test";
import { keepFiles, removeStep, stepRemove } from "./remove";
import type { ReplaceFs } from "./replace";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

function memoryFs(files: Record<string, string>) {
  const all = new Map(Object.entries(files).map(([k, v]) => [k, bytes(v)]));
  const fs: ReplaceFs = {
    readBytes: async (p) => { const b = all.get(p); if (!b) throw new Error(`no ${p}`); return b.slice(); },
    writeBytes: async (p, b) => { all.set(p, b.slice()); },
    copy: async () => { throw new Error("unused"); },
    delete: async (p) => { all.delete(p); },
    size: (p) => all.get(p)?.length,
  };
  return { fs, all, read: (p: string) => text(all.get(p)) };
}

interface E { path: string; flags: number }
const mk = () => {
  const a: E = { path: "a.blp", flags: 0 }, b: E = { path: "b.mdx", flags: 5 }, c: E = { path: "c.wav", flags: 0 }, d: E = { path: "d.blp", flags: 10 };
  return { a, b, c, d, doc: { files: [a, b, c, d] } };
};

/** Removes `gone` the way the view does: the files kept, deleted, the entries taken out of the list. */
async function doRemove(m: ReturnType<typeof memoryFs>, doc: { files: E[] }, gone: E[], paths: string[]) {
  const kept = await keepFiles(m.fs, paths);
  for (const p of paths) await m.fs.delete(p);
  const step = removeStep(doc.files, new Set(gone), kept);
  doc.files = doc.files.filter((e) => !gone.includes(e));
  return step;
}

test("Remove undo: the entries return at their places (same objects, flags kept), the deleted files with their bytes", async () => {
  const m = memoryFs({ "b.mdx": "BBB", "d.blp": "DDDD" });
  const { b, d, doc } = mk();
  const before = [...doc.files];
  const step = await doRemove(m, doc, [b, d], ["b.mdx", "d.blp"]);
  assert.deepEqual(doc.files.map((e) => e.path), ["a.blp", "c.wav"]);
  assert.equal(m.all.size, 0);
  await stepRemove(m.fs, doc, step, -1);
  assert.deepEqual(doc.files, before);
  assert.ok(doc.files[1] === b && doc.files[3] === d);
  assert.equal(b.flags, 5);
  assert.equal(m.read("b.mdx"), "BBB");
  assert.equal(m.read("d.blp"), "DDDD");
  await stepRemove(m.fs, doc, step, 1);
  assert.deepEqual(doc.files.map((e) => e.path), ["a.blp", "c.wav"]);
  assert.equal(m.all.size, 0);
  await stepRemove(m.fs, doc, step, -1);
  assert.deepEqual(doc.files, before);
});

test("Remove undo: removing from the list only (no files) puts back just the entry", async () => {
  const m = memoryFs({ "a.blp": "A" });
  const { a, doc } = mk();
  const step = await doRemove(m, doc, [a], []);
  assert.equal(m.read("a.blp"), "A");
  await stepRemove(m.fs, doc, step, -1);
  assert.ok(doc.files[0] === a);
  assert.equal(m.read("a.blp"), "A");
});

test("Remove undo: refused, with nothing changed, when things aren't as the step left them", async () => {
  const m = memoryFs({ "b.mdx": "BBB" });
  const { b, doc } = mk();
  const step = await doRemove(m, doc, [b], ["b.mdx"]);
  // A file of that name appeared meanwhile.
  m.all.set("b.mdx", bytes("other"));
  await assert.rejects(stepRemove(m.fs, doc, step, -1), /in the project again/);
  assert.equal(doc.files.length, 3);
  assert.equal(m.read("b.mdx"), "other");
  m.all.delete("b.mdx");
  await stepRemove(m.fs, doc, step, -1);
  // Redo with the file changed since: kept, the entry stays.
  m.all.set("b.mdx", bytes("changed"));
  await assert.rejects(stepRemove(m.fs, doc, step, 1), /changed since/);
  assert.equal(doc.files.length, 4);
  assert.equal(m.read("b.mdx"), "changed");
  // Undo twice: the entry is in the list already.
  await assert.rejects(stepRemove(m.fs, doc, step, -1), /in the list again/);
});

test("Remove undo: files beyond the limit can't be taken back, and the refusal changes nothing", async () => {
  const m = memoryFs({ "b.mdx": "BBBBBB", "d.blp": "DD" });
  const { b, d, doc } = mk();
  const kept = await keepFiles(m.fs, ["b.mdx", "d.blp"], 7);
  assert.equal(kept[0].bytes !== null, true);
  assert.equal(kept[1].bytes, null);
  for (const p of ["b.mdx", "d.blp"]) await m.fs.delete(p);
  const step = removeStep(doc.files, new Set([b, d]), kept);
  doc.files = [mk().a];
  await assert.rejects(stepRemove(m.fs, doc, step, -1), /too large/);
  assert.equal(m.all.size, 0);
  assert.equal(doc.files.length, 1);
});
