// Where Studio puts the camp icons of a real map, for comparing with the editor's minimap (read-camp-icons-real.py):
//
//   node --experimental-strip-types predict-camp-icons.mjs <w3proj cli> <map> [<out.json>]
//
// Unpacks the map, takes the neutral hostile units (player 24) that aren't start locations or gold mines, groups them
// with the app's own `campGroups` (builtin/terrain-viewer/clusters.ts) and prints the icon creep of each camp (the
// first of its group, in the map's order) as minimap pixels: the minimap of we-drive's 1600x1000 display has the
// whole map (its border too) in the box (10,75)-(152,200), centred on (82, 126), longer side 134 px.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gamePath } from "../../gamepath.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { campGroups } = await import(join(here, "../../../app/src/builtin/terrain-viewer/clusters.ts"));
const [cli, map, out] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!map) { console.error("usage: predict-camp-icons.mjs <w3proj cli> <map> [out.json]"); process.exit(2); }
const scratch = mkdtempSync(join(tmpdir(), "predict-camps-"));
try {
  const r = spawnSync(cli, ["unpack", map, join(scratch, "p"), "--game", gamePath()], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`unpack: ${r.stderr}`);
  // An unpack writes the terrain and placed objects split (map/terrain/); this script reads them as single files.
  if (existsSync(join(scratch, "p", "map", "terrain", "terrain.json"))) {
    const m = spawnSync(cli, ["terrain", "merge", join(scratch, "p")], { encoding: "utf8" });
    if (m.status !== 0) throw new Error(`terrain merge: ${m.stderr}`);
  }
  const units = JSON.parse(readFileSync(join(scratch, "p", "map", "war3mapUnits.doo.json"), "utf8")).units;
  const head = readFileSync(join(scratch, "p", "map", "war3map.w3e.txt"), "utf8");
  const [w, h] = /corners (\d+) (\d+)/.exec(head).slice(1).map(Number);
  const [ox, oy] = /offset (-?[\d.]+) (-?[\d.]+)/.exec(head).slice(1).map(Number);
  const width = (w - 1) * 128, height = (h - 1) * 128;
  const scale = 134 / Math.max(width, height);
  const centre = [ox + width / 2, oy + height / 2];
  const hostile = units.filter((u) => u.player === 24 && u.id !== "sloc" && u.id !== "ngol");
  const camps = campGroups(hostile, (u) => [u.position[0], u.position[1]]);
  const icons = camps.map((g) => ({
    id: g[0].id, level: g[0].level, creeps: g.length, x: g[0].position[0], y: g[0].position[1],
    px: 82 + (g[0].position[0] - centre[0]) * scale, py: 126 - (g[0].position[1] - centre[1]) * scale,
  }));
  const result = { map, size: [width, height], scale, creeps: hostile.length, camps: icons };
  if (out) writeFileSync(out, JSON.stringify(result, null, 1));
  else console.log(JSON.stringify(result));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
