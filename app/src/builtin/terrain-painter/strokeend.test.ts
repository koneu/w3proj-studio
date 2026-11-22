// The end of a cliff stroke (openpoints bugs.md "A cliff stroke dragged in under about 400 ms loses its last column"):
// the painter stamps a held layer brush at most once per HEIGHT_TICK (40 ms), and pointerUp doesn't stamp the release
// point, so a drag whose last move came within 40 ms of the previous stamp loses the corners round that move. Whether
// the release point should be stamped is still open (the World Editor skips it too at 20 ms): the failing case is a
// `todo` test, reported but not failing the run, and stays one until that's decided. The control (the last move after
// the tick) passes and shows the harness reaches the painter.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, W3Api } from "../../extensions/api";
import type { TerrainEditorHandle, TerrainToolGroupInstance } from "../../extensions/services";
import type { Corner, Terrain } from "../../lib/terrain/w3e";
import { activate } from "./index";

/** Just enough of the DOM for the painter's toolbar (workbench/dom h()): elements that keep their attributes and
 *  click listeners, so a tool button can be found by its title and clicked. */
class FakeElement {
  className = ""; hidden = false; style = {}; value = ""; src = "";
  attrs = new Map<string, string>();
  listeners = new Map<string, ((e: unknown) => void)[]>();
  classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  setAttribute(k: string, v: string) { this.attrs.set(k, v); }
  addEventListener(k: string, f: (e: unknown) => void) { this.listeners.set(k, [...(this.listeners.get(k) ?? []), f]); }
  append() {} replaceChildren() {} focus() {}
}
const elements: FakeElement[] = [];
const g = globalThis as Record<string, unknown>;
g.HTMLTextAreaElement ??= class {};
g.HTMLInputElement ??= class {};
g.HTMLSelectElement ??= class {};
g.document ??= { createElement: () => { const e = new FakeElement(); elements.push(e); return e; }, createTextNode: () => ({}), createElementNS: () => new FakeElement() };

let clock = 0;
Object.defineProperty(performance, "now", { value: () => clock, configurable: true, writable: true });

/** 12 x 5 corners of flat ground at cliff level 2 (Lordaeron Summer, one cliff type). */
function flat(): Terrain {
  const corners: Corner[] = [];
  for (let i = 0; i < 12 * 5; i++) {
    corners.push({ layer: 2, ramp: false, height: 0, rawHeight: 0x2000, hasWater: false, water: -2137.6, texture: 0, variation: 0, cliffVariation: 0, cliffTexture: 0, blight: false, boundary: false, rawWater: 0, texExtra: 0 } as Corner);
  }
  return { version: 11, tileset: "L", customTilesets: true, customTilesetsRaw: 1, groundTiles: ["Ldrt"], cliffTiles: ["CLdi"], width: 12, height: 5, offsetX: 0, offsetY: 0, corners, trailer: new Uint8Array(0) };
}

/** The painter on `terrain` with the +1 cliff tool picked; `commits` counts the strokes committed. */
async function painter(terrain: Terrain) {
  let create: ((ed: TerrainEditorHandle) => TerrainToolGroupInstance) | null = null;
  const none = { dispose() {} };
  const w3 = {
    services: { get: async () => ({ registerToolGroup: (g: { create: typeof create }) => { create = g.create; return none; } }) },
    settings: { get: (_k: string, d?: unknown) => d },
    workspace: { project: () => null, readText: async () => { throw new Error("no file"); }, filesReady: async () => {}, files: () => [], onDidSave: () => none },
    game: { readText: async () => "" },
    window: { showWarning: async () => undefined },
    // The Terrain Settings tab and its command (not used here).
    editors: { registerProvider: () => none, open: async () => {} },
    commands: { register: () => none, execute: async () => {} },
  } as unknown as W3Api;
  activate(w3, { extensionId: "w3.terrainPainter", extensionPath: null, subscriptions: [] } as ExtensionContext);
  await new Promise((r) => setTimeout(r, 0));
  const commits: unknown[] = [];
  const known: Record<string, unknown> = {
    terrain, editable: true,
    defaultCliffType: () => 0, claimDefaultCliffType: () => null, cliffGroundTiles: () => [],
    commitTerrain: (c: unknown) => { commits.push(c); },
  };
  const ed = new Proxy(known, { get: (t, k: string) => (k in t ? t[k] : async () => []) }) as unknown as TerrainEditorHandle;
  elements.length = 0;
  const p = create!(ed);
  const button = elements.find((e) => e.attrs.get("title")?.startsWith("+1:"));
  for (const f of button!.listeners.get("click") ?? []) f({});
  return { p, commits };
}

/** A drag along the row y = 256 from x = 128 (corner 1): a move to 640 (corner 5) at 50 ms, the last to 1152 (corner 9)
 *  at `last` ms, the release 10 ms after it. The corners of row 2 at cliff level 3 afterwards. */
async function drag(last: number): Promise<number[]> {
  const terrain = flat();
  const { p, commits } = await painter(terrain);
  const at = (x: number, down = true) => ({ ground: [x, 256, 0], event: { clientX: x, clientY: 256 }, down } as never);
  clock = 0;
  p.pointerDown!(at(128));
  clock = 50; p.pointerMove!(at(640));
  clock = last; p.pointerMove!(at(1152));
  clock = last + 10; p.pointerUp!(at(1152, false));
  assert.equal(commits.length, 1, "one stroke committed");
  return terrain.corners.slice(2 * 12, 3 * 12).map((c, i) => (c.layer === 3 ? i : -1)).filter((i) => i >= 0);
}

test("control: a drag whose last move comes after the tick raises the corners round it", async () => {
  const raised = await drag(100);
  assert.ok(raised.includes(1) && raised.includes(5) && raised.includes(9), `raised ${raised}`);
});

test("a drag whose last move comes within 40 ms of the last stamp keeps its last column", async () => {
  const raised = await drag(60);
  assert.ok(raised.includes(9), `raised ${raised}: corner 9, round the last move, isn't`);
});
