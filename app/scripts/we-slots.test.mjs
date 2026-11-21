// Several World Editors at once (slots): each slot's farm, prefix and lock (we-setup.mjs slotPaths), taking a free
// slot, the lock a we-compare run holds for its we-drive processes, the shard split of a full run, and that a slot's
// wineserver calls never reach another slot's prefix. Nothing here starts Wine or the editor.
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { scratchDir } from "../../tests/scratch.mjs";
import { repoPath } from "../src/lib/testhelpers/testutil";
import { mainCheckout } from "../../tests/gamepath.mjs";
import { clean, currentSlot, existingSlots, farmDir, guardedWeDir, heldByParent, lockPath, MAX_SLOT, parseSlot, prefixDir, repo, setup, slotBusy, slotPaths, takeAllSlots, takeFreeSlot, takeLock, weDir } from "./we-setup.mjs";
import { defaultWork as driveWork, parseArgs as driveArgs, Session } from "./we-drive.mjs";
import { DEFAULT_SLOTS, defaultWork as compareWork, holdSlot, parseArgs as compareArgs, runSerial } from "./we-compare.mjs";
import { parseShard, parseSpec, shardFiles } from "./we-compare-core.mjs";

const test = (name, fn) => nodeTest(name, { skip: process.platform !== "linux" && "the World Editor runs on Linux only" }, fn);

const KEYS = ["W3PROJ_WE_DIR", "W3PROJ_WE_LOCK", "W3PROJ_WE_SLOT", "W3PROJ_WE_LOCK_HOLDER"];

/** Runs fn with the given World Editor variables (undefined: removed); puts them all back. */
async function withVars(vars, fn) {
  const save = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  try {
    return await fn();
  } finally {
    for (const k of KEYS) if (save[k] === undefined) delete process.env[k]; else process.env[k] = save[k];
  }
}

test("slot 0 is today's farm and lock exactly; slot N has its own, both derived from N", () => {
  const main = "/m/checkout", run = scratchDir("we-slots-run-");
  const o = { main, tmp: "/t", user: "u" };
  // Slot 0: what weDir() and lockPath() always gave.
  assert.deepEqual(slotPaths(0, { ...o, env: {} }), { slot: 0, dir: "/m/checkout/target/we", lock: "/t/w3proj-we-u.lock" });
  assert.deepEqual(slotPaths(0, { ...o, env: { XDG_RUNTIME_DIR: run } }).lock, join(run, "w3proj-we.lock"));
  assert.deepEqual(slotPaths(0, { ...o, env: { W3PROJ_WE_DIR: "/w", W3PROJ_WE_LOCK: "/l/lock", XDG_RUNTIME_DIR: run } }), { slot: 0, dir: "/w", lock: "/l/lock" });
  assert.equal(slotPaths(0, { ...o, env: { W3PROJ_WE_DIR: "" } }).dir, "/m/checkout/target/we", "an empty W3PROJ_WE_DIR is the default");
  // Slot 3.
  assert.deepEqual(slotPaths(3, { ...o, env: {} }), { slot: 3, dir: "/m/checkout/target/we-slot3", lock: "/t/w3proj-we-u-slot3.lock" });
  assert.equal(slotPaths(3, { ...o, env: { XDG_RUNTIME_DIR: run } }).lock, join(run, "w3proj-we-slot3.lock"));
  assert.deepEqual(slotPaths(3, { ...o, env: { W3PROJ_WE_DIR: "/w", W3PROJ_WE_LOCK: "/l/lock" } }), { slot: 3, dir: "/w/slot3", lock: "/l/lock-slot3" });
  // Every slot's folder and lock differ from every other's, under each way of naming them.
  for (const env of [{}, { XDG_RUNTIME_DIR: run }, { W3PROJ_WE_DIR: "/w", W3PROJ_WE_LOCK: "/l/lock" }]) {
    const all = Array.from({ length: MAX_SLOT + 1 }, (_, n) => slotPaths(n, { ...o, env }));
    assert.equal(new Set(all.map((p) => p.dir)).size, all.length);
    assert.equal(new Set(all.map((p) => p.lock)).size, all.length);
    for (const p of all) assert.ok(!p.lock.startsWith(`${p.dir}/`), "the lock isn't inside a farm");
  }
  rmSync(run, { recursive: true, force: true });
});

