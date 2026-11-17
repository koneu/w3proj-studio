// Makes injected-script.w3x for tests/we-compare/injected-script.json from flat.w3x (a JASS map): its war3map.j gets what
// W3Champions' tools add to a map's script, code the map's triggers don't make:
//
//   node tests/fixtures/we-specs/make-injected-script.mjs <w3proj cli>
//
// A global (declared in the globals block), two functions before `main` (one a trigger action started from main by
// ExecuteFunc, the other a plain helper), and a call in `main` after InitCustomTriggers.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gamePath } from "../../gamepath.mjs";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = process.argv[2] ? resolve(process.argv[2]) : null;
if (!cli) { console.error("usage: make-injected-script.mjs <w3proj cli>"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const run = (...a) => {
  const r = spawnSync(cli, a, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${a.join(" ")}: ${r.stderr}${r.stdout}`);
};
const scratch = mkdtempSync(join(tmpdir(), "we-specs-injected-"));
try {
  const dir = join(scratch, "p");
  run("unpack", join(here, "flat.w3x"), dir, "--game", gamePath());
  const file = join(dir, "map", "war3map.j");
  let j = readFileSync(file, "utf8");
  const eol = j.includes("\r\n") ? "\r\n" : "\n";
  const lines = (...l) => l.join(eol) + eol;
  if (!j.includes("endglobals")) throw new Error("flat.w3x's script has no globals block");
  j = j.replace("endglobals", lines("    integer W3C_Injected = 0", "endglobals").trimEnd());
  j = j.replace("function main takes nothing returns nothing", lines(
    "function W3C_InjectedHelper takes integer n returns integer",
    "    return n + 1",
    "endfunction",
    "",
    "function W3C_InjectedStart takes nothing returns nothing",
    "    set W3C_Injected = W3C_InjectedHelper(W3C_Injected)",
    "    call BJDebugMsg(\"injected\")",
    "endfunction",
    "",
    "function main takes nothing returns nothing").trimEnd());
  j = j.replace("    call InitCustomTriggers(  )", lines("    call InitCustomTriggers(  )", "    call ExecuteFunc(\"W3C_InjectedStart\")").trimEnd());
  if (!j.includes("W3C_InjectedStart\")")) throw new Error("the call was not injected");
  writeFileSync(file, j);
  run("pack", dir, "-o", join(here, "injected-script.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
