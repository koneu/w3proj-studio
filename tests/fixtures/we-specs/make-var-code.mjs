// Makes var-code.w3x for tests/we-compare/var-code.json from flat.w3x (the World Editor's own new 64x64 map): integer
// variables whose initial value is not a plain number ('hfoo' as the script writes an object code, hex, a negative hex,
// an empty text) next to a unitcode variable, to see what the editor makes of them when it opens the map and saves it.
// The editor's own Variable dialog only types digits and a minus into an integer's value.
//
//   node tests/fixtures/we-specs/make-var-code.mjs <w3proj cli> <game folder> [--all | --only NAME] [--out FILE]
//
// The map holds the variables the editor's script compiles; --all adds the ones it doesn't (its save stops with Script
// Errors), --only keeps one, --out names the map: for finding which one it is.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const flag = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const [cli, game] = process.argv.slice(2, 4).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-var-code.mjs <w3proj cli> <game folder>"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
// [name, type, initial value, whether the editor's script for it compiles (measured 2026-11-17: bare letters on an
// integer, 1.5 on an integer, a quoted code on a unitcode and text on a real stop its save with "Script Errors")]
const VARS = [
  ["i_quoted", "integer", "'hfoo'", true], ["i_hex", "integer", "0x1F", true], ["i_negHex", "integer", "-0x10", true], ["i_empty", "integer", "", true],
  ["i_plain", "integer", "42", true], ["u_code", "unitcode", "hfoo", true],
  ["i_bare", "integer", "hfoo", false], ["i_real", "integer", "1.5", false], ["u_quoted", "unitcode", "'hfoo'", false], ["r_text", "real", "abc", false],
];
const scratch = mkdtempSync(join(tmpdir(), "we-specs-var-code-"));
try {
  const dir = join(scratch, "p");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const map = join(dir, "map");
  const file = join(map, "war3map.wtg.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  // As Studio's add_trigger_variable writes them (v7): the variable, a type 64 item naming it under the first category
  // (Initialization, 33554432), and the variable count (counts[6]).
  const picked = VARS.filter(([name, , , compiles]) => (flag("--only") ? name === flag("--only") : compiles || process.argv.includes("--all")));
  picked.forEach(([name, type, initialValue], i) => {
    const id = 100663296 + i;
    doc.variables.push({ name, type, unknown: 1, isArray: false, arraySize: 1, initialized: initialValue !== "", initialValue, id, parent: 33554432 });
    doc.items.push({ type: 64, id, name, parent: 33554432 });
  });
  doc.counts[6].count = picked.length;
  writeFileSync(file, JSON.stringify(doc, null, 2));
  // No script: the editor makes its own when it saves, Studio's rebuild its own (it keeps a script it didn't write).
  rmSync(join(map, "war3map.j"), { force: true });
  run("pack", dir, "-o", flag("--out") ? resolve(flag("--out")) : join(here, "var-code.w3x"), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