test("slot numbers: 0 to MAX_SLOT, written plainly; anything else is refused, W3PROJ_WE_SLOT too", async () => {
  for (const [v, n] of [["0", 0], ["1", 1], ["12", 12], [String(MAX_SLOT), MAX_SLOT], [2, 2]]) assert.equal(parseSlot(v), n);
  for (const v of ["", "-1", "01", "1.5", "a", " 1", String(MAX_SLOT + 1), "100", undefined, null]) assert.throws(() => parseSlot(v), /whole number 0 to/, String(v));
  await withVars({}, () => assert.equal(currentSlot(), 0));
  await withVars({ W3PROJ_WE_SLOT: "" }, () => assert.equal(currentSlot(), 0));
  await withVars({ W3PROJ_WE_SLOT: "2" }, () => assert.equal(currentSlot(), 2));
  await withVars({ W3PROJ_WE_SLOT: "two" }, () => assert.throws(() => weDir(), /W3PROJ_WE_SLOT/));
});

test("W3PROJ_WE_SLOT moves the farm, the prefix and the lock together; slot folders pass guardedWeDir", async () => {
  const lockBase = join(scratchDir("we-slots-lock-"), "l");
  const game = join(scratchDir("we-slots-game-"), "game");
  await withVars({ W3PROJ_WE_LOCK: lockBase }, () => {
    const zero = { dir: weDir(), farm: farmDir(), prefix: prefixDir(), lock: lockPath() };
    assert.equal(zero.dir, join(mainCheckout(repo), "target", "we"));
    assert.equal(zero.lock, lockBase);
    process.env.W3PROJ_WE_SLOT = "2";
    assert.equal(weDir(), join(mainCheckout(repo), "target", "we-slot2"));
    assert.equal(farmDir(), join(weDir(), "install"));
    assert.equal(prefixDir(), join(weDir(), "prefix"));
    assert.equal(lockPath(), `${lockBase}-slot2`);
    assert.equal(lockPath(0), lockBase, "lockPath(slot) names another slot's lock");
    assert.equal(guardedWeDir(game), weDir());
  });
});

test("a slot's first setup makes its own farm and prefix folder; slot 0's is left alone, and clean removes only its slot's", async () => {
  const we = scratchDir("we-slots-farm-");
  const game = scratchDir("we-slots-game-");
  mkdirSync(join(game, "Data", "data"), { recursive: true });
  writeFileSync(join(game, ".build.info"), "build-1");
  writeFileSync(join(game, "Data", "data", "data.001"), "bigdata");
  writeFileSync(join(game, "Data", "data", "0000000001.idx"), "idx");
  const lock = join(scratchDir("we-slots-lock-"), "l");
  await withVars({ W3PROJ_WE_DIR: we, W3PROJ_WE_LOCK: lock }, () => {
    setup(game, { farmOnly: true });
    process.env.W3PROJ_WE_SLOT = "1";
    const r = setup(game, { farmOnly: true });
    assert.equal(r.dir, join(we, "slot1"));
    assert.equal(r.reused, false, "slot 1 built a farm of its own");
    assert.ok(existsSync(join(we, "slot1", "prefix")));
    assert.equal(lstatSync(join(we, "slot1", "install", "Data", "data", "data.001")).nlink, 3, "hardlinked: the install, slot 0's and slot 1's farm");
    clean(game);
    assert.ok(!existsSync(join(we, "slot1", "install")) && !existsSync(join(we, "slot1", "prefix")));
    assert.ok(existsSync(join(we, "install", "Data", "data", "data.001")), "slot 0's farm stays");
    assert.ok(existsSync(join(we, "prefix")));
  });
});

