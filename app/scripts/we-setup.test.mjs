// we-setup.mjs without the game and without the editor: the guards around the farm folder, the farm's refresh, the
// snapshot proof, and the C shim's source. The farm of a test lives in a folder inside the repository (the guard
// refuses others); the "game" is a small folder in the temp dir.
import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { scratchDir } from "../../tests/scratch.mjs";
import { join } from "node:path";
import { mainCheckout } from "../../tests/gamepath.mjs";
import { clean, compare, guardedWeDir, repo, setup, snapshot } from "./we-setup.mjs";

const test = (name, fn) => nodeTest(name, { skip: process.platform === "win32" }, fn);

/** Runs fn with W3PROJ_WE_DIR (and W3PROJ_WE_LOCK, so no real lock is looked at) set; puts both back. */
async function withEnv(we, fn) {
  const save = { we: process.env.W3PROJ_WE_DIR, lock: process.env.W3PROJ_WE_LOCK };
  const lockDir = scratchDir("we-setup-lock-");
  process.env.W3PROJ_WE_LOCK = join(lockDir, "l");
  if (we === undefined) delete process.env.W3PROJ_WE_DIR; else process.env.W3PROJ_WE_DIR = we;
  try {
    return await fn(lockDir);
  } finally {
    for (const [k, v] of [["W3PROJ_WE_DIR", save.we], ["W3PROJ_WE_LOCK", save.lock]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function fakeGame() {
  const game = mkdtempSync(join(tmpdir(), "we-setup-game-"));
  mkdirSync(join(game, "Data", "data"), { recursive: true });
  writeFileSync(join(game, ".build.info"), "build-1");
  writeFileSync(join(game, "Data", "data", "data.001"), "bigdata");
  writeFileSync(join(game, "Data", "data", "0000000001.idx"), "idx-original");
  writeFileSync(join(game, "Data", "shmem"), "shared");
  if (process.platform !== "win32") writeFileSync(join(game, "a\\b"), "backslash name"); // a file name with a backslash
  return game;
}

const inRepo = () => mkdtempSync(join(repo, "we-setup-test-"));

test("W3PROJ_WE_DIR empty means the default, and a folder outside the repository is refused (clean never reaches the cwd)", async () => {
  const game = fakeGame();
  try {
    await withEnv("", () => assert.match(guardedWeDir(game), /target[\\/]we$/));
    // The old code: `??` kept "", resolve("") is the cwd, and --clean removed cwd/install and cwd/prefix.
    const cwd = mkdtempSync(join(tmpdir(), "we-setup-cwd-"));
    mkdirSync(join(cwd, "install"));
    mkdirSync(join(cwd, "prefix"));
    const save = process.cwd();
    process.chdir(cwd);
    try {
      await withEnv(cwd, () => {
        assert.throws(() => clean(game), /isn't inside the repository/);
        assert.throws(() => setup(game, { farmOnly: true }), /isn't inside the repository/);
      });
    } finally {
      process.chdir(save);
    }
    assert.ok(existsSync(join(cwd, "install")) && existsSync(join(cwd, "prefix")), "nothing was removed");
    rmSync(cwd, { recursive: true, force: true });
    // The main checkout itself is not "under" it either.
    await withEnv(mainCheckout(repo), () => assert.throws(() => guardedWeDir(game), /isn't inside/));
  } finally {
    rmSync(game, { recursive: true, force: true });
  }
});

test("a farm folder holding the game folder, or inside it, is refused", async () => {
  const dir = inRepo();
  try {
    await withEnv(dir, () => {
      assert.throws(() => guardedWeDir(join(dir, "game")), /contain one another/);
      assert.throws(() => guardedWeDir(dirOf(dir)), /contain one another/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
const dirOf = (p) => join(p, "..");

test("clean removes only install, prefix, the shim and the stamp", async () => {
  const game = fakeGame(), dir = inRepo();
  try {
    await withEnv(dir, () => {
      for (const n of ["install", "prefix"]) mkdirSync(join(dir, n));
      writeFileSync(join(dir, "keep.txt"), "x");
      writeFileSync(join(dir, "build.info"), "b");
      clean(game);
      assert.deepEqual(readdirSync(dir), ["keep.txt"]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(game, { recursive: true, force: true });
  }
});

test("the farm: a file name with a backslash is linked as it is; a refreshed run repairs stale and damaged files; a running editor's farm isn't replaced", async () => {
  const game = fakeGame(), dir = inRepo();
  try {
    await withEnv(dir, async (lockDir) => {
      const r = setup(game, { farmOnly: true });
      assert.equal(r.reused, false);
      const farm = join(dir, "install");
      // The old code turned the backslash into "/" and linked a/b: the file was in the wrong place.
      assert.equal(readFileSync(join(farm, "a\\b"), "utf8"), "backslash name");
      assert.ok(!existsSync(join(farm, "a")));
      assert.equal(statSync(join(farm, "Data", "data", "data.001")).ino, statSync(join(game, "Data", "data", "data.001")).ino, "a hardlink");
      assert.deepEqual(readdirSync(dir).sort(), ["build.info", "install", "prefix"]);

      // Same build: the editor's changed shmem stays; a damaged index and a stale link are made again.
      writeFileSync(join(farm, "Data", "shmem"), "changed by the editor");
      writeFileSync(join(farm, "Data", "data", "0000000001.idx"), "");
      rmSync(join(farm, "Data", "data", "data.001"));
      writeFileSync(join(farm, "Data", "data", "data.001"), "an old copy"); // not the install's file any more
      const again = setup(game, { farmOnly: true });
      assert.equal(again.reused, true);
      assert.equal(again.fixed, 2);
      assert.equal(readFileSync(join(farm, "Data", "shmem"), "utf8"), "changed by the editor");
      assert.equal(readFileSync(join(farm, "Data", "data", "0000000001.idx"), "utf8"), "idx-original");
      assert.equal(readFileSync(join(farm, "Data", "data", "data.001"), "utf8"), "bigdata");
      assert.equal(setup(game, { farmOnly: true }).fixed, 0, "nothing to repair the third time");

      // Another build, while another live process holds the lock on this farm: the farm stays.
      writeFileSync(join(game, ".build.info"), "build-2");
      const lock = join(lockDir, "l");
      mkdirSync(lock);
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.ppid, repo: "other", farm: dir, since: "now" }));
      assert.throws(() => setup(game, { farmOnly: true }), /in use by process/);
      assert.throws(() => clean(game), /in use by process/);
      assert.ok(existsSync(join(farm, "Data", "data", "data.001")));
      rmSync(lock, { recursive: true });

      // Free: the new build is made in a folder of its own and moved in; no leftovers.
      const fresh = setup(game, { farmOnly: true });
      assert.equal(fresh.reused, false);
      assert.equal(readFileSync(join(dir, "build.info"), "utf8"), "build-2");
      assert.deepEqual(readdirSync(dir).sort(), ["build.info", "install", "prefix"]);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(game, { recursive: true, force: true });
  }
});

test("the snapshot lists a file it couldn't stat, and the comparison fails for a guarded one", () => {
  const root = scratchDir("we-snap-");
  try {
    writeFileSync(join(root, "a\\b"), "x"); // a backslash in the name: the path has to come back as it is
    writeFileSync(join(root, "ok"), "y");
    const s = snapshot([root]);
    assert.deepEqual(s.skipped, []);
    assert.deepEqual(Object.keys(s.files).sort(), [join(root, "a\\b"), join(root, "ok")]);
    const hole = { ...s, skipped: [{ path: join(root, "gone"), code: "ENOENT" }] };
    assert.deepEqual(compare(s, hole, [root]).skippedGuarded, [join(root, "gone")]);
    assert.deepEqual(compare(s, hole, ["/elsewhere"]).skippedGuarded, []);
    assert.deepEqual(compare(s, hole, ["/elsewhere"]).skippedElsewhere, [join(root, "gone")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("we-rofs.c compiles without warnings, and takes the mode only for O_CREAT or a whole O_TMPFILE", (t) => {
  try { execFileSync("cc", ["--version"], { stdio: "ignore" }); } catch { return t.skip("no C compiler"); }
  const src = join(process.cwd(), "scripts", "we-rofs.c"); // the test runs bundled, from the app folder
  const text = readFileSync(src, "utf8");
  assert.ok(!/flags & \(O_CREAT \| O_TMPFILE\)/.test(text), "the mask test is also true for a plain O_DIRECTORY");
  const dir = scratchDir("we-rofs-");
  try {
    const out = join(dir, "we-rofs.so");
    execFileSync("cc", ["-Wall", "-Werror", "-shared", "-fPIC", "-O2", "-o", out, src, "-ldl"], { stdio: ["ignore", "pipe", "pipe"] });
    assert.ok(lstatSync(out).size > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
