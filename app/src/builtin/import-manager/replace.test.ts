import assert from "node:assert/strict";
import { test } from "node:test";
import { replaceFile, stepReplace, type ReplaceFs } from "./replace";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

/** Project and disk files in memory; `failCopyTo` makes copies to that path fail (after truncating, as a real copy can). */
function memoryFs(files: Record<string, string>, opts: { failCopyTo?: string; failCopyFrom?: string } = {}) {
  const all = new Map(Object.entries(files).map(([k, v]) => [k, bytes(v)]));
  const writes: string[] = [];
  const fs: ReplaceFs = {
    readBytes: async (p) => { const b = all.get(p); if (!b) throw new Error(`no ${p}`); return b.slice(); },
    writeBytes: async (p, b) => { writes.push(p); all.set(p, b.slice()); },
    copy: async (from, to) => {
      if (from === opts.failCopyFrom) throw new Error(`can't read ${from}`);
      if (to === opts.failCopyTo) { all.set(to, new Uint8Array()); throw new Error(`disk full at ${to}`); }
      const b = all.get(from);
      if (!b) throw new Error(`no ${from}`);
      writes.push(to);
      all.set(to, b.slice());
    },
    delete: async (p) => { all.delete(p); },
    size: (p) => all.get(p)?.length,
  };
  return { fs, all, writes, read: (p: string) => text(all.get(p)) };
}

const FILE = "map/war3mapImported/a.blp";

test("Replace File: new content at the same path; undo and redo, each one step", async () => {
  const m = memoryFs({ [FILE]: "old", "/disk/new.blp": "brand new" });
  const step = await replaceFile(m.fs, FILE, "/disk/new.blp");
  assert.equal(m.read(FILE), "brand new");
  // Nothing is left beside it.
  assert.deepEqual([...m.all.keys()].sort(), ["/disk/new.blp", FILE].sort());
  await stepReplace(m.fs, step, -1);
  assert.equal(m.read(FILE), "old");
  await stepReplace(m.fs, step, 1);
  assert.equal(m.read(FILE), "brand new");
});

test("Replace File: a source that can't be read leaves the file as it was", async () => {
  const m = memoryFs({ [FILE]: "old" }, { failCopyFrom: "/disk/gone.blp" });
  await assert.rejects(replaceFile(m.fs, FILE, "/disk/gone.blp"), /can't read/);
  assert.equal(m.read(FILE), "old");
  assert.deepEqual([...m.all.keys()], [FILE]);
});

test("Replace File: a copy failing on the file itself puts the old content back", async () => {
  const m = memoryFs({ [FILE]: "old", "/disk/new.blp": "new" }, { failCopyTo: FILE });
  await assert.rejects(replaceFile(m.fs, FILE, "/disk/new.blp"), /disk full/);
  assert.equal(m.read(FILE), "old");
  assert.equal(m.all.has(`${FILE}.replacing`), false);
});

test("Replace File: a missing file, or something in the way, is refused before anything is written", async () => {
  const m = memoryFs({ "/disk/new.blp": "new", [FILE]: "old", [`${FILE}.replacing`]: "mine" });
  await assert.rejects(replaceFile(m.fs, "map/war3mapImported/none.blp", "/disk/new.blp"), /isn't in the project/);
  await assert.rejects(replaceFile(m.fs, FILE, "/disk/new.blp"), /in the way/);
  assert.equal(m.read(FILE), "old");
  assert.equal(m.read(`${FILE}.replacing`), "mine");
  assert.deepEqual(m.writes, []);
});

test("Replace File undo: refused when the file changed since, or was too large to keep", async () => {
  const m = memoryFs({ [FILE]: "old", "/disk/new.blp": "new" });
  const step = await replaceFile(m.fs, FILE, "/disk/new.blp");
  await m.fs.writeBytes(FILE, bytes("edited elsewhere"));
  await assert.rejects(stepReplace(m.fs, step, -1), /changed since/);
  assert.equal(m.read(FILE), "edited elsewhere");
  // Control: as the step left it, undo works.
  await m.fs.writeBytes(FILE, bytes("new"));
  await stepReplace(m.fs, step, -1);
  assert.equal(m.read(FILE), "old");

  const big = memoryFs({ [FILE]: "0123456789", "/disk/new.blp": "abcdefghijk" });
  const unkept = await replaceFile(big.fs, FILE, "/disk/new.blp", 4);
  assert.equal(big.read(FILE), "abcdefghijk");
  assert.equal(unkept.before, null);
  await assert.rejects(stepReplace(big.fs, unkept, -1), /too large/);
  assert.equal(big.read(FILE), "abcdefghijk");
});