test("slots lock apart: slot 1 is taken while slot 0 is held; the owner names its slot and farm", async () => {
  const lock = join(scratchDir("we-slots-lock-"), "l");
  await withVars({ W3PROJ_WE_LOCK: lock, W3PROJ_WE_DIR: scratchDir("we-slots-we-") }, async () => {
    const zero = await takeLock(() => {}, 1000, { slot: 0 });
    assert.ok(slotBusy(0) && !slotBusy(1));
    const said = [];
    assert.equal(await takeLock((m) => said.push(m), 1000, { slot: 0, wait: false }), null, "wait: false gives up at once");
    assert.deepEqual(said, []);
    const one = await takeLock(() => {}, 1000, { slot: 1 });
    const owner = JSON.parse(readFileSync(join(`${lock}-slot1`, "owner.json"), "utf8"));
    assert.equal(owner.slot, 1);
    assert.equal(owner.farm, slotPaths(1).dir);
    assert.equal(owner.pid, process.pid);
    one();
    zero();
    assert.ok(!slotBusy(0) && !slotBusy(1));
  });
});

test("takeFreeSlot takes the first free slot in the list's order, waits while all are busy, and gives up", async () => {
  const lock = join(scratchDir("we-slots-lock-"), "l");
  await withVars({ W3PROJ_WE_LOCK: lock, W3PROJ_WE_DIR: scratchDir("we-slots-we-") }, async () => {
    const zero = await takeLock(() => {}, 1000, { slot: 0 });
    const a = await takeFreeSlot([0, 1, 2], () => {});
    assert.equal(a.slot, 1);
    const b = await takeFreeSlot([0, 1, 2], () => {});
    assert.equal(b.slot, 2, "a second run gets another slot");
    assert.equal((await takeFreeSlot([2, 3], () => {})).slot, 3, "the list's order, not the numbers'");
    const said = [];
    await assert.rejects(takeFreeSlot([0, 1, 2], (m) => said.push(m), { timeoutMs: 50, pollMs: 10 }), /every World Editor slot of 0,1,2 is still busy/);
    assert.equal(said.length, 1, "said once");
    // One is let go while a run waits: that run gets it.
    let polls = 0;
    const got = await takeFreeSlot([0, 1, 2], () => {}, { pollMs: 1, sleep: async () => { if (++polls === 3) a.release(); } });
    assert.equal(got.slot, 1);
    for (const r of [got.release, b.release, zero]) r();
    // Two runs at once: never the same slot.
    const [x, y] = await Promise.all([takeFreeSlot([0, 1], () => {}), takeFreeSlot([0, 1], () => {})]);
    assert.notEqual(x.slot, y.slot);
    x.release();
    y.release();
    rmSync(`${lock}-slot3`, { recursive: true, force: true });
  });
});

test("heldByParent: a lock is passed on only to a child of its holder, on the same slot and farm", async () => {
  const env = { W3PROJ_WE_LOCK_HOLDER: String(process.pid), W3PROJ_WE_DIR: "/w" };
  const o = { pid: process.pid, slot: 1, farm: "/w/slot1" };
  assert.ok(heldByParent(o, 1, { env, ppid: process.pid }));
  assert.ok(!heldByParent(o, 1, { env: { W3PROJ_WE_DIR: "/w" }, ppid: process.pid }), "no holder named");
  assert.ok(!heldByParent(o, 1, { env, ppid: process.pid + 1 }), "not this process's parent");
  assert.ok(!heldByParent(o, 2, { env, ppid: process.pid }), "another slot");
  assert.ok(!heldByParent({ ...o, farm: "/w" }, 1, { env, ppid: process.pid }), "another farm");
  assert.ok(!heldByParent({ ...o, pid: 2 ** 22 + 12345 }, 1, { env: { ...env, W3PROJ_WE_LOCK_HOLDER: String(2 ** 22 + 12345) }, ppid: 2 ** 22 + 12345 }), "a dead holder");
  assert.ok(!heldByParent(null, 1, { env, ppid: process.pid }));
});

