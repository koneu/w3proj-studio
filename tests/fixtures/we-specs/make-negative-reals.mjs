// Makes target/negative-reals/negative-reals.w3x (flat.w3x with one custom ability) for the Object Editor's negative
// real checks (test.md "Negative reals with the preference ON"): A000, based on Heal (Ahea), with 3 levels and a
// negative value in an unreal field the editor itself can't make: Cooldown (acdn) level 1 -3, level 2 -1.5, level 3 2.
// Also Casting Time (acas) level 2 -0.5 and Cast Range (aran) level 3 -100.
//
//   node tests/fixtures/we-specs/make-negative-reals.mjs <w3proj cli> <game folder> [--out DIR] [--allow-stale]
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [cli, game] = argv.slice(0, 2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-negative-reals.mjs <w3proj cli> <game folder> [--out DIR]"); process.exit(2); }
requireFresh(cli, "cli");
let out = resolve(here, "..", "..", "..", "target", "negative-reals");
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === "--out") out = resolve(argv[++i]);
  else if (argv[i] !== "--allow-stale") throw new Error(`unknown argument ${argv[i]}`);
}
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const real = (field, level, value) => ({ field, type: "unreal", value, level, data: 0 });
const scratch = mkdtempSync(join(tmpdir(), "we-negative-reals-"));
try {
  const dir = join(scratch, "map");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const mods = [
    { field: "alev", type: "int", value: 3, level: 0, data: 0 },
    real("acdn", 1, -3), real("acdn", 2, -1.5), real("acdn", 3, 2),
    real("acas", 2, -0.5), real("aran", 3, -100),
  ];
  writeFileSync(join(dir, "map", "war3map.w3a.json"), JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [], custom: [{ base: "Ahea", id: "A000", mods }] }, null, 2));
  mkdirSync(out, { recursive: true });
  run("rebuild", dir, "--only", "wpm,shd,minimap", "--game", game);
  run("pack", dir, "-o", join(out, "negative-reals.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`made ${join(out, "negative-reals.w3x")}`);
