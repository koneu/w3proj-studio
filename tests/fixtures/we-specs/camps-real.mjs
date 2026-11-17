// Camp icons of real maps, the editor's against Studio's grouping (test.md "Camp grouping on other maps"):
//
//   node tests/fixtures/we-specs/camps-real.mjs <w3proj cli> <out folder> <map.w3x>...
//
// One we-drive process opens the maps one after the other, takes a picture of the whole display before and after a click
// on "Show Creep Camp Icon" (22,225) of each (the box is ticked or not as the run before left it: the pictures are
// told apart by their difference), read-camp-icons-real.py gives the blobs that changed on the minimap, and
// predict-camp-icons.mjs the icons Studio's `campGroups` puts (neutral hostile units except start locations and gold
// mines, the first creep of each camp). Prints, per map, the two counts and the predicted icons with no blob within
// 3 px, and the blobs with no predicted icon within 3 px. Local only (the World Editor).
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, out, ...maps] = process.argv.slice(2).map((p) => resolve(p));
if (!maps.length) { console.error("usage: camps-real.mjs <w3proj cli> <out folder> <map>..."); process.exit(2); }
mkdirSync(out, { recursive: true });
const steps = [];
maps.forEach((m, i) => {
  const n = String(i);
  steps.push("--map", m, "--wait-ready", "--close-modules", "--sleep", "1500", "--shot-screen", join(out, `${n}-a.png`),
    "--click", "22,225", "--sleep", "1200", "--shot-screen", join(out, `${n}-b.png`));
});
const drive = spawnSync("node", [join(here, "../../../app/scripts/we-drive.mjs"), "--mode", "sd", "--work", join(out, "we-drive"), ...steps, "--close"], { encoding: "utf8", maxBuffer: 1 << 26, timeout: 3000_000 });
writeFileSync(join(out, "we-drive.log"), `${drive.stdout}\n${drive.stderr}`);
if (drive.status !== 0) { console.error(`we-drive exited ${drive.status}: see ${join(out, "we-drive.log")}`); process.exit(2); }
maps.forEach((m, i) => {
  const n = String(i);
  const blobs = JSON.parse(spawnSync("python3", ["-I", join(here, "read-camp-icons-real.py"), join(out, `${n}-a.png`), join(out, `${n}-b.png`)], { encoding: "utf8" }).stdout);
  const pred = JSON.parse(spawnSync("node", ["--experimental-strip-types", join(here, "predict-camp-icons.mjs"), cli, m], { encoding: "utf8", maxBuffer: 1 << 26 }).stdout);
  const near = (a, b) => Math.hypot(a.x - b.px, a.y - b.py) <= 3;
  const missing = pred.camps.filter((c) => !blobs.some((b) => near(b, c)));
  const extra = blobs.filter((b) => !pred.camps.some((c) => near(b, c)));
  writeFileSync(join(out, `${n}.json`), JSON.stringify({ map: basename(m), blobs, pred }, null, 1));
  console.log(JSON.stringify({ map: basename(m), size: pred.size, creeps: pred.creeps, studioCamps: pred.camps.length, editorBlobs: blobs.length,
    studioOnly: missing.map((c) => [c.id, Math.round(c.px), Math.round(c.py), c.creeps]), editorOnly: extra.map((b) => [Math.round(b.x), Math.round(b.y), b.n]) }));
});