test("a child process uses the slot lock its parent holds for it, and waits without being told", async () => {
  const lock = join(scratchDir("we-slots-lock-"), "l");
  const we = scratchDir("we-slots-we-");
  const url = pathToFileURL(repoPath("app", "scripts", "we-setup.mjs")).href;
  // [Refactored] Lowered negative timeout from 300ms to 40ms (now that takeLock clamps its poll interval).
  const child = (extra) => spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { takeLock } from ${JSON.stringify(url)}; try { const r = await takeLock(() => {}, 40); r(); console.log("took"); } catch (e) { console.log(e.message); }`], {
    env: { ...process.env, W3PROJ_WE_LOCK: lock, W3PROJ_WE_DIR: we, W3PROJ_WE_SLOT: "1", ...extra }, encoding: "utf8", timeout: 30000,
  });
  await withVars({ W3PROJ_WE_LOCK: lock, W3PROJ_WE_DIR: we }, async () => {
    const release = await takeLock(() => {}, 1000, { slot: 1 });
    try {
      assert.equal(child({ W3PROJ_WE_LOCK_HOLDER: String(process.pid) }).stdout.trim(), "took");
      assert.ok(existsSync(`${lock}-slot1`), "the child's release leaves the parent's lock");
      assert.match(child({}).stdout, /still holds/);
      assert.match(child({ W3PROJ_WE_LOCK_HOLDER: String(process.pid), W3PROJ_WE_SLOT: "2" }).stdout, /took/, "slot 2 is free anyway");
      assert.match(child({ W3PROJ_WE_LOCK_HOLDER: "1", W3PROJ_WE_SLOT: "1" }).stdout, /still holds/, "a holder that isn't its parent");
    } finally {
      release();
    }
  });
});

/** A Proton build whose wineserver writes its WINEPREFIX and arguments to `log`. */
function fakeProton(log) {
  const tool = scratchDir("we-slots-proton-");
  mkdirSync(join(tool, "files", "bin"), { recursive: true });
  const bin = join(tool, "files", "bin", "wineserver");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s %s\\n' "$WINEPREFIX" "$*" >> '${log}'\n`);
  chmodSync(bin, 0o755);
  return { tool };
}

test("a slot's wineserver calls (the start's leftover kill, stop) reach only its own prefix", async () => {
  const log = join(scratchDir("we-slots-log-"), "calls");
  const we = scratchDir("we-slots-we-");
  const proton = fakeProton(log);
  const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  await withVars({ W3PROJ_WE_DIR: we, W3PROJ_WE_SLOT: "1" }, () => {
    const s = new Session({ work: scratchDir("we-slots-work-") }, "/g", { proton });
    s.wineserver(["-k"]);
    s.stop();
    process.env.W3PROJ_WE_SLOT = "2";
    new Session({ work: scratchDir("we-slots-work-") }, "/g", { proton }).stop();
  });
  assert.deepEqual(lines(), [`${join(we, "slot1", "prefix", "pfx")} -k`, `${join(we, "slot1", "prefix", "pfx")} -k`, `${join(we, "slot2", "prefix", "pfx")} -k`]);
  for (const l of lines()) assert.ok(!l.startsWith(`${join(we, "prefix")}`), `slot 0's prefix never: ${l}`);
});

test("we-drive --slot: the slot and its own default work folder; --work stays as given", async () => {
  await withVars({}, () => {
    assert.equal(driveArgs(["--start"]).opts.work, driveWork(0));
    assert.match(driveWork(0), /target[\\/]we-drive$/);
    const { opts } = driveArgs(["--slot", "2", "--start"]);
    assert.equal(opts.slot, 2);
    assert.equal(opts.work, driveWork(2));
    assert.match(driveWork(2), /target[\\/]we-drive-slot2$/);
    assert.equal(driveArgs(["--slot", "2", "--work", "/x/w", "--start"]).opts.work, "/x/w");
    for (const v of ["auto", "-1", "99"]) assert.throws(() => driveArgs(["--slot", v, "--start"]), /--slot is a whole number/);
    process.env.W3PROJ_WE_SLOT = "3";
    assert.equal(driveArgs(["--start"]).opts.work, driveWork(3), "W3PROJ_WE_SLOT picks the default too");
  });
});

