// Makes doodad-pick.w3m (the input map of tests/we-compare/doodad-pick-we.json) and that spec's World Editor steps:
//
//   node tests/fixtures/we-compare/make-doodad-pick-input.mjs <base .w3m> <w3proj cli> <out.w3m> [<spec.json>]
//
// The base is any map made by the newest editor (edge-last-step.w3m does): its doodads, units and cameras are replaced.
// Doodads of three types on flat ground: LTlt (a tree), LRrk (a rock, 4x4 pathing) and XOmr (a mushroom ring, 2x2
// pathing). Each VIEW is a camera object (distance 2000, the editor's angles; picked on the camera palette as
// we-drive's --look does) over a 4x4 grid of copies of one type, SPACING apart, on the positions the editor keeps (it
// snaps what it loads to its doodad grid: 64, and 32 more for the 2x2 one). A probe is a ground point at 0 units from a
// copy's centre or at an offset of OFFSETS from it towards east, west, north or south. The editor's steps for a
// probe: click bare ground (clears the selection), click the probe's pixel (TESTING.md "Projection for clicks"),
// Delete: a copy the click selected is gone from the saved war3map.doo.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addLookCameras, parseLook, resolveLook, terrainHead } from "../../../app/scripts/we-camera.mjs";
import { requireFresh } from "../../binfresh.mjs";

export const OFFSETS = [30, 45, 60, 80, 100, 130];
export const DIRS = { E: [1, 0], W: [-1, 0], N: [0, 1], S: [0, -1] };
export const DISTANCE = 2000, SPACING = 384, COLS = 4, ROWS = 4;
const TYPES = [{ id: "LTlt", shift: 0 }, { id: "LRrk", shift: 0 }, { id: "XOmr", shift: 32 }];

