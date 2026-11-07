import test from "node:test";
import assert from "node:assert/strict";
import type { Settings } from "../extensions/api";

// The backend is the Tauri IPC: a stand-in game with a few files, counting what is asked.
const stored = new Map<string, Uint8Array>([
  ["units/unitdata.slk", new Uint8Array([1, 2, 3])],
  ["big.dds", new Uint8Array(600)],
  ["a.dds", new Uint8Array(300)],
  ["b.dds", new Uint8Array(300)],
]);
const asked: { path: string; mode: unknown; install: unknown }[] = [];
let busy = false, unopened = false;
let hold: Promise<void> | null = null;
const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.__TAURI_INTERNALS__ = {
  async invoke(command: string, args: Record<string, unknown>) {
    if (command !== "game_read") throw `unexpected ${command}`;
    const path = String(args.path);
    asked.push({ path, mode: args.modeName, install: args.install });
    if (hold) await hold;
    if (busy) throw "io: the storage is busy";
    if (unopened) throw "game data: .build.info: not there (os error 3)";
    const bytes = stored.get(path.replace(/\\/g, "/").toLowerCase());
    if (!bytes) throw `not found: ${path}`;
    // As the IPC answers: a fresh buffer each time.
    return bytes.slice().buffer;
  },
  transformCallback: () => 1, unregisterCallback() {},
};

const { GameService } = await import("./game");

function make(cacheBytes?: number) {
  const values: Record<string, unknown> = { "game.installDir": "C:\\Games\\W3", "game.graphicsMode": "hd" };
  const listeners: ((key: string) => void)[] = [];
  const settings = {
    get: (key: string) => values[key],
    onDidChange: (l: (key: string) => void) => { listeners.push(l); return { dispose() {} }; },
  } as unknown as Settings;
  const set = (key: string, value: unknown) => { values[key] = value; listeners.forEach((l) => l(key)); };
  asked.length = 0;
  busy = unopened = false;
  hold = null;
  return { game: new GameService(settings, cacheBytes), set };
}

test("a game file read twice is asked of the backend once, by any spelling of its path", async () => {
  const { game } = make();
  assert.deepEqual([...await game.read("Units\\UnitData.slk")], [1, 2, 3]);
  assert.deepEqual([...await game.read("units/unitdata.slk")], [1, 2, 3]);
  assert.equal(await game.readText("Units\\UnitData.slk"), "\u0001\u0002\u0003");
  assert.equal(asked.length, 1);
  assert.equal(game.backendReads, 1);
});

test("reads of the same file at once share one backend call", async () => {
  const { game } = make();
  let open!: () => void;
  hold = new Promise((r) => { open = r; });
  const reads = [game.read("a.dds"), game.read("A.dds"), game.read("a.dds")];
  open();
  const got = await Promise.all(reads);
  assert.equal(asked.length, 1);
  assert.ok(got.every((b) => b.length === 300));
});

test("each caller gets its own bytes: changing them doesn't change the next read", async () => {
  const { game } = make();
  const first = await game.read("Units\\UnitData.slk");
  first[0] = 99;
  assert.deepEqual([...await game.read("Units\\UnitData.slk")], [1, 2, 3]);
});

test("a file that isn't there is remembered as such; another failure is asked again", async () => {
  const { game } = make();
  await assert.rejects(game.read("Nothing.tif"), /not found/);
  await assert.rejects(game.read("nothing.tif"), /not found/);
  assert.equal(asked.length, 1);
  // The storage busy (io), not absent: the next read tries again, and then has it.
  busy = true;
  await assert.rejects(game.read("a.dds"), /busy/);
  busy = false;
  assert.equal((await game.read("a.dds")).length, 300);
  assert.equal(asked.filter((a) => a.path === "a.dds").length, 2);
});

test("another graphics mode or tileset reads again; another install forgets everything", async () => {
  const { game, set } = make();
  await game.read("a.dds");
  set("game.graphicsMode", "sd");
  await game.read("a.dds");
  assert.equal(asked.at(-1)!.mode, "sd");
  set("game.graphicsMode", "hd");
  await game.read("a.dds");
  assert.equal(asked.length, 2, "hd's copy is still there");
  await game.read("a.dds", "L");
  assert.equal(asked.length, 3, "a tileset's own files can differ");
  set("game.installDir", "D:\\Other");
  await game.read("a.dds");
  assert.equal(asked.length, 4);
  assert.equal(asked.at(-1)!.install, "D:\\Other");
});

test("a read that lands after the install changed isn't kept for the new one", async () => {
  const { game, set } = make();
  let open!: () => void;
  hold = new Promise((r) => { open = r; });
  const old = game.read("a.dds");
  set("game.installDir", "D:\\Other");
  open();
  await old;
  hold = null;
  await game.read("a.dds");
  assert.equal(asked.length, 2);
});

test("the cache keeps to its size: the least recently read goes first, a file too big isn't kept", async () => {
  const { game } = make(1000);
  for (const n of [1, 2, 3, 4, 5]) stored.set(`s${n}.dds`, new Uint8Array(240));
  const count = (path: string) => asked.filter((x) => x.path === path).length;
  for (const n of [1, 2, 3, 4]) await game.read(`s${n}.dds`);
  await game.read("s1.dds"); // s1 is now the most recent, s2 the least
  assert.equal(asked.length, 4, "four of 240 bytes fit in 1000");
  // A fifth goes over: s2 goes, the others stay.
  await game.read("s5.dds");
  for (const n of [1, 3, 4, 5]) await game.read(`s${n}.dds`);
  assert.equal(asked.length, 5);
  await game.read("s2.dds");
  assert.equal(count("s2.dds"), 2, "s2 went");
  // Over a quarter of the limit: read, but not kept, and nothing else had to go for it.
  await game.read("big.dds");
  await game.read("big.dds");
  assert.equal(count("big.dds"), 2);
});

test("game data that can't be opened reads as words, and isn't remembered", async () => {
  const { game } = make();
  unopened = true;
  await assert.rejects(game.read("a.dds"), (e: Error) => e.name === "GameDataError" && /game\.installDir/.test(e.message));
  unopened = false;
  assert.equal((await game.read("a.dds")).length, 300);
  assert.equal(asked.length, 2);
});

test("Reload forgets the files and what wasn't there: a patched install is asked again", async () => {
  const { game } = make();
  await game.read("a.dds");
  await assert.rejects(game.read("later.dds"), /not found/);
  stored.set("later.dds", new Uint8Array(5));
  await assert.rejects(game.read("later.dds"), /not found/);
  game.reload();
  assert.equal((await game.read("later.dds")).length, 5);
  await game.read("a.dds");
  assert.equal(asked.length, 4);
});

test("the cache's size is a setting: a smaller one lets the oldest go at once", async () => {
  const { game, set } = make();
  for (const n of [1, 2, 3]) stored.set(`m${n}.dds`, new Uint8Array(400 * 1024));
  for (const n of [1, 2, 3]) await game.read(`m${n}.dds`);
  assert.equal(game.cachedSize, 1200 * 1024);
  set("game.cacheMegabytes", 1);
  assert.equal(game.cachedSize, 800 * 1024, "m1 went");
  await game.read("m1.dds");
  await game.read("m3.dds");
  assert.equal(asked.length, 4);
  set("game.cacheMegabytes", 0);
  assert.equal(game.cachedSize, 0);
});
