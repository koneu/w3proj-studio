// The make-*.mjs generators of tests/fixtures/we-compare: run twice they pack the same bytes, from any working folder,
// and what they pack is what the committed input map holds (what the spec measured in the World Editor). Needs the
// release CLI and the empty map of smoketest_maps (the user's folder of the main checkout); skips without them.
// The minimap (war3mapMap.blp) is left out of the comparison with the committed map: Studio draws it from the game's
// files, which move with the game build.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { scratchDir } from "../../tests/scratch.mjs";
import { fixturePath, repoPath, skipOrFail } from "../src/lib/testhelpers/testutil";
import { gameCli, mainCheckout } from "../src/lib/testhelpers/gamefiles";

const dir = (...rel) => fixturePath("we-compare", ...rel);
const gen = (name) => dir(`make-${name}.mjs`);

/** What the generators need: the CLI, the empty map and the game folder; null (with the reason) when one is missing. */
function tools() {
  const g = gameCli();
  if (!g) return { why: "no release CLI (target/release/w3proj)" };
  // [Refactored] Verify the game install folder is actually readable (e.g. when running inside a sandbox without external paths).
  if (!g.install[1] || !existsSync(join(g.install[1], ".build.info"))) return { why: "no game install (.build.info not readable)" };
  const main = mainCheckout()?.main;
  const empty = main && join(main, "smoketest_maps", "empty_map_on_newest_world_editor.w3m");
  if (!empty || !existsSync(empty)) return { why: "no smoketest_maps/empty_map_on_newest_world_editor.w3m in the main checkout" };
  return { cli: g.bin, empty, game: g.install[1] };
}

/** Runs a generator from `cwd` (relative paths in `args` are that folder's); W3_ALLOW_STALE: the CLI is the release one in use. */
function runAsync(script, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [gen(script), ...args], {
      cwd,
      env: { ...process.env, W3_ALLOW_STALE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => {
      assert.equal(status, 0, `${script} ${args.join(" ")}: exit ${status}\n${stderr}`);
      resolve();
    });
  });
}

