// Region Editor: regions (war3map.w3r, "rects" in triggers) as a tool group
// of the terrain editor (service "w3.terrain"). Drag on empty ground to
// create one, inside one to move it, at an edge or corner to resize it.
// The file goes through the format engine ("regions" definition).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { TERRAIN_SERVICE, type TerrainEditorHandle, type TerrainService, type TerrainToolGroupInstance } from "../../extensions/services";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { h } from "../../workbench/dom";

const FILE = "map/war3map.w3r";
/** Regions snap to this grid (World Editor default). */
const GRID = 32;

interface Region {
  left: number;
  bottom: number;
  right: number;
  top: number;
  name: string;
  index: number;
  weather: string;
  sound: string;
  color: { blue: number; green: number; red: number; alpha: number };
  trailer?: number[];
}
interface RegionsDoc { format?: string; version: number; regions: Region[] }

/** Colours for new regions (cycled). */
const PALETTE: [number, number, number][] = [[255, 128, 128], [128, 192, 255], [128, 255, 128], [255, 224, 128], [224, 128, 255], [128, 255, 224]];
const NO_WEATHER = "0x00000000";

export function activate(w3: W3Api, ctx: ExtensionContext) {
  void w3.services.get<TerrainService>(TERRAIN_SERVICE).then((s) => {
    ctx.subscriptions.push(s.registerToolGroup({ id: "regions", title: "Regions", order: 25, create: (ed) => regionEditor(w3, ed) }));
  });
}

/** Weather effects: id → display name. */
let weathers: Promise<[string, string][]> | null = null;
const weatherList = (w3: W3Api) => (weathers ??= (async () => {
  const rows = parseSlk(await w3.game.readText("TerrainArt\\Weather.slk"));
  const strings = new Map<string, string>();
  for (const sec of parseIni(await w3.game.readText("UI\\WorldEditStrings.txt").catch(() => "")).values()) {
    for (const [k, v] of sec) strings.set(k.toUpperCase(), v);
  }
  return rows.filter((r) => r.effectID).map((r) => [r.effectID, (strings.get((r.name ?? "").toUpperCase()) ?? r.name ?? r.effectID).replace(/&/g, "")] as [string, string]);
})().catch(() => []));

