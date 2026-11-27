// Makes floating-place.w3x (the input map of tests/we-compare/floating-place.json) and that spec:
//
//   node tests/fixtures/we-compare/make-floating-place-input.mjs <w3proj cli> <out.w3x> [<spec.json>]
//
// test.md "Placing or pasting a floating doodad (lily pad) … put it on the water as the WE does". From flat.w3x (the
// editor's own new 64x64 Lordaeron Summer map, ground 0): a lake on the corners i 24..40, j 32..42 (x -1024..1024,
// y 0..1280), ground 0, water 38.4 above it, the water flag; south of it dry ground. One lily pad (LPfp, flags 2) in
// the lake to copy and to pick into the palette, seen by a camera object at 0, 200 from 2000 (the first of the camera
// palette, as we-drive's --look). The editor's steps: the camera; the pad box-selected, Ctrl+C, Ctrl+V and a click on
// the water, Ctrl+V and a click on the dry ground; the pad box-selected again, Ctrl+P (Select In Tool Palette: the
// palette's doodad becomes the lily pad), a click on the water and one on the dry ground. Studio: the same world
// points, clicked where its own camera shows them (its 3D view isn't the editor's: doodad-pick-we).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addLookCameras, parseLook, resolveLook, terrainHead } from "../../../app/scripts/we-camera.mjs";
import { requireFresh } from "../../binfresh.mjs";
import { project } from "./make-doodad-pick-input.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const LOOK = { x: 0, y: 200, distance: 2000, rotation: 90 };
export const WATER = 38.4;
/** The lake's corners (inclusive). */
const LAKE = { i0: 24, i1: 40, j0: 32, j1: 42 };
export const PAD = [-400.3, 500.6];
/** Where the copies and the placed pads go: [label, x, y]. */
export const PASTE_WET = [300.2, 700.4], PASTE_DRY = [300.7, -300.3], PLACE_WET = [-200.6, 900.2], PLACE_DRY = [-300.4, -500.5];
/** A bare spot for a click that clears the selection. */
const BARE = [700, -100];

const px = (p) => project(LOOK, p).join(",");
/** The editor's box round the pad: from its upper left to its lower right, away from the model. */
const box = () => `${px([PAD[0] - 90, PAD[1] + 70])}:${px([PAD[0] + 90, PAD[1] - 70])}@1200`;

export function buildSteps() {
  const s = [["--key", "m"], ["--sleep", "500"], ["--click", "1396,177"], ["--sleep", "300"], ["--click", "1476,119"], ["--sleep", "2500"], ["--click", px(BARE)], ["--sleep", "500"], ["--key", "d"], ["--sleep", "300"]];
  const select = () => s.push(["--click", px(BARE)], ["--sleep", "300"], ["--move", px([PAD[0] - 90, PAD[1] + 70])], ["--sleep", "400"], ["--drag", box()], ["--sleep", "700"]);
  const clickAt = (p) => s.push(["--move", px(p)], ["--sleep", "400"], ["--click", px(p)], ["--sleep", "500"]);
  select();
  s.push(["--key", "ctrl+c"], ["--sleep", "300"], ["--key", "ctrl+v"], ["--sleep", "300"]);
  clickAt(PASTE_WET);
  s.push(["--key", "ctrl+v"], ["--sleep", "300"]);
  clickAt(PASTE_DRY);
  s.push(["--key", "Escape"], ["--sleep", "300"], ["--key", "Escape"], ["--sleep", "300"]);
  select();
  s.push(["--key", "ctrl+p"], ["--sleep", "700"]);
  clickAt(PLACE_WET);
  clickAt(PLACE_DRY);
  s.push(["--key", "Escape"], ["--sleep", "300"], ["--key", "Escape"], ["--sleep", "300"]);
  return s;
}

export function buildStudioSteps() {
  const wait = "const s = await w3.services.get('w3.terrain'); for (let i = 0; i < 60 && !s.placedObjects()?.doodads?.length; i++) await new Promise((r) => setTimeout(r, 500)); [...document.querySelectorAll('.terrain-tab')].find((b) => b.textContent === 'Select').click(); await new Promise((r) => setTimeout(r, 500));";
  const view = ["view", `we:${LOOK.x},${LOOK.y},${LOOK.distance}`];
  const escape = "const c = document.querySelector('.model-stage canvas'); c.focus(); for (const type of ['keydown', 'keyup']) c.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', bubbles: true })); await new Promise((r) => setTimeout(r, 300));";
  return [
    { setting: ["script.generateOnSave", false] },
    { terrain: true },
    { eval: wait },
    { ui: [view, ["clickGround", ...BARE], ["clickGround", ...PAD]] },
    { eval: "const c = document.querySelector('.model-stage canvas'); c.focus(); await w3.commands.execute('w3.terrain.copy'); await w3.commands.execute('w3.terrain.paste'); await new Promise((r) => setTimeout(r, 300));" },
    { ui: [["clickGround", ...PASTE_WET]] },
    { eval: "await w3.commands.execute('w3.terrain.paste'); await new Promise((r) => setTimeout(r, 300));" },
    { ui: [["clickGround", ...PASTE_DRY]] },
    { eval: escape },
    { eval: "[...document.querySelectorAll('.terrain-tab')].find((b) => b.textContent === 'Select').click(); await new Promise((r) => setTimeout(r, 500));" },
    { ui: [view, ["clickGround", ...BARE], ["clickGround", ...PAD]] },
    { eval: "await w3.commands.execute('w3.terrain.selectInPalette'); await new Promise((r) => setTimeout(r, 700));" },
    { ui: [["clickGround", ...PLACE_WET], ["clickGround", ...PLACE_DRY]] },
    { eval: escape },
  ];
}

