// Inputs for tests/we-compare/studio-paths-*.json: a game map put through the release CLI's other paths, into
// <repo>/target/studio-paths/ (needs the game's folder and the smoketest maps of the main checkout).
//   node tests/fixtures/we-specs/make-studio-paths.mjs
//   echo-rebuilt.w3x  unpack, `w3proj rebuild --force`, pack
//   echo-nolua.w3x    unpack, war3map.lua deleted, `w3proj rebuild` writes it again, pack
//   echo-nowts.w3x    unpack, war3map.wts deleted, pack (Studio's save has to write it again)
//   echo-plain.w3x    unpack, pack (the control: nothing changed)
//   echo-zeromasks.w3x  echo with every player's allyLow/allyHigh set to 0 in the w3i (the all-zero masks of a map saved with
//                     Modify ally priorities off by another tool), packed as is (pack_as_is: `w3proj pack` would work them out)
//   matrix.w3x        MatrixPCDefense_v4.3 (no war3map.wtg: the editor refuses it, "Trigger data missing or invalid") with
//                     echo's war3map.wtg.json and war3map.wct.txt added, packed as is; its ally masks stay all zero
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chosenGamePath, mainCheckout } from "../../gamepath.mjs";
import { requireFresh } from "../../binfresh.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const main = mainCheckout();
const cli = join(main, "target", "release", process.platform === "win32" ? "w3proj.exe" : "w3proj");
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const src = join(main, "smoketest_maps", "blizzard", "(2)EchoIsles_S2_v2.2.w3x");
// Built next to the result and swapped in at the end: a failed run leaves the previous maps in place.
const final = join(repo, "target", "studio-paths");
const out = `${final}.new`;
const env = { ...process.env, W3PROJ_GAME: chosenGamePath() };

function run(...args) {
  const r = spawnSync(cli, args, { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr || r.stdout}`);
}

// `w3proj pack` works out the World Editor's ally priorities (crates/w3proj/src/allies.rs): the inputs whose all-zero masks
// are the point go through the pack_as_is example, which packs the project's files as they are.
function packAsIs(project, output) {
  const r = spawnSync("cargo", ["run", "--release", "--quiet", "-p", "w3proj", "--example", "pack_as_is", "--", project, output], { cwd: repo, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`pack_as_is ${project}: ${r.stderr || r.stdout}`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
run("unpack", src, join(out, "base"));
for (const name of ["rebuilt", "nolua", "nowts", "plain"]) cpSync(join(out, "base"), join(out, name), { recursive: true });
run("rebuild", join(out, "rebuilt"), "--force");
rmSync(join(out, "nolua", "map", "war3map.lua"));
run("rebuild", join(out, "nolua"));
rmSync(join(out, "nowts", "map", "war3map.wts"));
for (const name of ["rebuilt", "nolua", "nowts", "plain"]) run("pack", join(out, name), "-o", join(out, `echo-${name}.w3x`));
cpSync(join(out, "base"), join(out, "zeromasks"), { recursive: true });
const w3iPath = join(out, "zeromasks", "map", "war3map.w3i.json");
const w3i = JSON.parse(readFileSync(w3iPath, "utf8"));
for (const p of w3i.players) { p.allyLow = 0; p.allyHigh = 0; }
writeFileSync(w3iPath, JSON.stringify(w3i, null, 2));
packAsIs(join(out, "zeromasks"), join(out, "echo-zeromasks.w3x"));
const matrixSrc = join(main, "smoketest_maps", "new(er)_maps", "MatrixPCDefense_v4.3.w3x");
run("unpack", matrixSrc, join(out, "matrix"));
for (const f of ["war3map.wtg.json", "war3map.wct.txt"]) cpSync(join(out, "base", "map", f), join(out, "matrix", "map", f));
packAsIs(join(out, "matrix"), join(out, "matrix.w3x"));
rmSync(final, { recursive: true, force: true });
renameSync(out, final);
console.log(`made ${final}/echo-{rebuilt,nolua,nowts,plain,zeromasks}.w3x and matrix.w3x`);
