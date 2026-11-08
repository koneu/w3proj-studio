// Pathing Editor: a tool group in the terrain editor (service "w3.terrain").
// Shows the generated pathing map over the ground and paints manual
// overrides per 32×32 cell. Overrides live in .w3proj/pathing.json (sparse,
// git-friendly) and are applied every time the pathing map is generated, so
// they survive terrain and doodad edits.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { TERRAIN_SERVICE, type TerrainEditorHandle, type TerrainService, type TerrainToolGroupInstance } from "../../extensions/services";
import { BLOCKED, NO_BUILD, NO_FLY, NO_WALK, NO_WATER } from "../../lib/terrain/pathing";
import { overridesForSize, pathingOverridesText, validPathingOverrides } from "../../lib/terrain/resize";
import { strokePoints } from "../../lib/terrain/strokepath";
import { h } from "../../workbench/dom";

const FILE = ".w3proj/pathing.json";
const FORMAT = "w3proj.pathing/1";

/** Flags set and cleared on one cell. */
interface Override { set: number; clear: number }
type Mode = "block" | "allow" | "reset";

/** The flags a "walk" override touches (BLOCKED marks non-water blockers). */
const WALK = NO_WALK | BLOCKED;

export function activate(w3: W3Api, ctx: ExtensionContext) {
  void w3.services.get<TerrainService>(TERRAIN_SERVICE).then((terrain) => {
    ctx.subscriptions.push(terrain.registerToolGroup({
      id: "pathing", title: "Pathing", order: 30, create: (ed) => pathingGroup(w3, ed),
      filterSavedPathing: async (cells, width, height) => {
        const text = await w3.workspace.readText(FILE).catch(() => null);
        if (text === null) return;
        // An unreadable file or one of another size: its overrides are ignored, as the editor does.
        let parsed: unknown = null;
        try { parsed = JSON.parse(text); } catch { /* said below */ }
        const j = overridesForSize(parsed, width, height);
        if (!j) {
          w3.window.showWarning(`${FILE} isn't a pathing overrides file for this ${width}×${height} pathing map; its overrides are ignored.`);
          return;
        }
        for (const [x, y, set, clear] of j.cells) if (x >= 0 && x < width && y >= 0 && y < height) cells[y * width + x] = (cells[y * width + x] | set) & ~clear;
      },
    }));
  });
}

