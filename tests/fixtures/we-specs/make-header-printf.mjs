// Makes target/header-printf/hp-*.w3x for tests/we-compare/header-printf.json from flat.w3x (the World Editor's own new
// 64x64 map): maps whose custom script header (map/triggers/header.j, header.lua) holds % sequences. The World Editor
// passes the header, and only the header, through C printf with no arguments when it writes the map script
// (lib/script/printf.ts has the rule; measured 2026-11-22, target/evidence/verify-2026-11-22/wb.md). Each case is one
// function returning "NN|<case>|", so the script's lines show what became of it; the maps carry no war3map.j (the
// editor's save makes its own, Studio's spec step its own).
//
//   node tests/fixtures/we-specs/make-header-printf.mjs <w3proj cli> <game folder> [--out DIR] [--allow-stale]
//
//   hp-g         the cases measured first (%% → %, %* and a following char → that char, ...)
//   hp-new       more of printf's grammar: width, precision, length modifiers, flags, chars that are no conversion
//   hp-end1      a header whose last char is a lone %
//   hp-end2      a header that ends in % and a width (%5)
//   hp-lua       hp-g's cases in a Lua map's header.lua
//   hp-lua-mod   a Lua header using % as Lua's modulo operator (7 % 3)
// None has a conversion (%d, %s, ...): the editor prints garbage for those or crashes on save.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [cli, game] = argv.slice(0, 2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-header-printf.mjs <w3proj cli> <game folder> [--out DIR]"); process.exit(2); }
requireFresh(cli, "cli");
let out = resolve(here, "..", "..", "..", "target", "header-printf");
let each = false;
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === "--out") out = resolve(argv[++i]);
  else if (argv[i] === "--each") each = true;
  else if (argv[i] !== "--allow-stale") throw new Error(`unknown argument ${argv[i]}`);
}
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};

/** Measured first (make-pct.mjs of the 2026-11-22 round). */
const G = { "01": "%%", "02": "%*", "03": "100%", "07": "%%%", "08": "%%%%", "09": "%%*", "10": "%*%", "14": "%%d", "15": "a%%b%%c", "17": "%%%*%%", "18": "%**", "19": "%%%%%*", "20": "x%", "21": "%%%%%%" };
/** The rest of the grammar: flags, width, precision, length modifiers before a char that ends the sequence. Left out:
 *  46 "%lz" and 61 "%N", which crash the editor's save (--each found them, 2026-11-22). */
const NEW = {
  "30": "%5%", "31": "%.3", "32": "%hh", "33": "%I64", "34": "%-", "35": "%0", "36": "%#", "37": "%+", "38": "%l%", "39": "%5*",
  "40": "%.*", "41": "%*5", "42": "%I3", "43": "%I32", "44": "%w", "45": "%T", "47": "%L", "48": "%j", "49": "%t",
  "50": "%q%%", "51": "%-5.2%", "52": "%.", "53": "%.5.", "54": "%h%", "55": "% ", "56": "%!", "58": "%'", "59": "%$", "60": "%1$",
  "63": "%b", "64": "%D", "65": "%ll", "66": "%I64%", "67": "%v", "68": "%k", "69": "%r",
};
const jass = (cases) => Object.entries(cases).map(([n, c]) => `function H${n} takes nothing returns string\n    return "${n}|${c}|"\nendfunction\n`).join("");
const lua = (cases) => Object.entries(cases).map(([n, c]) => `function H${n}() return "${n}|${c}|" end\n`).join("");
const CONTROL = 'function HCTRL takes nothing returns string\n    return "CT|plain|"\nendfunction\n';
const MAPS = {
  "hp-g": { header: `// c1 100%% and %* and 5%\n${jass(G)}${CONTROL}` },
  "hp-new": { header: `// c1 100%% and %* and 5%\n${jass(NEW)}${CONTROL}` },
  "hp-end1": { header: `${CONTROL}// end x%` },
  "hp-end2": { header: `${CONTROL}// end y%5` },
  "hp-lua": { lua: true, header: `-- c1 100%% and %* and 5%\n${lua(G)}function HCTRL() return "CT|plain|" end\n` },
  "hp-lua-mod": { lua: true, header: 'function HMOD() return "MD|" .. tostring(7 % 3) .. "|" end\n' },
};
// --each: instead, one map per case of NEW (hp-n-NN.w3x), to find a case that crashes the editor's save.
if (each) {
  for (const k of Object.keys(MAPS)) delete MAPS[k];
  for (const [n, c] of Object.entries(NEW)) MAPS[`hp-n-${n}`] = { header: jass({ [n]: c }) + CONTROL };
}

const scratch = mkdtempSync(join(tmpdir(), "we-header-printf-"));
try {
  mkdirSync(out, { recursive: true });
  for (const [name, m] of Object.entries(MAPS)) {
    const dir = join(scratch, name);
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    const map = join(dir, "map");
    if (m.lua) {
      const w3i = join(map, "war3map.w3i.json");
      const text = readFileSync(w3i, "utf8");
      if (!text.includes('"scriptType": 0')) throw new Error(`${w3i}: no "scriptType": 0 to change`);
      writeFileSync(w3i, text.replace('"scriptType": 0', '"scriptType": 1'));
    }
    writeFileSync(join(map, "triggers", m.lua ? "header.lua" : "header.j"), m.header);
    // No script: the editor's save makes its own, Studio's "w3.script.generate" its own.
    rmSync(join(map, "war3map.j"), { force: true });
    run("pack", dir, "-o", join(out, `${name}.w3x`), "--force-stale");
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`made ${Object.keys(MAPS).map((n) => join(out, `${n}.w3x`)).join(", ")}`);