export function buildSpec() {
  return {
    name: "floating-place",
    description: "test.md 'Placing or pasting a floating doodad (lily pad)'. Input and steps: tests/fixtures/we-compare/make-floating-place-input.mjs (a lake, ground 0 and water 38.4 with the water flag, on corners 24..40 x 32..42; a lily pad in it; the camera 0, 200 from 2000). The pad copied and pasted on the water and on dry ground, then picked into the palette (Ctrl+P, Studio's Select In Tool Palette) and placed by clicks on the water and on dry ground. Studio clicks the same world points where its own camera shows them, so x and y may differ by a few units; z and flags are compared exactly.",
    input: { map: "${REPO}/tests/fixtures/we-compare/floating-place.w3x" },
    we: { mode: "sd", saveAccept: ["Warning"], steps: buildSteps() },
    studio: { steps: buildStudioSteps() },
    compare: [{
      file: "war3map.doo", as: "parsed",
      ignore: ["version", "doodads[].preFlags", "doodads[].editorId", "doodads[].trailer", "doodads[].extras", "doodads[].angle", "doodads[].scale", "doodads[].variation"],
      tolerance: { "doodads[].position[0]": 16, "doodads[].position[1]": 16, default: 0.01 },
    }],
    limit: 40,
  };
}

/** A section's rows as the text keeps them: the top row first. */
const rows = (n, f, sep = "") => Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, i) => f(i, n - 1 - r)).join(sep));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cli, out, specOut] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
  if (!out) { console.error("usage: make-floating-place-input.mjs <w3proj cli> <out.w3x> [<spec.json>]"); process.exit(2); }
  requireFresh(cli, "cli");
  const run = (...args) => {
    const r = spawnSync(cli, args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  };
  const scratch = mkdtempSync(join(tmpdir(), "we-compare-floating-"));
  try {
    const dir = join(scratch, "p");
    run("unpack", join(here, "..", "we-specs", "flat.w3x"), dir, "--game", "none");
    // An unpack writes the terrain and placed objects split (map/terrain/); this script edits them as single files.
    if (existsSync(join(dir, "map", "terrain", "terrain.json"))) run("terrain", "merge", dir);
    const map = join(dir, "map");
    const w3e = join(map, "war3map.w3e.txt");
    const text = readFileSync(w3e, "utf8");
    const head = terrainHead(text);
    const n = head.width;
    const wet = (i, j) => i >= LAKE.i0 && i <= LAKE.i1 && j >= LAKE.j0 && j <= LAKE.j1;
    // The text's water is the stored level less 0x2000: (world level + 89.6) * 4; its flags the high nibble (4: water).
    const sections = {
      water: rows(n, (i, j) => String(wet(i, j) ? Math.round((WATER + 89.6) * 4) : 0), " "),
      flags: rows(n, (i, j) => (wet(i, j) ? "4" : "0")),
    };
    const lines = text.split("\n"), outLines = [];
    for (let k = 0; k < lines.length; k++) {
      const m = /^\[([a-z-]+)\]/.exec(lines[k]);
      if (m && m[1] in sections) {
        outLines.push(`[${m[1]}]`, ...sections[m[1]]);
        while (k + 1 < lines.length && lines[k + 1] !== "" && !lines[k + 1].startsWith("[")) k++;
        continue;
      }
      outLines.push(lines[k]);
    }
    writeFileSync(w3e, outLines.join("\n"));
    const dooFile = join(map, "war3map.doo.json");
    const doo = JSON.parse(readFileSync(dooFile, "utf8"));
    doo.doodads = [{
      id: "LPfp", variation: 0, position: [PAD[0], PAD[1], WATER], angle: (270 * Math.PI) / 180, scale: [1, 1, 1], skinId: "LPfp", preFlags: 4294967295,
      flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [0, 0, 0], extras: [],
    }];
    writeFileSync(dooFile, JSON.stringify(doo, null, 1));
    const camerasFile = join(map, "war3map.w3c.json");
    const cameras = JSON.parse(readFileSync(camerasFile, "utf8"));
    cameras.cameras = [];
    writeFileSync(camerasFile, `${JSON.stringify(addLookCameras(cameras, [resolveLook(parseLook(`${LOOK.x},${LOOK.y},${LOOK.distance}`), head)]), null, 2)}\n`);
    run("pack", "--keep-objects", dir, "-o", out, "--force-stale");
    if (specOut) writeFileSync(specOut, `${JSON.stringify(buildSpec(), null, 1)}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