/** Every file of the map's unpacked project (name -> bytes) but the minimap and the shadow map (Studio now writes war3map.shd, the committed maps were made before). */
function unpacked(cli, map, into) {
  const r = spawnSync(cli, ["unpack", map, into, "--game", "none"], { encoding: "utf8" });
  assert.equal(r.status, 0, `unpack ${map}: ${r.stderr}`);
  const files = {};
  const walk = (d, prefix) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${n}/`);
      else if (n !== "war3mapMap.blp" && n !== "war3map.shd") files[prefix + n] = readFileSync(p);
    }
  };
  walk(into, "");
  return files;
}
/** The names of the files that differ (or exist on one side only). */
const differing = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !a[k] || !b[k] || !a[k].equals(b[k]));

// generator, its extra arguments after <out>, the committed map it makes.
const CASES = [
  ["camera-bounds-input", [], "camera-bounds.w3m"],
  ["edge-input", [], "edge-last-step.w3m"],
  ["mine-start-input", [], "mine-start-grid.w3m"],
  ["paste-centre-input", [], "paste-centre.w3m"],
  ["random-group-input", [], "random-group.w3m"],
  ["replace-input", [], "replace-units.w3m"],
  ["replace-units-overlap-input", [], "replace-units-overlap.w3m"],
  ["replace-doodad-input", ["GAME"], "replace-doodad.w3m"],
];

test("each generator packs the same bytes twice, from a folder that isn't the repository's, and the committed map's content", async (t) => {
  const tl = tools();
  if (tl.why) return skipOrFail(t, tl.why);
  const cwd = scratchDir("we-gen-");
  const unpackedByScript = {};
  // [Refactored] Run all 8 generator pairs concurrently instead of 16 sequential generator spawns.
  await Promise.all(CASES.map(async ([script, extra, committed]) => {
    const outA = `a-${script}.w3m`, outB = `b-${script}.w3m`;
    const args = (out) => [tl.empty, tl.cli, out, ...extra.map(() => tl.game)];
    await Promise.all([runAsync(script, args(outA), cwd), runAsync(script, args(outB), cwd)]);
    const a = readFileSync(join(cwd, outA));
    assert.ok(a.equals(readFileSync(join(cwd, outB))), `${script}: two runs pack different bytes`);
    const mine = unpacked(tl.cli, join(cwd, outA), join(cwd, `ua-${script}`));
    const theirs = unpacked(tl.cli, dir(committed), join(cwd, `ub-${script}`));
    assert.deepEqual(differing(mine, theirs), [], `${script}: not the content of ${committed} (the committed map no longer matches its generator)`);
    unpackedByScript[script] = theirs;
  }));
  assert.equal(Object.keys(unpackedByScript).length, CASES.length);
  // Control: two different generators' maps compare as unequal without re-unpacking them.
  assert.notDeepEqual(differing(unpackedByScript["edge-input"], unpackedByScript["paste-centre-input"]), [], "two different maps compare as equal");
});

// [Refactored] Test `differing()` pure logic in-memory without spawning redundant `w3proj unpack` processes.
test("control: differing() detects changed and extra files and matches identical maps", () => {
  const base = { "map/war3map.doo.json": Buffer.from('{"a":1}'), "map/war3map.w3i.json": Buffer.from('{"b":2}') };
  assert.deepEqual(differing(base, { ...base }), []);
  assert.deepEqual(differing(base, { ...base, "map/war3map.doo.json": Buffer.from("{}") }), ["map/war3map.doo.json"]);
  assert.deepEqual(differing(base, { ...base, "extra.txt": Buffer.from("x") }), ["extra.txt"]);
});

test("make-doodad-pick-input: the same map twice, and the committed map and spec", async (t) => {
  const tl = tools();
  if (tl.why) return skipOrFail(t, tl.why);
  const cwd = scratchDir("we-gen-pick-");
  const run1 = (n) => runAsync("doodad-pick-input", [dir("edge-last-step.w3m"), tl.cli, `${n}.w3m`, `${n}.json`], cwd);
  await Promise.all([run1("a"), run1("b")]);
  assert.ok(readFileSync(join(cwd, "a.w3m")).equals(readFileSync(join(cwd, "b.w3m"))));
  assert.ok(readFileSync(join(cwd, "a.w3m")).equals(readFileSync(dir("doodad-pick.w3m"))), "doodad-pick.w3m is not what its generator makes");
  const spec = readFileSync(join(cwd, "a.json"), "utf8");
  assert.deepEqual(JSON.parse(spec), JSON.parse(readFileSync(repoPath("tests", "we-compare", "doodad-pick-we.json"), "utf8")), "doodad-pick-we.json is not what the generator writes");
  // Control: the comparison fails for another generator's map (the base only gives terrain and options: the doodads are the generator's).
  assert.ok(!readFileSync(dir("edge-last-step.w3m")).equals(readFileSync(join(cwd, "a.w3m"))), "the committed maps of two generators are equal");
});

test("make-sound-order-input writes the committed sound-order.w3m; sound-order-sort.w3m is its copy; beep.wav is toneWav's", async (t) => {
  const tl = tools();
  if (tl.why) return skipOrFail(t, tl.why);
  const cwd = scratchDir("we-gen-snd-");
  await runAsync("sound-order-input", [tl.cli, "so.w3m"], cwd);
  const made = readFileSync(join(cwd, "so.w3m"));
  assert.ok(made.equals(readFileSync(dir("sound-order.w3m"))), "sound-order.w3m is not what its generator makes");
  assert.ok(made.equals(readFileSync(dir("sound-order-sort.w3m"))), "sound-order-sort.w3m is not a copy of sound-order.w3m");
  // Control: the sound-flags map (a different one) is not it.
  assert.ok(!made.equals(readFileSync(dir("sound-flags.w3m"))));
  // make-sound-flags-input needs no tools: it writes beep.wav and a copy of random-group.w3m.
  const flags = join(cwd, "flags");
  const r = spawnSync(process.execPath, [gen("sound-flags-input"), "flags"], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const f of ["beep.wav", "sound-flags.w3m"]) assert.ok(readFileSync(join(flags, f)).equals(readFileSync(dir(f))), `${f} is not what make-sound-flags-input writes`);
  assert.ok(readFileSync(dir("sound-flags.w3m")).equals(readFileSync(dir("random-group.w3m"))), "sound-flags.w3m is a copy of random-group.w3m");
  assert.ok(!readFileSync(join(flags, "beep.wav")).equals(made), "control: not the map");
});
