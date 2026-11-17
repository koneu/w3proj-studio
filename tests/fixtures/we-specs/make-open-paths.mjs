// Inputs for tests/we-compare/open-paths.json: maps packed by the release CLI from the projects in the main checkout's
// smoketest_maps (the 2026-11-05 GUI-round maps, later ones, and maps of the Curse of the Forsaken campaign project), into
// <repo>/target/open-paths/<name>.w3x. test.md "Maps from paths other than the WE's own save open in the WE".
//   node tests/fixtures/we-specs/make-open-paths.mjs
// (needs the smoketest_maps of the main checkout and a fresh release CLI, as make-studio-paths.mjs)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chosenGamePath, mainCheckout } from "../../gamepath.mjs";
import { requireFresh } from "../../binfresh.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const main = mainCheckout();
const exe = process.platform === "win32" ? "w3proj.exe" : "w3proj";
const cli = existsSync(join(repo, "target", "release", exe)) ? join(repo, "target", "release", exe) : join(main, "target", "release", exe);
requireFresh(cli, "cli");
const maps = join(main, "smoketest_maps");
const forsaken = join(maps, "build_2", "Curse of the Forsaken Classic v4.0.1", "maps");
/** name -> project folder */
export const INPUTS = {
  "gui-meelee-map": join(maps, "build_1", "meelee_map"),
  "gui-meelee-map-2": join(maps, "build_1", "meelee_map_2"),
  "gui-another-melee": join(maps, "build_1", "another melee map"),
  "gui-untitled": join(maps, "build_1", "Untitled"),
  "gui-water-tint": join(maps, "build_1", "03b_Water_Tint"),
  "gui-lastrefuge": join(maps, "build_1", "(2)LastRefuge_S2_v1.5"),
  "forsaken-start": join(forsaken, "ForsakenStart.w3x"),
  "forsaken-07": join(forsaken, "Forsaken07.w3x"),
  "forsaken-interlude": join(forsaken, "Forsaken05Interlude.w3x"),
};
// Built next to the result and swapped in at the end: a failed run leaves the previous maps in place.
const final = join(repo, "target", "open-paths");
const out = `${final}.new`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const env = { ...process.env, W3PROJ_GAME: chosenGamePath() };
for (const [name, project] of Object.entries(INPUTS)) {
  const r = spawnSync(cli, ["pack", project, "-o", join(out, `${name}.w3x`)], { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj pack ${project}: ${r.stderr || r.stdout}`);
}
// The controls: the same campaign maps as the campaign file holds them (without Studio), for what the editor says of a
// campaign map alone (its objects are in the campaign's own object data).
const w3n = join(maps, "campaign", "Curse of the Forsaken Classic v4.0.1.w3n");
for (const [name, inner] of Object.entries({ "forsaken-07-original": "Forsaken07.w3x", "forsaken-interlude-original": "Forsaken05Interlude.w3x" })) {
  const r = spawnSync(cli, ["cat", w3n, inner], { env, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout.length) throw new Error(`w3proj cat ${inner}: ${r.stderr}`);
  writeFileSync(join(out, `${name}.w3x`), r.stdout);
}
rmSync(final, { recursive: true, force: true });
renameSync(out, final);
console.log(`made ${Object.keys(INPUTS).length} maps and 2 originals in ${final}`);