test("we-compare --slot, --slots, --shard: parsed and refused; per-slot work folders", () => {
  assert.equal(compareArgs(["a.json"]).slot, undefined);
  assert.equal(compareArgs(["a.json"]).work, null, "the default is chosen once the slot is known");
  assert.equal(compareArgs(["--slot", "1", "a.json"]).slot, 1);
  const auto = compareArgs(["--slot", "auto", "a.json"]);
  assert.equal(auto.slot, "auto");
  assert.deepEqual(auto.slots, DEFAULT_SLOTS);
  assert.deepEqual(compareArgs(["--slot", "auto", "--slots", "3,1", "a.json"]).slots, [3, 1]);
  assert.throws(() => compareArgs(["--slots", "0,1", "a.json"]), /give --slot auto too/);
  assert.throws(() => compareArgs(["--slot", "auto", "--slots", "1,1", "a.json"]), /twice/);
  assert.throws(() => compareArgs(["--slot", "x", "a.json"]), /--slot is a whole number/);
  assert.deepEqual(compareArgs(["--shard", "2/3", "a.json"]).shard, { index: 2, count: 3 });
  for (const v of ["0/2", "3/2", "1/0", "a/b", "1/65", "1-2"]) assert.throws(() => parseShard(v), /--shard wants i\/n/, v);
  assert.match(compareWork(0), /target[\\/]we-compare$/);
  assert.match(compareWork(4), /target[\\/]we-compare-slot4$/);
});

test("holdSlot: the run holds its slot and names itself the holder for its we-drive processes; the release undoes both", async () => {
  const env = {}, calls = [];
  const o = { slot: "auto", slots: [0, 1] };
  const release = await holdSlot(o, { env, pid: 4242, takeFree: async (slots) => { calls.push(["free", slots]); return { slot: 1, release: () => calls.push(["released", 1]) }; } });
  assert.equal(o.slot, 1);
  assert.deepEqual(env, { W3PROJ_WE_SLOT: "1", W3PROJ_WE_LOCK_HOLDER: "4242" });
  release();
  assert.deepEqual(calls, [["free", [0, 1]], ["released", 1]]);
  assert.equal(env.W3PROJ_WE_LOCK_HOLDER, undefined);
  const o2 = { slot: 2 }, env2 = {};
  (await holdSlot(o2, { env: env2, pid: 7, take: async (_say, _ms, { slot }) => { calls.push(["take", slot]); return () => {}; } }))();
  assert.deepEqual(calls.at(-1), ["take", 2]);
  assert.equal(env2.W3PROJ_WE_SLOT, "2");
});

test("takeAllSlots takes every existing slot's lock in ascending order, waits for a held one, and lets all go", async () => {
  const lock = join(scratchDir("we-slots-lock-"), "l");
  const we = scratchDir("we-slots-we-");
  await withVars({ W3PROJ_WE_LOCK: lock, W3PROJ_WE_DIR: we }, async () => {
    mkdirSync(join(we, "slot2"));
    const three = await takeLock(() => {}, 1000, { slot: 3 }); // slot 3 has no folder yet, only a held lock
    assert.deepEqual(existingSlots(), [0, 2, 3]);
    three();
    assert.deepEqual(existingSlots(), [0, 2]);
    const all = await takeAllSlots(() => {});
    assert.ok(slotBusy(0) && slotBusy(2) && !slotBusy(1));
    const said = [];
    // [Refactored] Lowered negative timeoutMs from 300 to 40.
    await assert.rejects(takeAllSlots((m) => said.push(m), { timeoutMs: 40 }), /still holds/);
    assert.ok(slotBusy(0) && slotBusy(2), "a failed takeAllSlots leaves the other holder's locks");
    all();
    assert.ok(!slotBusy(0) && !slotBusy(2));
    // A held slot 2 makes it wait; slot 0, taken first, is let go again when it gives up.
    const two = await takeLock(() => {}, 1000, { slot: 2 });
    await assert.rejects(takeAllSlots(() => {}, { timeoutMs: 40 }), /still holds/);
    assert.ok(!slotBusy(0), "what it took is let go");
    two();
  });
});

