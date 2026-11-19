// Makes trigger-folds.w3x for tests/we-compare/trigger-folds.json from flat.w3x (the World Editor's own new map: one
// category "Initialization", stored with `expanded` 0, holding Melee Initialization): a second category "Other" with
// `expanded` 0 and no trigger, before Initialization, so the first trigger is in the second category. Opening the
// Trigger Editor (F4) opens the first trigger's category in the editor whatever it says (docs/testing/branch-rounds.md branch we-compare-7);
// does its save then write that category's `expanded` as 1?
//
//   node tests/fixtures/we-specs/make-trigger-folds.mjs <w3proj cli> <game folder>
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cliArg, gameArg] = process.argv.slice(2);
const [cli, game] = [cliArg, gameArg].map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli");
if (!game) { console.error("usage: make-trigger-folds.mjs <w3proj cli> <game folder>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const scratch = mkdtempSync(join(tmpdir(), "we-specs-trigger-folds-"));
try {
  const dir = join(scratch, "folds");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const path = join(dir, "map", "war3map.wtg.json");
  const wtg = JSON.parse(readFileSync(path, "utf8"));
  const init = wtg.items.findIndex((it) => it.type === 4);
  if (init < 0 || wtg.items[init].expanded !== 0) throw new Error("flat.w3x's Initialization category isn't as expected");
  wtg.items.splice(init, 0, { type: 4, id: 33554433, name: "Other", isComment: 0, expanded: 0, parent: 0 });
  wtg.counts[2].count += 1;
  writeFileSync(path, JSON.stringify(wtg, null, 2));
  run("pack", dir, "-o", join(here, "trigger-folds.w3x"));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
