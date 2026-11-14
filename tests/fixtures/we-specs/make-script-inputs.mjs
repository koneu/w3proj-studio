// Makes the input of the gameplay constants spec (tests/we-compare/script-inputs-e.json, melee-misc-w3i) from flat.w3x (the World Editor's own new 64x64 Lordaeron Summer melee map):
//
//   node tests/fixtures/we-specs/make-script-inputs.mjs <w3proj cli> <game folder>
//
// - melee-misc.w3x: flat.w3x with a war3mapMisc.txt that sets one gameplay constant ([Misc] ScaledAnimTime=75.0, what
//   the editor writes after one edited value), the Melee flag still on in the w3i (the editor would take it off in a
//   save).
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-script-inputs.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const make = (out, edit) => {
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
  try {
    const dir = join(scratch, "map");
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    edit(join(dir, "map"));
    run("pack", dir, "-o", join(here, out), "--force-stale");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};
make("melee-misc.w3x", (dir) => writeFileSync(join(dir, "war3mapMisc.txt"), "[Misc]\nScaledAnimTime=75.0\n"));
