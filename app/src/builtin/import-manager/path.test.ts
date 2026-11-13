import assert from "node:assert/strict";
import { test } from "node:test";
import { stepPath, type PathFs, type PathStep } from "./path";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

function setup() {
  const all = new Map<string, Uint8Array>([["map/a.blp", bytes("A")], ["map/objects.json", bytes('{"t":"new\\\\a.blp"}')]]);
  const dirty = new Set<string>();
  const log: string[] = [];
  const fs: PathFs = {
    readBytes: async (p) => { const b = all.get(p); if (!b) throw new Error(`no ${p}`); return b.slice(); },
    writeBytes: async (p, b) => { log.push(`write ${p}`); all.set(p, b.slice()); },
    copy: async () => { throw new Error("unused"); },
    delete: async (p) => { all.delete(p); },
    size: (p) => all.get(p)?.length,
    rename: async (a, b) => { log.push(`rename ${a} ${b}`); all.set(b, all.get(a)!); all.delete(a); },
    isDirty: (p) => dirty.has(p),
  };
  // The state after a change of path "a.blp" -> "new\\a.blp" with its references updated.
  const entry = { path: "new\\a.blp", flags: 7 };
  const other = { path: "z.blp", flags: 0 };
  const doc = { files: [other, entry] };
  all.set("map/new/a.blp", all.get("map/a.blp")!); all.delete("map/a.blp");
  const before = bytes('{"t":"a.blp"}'), after = all.get("map/objects.json")!;
  const step: PathStep<typeof entry> = {
    moves: [{ entry, before: { path: "a.blp", flags: 0 }, after: { path: "new\\a.blp", flags: 7 }, file: { from: "map/a.blp", to: "map/new/a.blp" } }],
    refs: [{ path: "map/objects.json", before, after }],
  };
  all.set("map/objects.json", after);
  return { fs, all, dirty, log, entry, other, doc, step, before, after };
}

test("Change path undo and redo: file, entry (path and flags) and references go back and forth", async () => {
  const t = setup();
  await stepPath(t.fs, t.doc, t.step, -1);
  assert.deepEqual(t.entry, { path: "a.blp", flags: 0 });
  assert.equal(text(t.all.get("map/a.blp")), "A");
  assert.equal(t.all.has("map/new/a.blp"), false);
  assert.equal(text(t.all.get("map/objects.json")), '{"t":"a.blp"}');
  await stepPath(t.fs, t.doc, t.step, 1);
  assert.deepEqual(t.entry, { path: "new\\a.blp", flags: 7 });
  assert.equal(text(t.all.get("map/new/a.blp")), "A");
  assert.equal(text(t.all.get("map/objects.json")), '{"t":"new\\\\a.blp"}');
});

test("Change path undo: refused with nothing changed when files or the list differ from what the step left", async () => {
  const cases: [string, (t: ReturnType<typeof setup>) => void, RegExp][] = [
    ["reference file edited since", (t) => t.all.set("map/objects.json", bytes("edited")), /changed since/],
    ["reference file open with unsaved changes", (t) => t.dirty.add("map/objects.json"), /unsaved changes/],
    ["old file name taken", (t) => t.all.set("map/a.blp", bytes("x")), /in the project already/],
    ["moved file gone", (t) => t.all.delete("map/new/a.blp"), /isn't in the project any more/],
    ["entry gone from the list", (t) => { t.doc.files.splice(1, 1); }, /isn't in the list/],
    ["entry changed since", (t) => { t.entry.path = "q.blp"; }, /isn't in the list/],
    ["old path used by another entry", (t) => { t.other.path = "A.BLP"; }, /in the list already/],
  ];
  for (const [name, make, re] of cases) {
    const t = setup();
    make(t);
    const snap = JSON.stringify([...t.all.entries()].map(([k, v]) => [k, text(v)]));
    const entry = JSON.stringify(t.entry);
    await assert.rejects(stepPath(t.fs, t.doc, t.step, -1), re, name);
    assert.deepEqual(t.log, [], name);
    assert.equal(JSON.stringify([...t.all.entries()].map(([k, v]) => [k, text(v)])), snap, name);
    assert.equal(JSON.stringify(t.entry), entry, name);
  }
});

test("Change path: a failed reference write puts the files and references back", async () => {
  const t = setup();
  t.step.refs.push({ path: "map/s.j", before: bytes("b"), after: bytes("a") });
  t.all.set("map/s.j", bytes("a"));
  const write = t.fs.writeBytes;
  t.fs.writeBytes = async (p, b) => { if (p === "map/s.j") throw new Error("disk"); await write(p, b); };
  await assert.rejects(stepPath(t.fs, t.doc, t.step, -1), /disk/);
  assert.equal(text(t.all.get("map/objects.json")), '{"t":"new\\\\a.blp"}');
  assert.equal(text(t.all.get("map/new/a.blp")), "A");
  assert.equal(t.all.has("map/a.blp"), false);
  assert.deepEqual(t.entry, { path: "new\\a.blp", flags: 7 });
});
