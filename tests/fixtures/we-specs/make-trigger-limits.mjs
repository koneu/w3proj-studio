// Makes the input of the Trigger Editor Value-dialog measurements (docs/testing/numeric-limits-measured.md) from an
// empty map:
//
//   node tests/fixtures/we-specs/make-trigger-limits.mjs <empty map> <w3proj cli> <out.w3x>
//
// One GUI trigger "Limits" (a map-initialization event) whose actions each take a number with limits in the game's
// TriggerData.txt (_Limits), one action per line in this order:
//   Wait 2 seconds                                    TriggerSleepAction, real, 0.._
//   Set HD water min opacity to 50                    BlzSetHDWaterMinOpacityBJ, integer, 0..100
//   Set ally color filter state to 1                  SetAllyColorFilterState, integer, 0..2
//   Limit heroes to 1 for Player 1 (Red)              SetPlayerMaxHeroesAllowed, integer, -1.._
//   Set Player 1 (Red) handicap to 100.00%            SetPlayerHandicapBJ, real, 1..10000
//   Wait 3 seconds                                    TriggerSleepAction again (a second line for more values)
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireFresh } from "../../binfresh.mjs";
import { addGuiTrigger } from "./trigger-folder.mjs";
import { gamePath } from "../../gamepath.mjs";

const [empty, cli, out] = process.argv.slice(2).filter((a) => !a.startsWith("--")).map((p) => (p ? resolve(p) : p));
if (!out) { console.error("usage: make-trigger-limits.mjs <empty map> <w3proj cli> <out.w3x>"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const eca = (kind, name, params) => ({ kind, name, enabled: true, params, children: [] });
const num = (value) => ({ type: 3, value });
const preset = (value) => ({ type: 0, value });
const scratch = mkdtempSync(join(tmpdir(), "we-specs-trigger-limits-"));
try {
  const dir = join(scratch, "p");
  run("unpack", empty, dir, "--game", gamePath()); // the trigger file needs the game's TriggerData
  addGuiTrigger(dir, { description: "", isComment: 0, enabled: true, initiallyOff: false, runOnInit: false, name: "Limits", ecas: [
    eca(0, "MapInitializationEvent", []),
    eca(2, "TriggerSleepAction", [num("2")]),
    eca(2, "BlzSetHDWaterMinOpacityBJ", [num("50")]),
    eca(2, "SetAllyColorFilterState", [num("1")]),
    eca(2, "SetPlayerMaxHeroesAllowed", [num("1"), preset("Player00")]),
    eca(2, "SetPlayerHandicapBJ", [preset("Player00"), num("100")]),
    eca(2, "TriggerSleepAction", [num("3")]),
  ] });
  run("pack", "--keep-objects", dir, "-o", out, "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
