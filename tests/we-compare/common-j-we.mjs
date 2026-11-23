// Which common.j the World Editor checks a map's script against (branch fix/we-common-j-experiment, 2026-11-23;
// docs/testing/saved-data-rules.md "Which common.j the editor checks against"). Not a we-compare spec: there is no
// Studio side, only the editor's verdict on each map of tests/fixtures/we-specs/make-common-j.mjs.
//
//   node tests/we-compare/common-j-we.mjs [--only NAME,NAME] [--out DIR] [--allow-stale]
//
// Makes the maps into target/common-j/ (the w3proj CLI of appctl.mjs ensureCli, W3PROJ_BIN overrides), opens each in
// the hidden editor (app/scripts/we-drive.mjs, SD, one process per map) and saves it: "saved" means the save passed the
// script check, "refused" that it stopped at the named error dialog (its picture is kept in DIR). Exit 1 when a map's
// verdict differs from EXPECT, 0 when we-drive skips (no editor on this machine).
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureCli } from "../../app/scripts/appctl.mjs";
import { gamePath } from "../gamepath.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");

// map -> [verdict, the dialog a refusal stops at, text the saved war3map.j has to hold]
export const EXPECT = {
  "cj-control": ["saved", null, "BlzGetUnitArmor( null )"],
  "cj-own": ["saved", null, "GetUnitGoldCost( 'hfoo' ) + W3PROJ_MAP_ONLY"],
  "cj-none": ["refused", "Script Errors"],
  "cj-subset": ["refused", "Script Errors"],
  "cj-vjass-own": ["saved", null, "GetUnitGoldCost('hfoo') + W3PROJ_MAP_ONLY"],
  "cj-vjass-none": ["refused", "Syntax Errors"],
  "cj-vjass-subset": ["refused", "Syntax Errors"],
};

const argv = process.argv.slice(2);
let only = Object.keys(EXPECT), out = join(repo, "target", "common-j");
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--only" && argv[i + 1]) only = argv[++i].split(",").filter(Boolean);
  else if (argv[i] === "--out" && argv[i + 1]) out = resolve(argv[++i]);
  else if (argv[i] === "--allow-stale") process.env.W3_ALLOW_STALE = "1";
  else { console.error(`unknown argument ${argv[i]}`); process.exit(2); }
}
for (const n of only) if (!EXPECT[n]) { console.error(`no map ${n} (${Object.keys(EXPECT).join(", ")})`); process.exit(2); }

const cli = ensureCli();
const game = gamePath();
const made = spawnSync(process.execPath, [join(repo, "tests", "fixtures", "we-specs", "make-common-j.mjs"), cli, game, "--out", out, "--allow-stale"], { encoding: "utf8" });
if (made.status !== 0) { console.error(made.stderr || made.stdout); process.exit(1); }
const saved = join(out, "out");
mkdirSync(saved, { recursive: true });

let bad = 0;
for (const name of only) {
  const [verdict, dialog, text] = EXPECT[name];
  const r = spawnSync(process.execPath, [join(repo, "app", "scripts", "we-drive.mjs"), "--mode", "sd", "--timeout", "300",
    "--map", join(out, `${name}.w3x`), "--wait-ready", "--save", join(saved, `${name}.w3x`), "--close"],
  { cwd: join(repo, "app"), encoding: "utf8", timeout: 900000 });
  const steps = (r.stdout ?? "").split(/\r?\n/).filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  if (steps.some((s) => s.skipped)) { console.log(JSON.stringify({ skipped: steps.find((s) => s.skipped).skipped })); process.exit(0); }
  const save = steps.find((s) => s.step === "--save");
  let got, why = "";
  if (save?.saved) {
    got = "saved";
    const j = spawnSync(cli, ["cat", join(saved, `${name}.w3x`), "war3map.j"], { encoding: "latin1", maxBuffer: 1 << 26 });
    if (text && !j.stdout?.includes(text)) why = `the saved war3map.j lacks ${text}`;
  } else if (save && save.dialogs) {
    got = "refused";
    const titles = save.dialogs.map((d) => d.title);
    if (save.screen) copyFileSync(save.screen, join(saved, `${name}-dialog.png`));
    if (dialog && !titles.includes(dialog)) why = `stopped at ${titles.join(", ")}, not ${dialog}`;
  } else {
    got = "error";
    why = JSON.stringify(save ?? { status: r.status, stderr: r.stderr?.slice(-400) });
  }
  const ok = got === verdict && !why;
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name.padEnd(16)} expected ${verdict}${dialog ? ` (${dialog})` : ""}, got ${got}${why ? `: ${why}` : ""}`);
}
process.exit(bad ? 1 : 0);
