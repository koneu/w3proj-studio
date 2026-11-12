// Pathing Editor: a tool group in the terrain editor (service "w3.terrain").
// Shows the generated pathing map over the ground and paints manual
// overrides per 32×32 cell. Overrides live in .w3proj/pathing.json (sparse,
// git-friendly) and are applied every time the pathing map is generated, so
// they survive terrain and doodad edits.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { TERRAIN_SERVICE, type TerrainEditorHandle, type TerrainService, type TerrainToolGroupInstance } from "../../extensions/services";
import { BLOCKED, NO_BUILD, NO_FLY, NO_WALK, NO_WATER } from "../../lib/terrain/pathing";
import { overridesForSize, pathingOverridesText } from "../../lib/terrain/resize";
import { backupPath, importWpmDifferences, mayPaint, readPathingFile, replaceQuestion, type PathingFile } from "./file";
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
  /** Counts the changes: one made while a save writes stays unsaved. */
  let changes = 0;
  let fileExists = false;
  /** The file as read: its fields other than the overrides are saved along with them. */
  let readFile: unknown = null;
  /** The file as found when the editor opened; null until it has been looked at. */
  let found: PathingFile | null = null;
  /** The user chose to replace a file that can't be used (unreadable, another size): a save backs it up first. */
  let replacing = false;
  /** A question about replacing it is on screen. */
  let asking = false;
  let mode: Mode = "block", radius = 2;
  const flags = { walk: true, fly: false, build: true };
  let active = false;
  /** Generated pathing without overrides; null when stale. */
  let raw: Uint8Array | null = null;
  /** Where destructables stand: not in the pathing map, since the game blocks them at runtime. */
  let standing: Uint8Array | null = null;
  let showStanding = true;
  let loading: Promise<void> | null = null;

  // A file that isn't there is started by the first stroke; one that is there and can't be used is said once
  // here, and kept: painting is off until the user chooses to replace it (see ask).
  const exists = (p: string) => w3.backend.invoke<boolean>("fs_exists", { path: w3.workspace.resolve(p) });
  const load = readPathingFile(() => exists(FILE), () => w3.workspace.readText(FILE), W, H).then((f) => {
    found = f;
    if (f.state === "absent") return;
    fileExists = true;
    if (f.state === "unreadable") {
      void w3.window.showWarning(`${FILE} is there, but ${f.why}: its overrides are ignored, and painting pathing is off so that it isn't written over.`);
      return;
    }
    readFile = f.file;
    if (f.state === "otherSize") {
      void w3.window.showWarning(`${FILE} is for a ${f.file.width}×${f.file.height} pathing map, this map's is ${W}×${H}: its overrides are ignored. Painting asks before replacing them.`);
      return;
    }
    for (const [x, y, set, clear] of f.file.cells) if (x >= 0 && x < W && y >= 0 && y < H) overrides.set(y * W + x, { set, clear });
  }).finally(() => { if (active) render(); });
  /** Asks whether to replace a file painting can't use; painting starts with the next stroke once the user agreed. */
  const ask = async () => {
    const q = replaceQuestion(found, FILE, W, H);
    if (!q || asking) return;
    asking = true;
    try {
      if ((await w3.window.showWarning(q.message, ...q.actions)) === q.actions[0]) { replacing = true; render(); }
    } finally {
      asking = false;
    }
  };

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
    notice.textContent = !found || mayPaint(found, replacing) ? (replacing ? `A save replaces ${FILE} (the old one is kept as a backup).` : "")
      : found.state === "unreadable" ? `${FILE} can't be read: painting is off.` : `${FILE} is for another map size: painting asks first.`;
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
    changes++;
    render();
  };

  /** Turns the differences between the saved wpm and the derived pathing into overrides: one undo step. The wpm isn't written. */
  const importDifferences = async () => {
    if (!ed.editable) return;
    if (!mayPaint(found, replacing)) { await ask(); if (!mayPaint(found, replacing)) return; }
    const at = changes;
    let r: ReturnType<typeof importWpmDifferences>;
    try {
      const [saved, derived] = await Promise.all([w3.workspace.readBytes("map/war3map.wpm"), ed.pathing({ filtered: false })]);
      r = derived.width === W && derived.height === H ? importWpmDifferences(saved, derived.cells, W, H, overrides) : { error: "The pathing map changed size: try again." };
    } catch (e) {
      void w3.window.showError(`Import from war3map.wpm: ${(e as Error).message ?? e}`);
      return;
    }
    if (changes !== at) { void w3.window.showWarning("The overrides changed while war3map.wpm was read: nothing imported, try again."); return; }
    if ("error" in r) { void w3.window.showWarning(r.error); return; }
    if (!r.changed.size) { void w3.window.showInfo(`No new differences: war3map.wpm differs from the derived pathing in ${r.differing.toLocaleString()} cells, all already overrides.`); return; }
    const before = new Map([...r.changed.keys()].map((i) => [i, overrides.get(i) && { ...overrides.get(i)! }] as const));
    const after = new Map([...r.changed].map(([i, o]) => [i, { ...o }] as const));
    restore(after);
    ed.pushEdit({ undo: () => restore(before), redo: () => restore(after), terrain: false, objects: false });
    void w3.window.showInfo(`Imported ${r.changed.size.toLocaleString()} cells from war3map.wpm as overrides.`);
  };

  // ---- toolbar -----------------------------------------------------------------------
  const count = h("span.muted");
  const notice = h("span.pathing-notice", { role: "status" });
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
    h("button", { title: "Make every difference between the saved war3map.wpm and the pathing derived from terrain and doodads a manual override (for a wpm edited elsewhere)", onclick: () => void importDifferences() }, "Import differences from war3map.wpm"),
    count,
    notice,
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
      // The file isn't known yet, or can't be used: no stroke (no change, no undo step); asked about instead.
      if (!mayPaint(found, replacing)) { void ask(); return true; }
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
      changes++;
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
      // Never over a file that couldn't be used, unless the user chose to replace it: then it is backed up first.
      if (!mayPaint(found, replacing)) throw new Error(`${FILE} wasn't written: it couldn't be read as this map's pathing overrides.`);
      const at = changes;
      const cells = [...overrides].sort((a, b) => a[0] - b[0]).map(([i, o]) => [i % W, Math.floor(i / W), o.set, o.clear]);
      const own = found?.state === "ok" && readFile && typeof readFile === "object" && !Array.isArray(readFile) ? readFile : {};
      const file = { ...own, format: FORMAT, width: W, height: H, cells: cells as [number, number, number, number][] };
      if (replacing && found?.state !== "ok" && found?.state !== "absent" && (await exists(FILE))) {
        const backup = await backupPath(FILE, exists);
        await w3.workspace.copy(FILE, backup);
        w3.window.showInfo(`The ${FILE} that couldn't be used is kept as ${backup}.`);
      }
      await w3.workspace.writeText(FILE, pathingOverridesText(file));
      fileExists = true;
      readFile = file;
      found = { state: "ok", file };
      replacing = false;
      if (changes === at) unsaved = false;
    },
    dispose() { ed.setGroundOverlay(null); },
  };
}
