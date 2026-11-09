// The settings layers (SettingsService, workspace.ts) against a made-up disk: a settings file that is there but can't be
// read (not JSON, not an object, no access) is never written over, and the user is told; a file that isn't there is
// "no settings yet", made by the first change.

import test from "node:test";
import assert from "node:assert/strict";

/** The disk: path → text; `locked` paths can't be read (but are there); `unknown` paths can't even be checked. */
const disk = new Map<string, string>();
const locked = new Set<string>();
const unknown = new Set<string>();
const writes: string[] = [];
const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.__TAURI_INTERNALS__ = {
  async invoke(command: string, args: Record<string, unknown>) {
    const path = String(args.path);
    switch (command) {
      case "fs_read_text":
        if (locked.has(path) || unknown.has(path)) throw `${path}: Permission denied (os error 13)`;
        if (!disk.has(path)) throw `${path}: No such file or directory (os error 2)`;
        return disk.get(path);
      case "fs_exists":
        if (unknown.has(path)) throw `${path} can't be checked: Permission denied (os error 13)`;
        return disk.has(path) || locked.has(path);
      case "fs_write_text":
        writes.push(path);
        disk.set(path, String(args.text));
        return { size: String(args.text).length, modified: 1 };
      default: throw `unexpected ${command}`;
    }
  },
  transformCallback: () => 1, unregisterCallback() {},
};

const { SettingsService, readSettingsFile } = await import("./workspace");
const USER = "/home/u/.config/w3proj/settings.json";
const ROOT = "/home/u/maps/Turtle", PROJECT = `${ROOT}/.w3proj/settings.json`;

const fresh = () => {
  disk.clear(); locked.clear(); unknown.clear(); writes.length = 0;
  const s = new SettingsService();
  const warned: string[] = [];
  s.warn = (m) => warned.push(m);
  return { s, warned };
};

test("a settings file that isn't JSON is kept: a change lasts for the session, nothing is written, the user is told", async () => {
  const { s, warned } = fresh();
  const mine = `{\n  // my comment\n  "game.installDir": "/games/w3",\n  "terrain.fog": false\n}\n`;
  disk.set(USER, mine);
  await s.load(USER);
  assert.ok(s.problem("user"), "the problem is known");
  assert.equal(warned.length, 1, "said when it is read");
  assert.match(warned[0], /is there, but it isn't valid JSON/);
  assert.match(warned[0], /Open Settings \(JSON\)/);
  await s.set("terrain.fog", true);
  assert.equal(disk.get(USER), mine, "the user's file was written over");
  assert.deepEqual(writes, []);
  assert.equal(s.get("terrain.fog"), true, "the change holds for the session");
  assert.equal(warned.length, 2);
  assert.match(warned[1], /terrain\.fog was changed for this session only/);
  await s.set("terrain.sky", "x");
  assert.equal(warned.length, 2, "said once, not at every change");
  assert.equal(disk.get(USER), mine);
  // Fixed and saved as JSON (the text editor's save loads it again): written to as before.
  disk.set(USER, `{ "game.installDir": "/games/w3" }`);
  await s.load(USER);
  assert.equal(s.problem("user"), null);
  await s.set("terrain.fog", false);
  assert.deepEqual(JSON.parse(disk.get(USER)!), { "game.installDir": "/games/w3", "terrain.fog": false });
});

test("a settings file that can't be read, isn't an object, or can't be checked is kept too", async () => {
  for (const [what, setup] of [
    ["no access", () => locked.add(USER)],
    ["an array", () => disk.set(USER, "[1, 2]")],
    ["not checkable", () => unknown.add(USER)],
  ] as const) {
    const { s, warned } = fresh();
    setup();
    const before = disk.get(USER);
    await s.load(USER);
    await s.set("terrain.fog", true);
    assert.deepEqual(writes, [], `${what}: written`);
    assert.equal(disk.get(USER), before, what);
    assert.ok(warned.length >= 1, `${what}: nothing said`);
  }
});

test("a file that isn't there, or is empty, is no settings yet: the first change makes it", async () => {
  for (const start of [undefined, "", "  \n"]) {
    const { s, warned } = fresh();
    if (start !== undefined) disk.set(USER, start);
    await s.load(USER);
    assert.equal(s.problem("user"), null);
    await s.set("terrain.fog", true);
    assert.deepEqual(JSON.parse(disk.get(USER)!), { "terrain.fog": true }, JSON.stringify(start));
    assert.deepEqual(warned, []);
  }
});

test("a file broken after it was read (by another program) isn't written over either", async () => {
  const { s, warned } = fresh();
  disk.set(USER, `{ "terrain.fog": false }`);
  await s.load(USER);
  const broken = `{ "terrain.fog": false, oops`;
  disk.set(USER, broken);
  await s.set("terrain.sky", "x");
  assert.equal(disk.get(USER), broken);
  assert.match(warned.join("\n"), /for this session only/);
  // Control: a file that still reads is written as before.
  const ok = fresh();
  disk.set(USER, `{ "terrain.fog": false }`);
  await ok.s.load(USER);
  await ok.s.set("terrain.sky", "x");
  assert.deepEqual(JSON.parse(disk.get(USER)!), { "terrain.fog": false, "terrain.sky": "x" });
});

test("the project's settings file: kept when unreadable, and the user's file is still written", async () => {
  const { s, warned } = fresh();
  const theirs = `{ "terrain.fog": tru }`;
  disk.set(PROJECT, theirs);
  await s.load(USER);
  await s.loadProject(ROOT);
  assert.match(warned.join("\n"), /\.w3proj\/settings\.json .* is there, but it isn't valid JSON/);
  assert.match(warned.join("\n"), /Open Project Settings \(JSON\)/);
  await s.set("terrain.fog", true, "project");
  assert.equal(disk.get(PROJECT), theirs);
  assert.equal(s.get("terrain.fog"), true);
  await s.set("terrain.sky", "x");
  assert.deepEqual(JSON.parse(disk.get(USER)!), { "terrain.sky": "x" }, "the user layer is fine and written");
});

test("two changes at once both reach the file, in order", async () => {
  const { s } = fresh();
  await s.load(USER);
  await Promise.all([s.set("a", 1), s.set("b", 2), s.set("a", 3)]);
  assert.deepEqual(JSON.parse(disk.get(USER)!), { a: 3, b: 2 });
  assert.equal(s.get("a"), 3);
});

test("readSettingsFile tells absent from unreadable", async () => {
  fresh();
  assert.deepEqual(await readSettingsFile(USER), { values: {}, problem: null });
  disk.set(USER, "﻿{ \"a\": 1 }");
  assert.deepEqual(await readSettingsFile(USER), { values: { a: 1 }, problem: null }, "a byte order mark is no problem");
  disk.set(USER, "{");
  assert.match((await readSettingsFile(USER)).problem ?? "", /isn't valid JSON/);
  disk.delete(USER);
  locked.add(USER);
  assert.match((await readSettingsFile(USER)).problem ?? "", /can't be read/);
  unknown.add(USER);
  assert.match((await readSettingsFile(USER)).problem ?? "", /can't be checked/);
});
