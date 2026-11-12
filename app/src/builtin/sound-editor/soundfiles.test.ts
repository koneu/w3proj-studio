import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { exportSound, findSoundFile, planReplace, replaceSound, soundVariants, type ImportEntry } from "./soundfiles";
import { forgetCheckpointsOffWarning } from "../../lib/checkpoint";
import { commandNotFound } from "../../lib/commanderror";

test("a sound's other extensions are looked for, its own path first", () => {
  assert.deepEqual(soundVariants("Sound\\Music\\a.mp3"), ["Sound\\Music\\a.mp3", "Sound\\Music\\a.flac", "Sound\\Music\\a.ogg", "Sound\\Music\\a.wav"]);
});

const entry = (path: string, flags = 21): ImportEntry => ({ flags, path });

test("replacing with the same format overwrites in place and leaves the list alone", () => {
  const plan = planReplace({ soundFile: "war3mapImported\\boom.wav", sourceName: "new.WAV", projectFiles: ["map/war3mapImported/boom.wav"], imports: [entry("war3mapImported\\boom.wav")] });
  assert.equal(plan.write, "map/war3mapImported/boom.wav");
  assert.equal(plan.remove, null);
  assert.equal(plan.importsChanged, false);
  assert.equal(plan.inMap, true);
});

test("replacing with another format puts the new file at the sound's name, removes the old one and follows in the list", () => {
  const imports = [entry("war3mapImported\\boom.wav"), entry("war3mapImported\\other.wav")];
  const plan = planReplace({ soundFile: "war3mapImported\\boom.wav", sourceName: "x.mp3", projectFiles: ["map/war3mapImported/boom.wav", "map/Map/Other.txt"], imports });
  assert.equal(plan.write, "map/war3mapImported/boom.mp3");
  assert.equal(plan.remove, "map/war3mapImported/boom.wav");
  assert.deepEqual(plan.imports.map((e) => e.path), ["war3mapImported\\boom.mp3", "war3mapImported\\other.wav"]);
  assert.equal(plan.importsChanged, true);
  assert.equal(imports[0].path, "war3mapImported\\boom.wav", "the list handed in is not changed");
});

test("the file may be in the map under another extension than the sound names", () => {
  const plan = planReplace({ soundFile: "Sound\\a.wav", sourceName: "n.ogg", projectFiles: ["map/Sound/a.flac"], imports: [entry("Sound\\a.flac", 13)] });
  assert.equal(plan.write, "map/Sound/a.ogg");
  assert.equal(plan.remove, "map/Sound/a.flac");
  assert.equal(plan.imports[0].path, "Sound\\a.ogg");
  assert.equal(plan.imports[0].flags, 13);
});

test("a standard-path entry keeps its relative name", () => {
  const plan = planReplace({ soundFile: "war3mapImported\\v.wav", sourceName: "v.mp3", projectFiles: ["map/war3mapImported/v.wav"], imports: [entry("v.wav", 5)] });
  assert.deepEqual(plan.imports, [{ flags: 5, path: "v.mp3" }]);
});

test("a game sound gets the file as an override at its path, registered in the list", () => {
  const plan = planReplace({ soundFile: "Sound\\Buildings\\Death\\x.wav", sourceName: "mine.wav", projectFiles: ["map/war3map.j"], imports: [] });
  assert.equal(plan.inMap, false);
  assert.equal(plan.write, "map/Sound/Buildings/Death/x.wav");
  assert.equal(plan.remove, null);
  assert.deepEqual(plan.imports, [{ flags: 13, path: "Sound\\Buildings\\Death\\x.wav" }]);
  assert.equal(plan.importsChanged, true);
  // Another format: the override carries the new extension.
  assert.equal(planReplace({ soundFile: "Sound\\x.wav", sourceName: "m.flac", projectFiles: [], imports: [] }).write, "map/Sound/x.flac");
});

test("a file in the map that the list lacks is registered", () => {
  const plan = planReplace({ soundFile: "Sound\\a.wav", sourceName: "n.wav", projectFiles: ["map/Sound/a.wav"], imports: [] });
  assert.deepEqual(plan.imports, [{ flags: 13, path: "Sound\\a.wav" }]);
});

