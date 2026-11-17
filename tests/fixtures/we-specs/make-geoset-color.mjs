// Makes target/geoset-color/geoset-color.w3x for the geoset colour track comparison (test.md "A geoset colour track"):
// flat.w3x (the World Editor's own new 64x64 Lordaeron Summer map) with game doodads whose models hold a geoset
// animation with a colour track (KGAC in the model), in two rows at ground level, 256 apart:
//   DOlc LavaCracks, GOlc GCracks, YOsw SunWell, DOas AzsharaStatue, ZZys EyeOfSargeras, KOdr RuneArt, GPsh ShroomsBlue
//
//   node tests/fixtures/we-specs/make-geoset-color.mjs <w3proj cli> <game folder> [--out DIR] [--allow-stale]
//
// Look at them with we-drive `--look 0,-250,2000` and app-drive `--camera we:0,-250,2000`.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [cli, game] = argv.slice(0, 2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-geoset-color.mjs <w3proj cli> <game folder> [--out DIR]"); process.exit(2); }
requireFresh(cli, "cli");
let out = resolve(here, "..", "..", "..", "target", "geoset-color");
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === "--out") out = resolve(argv[++i]);
  else if (argv[i] !== "--allow-stale") throw new Error(`unknown argument ${argv[i]}`);
}
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
// first row y 0, second row y -512 (OZsp ShimmeringPortal: a static geoset colour and a track in one model)
const IDS = ["DOlc", "GOlc", "YOsw", "DOas", "ZZys", "KOdr", "GPsh", "OZsp"];
const scratch = mkdtempSync(join(tmpdir(), "we-geoset-color-"));
try {
  const dir = join(scratch, "map");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const dooFile = join(dir, "map", "war3map.doo.json");
  const doo = JSON.parse(readFileSync(dooFile, "utf8"));
  doo.doodads = IDS.map((id, k) => ({
    id, variation: 0, position: k < 7 ? [(k - 3) * 256, 0, 0] : [0, -512, 0], angle: (270 * Math.PI) / 180, scale: [1, 1, 1], skinId: id,
    preFlags: 4294967295, flags: 2, life: 255, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [k, 0, 0], extras: [],
  }));
  writeFileSync(dooFile, JSON.stringify(doo, null, 1));
  run("rebuild", dir, "--only", "wpm,shd,minimap", "--game", game);
  mkdirSync(out, { recursive: true });
  run("pack", dir, "-o", join(out, "geoset-color.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`made ${join(out, "geoset-color.w3x")}`);
