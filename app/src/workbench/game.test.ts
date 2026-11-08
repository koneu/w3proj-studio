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
  assert.equal(game.requests, 3, "every read is counted as asked, kept or not");
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
  assert.deepEqual(game.backendMisses, ["Nothing.tif"], "only what isn't there counts as missing, once");
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

test("at most MAX_READS_IN_FLIGHT reads wait on the backend at once; the rest follow in order, and all arrive", async () => {
  const { game } = make();
  const { MAX_READS_IN_FLIGHT } = await import("./game");
  assert.ok(MAX_READS_IN_FLIGHT >= 16 && MAX_READS_IN_FLIGHT <= 64);
  const n = MAX_READS_IN_FLIGHT * 3;
  for (let i = 0; i < n; i++) stored.set(`q${i}.dds`, new Uint8Array([i & 255]));
  let open!: () => void;
  hold = new Promise((r) => { open = r; });
  // Not there, and the same file twice: a failure frees its place too, a shared read takes one.
  const reads = [...Array.from({ length: n }, (_, i) => game.read(`q${i}.dds`)), game.read("q0.dds"), game.read("gone.dds").catch(() => null)];
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asked.length, MAX_READS_IN_FLIGHT, "the rest wait their turn");
  assert.deepEqual(asked.map((a) => a.path), Array.from({ length: MAX_READS_IN_FLIGHT }, (_, i) => `q${i}.dds`), "first come, first asked");
  open();
  const got = await Promise.all(reads);
  assert.equal(asked.length, n + 1);
  assert.deepEqual(got.slice(0, n).map((b) => b![0]), Array.from({ length: n }, (_, i) => i & 255));
  assert.equal(got[n + 1], null);
});

/** Fills every place with reads held at the backend, then queues `queue` (path and whether it's a
 *  background read) and opens: what the backend is asked after the first places is the queue's order. */
async function queueOrder(queue: [string, boolean][], meanwhile?: (game: InstanceType<typeof GameService>) => void) {
  const { game } = make();
  const { MAX_READS_IN_FLIGHT } = await import("./game");
  for (let i = 0; i < MAX_READS_IN_FLIGHT; i++) stored.set(`f${i}.dds`, new Uint8Array(1));
  for (const [p] of queue) stored.set(p, new Uint8Array(1));
  let open!: () => void;
  hold = new Promise((r) => { open = r; });
  const reads = Array.from({ length: MAX_READS_IN_FLIGHT }, (_, i) => game.read(`f${i}.dds`));
  reads.push(...queue.map(([p, background]) => game.read(p, undefined, background)));
  meanwhile?.(game);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asked.length, MAX_READS_IN_FLIGHT, "the queue waits for a place");
  open();
  await Promise.all(reads);
  return asked.slice(MAX_READS_IN_FLIGHT).map((a) => a.path);
}

test("a read someone waits on goes before background reads queued earlier", async () => {
  const order = await queueOrder([["b1.dds", true], ["b2.dds", true], ["n1.dds", false], ["n2.dds", false]]);
  assert.deepEqual(order, ["n1.dds", "n2.dds", "b1.dds", "b2.dds"]);
});

test("background reads aren't held back for good: every BACKGROUND_TURN-th place is theirs", async () => {
  const { BACKGROUND_TURN } = await import("./game");
  const now = Array.from({ length: BACKGROUND_TURN * 8 }, (_, i): [string, boolean] => [`n${i}.dds`, false]);
  const order = await queueOrder([["b1.dds", true], ["b2.dds", true], ...now]);
  assert.equal(order.indexOf("b1.dds"), BACKGROUND_TURN - 1, `b1 is asked ${BACKGROUND_TURN - 1} reads after the others started: ${order.join(" ")}`);
  // The next one's turn comes once b1 is done (one background read at a time while others run), still
  // well before the others are all asked.
  assert.ok(order.indexOf("b2.dds") < order.length - 2 * BACKGROUND_TURN, `b2 isn't held back to the end: ${order.indexOf("b2.dds")} of ${order.length}`);
  assert.deepEqual(order.filter((p) => p.startsWith("n")), now.map(([p]) => p), "the others keep their order");
});

test("a background read someone then waits on moves up to the reads waited on", async () => {
  const order = await queueOrder([["b1.dds", true], ["b2.dds", true], ["b3.dds", true], ["n1.dds", false]], (game) => { void game.read("B3.dds"); });
  assert.deepEqual(order, ["n1.dds", "b3.dds", "b1.dds", "b2.dds"]);
  // A background read of one waited on doesn't move it back.
  const kept = await queueOrder([["n1.dds", false], ["n2.dds", false]], (game) => { void game.read("n1.dds", undefined, true); });
  assert.deepEqual(kept, ["n1.dds", "n2.dds"]);
});