test("what is no sound, or has no name to replace, is refused", () => {
  assert.throws(() => planReplace({ soundFile: "a.wav", sourceName: "n.txt", projectFiles: [], imports: [] }), /isn't a sound file/);
  assert.throws(() => planReplace({ soundFile: "", sourceName: "n.wav", projectFiles: [], imports: [] }), /no file name/);
  assert.throws(() => planReplace({ soundFile: "noext", sourceName: "n.wav", projectFiles: [], imports: [] }), /no file name/);
});

interface Opts { mapFiles?: Record<string, Uint8Array>; gameFiles?: Record<string, Uint8Array>; pick?: string | null; save?: string | null; confirm?: boolean; unsaved?: string[]; imp?: string }

function fake(opts: Opts = {}) {
  const map = new Map(Object.entries(opts.mapFiles ?? {}));
  const log: string[] = [];
  const written: { path: string; bytes: Uint8Array }[] = [];
  let imp = opts.imp;
  const w3 = {
    workspace: {
      project: () => ({ root: "C:\\p" }),
      files: () => [...map.keys(), ...(imp === undefined ? [] : ["map/war3map.imp.json"])].map((path) => ({ path, size: 1, modified: 0 })),
      readBytes: async (p: string) => { const b = map.get(p); if (!b) throw new Error("none"); return b; },
      readText: async (p: string) => { if (p === "map/war3map.imp.json" && imp !== undefined) return imp; throw new Error("none"); },
      writeText: async (p: string, t: string) => { log.push(`writeText ${p}`); if (p === "map/war3map.imp.json") imp = t; },
      copy: async (from: string, to: string) => { log.push(`copy ${from} ${to}`); map.set(to, new Uint8Array([9])); },
      delete: async (p: string) => { log.push(`delete ${p}`); map.delete(p); },
      refresh: async () => { log.push("refresh"); },
    },
    game: { read: async (p: string) => { const b = (opts.gameFiles ?? {})[p]; if (!b) throw new Error("none"); return b; } },
    backend: {
      writeBytes: async (path: string, bytes: Uint8Array) => { written.push({ path, bytes }); },
      invoke: async (cmd: string, a: { text?: string }) => { if (cmd === "codec_canonicalize") return a.text!; throw new Error(cmd); },
    },
    editors: { unsavedPaths: () => opts.unsaved ?? [] },
    commands: { execute: async (id: string) => { log.push(`command ${id}`); } },
    window: {
      pickSaveFile: async () => (opts.save === undefined ? "C:\\out\\s.wav" : opts.save),
      pickFile: async () => (opts.pick === undefined ? "C:\\in\\new.mp3" : opts.pick),
      confirm: async () => { log.push("confirm"); return opts.confirm ?? true; },
      showInfo: async () => undefined,
    },
  } as unknown as W3Api;
  return { w3, log, written, map, imp: () => imp };
}

const bytes = (...b: number[]) => new Uint8Array(b);

test("the map's file is found first, also under another extension, then the game's", async () => {
  const f = fake({ mapFiles: { "map/Sound/a.ogg": bytes(1) }, gameFiles: { "Sound\\a.wav": bytes(2), "Sound\\b.flac": bytes(3) } });
  assert.deepEqual(await findSoundFile(f.w3, "Sound\\a.wav", null), { bytes: bytes(1), path: "Sound\\a.ogg", source: "map" });
  const g = await findSoundFile(f.w3, "Sound\\b.wav", null);
  assert.deepEqual([g?.path, g?.source, [...g!.bytes]], ["Sound\\b.flac", "game", [3]]);
  assert.equal(await findSoundFile(f.w3, "Sound\\none.wav", new Map()), null);
  // The game's storage path for a logical one.
  const h = fake({ gameFiles: { "War3.w3mod:Sound/c.wav": bytes(4) } });
  assert.equal((await findSoundFile(h.w3, "Sound\\c.wav", new Map([["Sound\\c.wav", "War3.w3mod:Sound/c.wav"]])))?.source, "game");
});

test("the map's sound is found under its name on disk when the sound names it in another case (Linux tells cases apart)", async () => {
  const f = fake({ mapFiles: { "map/war3mapimported/Boom.wav": bytes(5) }, gameFiles: { "war3mapImported\\boom.wav": bytes(6) } });
  assert.deepEqual(await findSoundFile(f.w3, "war3mapImported\\boom.wav", null), { bytes: bytes(5), path: "war3mapImported\\boom.wav", source: "map" });
});

test("Export Sound writes the sound's bytes to the chosen file", async () => {
  const f = fake({ mapFiles: { "map/Sound/a.wav": bytes(7, 8, 9) } });
  assert.equal(await exportSound(f.w3, "Sound\\a.wav", null), "C:\\out\\s.wav");
  assert.deepEqual(f.written, [{ path: "C:\\out\\s.wav", bytes: bytes(7, 8, 9) }]);
  const c = fake({ mapFiles: { "map/Sound/a.wav": bytes(1) }, save: null });
  assert.equal(await exportSound(c.w3, "Sound\\a.wav", null), null);
  assert.equal(c.written.length, 0);
  await assert.rejects(exportSound(fake().w3, "Sound\\gone.wav", null), /Can't find/);
  await assert.rejects(exportSound(fake().w3, "  ", null), /no file/);
});

const IMP = JSON.stringify({ format: "w3proj.imports/1", version: 1, files: [{ flags: 21, path: "war3mapImported\\boom.wav" }] });

test("Replace Internal Sound asks, makes a checkpoint, copies the file, removes the old one and updates the list", async () => {
  const f = fake({ mapFiles: { "map/war3mapImported/boom.wav": bytes(1) }, imp: IMP });
  assert.equal(await replaceSound(f.w3, "war3mapImported\\boom.wav"), "map/war3mapImported/boom.mp3");
  assert.deepEqual(f.log, ["confirm", "command w3.checkpoints.create", "copy C:\\in\\new.mp3 map/war3mapImported/boom.mp3", "delete map/war3mapImported/boom.wav", "writeText map/war3map.imp.json", "refresh"]);
  assert.deepEqual(JSON.parse(f.imp()!).files, [{ flags: 21, path: "war3mapImported\\boom.mp3" }]);
});

test("Replace Internal Sound goes on with the Checkpoints extension off, and says no checkpoint was made", async () => {
  forgetCheckpointsOffWarning();
  const f = fake({ mapFiles: { "map/war3mapImported/boom.wav": bytes(1) }, imp: IMP });
  const warned: string[] = [];
  Object.assign(f.w3.commands, { execute: async (id: string) => { f.log.push(`command ${id}`); throw new Error(commandNotFound(id)); } });
  Object.assign(f.w3.window, { showWarning: async (m: string) => { warned.push(m); } });
  assert.equal(await replaceSound(f.w3, "war3mapImported\\boom.wav"), "map/war3mapImported/boom.mp3");
  assert.ok(f.log.includes("copy C:\\in\\new.mp3 map/war3mapImported/boom.mp3"));
  assert.equal(warned.length, 1);
  assert.match(warned[0], /Replace Internal Sound went on without a checkpoint/);
  forgetCheckpointsOffWarning();
});

test("Replace Internal Sound stops before changing anything when the checkpoint fails", async () => {
  const f = fake({ mapFiles: { "map/war3mapImported/boom.wav": bytes(1) }, imp: IMP });
  Object.assign(f.w3.commands, { execute: async () => { throw new Error("disk full"); } });
  await assert.rejects(replaceSound(f.w3, "war3mapImported\\boom.wav"), /disk full/);
  assert.deepEqual(f.log, ["confirm"]);
});

test("Replace Internal Sound on a game sound registers the override in a new list", async () => {
  const f = fake({});
  await replaceSound(f.w3, "Sound\\x.wav");
  assert.ok(f.log.includes("copy C:\\in\\new.mp3 map/Sound/x.mp3"));
  assert.deepEqual(JSON.parse(f.imp()!).files, [{ flags: 13, path: "Sound\\x.mp3" }]);
  assert.equal(JSON.parse(f.imp()!).format, "w3proj.imports/1");
});

test("Replace Internal Sound changes nothing when declined, cancelled, with the list unsaved or a non-sound", async () => {
  const mapFiles = { "map/war3mapImported/boom.wav": bytes(1) };
  const declined = fake({ mapFiles, imp: IMP, confirm: false });
  assert.equal(await replaceSound(declined.w3, "war3mapImported\\boom.wav"), null);
  assert.deepEqual(declined.log, ["confirm"]);
  assert.equal(await replaceSound(fake({ mapFiles, imp: IMP, pick: null }).w3, "war3mapImported\\boom.wav"), null);
  await assert.rejects(replaceSound(fake({ mapFiles, imp: IMP, unsaved: ["map/war3map.imp.json"] }).w3, "war3mapImported\\boom.wav"), /Save or discard/);
  const bad = fake({ mapFiles, imp: IMP, pick: "C:\\in\\notes.txt" });
  await assert.rejects(replaceSound(bad.w3, "war3mapImported\\boom.wav"), /isn't a sound file/);
  assert.deepEqual(bad.log, []);
});

test("a replacement in another format that would overwrite another file of the map is refused", () => {
  const projectFiles = ["map/Sound/x.wav", "map/Sound/x.mp3"];
  assert.throws(() => planReplace({ soundFile: "Sound\\x.wav", sourceName: "new.mp3", projectFiles, imports: [] }), /Sound\\x\.mp3 is already in the map/);
  // The same format replaces its own file; a free name is fine.
  assert.equal(planReplace({ soundFile: "Sound\\x.wav", sourceName: "new.wav", projectFiles, imports: [] }).remove, null);
  assert.equal(planReplace({ soundFile: "Sound\\x.wav", sourceName: "new.ogg", projectFiles, imports: [] }).remove, "map/Sound/x.wav");
});

test("Replace Internal Sound refused for a clash writes nothing", async () => {
  const f = fake({ mapFiles: { "map/war3mapImported/boom.wav": bytes(1), "map/war3mapImported/boom.mp3": bytes(2) }, imp: IMP });
  await assert.rejects(replaceSound(f.w3, "war3mapImported\\boom.wav"), /already in the map/);
  assert.deepEqual(f.log, []);
  assert.deepEqual([...f.map.get("map/war3mapImported/boom.mp3")!], [2]);
});