function pathingGroup(w3: W3Api, ed: TerrainEditorHandle): TerrainToolGroupInstance {
  const t = ed.terrain;
  const W = (t.width - 1) * 4, H = (t.height - 1) * 4;
  /** Cell index → override. */
  let overrides = new Map<number, Override>();
  /** Set when overrides changed since loading or saving. */
  let unsaved = false;
  let fileExists = false;
  let mode: Mode = "block", radius = 2;
  const flags = { walk: true, fly: false, build: true };
  let active = false;
  /** Generated pathing without overrides; null when stale. */
  let raw: Uint8Array | null = null;
  /** Where destructables stand: not in the pathing map, since the game blocks them at runtime. */
  let standing: Uint8Array | null = null;
  let showStanding = true;
  let loading: Promise<void> | null = null;

  const load = w3.workspace.readText(FILE).then((text) => {
    const parsed = JSON.parse(text) as unknown;
    fileExists = true;
    const j = overridesForSize(parsed, W, H);
    if (!j) {
      w3.window.showWarning(validPathingOverrides(parsed)
        ? `${FILE} is for a ${parsed.width}×${parsed.height} pathing map, this map's is ${W}×${H}; its overrides are ignored.`
        : `${FILE} isn't a pathing overrides file; its overrides are ignored.`);
      return;
    }
    for (const [x, y, set, clear] of j.cells) if (x >= 0 && x < W && y >= 0 && y < H) overrides.set(y * W + x, { set, clear });
  }).catch(() => { /* no overrides yet */ });

  const apply = (cells: Uint8Array) => {
    for (const [i, o] of overrides) cells[i] = (cells[i] | o.set) & ~o.clear;
  };

  // ---- overlay ---------------------------------------------------------------------
  const colour = (f: number, manual: boolean): [number, number, number, number] => {
    const a = manual ? 200 : 110;
    if ((f & (NO_WALK | NO_FLY | NO_BUILD)) === (NO_WALK | NO_FLY | NO_BUILD) && f & BLOCKED) return [20, 20, 20, manual ? 200 : 150];
    if (f & NO_WALK) return f & NO_WATER ? [230, 50, 50, a] : [40, 70, 200, a];
    if (f & NO_FLY) return [60, 210, 80, a];
    if (f & NO_BUILD) return [240, 190, 40, manual ? 170 : 70];
    return manual ? [255, 255, 255, 60] : [0, 0, 0, 0];
  };
  const render = () => {
    if (!active || !raw) return;
    const cells = raw.slice();
    apply(cells);
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < cells.length; i++) rgba.set(showStanding && standing?.[i] && !overrides.has(i) ? [170, 70, 230, 150] : colour(cells[i], overrides.has(i)), i * 4);
    ed.setGroundOverlay(rgba, W, H);
    count.textContent = `${overrides.size.toLocaleString()} cells overridden`;
  };
  const refresh = () => {
    if (!active) return;
    loading ??= (async () => {
      await load;
      [raw, standing] = await Promise.all([ed.pathing({ filtered: false }).then((p) => p.cells), ed.objects.destructables()]);
      loading = null;
      render();
    })().catch((e) => { loading = null; w3.window.showError(`Pathing: ${(e as Error).message ?? e}`); });
  };

  // ---- painting ----------------------------------------------------------------------
  let stroke: Map<number, Override | undefined> | null = null;
  /** The stroke's last point. */
  let last: [number, number] | null = null;
  const touched =(cx: number, cy: number) => {
    const out: number[] = [];
    for (let y = cy - radius + 1; y < cy + radius; y++) {
      for (let x = cx - radius + 1; x < cx + radius; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H || Math.hypot(x - cx, y - cy) > radius - 0.5) continue;
        out.push(y * W + x);
      }
    }
    return out;
  };
  const mask = () => (flags.walk ? WALK : 0) | (flags.fly ? NO_FLY : 0) | (flags.build ? NO_BUILD : 0);
  const paint = (p: [number, number, number]) => {
    const m = mask();
    // Along the way from the last point: a quick drag must not leave gaps units walk through.
    for (const [x, y] of last ? strokePoints(last, [p[0], p[1]], 16) : [[p[0], p[1]]]) {
      const cx = Math.floor((x - t.offsetX) / 32), cy = Math.floor((y - t.offsetY) / 32);
      for (const i of touched(cx, cy)) {
        if (!stroke!.has(i)) stroke!.set(i, overrides.get(i) && { ...overrides.get(i)! });
        const o = { ...(overrides.get(i) ?? { set: 0, clear: 0 }) };
        if (mode === "block") { o.set |= m; o.clear &= ~m; }
        else if (mode === "allow") { o.clear |= m; o.set &= ~m; }
        else { o.set &= ~m; o.clear &= ~m; }
        if (o.set || o.clear) overrides.set(i, o); else overrides.delete(i);
      }
    }
    last = [p[0], p[1]];
    render();
  };
  const restore = (values: Map<number, Override | undefined>) => {
    for (const [i, o] of values) if (o) overrides.set(i, { ...o }); else overrides.delete(i);
    unsaved = true;
    render();
  };

  // ---- toolbar -----------------------------------------------------------------------
  const count = h("span.muted");
  const modeButtons = new Map<Mode, HTMLButtonElement>();
  const setMode = (m: Mode) => { mode = m; for (const [k, b] of modeButtons) b.classList.toggle("active", k === m); ed.focus(); };
  const modeButton = (m: Mode, label: string, title: string) => {
    const b = h("button", { title, onclick: () => setMode(m) }, label);
    modeButtons.set(m, b);
    return b;
  };
  const flag = (k: keyof typeof flags, label: string) => {
    const cb = h("input", { type: "checkbox", checked: flags[k], onchange: () => { flags[k] = cb.checked; ed.focus(); } });
    return h("label.terrain-place-opt", {}, cb, ` ${label}`);
  };
  const legend = (rgb: string, label: string) => h("span.pathing-legend", {}, h("span.pathing-swatch", { style: { background: rgb } }), label);
  const toolbar = h("div.pathing-bar", {},
    modeButton("block", "Block", "Paint: the chosen kinds of movement are blocked"),
    modeButton("allow", "Allow", "Paint: the chosen kinds are allowed even where terrain or doodads block them"),
    modeButton("reset", "Reset", "Paint: remove manual overrides (back to the generated pathing)"),
    h("span.terrain-tool-opt", {}, "for:", flag("walk", "Walk"), flag("fly", "Fly"), flag("build", "Build")),
    h("label.terrain-tool-opt", { title: "Brush radius in pathing cells (32 units)" }, "Size ",
      h("input", { type: "range", min: "1", max: "16", value: String(radius), oninput: (e: Event) => { radius = Number((e.target as HTMLInputElement).value); } })),
    h("button", { title: "Remove every manual override", onclick: () => {
      if (!overrides.size) return;
      const before = new Map([...overrides].map(([i, o]) => [i, { ...o }] as const));
      const cleared = new Map([...before.keys()].map((i) => [i, undefined] as const));
      restore(cleared);
      ed.pushEdit({ undo: () => restore(before), redo: () => restore(cleared), terrain: false, objects: false });
    } }, "Clear overrides"),
    count,
    h("span.pathing-legends", {},
      legend("rgb(230,50,50)", "unwalkable"), legend("rgb(40,70,200)", "deep water"), legend("rgb(60,210,80)", "unflyable"),
      legend("rgb(240,190,40)", "unbuildable"), legend("rgb(20,20,20)", "blocked"), legend("rgba(255,255,255,0.5)", "manual"),
      h("label.pathing-legend", { title: "Trees and other destructables. They aren't in the pathing map: the game blocks them at runtime, and frees the ground when one is destroyed." },
        h("input", { type: "checkbox", checked: true, onchange: (e: Event) => { showStanding = (e.target as HTMLInputElement).checked; render(); } }),
        h("span.pathing-swatch", { style: { background: "rgb(170,70,230)" } }), "destructables")),
  );
  setMode("block");

  return {
    toolbar,
    activate() { active = true; if (raw) render(); else refresh(); },
    deactivate() { active = false; ed.setGroundOverlay(null); ed.setBrush(null); },
    pointerDown(p) {
      if (!ed.editable || !p.ground) return false;
      stroke = new Map();
      last = null;
      paint(p.ground);
      return true;
    },
    pointerMove(p) {
      if (p.ground) ed.setBrush({ x: p.ground[0], y: p.ground[1], r: radius * 32, rgb: mode === "block" ? [255, 90, 90] : mode === "allow" ? [120, 255, 140] : [220, 220, 220] });
      if (p.down && stroke && p.ground) paint(p.ground);
    },
    pointerUp() {
      const before = stroke;
      stroke = null;
      if (!before?.size) return;
      const after = new Map([...before.keys()].map((i) => [i, overrides.get(i) && { ...overrides.get(i)! }] as const));
      unsaved = true;
      ed.pushEdit({ undo: () => restore(before), redo: () => restore(after), terrain: false, objects: false });
    },
    pointerLeave() { ed.setBrush(null); },
    changed(what) {
      // Terrain and doodads change the generated pathing underneath.
      if (what.terrain || what.objects) { raw = null; refresh(); }
    },
    filterPathing(cells, width, height) {
      if (width === W && height === H) apply(cells);
    },
    async save() {
      if (!unsaved || (!fileExists && !overrides.size)) return;
      const cells = [...overrides].sort((a, b) => a[0] - b[0]).map(([i, o]) => [i % W, Math.floor(i / W), o.set, o.clear]);
      const text = pathingOverridesText({ format: FORMAT, width: W, height: H, cells: cells as [number, number, number, number][] });
      await w3.workspace.writeText(FILE, text);
      fileExists = true;
      unsaved = false;
    },
    dispose() { ed.setGroundOverlay(null); },
  };
}
