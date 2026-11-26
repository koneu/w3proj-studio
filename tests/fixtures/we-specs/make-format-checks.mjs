// Makes the inputs of the format specs (tests/we-compare/format-checks.json) from flat.w3x (the World Editor's own new
// 64x64 Lordaeron Summer map, build 7003: doo 13, w3c 3, w3i 39):
//
//   node tests/fixtures/we-specs/make-format-checks.mjs <w3proj cli> <game folder> [fields|missing|hud|props]
//
// "fields" (format-fields.w3x): values the game's maps carry in fields whose meaning was a guess, so a World Editor
// save shows what it keeps, what it writes in the script, and what it changes:
//   cameras Alpha, Bravo, Charlie, Delta at (0, 0)..(768, 0) with the u32 after the name (`trailer`) 0, 1, 2, 7;
//   doodads (corner i, j at -4096 + 128 i, -4096 + 128 j), all trees LTlt unless said:
//     0  (24, 36) as the editor places one (the control)
//     1  (28, 36) trailer [1, 0.5 rad, 0]       2  (32, 36) trailer [2, 0, 0.25 rad]   (floats in the u32s)
//     3  (36, 36) preFlags 0                    4  (40, 36) preFlags 7
//     5  (24, 40) lamp post LOlp, extras: the block the campaign's lamp posts have (0, 0, 0xffff883b, 0, 0, 0, 0.0005, 0, 0.00001)
//     6  (28, 40) LOlp without extras           7  (32, 40) LTlt, trailer [100, 0, 0] (a placement id out of order)
//     8  (36, 40) LOlp, extras with 1 in the second dword and 4.0 in the fourth (0, 1, 0xff00ff00, 4.0, 0, 0, 0.0005, 0, 0.00001)
//     (the lamp posts 32 further east and north, where the editor's open puts a 2x2 doodad, and with life 255, as it
//     writes a doodad's: so only the fields above can differ)
//   war3map.w3e: water bit 15 (water-bits 2) on corners 30..34, 20..24 and both bits (3) on 40..42, 20..22.
// "missing" (format-missing.w3x): a doodad of the unknown id Xzz1 at (0, 0), a unit of the unknown id xzz1 at (256, 0)
// for Player 1, a tree LTlt at (-256, 0) and a footman hfoo at (512, 0) beside them (the controls).
// "hud" (format-hud.w3x): ten players (start locations 448 apart on y = -256) with the HUD skins of HUD below, so the
// editor's script shows which RACE_PREF_ each value is.
// "props" (format-doodad-props.w3x): a lamp post LOlp at (32, 32) (where the editor puts one placed at 0, 0) with one
// light of nine different values (0, 1, 0xff102030, 2.5, 3.5, 4.5, 0.125, 0.25, 0.375), and a tree LTlt at (-384, 0),
// for the Doodad Properties dialog (Roll, Pitch, the Lights tab).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2, 4).map((p) => (p ? resolve(p) : p));
const kind = process.argv[4] ?? "fields";
if (!game || !["fields", "missing", "hud", "props"].includes(kind)) { console.error("usage: make-format-checks.mjs <w3proj cli> <game folder> [fields|missing|hud|props]"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
/** A float's bits as the u32 the codec keeps. */
const bits = (f) => { const b = Buffer.alloc(4); b.writeFloatLE(f); return b.readUInt32LE(0); };
const X = (i) => -4096 + 128 * i;
/** "hud": a player each, Player 1 to 10, with these HUD skins (32759 is what the editor gives its own new maps). */
const HUD = [32759, 0, 1, 2, 4, 8, 16, 32, 64, 128];
const LAMP = [0, 0, 0xffff883b, 0, 0, 0, bits(0.0005), 0, bits(0.00001)];
const doodad = (k, id, x, y, more = {}) => ({
  id, variation: 0, position: [x, y, 0], angle: (270 * Math.PI) / 180, scale: [1, 1, 1], skinId: id,
  preFlags: 4294967295, flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [k, 0, 0], extras: [], ...more,
});
const camera = (name, x, trailer) => ({
  targetX: x, targetY: 0, zOffset: 0, rotation: 90, angleOfAttack: 304, distance: 1650, roll: 0, fieldOfView: 70, farZ: 5000, nearZ: 16,
  localPitch: 0, localYaw: 0, localRoll: 0, dofDistance: 0, dofScale: 0, posAbsoluteZ: 0, name, trailer,
});

const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  const dir = join(scratch, kind);
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
  if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
  const map = join(dir, "map");
  const edit = (file, f) => { const p = join(map, file); const doc = JSON.parse(readFileSync(p, "utf8")); f(doc); writeFileSync(p, JSON.stringify(doc, null, 1)); };
  if (kind === "fields") {
    edit("war3map.w3c.json", (doc) => { doc.cameras = [["Alpha", 0], ["Bravo", 1], ["Charlie", 2], ["Delta", 7]].map(([n, t], i) => camera(n, 256 * i, t)); });
    edit("war3map.doo.json", (doc) => {
      doc.doodads = [
        doodad(0, "LTlt", X(24), X(36)),
        doodad(1, "LTlt", X(28), X(36), { trailer: [1, bits(0.5), 0] }),
        doodad(2, "LTlt", X(32), X(36), { trailer: [2, 0, bits(0.25)] }),
        doodad(3, "LTlt", X(36), X(36), { preFlags: 0 }),
        doodad(4, "LTlt", X(40), X(36), { preFlags: 7 }),
        doodad(5, "LOlp", X(24) + 32, X(40) + 32, { life: 255, extras: [LAMP] }),
        doodad(6, "LOlp", X(28) + 32, X(40) + 32, { life: 255 }),
        doodad(100, "LTlt", X(32), X(40)),
        doodad(8, "LOlp", X(36) + 32, X(40) + 32, { life: 255, extras: [[0, 1, 0xff00ff00, bits(4), 0, 0, bits(0.0005), 0, bits(0.00001)]] }),
      ];
    });
    // Water bits: the text's [water-bits] grid, top row (y = 64) first.
    const w3e = join(map, "war3map.w3e.txt");
    const text = readFileSync(w3e, "utf8");
    const m = /\[water-bits\]\n((?:[0-9]+\n)+)/.exec(text);
    if (!m) throw new Error("flat.w3x: no [water-bits] grid");
    const grid = m[1].trim().split("\n").map((r) => r.split(""));
    const put = (i0, i1, j0, j1, v) => { for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) grid[64 - j][i] = String(Number(grid[64 - j][i]) | v); };
    put(30, 34, 20, 24, 2);
    put(40, 42, 20, 22, 3);
    writeFileSync(w3e, text.replace(m[1], grid.map((r) => r.join("")).join("\n") + "\n"));
  } else if (kind === "props") {
    const light = [0, 1, 0xff102030, ...[2.5, 3.5, 4.5, 0.125, 0.25, 0.375].map(bits)];
    edit("war3map.doo.json", (doc) => { doc.doodads = [doodad(0, "LOlp", 32, 32, { life: 255, extras: [light] }), doodad(1, "LTlt", -384, 0)]; });
  } else if (kind === "hud") {
    const players = HUD.map((hudSkin, id) => ({ id, start: [-2048 + 448 * id, -256], hudSkin }));
    edit("war3map.w3i.json", (doc) => {
      const template = doc.players[0];
      doc.players = players.map(({ id, start, hudSkin }) => ({ ...template, id, hudSkin, start, name: id ? "" : template.name }));
    });
    edit("war3mapUnits.doo.json", (doc) => {
      const template = doc.units[0];
      doc.units = players.map(({ id, start }) => ({ ...template, position: [...start, 0], player: id, editorId: id }));
    });
  } else {
    edit("war3map.doo.json", (doc) => { doc.doodads = [doodad(0, "Xzz1", 0, 0), doodad(1, "LTlt", -256, 0)]; });
    edit("war3mapUnits.doo.json", (doc) => {
      const template = doc.units[0];
      doc.units.push(...[["xzz1", 256], ["hfoo", 512]].map(([id, x], k) => ({
        ...template, id, skinId: id, position: [x, 0, 0], angle: (270 * Math.PI) / 180, player: 0, hp: -1, mana: -1, level: 1,
        targetAcquisition: -1, editorId: k + 1, trailer: [0, 0],
      })));
    });
  }
  if (kind === "fields" || kind === "hud") {
    // The script as Studio makes it from these files (flat.w3x's is the editor's, which Studio keeps): its specs
    // compare the editor's regenerated script with it.
    rmSync(join(map, "war3map.j"));
    run("rebuild", dir, "--only", "script", "--game", game);
  }
  run("pack", dir, "-o", join(here, `format-${kind === "props" ? "doodad-props" : kind}.w3x`), "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