test("background reads take a few places only: a read someone waits on asked after them starts at once", async () => {
  const { game } = make();
  const { BACKGROUND_IN_FLIGHT, MAX_READS_IN_FLIGHT } = await import("./game");
  assert.ok(BACKGROUND_IN_FLIGHT < MAX_READS_IN_FLIGHT);
  const n = MAX_READS_IN_FLIGHT * 2;
  for (let i = 0; i < n; i++) stored.set(`bg${i}.dds`, new Uint8Array([i]));
  stored.set("now.dds", new Uint8Array([7]));
  let open!: () => void;
  hold = new Promise((r) => { open = r; });
  const later = Array.from({ length: n }, (_, i) => game.read(`bg${i}.dds`, undefined, true));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asked.length, BACKGROUND_IN_FLIGHT, "the rest of the background reads wait, with places free");
  const now = game.read("now.dds");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(asked.at(-1)?.path, "now.dds", "the read waited on didn't queue behind them");
  open();
  assert.equal((await now)[0], 7);
  const got = await Promise.all(later);
  assert.deepEqual(got.map((b) => b[0]), Array.from({ length: n }, (_, i) => i), "every background read arrives");
  assert.equal(game.readsPending, 0);
});

test("a pass over many files read once doesn't push out the files read again", async () => {
  const { game } = make(10_000);
  const count = (path: string) => asked.filter((x) => x.path === path).length;
  const hot = ["h1.dds", "h2.dds", "h3.dds"];
  for (const p of hot) stored.set(p, new Uint8Array(1000));
  // In use: read twice (another editor, the map opened again).
  for (const p of [...hot, ...hot]) await game.read(p);
  // One file read once before the pass: it may go.
  stored.set("once.dds", new Uint8Array(1000));
  await game.read("once.dds");
  // The pass: four times the cache, each file once, some of them as background reads.
  for (let i = 0; i < 40; i++) {
    stored.set(`scan${i}.dds`, new Uint8Array(1000));
    await game.read(`scan${i}.dds`, undefined, i % 2 === 0);
  }
  assert.ok(game.cachedSize <= 10_000, `the cache keeps to its size (${game.cachedSize})`);
  const before = asked.length;
  for (const p of hot) await game.read(p);
  assert.equal(asked.length, before, `the files in use are still kept: ${hot.map((p) => `${p} asked ${count(p)}×`).join(", ")}`);
  // The control: what was read once went (the pass did push files out).
  await game.read("once.dds");
  await game.read("scan0.dds");
  assert.equal(count("once.dds"), 2);
  assert.equal(count("scan0.dds"), 2);
});

test("a background read of a kept file doesn't make it one in use", async () => {
  const { game } = make(5_000);
  stored.set("x.dds", new Uint8Array(1000));
  await game.read("x.dds");
  await game.read("x.dds", undefined, true);
  for (let i = 0; i < 10; i++) { stored.set(`p${i}.dds`, new Uint8Array(1000)); await game.read(`p${i}.dds`, undefined, true); }
  await game.read("x.dds");
  assert.equal(asked.filter((a) => a.path === "x.dds").length, 2, "read once by someone, it went with the pass");
});

test("the files in use keep to their share of the cache: the oldest of them go back to read once", async () => {
  const { game } = make(4_000);
  const { PROTECTED_SHARE } = await import("./game");
  for (let i = 0; i < 4; i++) stored.set(`u${i}.dds`, new Uint8Array(1000));
  for (let i = 0; i < 4; i++) { await game.read(`u${i}.dds`); await game.read(`u${i}.dds`); }
  assert.equal(asked.length, 4);
  assert.equal(game.cachedSize, 4000);
  // u0 is the oldest in use; over the share, it counts as read once again, and goes first.
  assert.ok(PROTECTED_SHARE * 4000 < 4000);
  stored.set("new.dds", new Uint8Array(1000));
  await game.read("new.dds");
  for (const p of ["u1.dds", "u2.dds", "u3.dds", "new.dds"]) await game.read(p);
  assert.equal(asked.length, 5, "u1–u3 and the new one stayed");
  await game.read("u0.dds");
  assert.equal(asked.length, 6, "u0 went");
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