/** The ground point (x, y, 0) in the editor's view of a look (target x, y; rotation 90; TESTING.md "Projection for clicks"). */
export function project(look, [X, Y, Z = 0]) {
  const D = look.distance, r = (look.rotation * Math.PI) / 180, p = (57.2 * Math.PI) / 180;
  const tx = look.x - (298 / 3000) * D * Math.cos(r), ty = look.y - (298 / 3000) * D * Math.sin(r);
  const dist = (2738 / 3000) * D;
  const hx = Math.cos(r), hy = Math.sin(r);
  const eye = [tx - dist * Math.cos(p) * hx, ty - dist * Math.cos(p) * hy, dist * Math.sin(p)];
  const f = [Math.cos(p) * hx, Math.cos(p) * hy, -Math.sin(p)];
  const right = [hy, -hx, 0];
  const u = [right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]];
  const v = [X - eye[0], Y - eye[1], Z - eye[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const focal = 844 / 2 / Math.tan((41.06 / 2) * Math.PI / 180);
  const z = dot(v, f);
  return [Math.round(156 + 592 + (focal * dot(v, right)) / z), Math.round(79 + 422 - (focal * dot(v, u)) / z)];
}

/** Every probe of one type: [label, dx, dy], the centre first. */
export function probes() {
  const out = [["0", 0, 0]];
  for (const off of OFFSETS) for (const [d, [ux, uy]] of Object.entries(DIRS)) out.push([`${d}${off}`, ux * off, uy * off]);
  return out;
}

/**
 * The views: per type the probes in groups of COLS * ROWS, each group with its own target (x, y) and a copy per probe.
 * { type, id, x, y, copies: [{ label, x, y, dx, dy }] }; the copies' centres are where the editor keeps them.
 */
export function views() {
  const out = [];
  const all = probes();
  const targets = [[-2560, 1920], [0, 1920], [2560, 1920], [-2560, -1920], [0, -1920], [2560, -1920]];
  let t = 0;
  for (const type of TYPES) {
    for (let from = 0; from < all.length; from += COLS * ROWS) {
      const [x, y] = targets[t++];
      const copies = all.slice(from, from + COLS * ROWS).map(([label, dx, dy], i) => ({
        label, dx, dy,
        x: x + (i % COLS - (COLS - 1) / 2) * SPACING + type.shift,
        y: y + ((ROWS - 1) / 2 - Math.floor(i / COLS)) * SPACING + type.shift,
      }));
      out.push({ id: type.id, x, y, copies });
    }
  }
  return out;
}

/** The editor's steps: each view's camera from the palette (row = view), then the probes. */
export function buildSteps() {
  const steps = [];
  const bare = [220, 130];
  views().forEach((v, vi) => {
    const look = { x: v.x, y: v.y, distance: DISTANCE, rotation: 90 };
    steps.push(["--key", "m"], ["--sleep", "500"], ["--click", `1396,${177 + 13 * vi}`], ["--sleep", "300"], ["--click", "1476,119"], ["--sleep", "2500"], ["--key", "d"]);
    for (const c of v.copies) {
      steps.push(["--click", bare.join(",")], ["--click", project(look, [c.x + c.dx, c.y + c.dy]).join(",")], ["--key", "Delete"], ["--sleep", "150"]);
    }
    steps.push(["--key", "Escape"]);
  });
  return steps;
}

/** Studio's steps: the same ground points, clicked where its own camera "we:x,y,distance" shows them (its 3D view isn't the editor's: bugs.md; we-compare-ui.mjs). */
export function buildStudioSteps() {
  const steps = [
    { setting: ["script.generateOnSave", false] },
    { terrain: true },
    { eval: "const s = await w3.services.get('w3.terrain'); for (let i = 0; i < 60 && !s.placedObjects()?.doodads?.length; i++) await new Promise((r) => setTimeout(r, 500)); [...document.querySelectorAll('.terrain-tab')].find((b) => b.textContent === 'Select').click(); await new Promise((r) => setTimeout(r, 500));" },
  ];
  for (const v of views()) {
    // The camera is put again for each probe: after a deletion it has moved.
    const ui = [];
    for (const c of v.copies) ui.push(["view", `we:${v.x},${v.y},${DISTANCE}`], ["click", 220, 130], ["clickGround", c.x + c.dx, c.y + c.dy], ["key", "Delete"]);
    steps.push({ ui });
  }
  return steps;
}

/** The spec file: what the editor and Studio delete, compared as the doodads left (we-compare-w3e.mjs doodadPlaces). */
export function buildSpec() {
  return {
    name: "doodad-pick-we",
    description: "Which clicks pick a doodad. On bare flat ground, 0 and 30 to 130 units from the centre of a tree (LTlt), a rock (LRrk) and a rune (XOmr), towards east, west, north and south: the left button, then Delete; the doodad is gone from the save when the click picked it. The editor takes a click where the model stands on the screen (a rock 80 off, a tree's crown above its foot, 130 north of a rock), not where its pathing footprint is. Studio picked by the footprint's cylinder (radius 32 and 64) and now by the model's triangles, and by the footprint's as before (renderer.ts pickObject, meshpick.ts). Studio clicks where its own camera shows the ground point (its 3D view isn't the editor's: bugs.md). DIFFERS, expected: the clicks that still differ (see the report: tree S60 and S80, rock S60, rune S30, E45 and N80). Input and steps: tests/fixtures/we-compare/make-doodad-pick-input.mjs (six camera objects over 4x4 grids)",
    input: { map: "${REPO}/tests/fixtures/we-compare/doodad-pick.w3m" },
    we: { mode: "sd", steps: buildSteps() },
    studio: { settings: { "game.graphicsMode": "sd" }, steps: buildStudioSteps() },
    compare: [{ file: "war3map.doo", as: "doodad-places", expect: "differs" }],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, cli, out, specOut] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
  requireFresh(cli, "cli");
  if (!out) { console.error("usage: make-doodad-pick-input.mjs <base map> <w3proj cli> <out.w3m> [<spec.json>]"); process.exit(2); }
  const run = (...args) => {
    const r = spawnSync(cli, args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  };
  const scratch = mkdtempSync(join(tmpdir(), "we-compare-pick-"));
  try {
    const dir = join(scratch, "p");
    run("unpack", base, dir, "--game", "none");
    const map = join(dir, "map");
    const unitsFile = join(map, "war3mapUnits.doo.json");
    const units = JSON.parse(readFileSync(unitsFile, "utf8"));
    units.units = [units.units[0]];
    writeFileSync(unitsFile, JSON.stringify(units, null, 1));
    const dooFile = join(map, "war3map.doo.json");
    const doo = JSON.parse(readFileSync(dooFile, "utf8"));
    doo.doodads = [];
    for (const v of views()) {
      for (const c of v.copies) {
        doo.doodads.push({
          id: v.id, variation: 0, position: [c.x, c.y, 0], angle: (270 * Math.PI) / 180, scale: [1, 1, 1], skinId: v.id, preFlags: 4294967295,
          flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [doo.doodads.length, 0, 0], extras: [],
        });
      }
    }
    writeFileSync(dooFile, JSON.stringify(doo, null, 1));
    const head = terrainHead(readFileSync(join(map, "war3map.w3e.txt"), "utf8"));
    const camerasFile = join(map, "war3map.w3c.json");
    const cameras = JSON.parse(readFileSync(camerasFile, "utf8"));
    cameras.cameras = [];
    const looks = views().map((v) => resolveLook(parseLook(`${v.x},${v.y},${DISTANCE}`), head));
    writeFileSync(camerasFile, `${JSON.stringify(addLookCameras(cameras, looks), null, 2)}\n`);
    run("pack", dir, "-o", out, "--force-stale");
    if (specOut) writeFileSync(specOut, `${JSON.stringify(buildSpec(), null, 1)}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