function regionEditor(w3: W3Api, ed: TerrainEditorHandle): TerrainToolGroupInstance {
  const t = ed.terrain;
  const W = (t.width - 1) * 4, H = (t.height - 1) * 4;
  let doc: RegionsDoc = { version: 5, regions: [] };
  /** Kept as map/war3map.w3r.json (else the raw file, through the backend). */
  let asJson = true, unsaved = false, active = false;
  let selected: Region | null = null;

  const load = (async () => {
    const files = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
    const root = w3.workspace.project()?.root;
    if (files.has(`${FILE}.json`)) doc = JSON.parse(await w3.workspace.readText(`${FILE}.json`));
    else if (files.has(FILE) && root) { doc = JSON.parse(await w3.backend.invoke<string>("codec_decode", { root, path: FILE })); asJson = false; }
    doc.regions ??= [];
  })().catch((e) => w3.window.showError(`Regions: ${(e as Error).message ?? e}`));

  // ---- overlay -----------------------------------------------------------------------
  const cellRange = (r: Region) => [
    Math.max(0, Math.round((r.left - t.offsetX) / GRID)), Math.min(W, Math.round((r.right - t.offsetX) / GRID)),
    Math.max(0, Math.round((r.bottom - t.offsetY) / GRID)), Math.min(H, Math.round((r.top - t.offsetY) / GRID)),
  ];
  /** A region being drawn (not yet in the list). */
  let draft: Region | null = null;
  const render = () => {
    if (!active) return;
    const rgba = new Uint8Array(W * H * 4);
    // Larger regions first, so small ones stay visible on top.
    const list = [...doc.regions, ...(draft ? [draft] : [])].sort((a, b) => (b.right - b.left) * (b.top - b.bottom) - (a.right - a.left) * (a.top - a.bottom));
    for (const r of list) {
      const [x0, x1, y0, y1] = cellRange(r);
      const sel = r === selected || r === draft;
      const c = r.color;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const edge = x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1;
          const o = (y * W + x) * 4;
          if (edge) rgba.set(sel ? [255, 255, 255, 240] : [c.red, c.green, c.blue, 230], o);
          else rgba.set([c.red, c.green, c.blue, sel ? 110 : 60], o);
        }
      }
    }
    ed.setGroundOverlay(rgba, W, H);
    count.textContent = `${doc.regions.length} regions`;
  };

  // ---- undo --------------------------------------------------------------------------
  const commit = (before: Region[], after: Region[], select: Region | null) => {
    const set = (v: Region[], sel: Region | null) => { doc.regions = v; selected = sel; unsaved = true; renderPanel(); render(); };
    set(after, select);
    const selName = select?.index;
    const pick = (v: Region[]) => v.find((r) => r.index === selName) ?? null;
    ed.pushEdit({ undo: () => set(before, pick(before)), redo: () => set(after, pick(after)), terrain: false, objects: false });
  };
  /** Changes one region (by copy) as an undo step. */
  const update = (r: Region, change: Partial<Region>) => {
    const before = doc.regions;
    const copy = { ...structuredClone(r), ...change };
    commit(before, before.map((x) => (x === r ? copy : x)), copy);
  };

  // ---- pointer -----------------------------------------------------------------------
  const snap = (v: number) => Math.round(v / GRID) * GRID;
  const hit = (x: number, y: number) =>
    doc.regions.filter((r) => x >= r.left && x <= r.right && y >= r.bottom && y <= r.top)
      .sort((a, b) => (a.right - a.left) * (a.top - a.bottom) - (b.right - b.left) * (b.top - b.bottom))[0] ?? null;
  /** Which edges of `r` a point grabs (within a few cells of them). */
  const edges = (r: Region, x: number, y: number) => {
    const m = Math.max(GRID, Math.min(96, (r.right - r.left) / 4, (r.top - r.bottom) / 4));
    return { l: x - r.left < m, r: r.right - x < m, b: y - r.bottom < m, t: r.top - y < m };
  };
  let drag: { kind: "new" | "move" | "resize"; start: [number, number]; orig: Region; grab: ReturnType<typeof edges>; moved: boolean } | null = null;
  const nextIndex = () => 1 + Math.max(-1, ...doc.regions.map((r) => r.index));

  // ---- toolbar -----------------------------------------------------------------------
  const count = h("span.muted");
  const hover = h("span.terrain-place-hint");
  const jump = h("select", { title: "Go to a region", onchange: () => {
    const r = doc.regions.find((x) => String(x.index) === jump.value);
    if (r) { selected = r; ed.lookAt((r.left + r.right) / 2, (r.bottom + r.top) / 2); renderPanel(); render(); }
    jump.value = "";
  } });
  const panel = h("div.terrain-region-panel");
  const renderPanel = () => {
    jump.replaceChildren(h("option", { value: "" }, "Go to region…"),
      ...[...doc.regions].sort((a, b) => a.name.localeCompare(b.name)).map((r) => h("option", { value: String(r.index) }, r.name)));
    const r = selected;
    if (!r) { panel.replaceChildren(h("span.muted", {}, "Drag on the map to draw a region · click one to select it · drag inside to move, at an edge to resize · Del deletes")); return; }
    const hex = `#${[r.color.red, r.color.green, r.color.blue].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    const name = h("input.terrain-region-name", { type: "text", value: r.name, title: "Name (triggers use gg_rct_<name>)", onchange: () => {
      const v = name.value.trim();
      if (v && v !== r.name) update(r, { name: v });
    } });
    const color = h("input", { type: "color", value: hex, title: "Colour in the editor", onchange: () => {
      const v = color.value;
      update(r, { color: { ...r.color, red: parseInt(v.slice(1, 3), 16), green: parseInt(v.slice(3, 5), 16), blue: parseInt(v.slice(5, 7), 16) } });
    } });
    const weather = h("select", { title: "Weather effect", onchange: () => update(r, { weather: weather.value }) }, h("option", { value: NO_WEATHER }, "No weather"));
    void weatherList(w3).then((list) => weather.append(...list.map(([id, label]) => h("option", { value: id, selected: id === r.weather }, `${label} (${id})`))));
    const sound = h("input.terrain-region-sound", { type: "text", value: r.sound, placeholder: "ambient sound (variable)", title: "Ambient sound: a sound variable name, empty for none", onchange: () => update(r, { sound: sound.value.trim() }) });
    const size = `${Math.round(r.right - r.left)} × ${Math.round(r.top - r.bottom)} at (${Math.round(r.left)}, ${Math.round(r.bottom)})`;
    panel.replaceChildren(name, color, weather, sound, h("span.muted", {}, size),
      h("button", { title: "Delete this region (Del)", onclick: () => deleteSelected() }, "Delete"));
  };
  const deleteSelected = () => {
    const r = selected;
    if (!r) return;
    commit(doc.regions, doc.regions.filter((x) => x !== r), null);
  };
  const toolbar = h("div.terrain-group-tools", {}, jump, count, hover, panel);

  return {
    toolbar,
    activate() { active = true; void load.then(() => { renderPanel(); render(); }); },
    deactivate() { active = false; drag = null; draft = null; ed.setGroundOverlay(null); ed.host.style.cursor = ""; },
    pointerDown(p) {
      if (!ed.editable || !p.ground) return false;
      const [x, y] = p.ground;
      const r = hit(x, y);
      if (r) {
        selected = r;
        const grab = edges(r, x, y);
        drag = { kind: grab.l || grab.r || grab.b || grab.t ? "resize" : "move", start: [x, y], orig: structuredClone(r), grab, moved: false };
      } else {
        selected = null;
        const [c0, c1, c2] = PALETTE[doc.regions.length % PALETTE.length];
        draft = {
          left: snap(x), right: snap(x), bottom: snap(y), top: snap(y), name: "", index: nextIndex(), weather: NO_WEATHER, sound: "",
          color: { red: c0, green: c1, blue: c2, alpha: 255 }, ...(doc.version >= 7 ? { trailer: [0, 0] } : {}),
        };
        drag = { kind: "new", start: [x, y], orig: draft, grab: { l: false, r: false, b: false, t: false }, moved: false };
      }
      renderPanel();
      render();
      return true;
    },
    pointerMove(p) {
      if (!p.ground) return;
      const [x, y] = p.ground;
      if (!p.down || !drag) {
        const r = hit(x, y);
        hover.textContent = r ? r.name : "";
        const g = r && r === selected ? edges(r, x, y) : null;
        ed.host.style.cursor = g ? ((g.l || g.r) && (g.b || g.t) ? "move" : g.l || g.r ? "ew-resize" : g.b || g.t ? "ns-resize" : "grab") : r ? "pointer" : "crosshair";
        return;
      }
      drag.moved = true;
      const o = drag.orig;
      if (drag.kind === "new") {
        const [sx, sy] = drag.start;
        Object.assign(draft!, { left: snap(Math.min(sx, x)), right: snap(Math.max(sx, x)), bottom: snap(Math.min(sy, y)), top: snap(Math.max(sy, y)) });
      } else if (drag.kind === "move") {
        const dx = snap(x - drag.start[0]), dy = snap(y - drag.start[1]);
        Object.assign(selected!, { left: o.left + dx, right: o.right + dx, bottom: o.bottom + dy, top: o.top + dy });
      } else {
        const g = drag.grab, r = selected!;
        if (g.l) r.left = Math.min(snap(x), o.right - GRID);
        if (g.r) r.right = Math.max(snap(x), o.left + GRID);
        if (g.b) r.bottom = Math.min(snap(y), o.top - GRID);
        if (g.t) r.top = Math.max(snap(y), o.bottom + GRID);
      }
      render();
    },
    pointerUp() {
      const d = drag;
      drag = null;
      if (!d) return;
      if (d.kind === "new") {
        const r = draft!;
        draft = null;
        if (r.right - r.left >= GRID && r.top - r.bottom >= GRID) {
          r.name = `Region ${String(r.index).padStart(3, "0")}`;
          commit(doc.regions, [...doc.regions, r], r);
        } else render();
        return;
      }
      if (!d.moved || !selected) { renderPanel(); render(); return; }
      // The live edit becomes one undo step: restore, then apply as an update.
      const now = { left: selected.left, right: selected.right, bottom: selected.bottom, top: selected.top };
      Object.assign(selected, { left: d.orig.left, right: d.orig.right, bottom: d.orig.bottom, top: d.orig.top });
      update(selected, now);
    },
    pointerLeave() { hover.textContent = ""; ed.host.style.cursor = ""; },
    keyDown(e) {
      if ((e.key === "Delete" || e.key === "Backspace") && selected) { deleteSelected(); return true; }
      if (e.key === "Escape" && selected) { selected = null; renderPanel(); render(); return true; }
      return false;
    },
    async save() {
      if (!unsaved) return;
      const root = w3.workspace.project()!.root;
      const text = JSON.stringify({ format: "w3proj.regions/1", ...doc });
      if (asJson) {
        const canonical = await w3.backend.invoke<string>("codec_canonicalize", { root, path: `${FILE}.json`, text });
        await w3.workspace.writeText(`${FILE}.json`, canonical);
      } else {
        await w3.backend.invoke("codec_write", { root, path: FILE, text });
      }
      unsaved = false;
    },
    dispose() { ed.setGroundOverlay(null); ed.host.style.cursor = ""; },
  };
}
