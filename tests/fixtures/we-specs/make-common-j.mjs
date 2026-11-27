// Inputs of the common.j experiment (tests/we-compare/common-j-we.mjs, docs/testing/saved-data-rules.md "Which
// common.j the editor checks against"): flat.w3x (the editor's own new 64x64 JASS map) with a custom text trigger
// "UseExtra" and, in some, an imported Scripts\common.j, into <repo>/target/common-j/ (not committed).
//
//   node tests/fixtures/we-specs/make-common-j.mjs <w3proj cli> <game folder> [--out DIR] [--allow-stale]
//
//   cj-own           Scripts\common.j = the game's + `native GetUnitGoldCost` (at the end) + `constant integer
//                    W3PROJ_MAP_ONLY = 7` (first line of its globals); the trigger uses both
//   cj-none          the same trigger, no Scripts\common.j
//   cj-subset        Scripts\common.j = the game's without `native BlzGetUnitArmor`; the trigger calls BlzGetUnitArmor
//                    (Blizzard.j doesn't), so it fails only if the map's file replaces the game's
//   cj-control       the BlzGetUnitArmor trigger, no Scripts\common.j (the trigger's shape is right)
//   cj-vjass-own / cj-vjass-none / cj-vjass-subset
//                    as above with JassHelper on (war3mapExtra.txt) and the trigger a vJASS library
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";
import { addScriptTrigger } from "./trigger-folder.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [cli, game] = argv.slice(0, 2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-common-j.mjs <w3proj cli> <game folder> [--out DIR] [--allow-stale]"); process.exit(2); }
requireFresh(cli, "cli");
let out = resolve(here, "..", "..", "..", "target", "common-j");
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === "--out") {
    if (argv[i + 1] === undefined) { console.error("--out needs a folder"); process.exit(2); }
    out = resolve(argv[++i]);
  } else if (argv[i] !== "--allow-stale") { console.error(`unknown argument ${argv[i]}`); process.exit(2); }
}

const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const r = spawnSync(cli, ["game", "--install", game, "cat", "Scripts/common.j"], { encoding: "latin1", maxBuffer: 64 * 1024 * 1024 });
if (r.status !== 0 || !r.stdout.length) throw new Error(`w3proj game cat Scripts/common.j: ${r.stderr}`);
const GAME = r.stdout;
const EOL = GAME.includes("\r\n") ? "\r\n" : "\n";
if (/GetUnitGoldCost|W3PROJ_MAP_ONLY/.test(GAME)) throw new Error("the game's common.j already declares the extra names");

/** The game's common.j plus a native and a constant only the map's file declares. */
const withExtras = () => {
  const at = GAME.indexOf(`${EOL}globals${EOL}`);
  if (at < 0) throw new Error("no globals block in the game's common.j");
  const head = at + `${EOL}globals${EOL}`.length;
  return `${GAME.slice(0, head)}    constant integer W3PROJ_MAP_ONLY = 7${EOL}${GAME.slice(head)}${EOL}native GetUnitGoldCost takes integer unitid returns integer${EOL}`;
};
/** The game's common.j without BlzGetUnitArmor. */
const withoutArmor = () => {
  const lines = GAME.split(EOL);
  const kept = lines.filter((l) => !/^native\s+BlzGetUnitArmor\s/.test(l));
  if (kept.length !== lines.length - 1) throw new Error("BlzGetUnitArmor is not declared once in the game's common.j");
  return kept.join(EOL);
};

const init = (body) => [
  "function Trig_UseExtra_Actions takes nothing returns nothing",
  `    ${body}`,
  "endfunction",
  "",
  "function InitTrig_UseExtra takes nothing returns nothing",
  "    set gg_trg_UseExtra = CreateTrigger(  )",
  "    call TriggerAddAction( gg_trg_UseExtra, function Trig_UseExtra_Actions )",
  "endfunction",
  "",
];
const EXTRA = "call BJDebugMsg( I2S( GetUnitGoldCost( 'hfoo' ) + W3PROJ_MAP_ONLY ) )";
const ARMOR = "call BJDebugMsg( R2S( BlzGetUnitArmor( null ) ) )";
const plainText = (body) => init(body).join("\r\n");
const vjassText = (expr) => [
  "library UseExtraLib",
  "    function UseExtraValue takes nothing returns string",
  `        return ${expr}`,
  "    endfunction",
  "endlibrary",
  "",
  ...init("call BJDebugMsg( UseExtraValue() )"),
].join("\r\n");
const VJ_EXTRA = "I2S( GetUnitGoldCost( 'hfoo' ) + W3PROJ_MAP_ONLY )";
const VJ_ARMOR = "R2S( BlzGetUnitArmor( null ) )";
const JASSHELPER = "[MapExtraInfo]\nEnableJassHelper=true\n\n";

/** name -> { common: text or null, text: the trigger, vjass } */
export const MAPS = {
  "cj-own": () => ({ common: withExtras(), text: plainText(EXTRA) }),
  "cj-none": () => ({ common: null, text: plainText(EXTRA) }),
  "cj-subset": () => ({ common: withoutArmor(), text: plainText(ARMOR) }),
  "cj-control": () => ({ common: null, text: plainText(ARMOR) }),
  "cj-vjass-own": () => ({ common: withExtras(), text: vjassText(VJ_EXTRA), vjass: true }),
  "cj-vjass-none": () => ({ common: null, text: vjassText(VJ_EXTRA), vjass: true }),
  "cj-vjass-subset": () => ({ common: withoutArmor(), text: vjassText(VJ_ARMOR), vjass: true }),
};

function make(name) {
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-common-j-"));
  try {
    const dir = join(scratch, "p");
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    const map = join(dir, "map");
    const { common, text, vjass } = MAPS[name]();
    if (common !== null) {
      mkdirSync(join(map, "Scripts"), { recursive: true });
      writeFileSync(join(map, "Scripts", "common.j"), Buffer.from(common, "latin1"));
      writeFileSync(join(map, "war3map.imp.json"), JSON.stringify({ format: "w3proj.imports/1", version: 1, files: [{ flags: 13, path: "Scripts\\common.j" }] }, null, 2));
    }
    if (vjass) writeFileSync(join(map, "war3mapExtra.txt"), JASSHELPER);
    addScriptTrigger(dir, { name: "UseExtra", description: "", isComment: 0, enabled: true, initiallyOff: false, runOnInit: false }, text);
    mkdirSync(out, { recursive: true });
    run("pack", "--keep-objects", dir, "-o", join(out, `${name}.w3x`), "--force-stale");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const name of Object.keys(MAPS)) make(name);
console.log(`made ${Object.keys(MAPS).length} maps in ${out}`);
