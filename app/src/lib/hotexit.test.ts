import assert from "node:assert/strict";
import { test } from "node:test";
import { backupName, backupText, fromBase64, parseBackup, parseTerrainBackup, readBackups, toBase64, type Backup, type BackupStore } from "./hotexit";

const backup: Backup = { path: "map/war3map.w3u.json", editor: "w3.objectEditor", saved: "abc", time: 5, data: "{\"x\":1}" };

test("a tab's snapshot file is named by its editor and file", () => {
  assert.match(backupName("w3.textEditor", "map/a.txt"), /^[0-9a-f]{16}\.json$/);
  assert.notEqual(backupName("w3.textEditor", "map/a.txt"), backupName("w3.hexViewer", "map/a.txt"));
  assert.notEqual(backupName("w3.textEditor", "map/a.txt"), backupName("w3.textEditor", "map/b.txt"));
});

test("snapshots read back as written; what isn't one is none", async () => {
  assert.deepEqual(parseBackup(backupText(backup)), backup);
  for (const text of ["", "{", "null", "{}", backupText(backup).slice(0, -3), backupText(backup).replace("w3proj.unsaved/1", "w3proj.unsaved/2")]) assert.equal(parseBackup(text), null, text);
  const files = new Map([["/p/build/unsaved/a.json", backupText(backup)], ["/p/build/unsaved/b.json", "cut sho"], ["/p/build/unsaved/c.tmp", backupText(backup)]]);
  const store: BackupStore = {
    folder: () => "/p/build/unsaved",
    list: async () => [...files.keys()].map((f) => f.split("/").pop()!),
    read: async (f) => files.get(f)!,
    write: async () => {},
    remove: async () => {},
  };
  assert.deepEqual(await readBackups(store), [{ file: "/p/build/unsaved/a.json", backup }]);
  assert.deepEqual(await readBackups({ ...store, folder: () => null }), []);
});

test("binary parts come back byte for byte; the terrain editor's snapshot is checked", () => {
  const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 31) % 256);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  assert.deepEqual(parseTerrainBackup(JSON.stringify({ w3e: "AA==", groups: {} })), { w3e: "AA==", doodads: null, units: null, groups: {}, open: null });
  assert.throws(() => parseTerrainBackup("{}"), /aren't this editor's/);
});