test("serial specs: parsed; runSerial lets the run's own slot go, takes all, runs them on slot 0 as the holder, and puts the variables back", async () => {
  const spec = (extra) => ({ name: "s", input: { map: "/m.w3x" }, we: {}, compare: ["war3map.w3i"], ...extra });
  assert.equal(parseSpec(spec({}), "/d").serial, false);
  assert.equal(parseSpec(spec({ serial: true }), "/d").serial, true);
  assert.throws(() => parseSpec(spec({ serial: "yes" }), "/d"), /serial is true or false/);
  const env = { W3PROJ_WE_SLOT: "2", W3PROJ_WE_LOCK_HOLDER: "99" }, calls = [];
  const o = { releaseSlot: () => calls.push("own released") };
  await runSerial([{ name: "a" }], o, "/g", {
    env, pid: 4242,
    takeAll: async () => { calls.push("all taken"); return () => calls.push("all released"); },
    runGroups: async (specs) => calls.push(`ran ${specs.map((s) => s.name)} on ${env.W3PROJ_WE_SLOT} held by ${env.W3PROJ_WE_LOCK_HOLDER}`),
  });
  assert.deepEqual(calls, ["own released", "all taken", "ran a on 0 held by 4242", "all released"]);
  assert.deepEqual(env, { W3PROJ_WE_SLOT: "2", W3PROJ_WE_LOCK_HOLDER: "99" });
  assert.equal(o.releaseSlot, null, "the run's own release isn't called again at the end");
  // A failing World Editor part still lets the locks go.
  const env2 = {}, calls2 = [];
  await assert.rejects(runSerial([{ name: "b" }], {}, "/g", { env: env2, takeAll: async () => () => calls2.push("all released"), runGroups: async () => { throw new Error("boom"); } }), /boom/);
  assert.deepEqual(calls2, ["all released"]);
  assert.deepEqual(env2, {});
});

test("we-drive --alone is an option, not a step", () => {
  const { opts, steps } = driveArgs(["--alone", "--start"]);
  assert.equal(opts.alone, true);
  assert.deepEqual(steps.map(([s]) => s), ["--start"]);
});

test("shardFiles: whole files, every file in exactly one shard, the same split whatever the order, balanced by spec count", () => {
  const files = Array.from({ length: 40 }, (_, i) => ({ file: `/c/tests/we-compare/f${String(i).padStart(2, "0")}.json`, specs: 1 + ((i * 7) % 13) }));
  const total = files.reduce((a, f) => a + f.specs, 0);
  for (const n of [1, 2, 3, 5]) {
    const shards = Array.from({ length: n }, (_, i) => shardFiles(files, i + 1, n));
    const all = shards.flat();
    assert.equal(all.length, files.length, `n=${n}: no file twice`);
    assert.equal(new Set(all).size, files.length, `n=${n}: every file`);
    const reversed = [...files].reverse();
    for (let i = 0; i < n; i++) assert.deepEqual(new Set(shardFiles(reversed, i + 1, n)), new Set(shards[i]), `n=${n}: order-free`);
    const loads = shards.map((s) => s.reduce((a, f) => a + files.find((x) => x.file === f).specs, 0));
    assert.ok(Math.max(...loads) - Math.min(...loads) <= 13, `n=${n}: balanced within the biggest file (${loads})`);
    assert.equal(loads.reduce((a, b) => a + b, 0), total);
    for (const s of shards) assert.deepEqual(s, files.map((f) => f.file).filter((f) => s.includes(f)), "the order given");
  }
  // The same file names in another checkout split the same way.
  const other = files.map((f) => ({ ...f, file: f.file.replace("/c/", "/d/") }));
  assert.deepEqual(shardFiles(other, 2, 3).map((f) => f.replace("/d/", "/c/")), shardFiles(files, 2, 3));
});
