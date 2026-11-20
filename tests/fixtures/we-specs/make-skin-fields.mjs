// Makes target/skin-fields/skin-fields.w3x (flat.w3x with custom objects whose names live in the Skin files) for the
// questions where the World Editor keeps Skin fields (test.md "Where the WE keeps Skin fields", "A renamed plain name
// written into the Skin file"; docs/testing/branch-rounds.md "Branch we-batch-5"):
// - H001 (Paladin): war3map.w3u has hit points 777 (and in skin-fields-hidden.w3x also unam "Main Hero", hidden),
//   war3mapSkin.w3u unam "Skin Hero" and a proper name upro "Skin Proper";
// - A001 (Holy Light): war3map.w3a has the levels (alev 1), war3mapSkin.w3a anam "Skin Ability";
// - B001 (Brilliance Aura's buff BHab): war3mapSkin.w3h fnam "Skin Buff", ftip "Skin Tip", nothing in war3map.w3h.
// All names are plain text (no TRIGSTR_), as Studio writes a typed name.
//
//   node tests/fixtures/we-specs/make-skin-fields.mjs <w3proj cli> <game folder> [--out DIR] [--allow-stale]
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [cli, game] = argv.slice(0, 2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-skin-fields.mjs <w3proj cli> <game folder> [--out DIR]"); process.exit(2); }
requireFresh(cli, "cli");
let out = resolve(here, "..", "..", "..", "target", "skin-fields");
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === "--out") out = resolve(argv[++i]);
  else if (argv[i] !== "--allow-stale") throw new Error(`unknown argument ${argv[i]}`);
}
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const file = (custom) => JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [], custom }, null, 2);
const str = (field, value) => ({ field, type: "string", value });
const lv = (field, type, value) => ({ field, type, value, level: 0, data: 0 });
const scratch = mkdtempSync(join(tmpdir(), "we-skin-fields-"));
try {
  const dir = join(scratch, "map");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const m = (name) => join(dir, "map", name);
  writeFileSync(m("war3mapSkin.w3u.json"), file([{ base: "Hpal", id: "H001", mods: [str("unam", "Skin Hero"), str("upro", "Skin Proper")] }]));
  writeFileSync(m("war3map.w3a.json"), file([{ base: "AHhb", id: "A001", mods: [lv("alev", "int", 1)] }]));
  writeFileSync(m("war3mapSkin.w3a.json"), file([{ base: "AHhb", id: "A001", mods: [lv("anam", "string", "Skin Ability")] }]));
  writeFileSync(m("war3map.w3h.json"), file([{ base: "BHab", id: "B001", mods: [] }]));
  writeFileSync(m("war3mapSkin.w3h.json"), file([{ base: "BHab", id: "B001", mods: [str("fnam", "Skin Buff"), str("ftip", "Skin Tip")] }]));
  mkdirSync(out, { recursive: true });
  run("rebuild", dir, "--only", "wpm,shd,minimap", "--game", game);
  // skin-fields-hidden.w3x: war3map.w3u has a name of its own ("Main Hero"), hidden by the Skin file's.
  for (const [name, mods] of [["skin-fields.w3x", []], ["skin-fields-hidden.w3x", [str("unam", "Main Hero")]]]) {
    writeFileSync(m("war3map.w3u.json"), file([{ base: "Hpal", id: "H001", mods: [...mods, { field: "uhpm", type: "int", value: 777 }] }]));
    run("pack", dir, "-o", join(out, name), "--force-stale");
    console.log(`made ${join(out, name)}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
