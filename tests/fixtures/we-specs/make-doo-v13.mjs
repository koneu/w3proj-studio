// Inputs for tests/we-compare/doo-v13.json: war3map.doo of version 7, 8 and 12 in maps the release CLI packs, into
// <repo>/target/doo-v13/ (needs the smoketest maps of the main checkout).
//   node tests/fixtures/we-specs/make-doo-v13.mjs
//   autumn-doo-v7.w3x   (2)AutumnLeaves_S2_v2.0 as a pre-Reforged editor saved it (w3i editorVersion 6059, the units file
//                       version 8 without skin ids, as make-units-v13.mjs autumn-noskin) with war3map.doo of version 7: no
//                       item table, no item sets, no skin ids
//   autumn-doo-v12.w3x  AutumnLeaves with war3map.doo of version 12: every doodad its skin id, preFlags 0xFFFFFFFF,
//                       trailer [0, 0], no extras (the units file as it was, version 8 with skin ids)
//   autumn-drops.w3x    AutumnLeaves (doo version 8 with skin ids) with item drops on three destructables: an item set
//                       of two items on the first barricade (LTba), one of one item on the second, an item table index
//                       (-1 stays) and odd creation numbers kept, flags 0, 1, 4 and 8 on four doodads
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
// Built next to the result and swapped in at the end: a failed run leaves the previous maps in place.
const final = join(repo, "target", "doo-v13");
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
const unitsNoSkin = (doc) => {
  doc.skinIds = false;
  for (const u of doc.units) delete u.skinId;
};
const dooV7 = (doc) => {
  doc.version = 7;
  delete doc.skinIds;
  for (const d of doc.doodads) for (const k of ["skinId", "itemTable", "itemSets", "preFlags", "trailer", "extras"]) delete d[k];
};
const dooV12 = (doc) => {
  doc.version = 12;
  delete doc.skinIds;
  for (const d of doc.doodads) Object.assign(d, { preFlags: 0xffffffff, trailer: [0, 0], extras: [] });
};
const drops = (doc) => {
  const barricades = doc.doodads.filter((d) => d.id === "LTba");
  if (barricades.length < 2) throw new Error("AutumnLeaves has fewer than two LTba");
  barricades[0].itemSets = [[{ id: "phea", chance: 60 }, { id: "pman", chance: 40 }]];
  barricades[1].itemSets = [[{ id: "ratc", chance: 100 }]];
  const plain = doc.doodads.filter((d) => d.id === "LPrs");
  [0, 1, 4, 8].forEach((flags, i) => { plain[i].flags = flags; });
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
run("unpack", autumn, join(out, "autumn"));
const variants = {
  "autumn-doo-v7": (p) => { edit(p, "war3map.w3i.json", preReforged); edit(p, "war3mapUnits.doo.json", unitsNoSkin); edit(p, "war3map.doo.json", dooV7); },
  "autumn-doo-v12": (p) => { edit(p, "war3map.doo.json", dooV12); },
  "autumn-drops": (p) => { edit(p, "war3map.doo.json", drops); },
};
for (const [name, change] of Object.entries(variants)) {
  cpSync(join(out, "autumn"), join(out, name), { recursive: true });
  change(join(out, name));
  // The doodads' layout changed, not where they stand: the derived files are the map's own.
  run("pack", join(out, name), "-o", join(out, `${name}.w3x`), "--force-stale");
}
rmSync(final, { recursive: true, force: true });
renameSync(out, final);
console.log(`made ${final}/{${Object.keys(variants).join(",")}}.w3x`);
