// Studio's minimap of a map, as the app's rebuild makes it (war3mapMap.blp, JPEG at quality 100 so the file adds almost
// no error of its own), for comparing with the World Editor's Export Minimap (minimap-diff.mjs, we-drive --export-minimap):
//
//   node scripts/minimap-studio.mjs MAP.w3x OUT.blp [--mode sd|hd] [--game DIR] [--keep DIR] [--set key=value]...
//
// Unpacks the map into a scratch project (or --keep DIR, left behind), rebuilds its minimap with this checkout's code
// (the CLI's headless bundle, built from here), copies the picture to OUT.blp. Needs the release CLI (target/*/w3proj of
// the main checkout, or W3PROJ_CLI) and the game folder (W3PROJ_GAME / .game-path).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gamePath, mainCheckout } from "../../tests/gamepath.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : fallback; };
const mode = opt("--mode", "sd"), keep = opt("--keep"), gameArg = opt("--game");
/** Settings given as --set key=value (a number when it is one): "terrain.minimap.groundNoise=0" leaves out the grain. */
const extra = {};
for (let i = args.indexOf("--set"); i >= 0; i = args.indexOf("--set")) {
  const [k, v] = args.splice(i, 2)[1].split("=");
  extra[k] = v !== "" && Number.isFinite(Number(v)) ? Number(v) : v;
}
const [map, out] = args;
if (!map || !out) { console.error("usage: minimap-studio.mjs MAP.w3x OUT.blp [--mode sd|hd] [--game DIR] [--keep DIR]"); process.exit(2); }
const game = gameArg ?? gamePath();
const main = mainCheckout(here);
const cli = process.env.W3PROJ_CLI ?? ["release", "debug"].map((p) => join(main, "target", p, process.platform === "win32" ? "w3proj.exe" : "w3proj")).find(existsSync);
if (!cli) { console.error("no w3proj CLI found (W3PROJ_CLI)"); process.exit(2); }
const scratch = mkdtempSync(join(tmpdir(), "minimap-studio-"));
const run = (cmd, a, env = {}) => {
  const r = spawnSync(cmd, a, { encoding: "utf8", env: { ...process.env, W3PROJ_GAME: game, W3_ALLOW_STALE: "1", ...env } });
  if (r.status !== 0) { console.error(`${cmd} ${a.join(" ")}\n${r.stderr}${r.stdout}`); process.exit(1); }
  if (process.env.MM_DEBUG) process.stderr.write(r.stderr);
};
try {
  const bundle = join(scratch, "headless.mjs");
  run(process.execPath, [join(here, "headless.mjs"), "--out", bundle]);
  const project = resolve(keep ?? join(scratch, "project"));
  run(cli, ["unpack", resolve(map), project, "--game", game]);
  mkdirSync(join(project, ".w3proj"), { recursive: true });
  writeFileSync(join(project, ".w3proj", "settings.json"), JSON.stringify({ "terrain.minimap.jpegQuality": 100, "terrain.minimap.regenerate": "always", ...extra }));
  run(cli, ["rebuild", project, "--only", "minimap", "--force", "--mode", mode, "--game", game], { W3PROJ_HEADLESS: bundle });
  copyFileSync(join(project, "map", "war3mapMap.blp"), resolve(out));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
