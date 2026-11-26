// Inputs for tests/we-compare/units-v13.json: war3mapUnits.doo of version 8 (and 7) in maps the release CLI packs, into
// <repo>/target/units-v13/ (needs the smoketest maps of the main checkout).
//   node tests/fixtures/we-specs/make-units-v13.mjs
//   autumn-noskin.w3x  (2)AutumnLeaves_S2_v2.0 as a pre-Reforged editor saved it: w3i editorVersion 6059, war3map.doo and
//                      war3mapUnits.doo of version 8 without skin ids (the editor tells their layout by editorVersion: a
//                      Reforged one reads skin ids, and the stripped files crash it)
//   autumn-v7.w3x      the same with the units file of version 7 (subversion 9: no item tables, no hero attributes)
//   flat-8-9-skin.w3x  flat.w3x (one start location, nothing of version 1) with its units file of version 8 / subversion 9
//                      with skin ids (editorVersion 7003 as it was)
// Not made: flat.w3x with editorVersion 6059 and units without skin ids. Its war3map.doo is version 13; the editor opening
// such a map (melee-valid-tft-unit-v0 changed so, 2026-11-23) grew to 57 GB and was killed by the kernel.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chosenGamePath, mainCheckout } from "../../gamepath.mjs";
import { requireFresh } from "../../binfresh.mjs";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const main = mainCheckout();
const exe = process.platform === "win32" ? "w3proj.exe" : "w3proj";
const cli = existsSync(join(repo, "target", "release", exe)) ? join(repo, "target", "release", exe) : join(main, "target", "release", exe);
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const autumn = join(main, "smoketest_maps", "blizzard", "(2)AutumnLeaves_S2_v2.0.w3x");
const flat = join(repo, "tests", "fixtures", "we-specs", "flat.w3x");
// Built next to the result and swapped in at the end: a failed run leaves the previous maps in place.
const final = join(repo, "target", "units-v13");
const out = `${final}.new`;
const env = { ...process.env, W3PROJ_GAME: chosenGamePath() };

function run(...args) {
  const r = spawnSync(cli, args, { env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr || r.stdout}`);
}

const edit = (project, file, change) => {
  const path = join(project, "map", file);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  change(doc);
  writeFileSync(path, JSON.stringify(doc, null, 2));
};
const preReforged = (w3i) => { w3i.editorVersion = 6059; };
/** A placement file's layout: `version`, `subversion` (units), skin ids or not; the 3.0 fields go. */
const layout = (key, version, subversion, skins) => (doc) => {
  doc.version = version;
  if (subversion !== undefined) doc.subversion = subversion;
  if (version === 8) doc.skinIds = skins; else delete doc.skinIds;
  for (const e of doc[key]) {
    if (!skins) delete e.skinId;
    if (key === "units" && doc.subversion < 11) for (const k of ["itemTable", "strength", "agility", "intelligence"]) delete e[k];
    for (const k of ["preFlags", "trailer", "extras"]) delete e[k];
  }
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
run("unpack", autumn, join(out, "autumn"));
// An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
if (existsSync(join(join(out, "autumn"), "map", "terrain", "terrain.json"))) run("terrain", "merge", join(out, "autumn"));
run("unpack", flat, join(out, "flat"));
// An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
if (existsSync(join(join(out, "flat"), "map", "terrain", "terrain.json"))) run("terrain", "merge", join(out, "flat"));
const variants = {
  "autumn-noskin": ["autumn", (p) => { edit(p, "war3map.w3i.json", preReforged); edit(p, "war3map.doo.json", layout("doodads", 8, undefined, false)); edit(p, "war3mapUnits.doo.json", layout("units", 8, 11, false)); }],
  "autumn-v7": ["autumn", (p) => { edit(p, "war3map.w3i.json", preReforged); edit(p, "war3map.doo.json", layout("doodads", 8, undefined, false)); edit(p, "war3mapUnits.doo.json", layout("units", 7, 9, false)); }],
  "flat-8-9-skin": ["flat", (p) => { edit(p, "war3mapUnits.doo.json", layout("units", 8, 9, true)); }],
};
for (const [name, [base, change]] of Object.entries(variants)) {
  cpSync(join(out, base), join(out, name), { recursive: true });
  change(join(out, name));
  // The doodads' layout changed, not where they stand: the derived files are the map's own.
  run("pack", join(out, name), "-o", join(out, `${name}.w3x`), "--force-stale");
}
rmSync(final, { recursive: true, force: true });
renameSync(out, final);
console.log(`made ${final}/{${Object.keys(variants).join(",")}}.w3x`);
