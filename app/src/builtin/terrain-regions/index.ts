// Region Editor: regions (war3map.w3r, "rects" in triggers) as a tool group
// of the terrain editor (service "w3.terrain"). Drag on empty ground to
// create one, inside one to move it, at an edge or corner to resize it.
// The file goes through the format engine ("regions" definition).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { TERRAIN_SERVICE, type TerrainEditorHandle, type TerrainService, type TerrainToolGroupInstance } from "../../extensions/services";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { weatherName } from "../../lib/terrain/weather";
import { jsonPathOf, readMapDoc, requireProject } from "../../lib/formats/mapdoc";
import { MCP_EDITS_SERVICE, type McpEditsService } from "../../extensions/services";
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

/** One edit of the map's regions. */
async function editRegions(w3: W3Api, title: string, change: (doc: RegionsDoc) => void) {
  const { root } = requireProject(w3);
  const path = jsonPathOf(w3, "war3map.w3r");
  const edits = await w3.services.get<McpEditsService>(MCP_EDITS_SERVICE);
  return edits.edit(title, async (read) => {
    const text = await read(path);
    const doc: RegionsDoc = text === null ? { format: "w3proj.regions/1", version: 5, regions: [] } : JSON.parse(text);
    change(doc);
    return [{ path, text: await w3.backend.invoke<string>("codec_canonicalize", { root, path, text: JSON.stringify(doc) }) }];
  });
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  ctx.subscriptions.push(
    w3.mcp.registerTool("add_region", async ({ name, left, bottom, right, top }) => {
      if (typeof name !== "string" || !name.trim()) throw new Error("add_region needs a name.");
      const box = [left, bottom, right, top];
      if (!box.every((n) => typeof n === "number" && Number.isFinite(n)) || Number(left) >= Number(right) || Number(bottom) >= Number(top)) {
        throw new Error("left, bottom, right and top must be numbers, with left below right and bottom below top.");
      }
      await editRegions(w3, `Add region ${name}`, (doc) => {
        if (doc.regions.some((r) => r.name.toLowerCase() === name.trim().toLowerCase())) throw new Error(`There's already a region "${name}".`);
        const [red, green, blue] = PALETTE[doc.regions.length % PALETTE.length];
        doc.regions.push({
          left: Number(left), bottom: Number(bottom), right: Number(right), top: Number(top), name: name.trim(),
          index: 1 + Math.max(-1, ...doc.regions.map((r) => r.index)), weather: NO_WEATHER, sound: "",
          color: { red, green, blue, alpha: 255 }, ...(doc.version >= 7 ? { trailer: [0, 0] } : {}),
        });
      });
      return `Added the region ${name.trim()}.`;
    }),
    w3.mcp.registerTool("remove_region", async ({ name }) => {
      await editRegions(w3, `Remove region ${String(name)}`, (doc) => {
        const at = doc.regions.findIndex((r) => r.name.toLowerCase() === String(name).toLowerCase());
        if (at < 0) throw new Error(`There's no region "${String(name)}".`);
        doc.regions.splice(at, 1);
      });
      return `Removed the region ${String(name)}. list_problems shows triggers still using it.`;
    }),
  );
  ctx.subscriptions.push(w3.mcp.registerTool("list_regions", async () => {
    requireProject(w3);
    const file = await readMapDoc<{ regions: { name: string; left: number; bottom: number; right: number; top: number; weather: string; sound: string }[] }>(w3, "map/war3map.w3r.json");
    return (file?.regions ?? []).map(({ name, left, bottom, right, top, weather, sound }) => ({
      name, left, bottom, right, top, ...(weather !== "0x00000000" ? { weather } : {}), ...(sound ? { sound } : {}),
    }));
  }));
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
  return rows.filter((r) => r.effectID).map((r) => [r.effectID, weatherName(r.name, r.effectID, strings)] as [string, string]);
})().catch(() => []));

function regionEditor(w3: W3Api, ed: TerrainEditorHandle): TerrainToolGroupInstance {
  const t = ed.terrain;
  const W = (t.width - 1) * 4, H = (t.height - 1) * 4;
  let doc: RegionsDoc = { version: 5, regions: [] };
  /** Kept as map/war3map.w3r.json (else the raw file, through the backend). */
  let asJson = true, unsaved = false, active = false;
  let selected: Region | null = null;
  /** Further regions selected with Shift or Ctrl (by index): colour, weather, sound, moving and Delete work on all. */
  let extra = new Set<number>();
  /** Every selected region, the one clicked last first. */
  const selection = (): Region[] => selected ? [selected, ...doc.regions.filter((r) => r !== selected && extra.has(r.index))] : [];

  const read = async () => {
    const files = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
    const root = w3.workspace.project()?.root;
    if (files.has(`${FILE}.json`)) doc = JSON.parse(await w3.workspace.readText(`${FILE}.json`));
    else if (files.has(FILE) && root) { doc = JSON.parse(await w3.backend.invoke<string>("codec_decode", { root, path: FILE })); asJson = false; }
    doc.regions ??= [];
  };
  const load = read().catch((e) => w3.window.showError(`Regions: ${(e as Error).message ?? e}`));
  /** The map's sounds (war3map.w3s), offered for the ambient sound. */
  const soundList = h("datalist", { id: `terrain-region-sounds-${Math.random().toString(36).slice(2)}` });
  void (async () => {
    const files = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
    const root = w3.workspace.project()?.root;
    const sounds = "map/war3map.w3s";
    const text = files.has(`${sounds}.json`) ? await w3.workspace.readText(`${sounds}.json`)
      : files.has(sounds) && root ? await w3.backend.invoke<string>("codec_decode", { root, path: sounds }) : null;
    const names: string[] = text ? (JSON.parse(text).sounds ?? []).map((x: { name: string }) => x.name) : [];
    soundList.replaceChildren(...names.sort().map((n) => h("option", { value: n })));
  })().catch(() => {});

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
    ed.setLabels(doc.regions.map((r) => ({ x: (r.left + r.right) / 2, y: (r.bottom + r.top) / 2, text: r.name })));
    count.textContent = `${doc.regions.length} regions`;
  };

  // ---- undo --------------------------------------------------------------------------
  const commit = (before: Region[], after: Region[], select: Region | null, others: Iterable<number> = []) => {
    const keep = new Set(others);
    const set = (v: Region[], sel: Region | null) => {
      doc.regions = v;
      selected = sel;
      extra = new Set(sel ? v.filter((r) => r !== sel && keep.has(r.index)).map((r) => r.index) : []);
      unsaved = true;
      renderPanel();
      render();
    };
    set(after, select);
    const selName = select?.index;
    const pick = (v: Region[]) => v.find((r) => r.index === selName) ?? null;
    ed.pushEdit({ undo: () => set(before, pick(before)), redo: () => set(after, pick(after)), terrain: false, objects: false });
  };
  /** Changes one region (by copy) as an undo step. */
  const update = (r: Region, change: Partial<Region>) => updateAll([r], () => change);
  /** Changes several regions (by copy) as one undo step; the selection stays on them. */
  const updateAll = (list: Region[], change: (r: Region) => Partial<Region>) => {
    const before = doc.regions;
    const copies = new Map(list.map((r) => [r, { ...structuredClone(r), ...change(r) }]));
    const after = before.map((x) => copies.get(x) ?? x);
    const primary = selected && copies.get(selected) ? copies.get(selected)! : copies.get(list[0]) ?? null;
    commit(before, after, primary, list.map((r) => r.index));
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
  /** `origs`: every region a move takes along, as it was. */
  let drag: { kind: "new" | "move" | "resize"; start: [number, number]; orig: Region; grab: ReturnType<typeof edges>; moved: boolean; origs: Map<Region, Region> } | null = null;
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
    if (!r) { panel.replaceChildren(h("span.muted", {}, "Drag on the map to draw a region · click one to select it · Shift+click adds one · drag inside to move, at an edge to resize · Del deletes")); return; }
    const all = selection(), many = all.length > 1;
    // Colour, weather and sound: what the first shows, set on every selected region (one undo step).
    const same = <T>(get: (x: Region) => T) => all.every((x) => get(x) === get(r));
    const hex = `#${[r.color.red, r.color.green, r.color.blue].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    const color = h("input", { type: "color", value: hex, title: many ? `Colour in the editor, for all ${all.length}` : "Colour in the editor", onchange: () => {
      const v = color.value;
      updateAll(all, (x) => ({ color: { ...x.color, red: parseInt(v.slice(1, 3), 16), green: parseInt(v.slice(3, 5), 16), blue: parseInt(v.slice(5, 7), 16) } }));
    } });
    const mixed = h("option", { value: "", disabled: true, selected: true }, "(different weather)");
    const weather = h("select", { title: many ? `Weather effect, for all ${all.length}` : "Weather effect", onchange: () => { if (weather.value) updateAll(all, () => ({ weather: weather.value })); } },
      ...(same((x) => x.weather) ? [] : [mixed]), h("option", { value: NO_WEATHER, selected: same((x) => x.weather) && r.weather === NO_WEATHER }, "No weather"));
    void weatherList(w3).then((list) => weather.append(...list.map(([id, label]) => h("option", { value: id, selected: same((x) => x.weather) && id === r.weather }, `${label} (${id})`))));
    const sound = h("input.terrain-region-sound", { type: "text", value: same((x) => x.sound) ? r.sound : "", placeholder: same((x) => x.sound) ? "ambient sound (variable)" : "(different sounds)", list: soundList.id,
      title: "Ambient sound: a sound variable name (from the map's sounds), empty for none", onchange: () => updateAll(all, () => ({ sound: sound.value.trim() })) });
    const remove = h("button", { title: many ? `Delete these ${all.length} regions (Del)` : "Delete this region (Del)", onclick: () => deleteSelected() }, "Delete");
    if (many) {
      panel.replaceChildren(h("span.terrain-region-count", {}, `${all.length} regions`), color, weather, sound, remove);
      return;
    }
    const name = h("input.terrain-region-name", { type: "text", value: r.name, title: "Name (triggers use gg_rct_<name>)", onchange: () => {
      const v = name.value.trim();
      if (v && v !== r.name) update(r, { name: v });
    } });
    // The bounds as numbers (world units): a value that leaves the region with no size is refused and put back.
    const bound = (key: "left" | "right" | "bottom" | "top", label: string) => {
      const input = h(`input.terrain-region-bound.terrain-region-${key}`, { type: "number", step: String(GRID), value: String(r[key]), title: `${label} edge (world units)` });
      input.addEventListener("change", () => {
        const v = Number(input.value);
        const box = { left: r.left, right: r.right, bottom: r.bottom, top: r.top, [key]: v };
        if (input.value.trim() === "" || !Number.isFinite(v) || box.left >= box.right || box.bottom >= box.top) {
          input.classList.add("invalid");
          input.title = `${label}: left must be below right and bottom below top`;
          return;
        }
        if (v !== r[key]) update(r, { [key]: v });
      });
      return h("label.terrain-region-boundrow", {}, h("span.muted", {}, `${label} `), input);
    };
    panel.replaceChildren(name, color, weather, sound,
      bound("left", "Left"), bound("right", "Right"), bound("bottom", "Bottom"), bound("top", "Top"),
      h("span.muted", {}, `${Math.round(r.right - r.left)} × ${Math.round(r.top - r.bottom)}`), remove);
  };
  const deleteSelected = () => {
    const gone = new Set(selection());
    if (!gone.size) return;
    commit(doc.regions, doc.regions.filter((x) => !gone.has(x)), null);
  };
  const toolbar = h("div.terrain-group-tools", {}, jump, count, hover, panel, soundList);

  return {
    toolbar,
    activate() { active = true; void load.then(() => { renderPanel(); render(); }); },
    deactivate() { active = false; drag = null; draft = null; ed.setGroundOverlay(null); ed.setLabels(null); ed.host.style.cursor = ""; },
    pointerDown(p) {
      if (!ed.editable || !p.ground) return false;
      const [x, y] = p.ground;
      const r = hit(x, y);
      const adding = p.event.shiftKey || p.event.ctrlKey || p.event.metaKey;
      if (r && adding) {
        // Shift/Ctrl+click: adds the region to the selection, or takes it out.
        const all = selection();
        if (all.includes(r)) {
          const rest = all.filter((x) => x !== r);
          selected = rest[0] ?? null;
          extra = new Set(rest.slice(1).map((x) => x.index));
        } else {
          if (selected) extra.add(selected.index);
          selected = r;
        }
        renderPanel();
        render();
        return true;
      }
      if (r) {
        const together = selection().includes(r) && selection().length > 1;
        if (!together) extra = new Set();
        selected = r;
        const grab = edges(r, x, y);
        // Inside one of several selected regions, a drag moves them all.
        const kind = !together && (grab.l || grab.r || grab.b || grab.t) ? "resize" : "move";
        drag = { kind, start: [x, y], orig: structuredClone(r), grab, moved: false, origs: new Map(selection().map((s) => [s, structuredClone(s)])) };
      } else if (adding) {
        return false;
      } else {
        selected = null;
        extra = new Set();
        const [c0, c1, c2] = PALETTE[doc.regions.length % PALETTE.length];
        draft = {
          left: snap(x), right: snap(x), bottom: snap(y), top: snap(y), name: "", index: nextIndex(), weather: NO_WEATHER, sound: "",
          color: { red: c0, green: c1, blue: c2, alpha: 255 }, ...(doc.version >= 7 ? { trailer: [0, 0] } : {}),
        };
        drag = { kind: "new", start: [x, y], orig: draft, grab: { l: false, r: false, b: false, t: false }, moved: false, origs: new Map() };
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
        for (const [r, b] of drag.origs) Object.assign(r, { left: b.left + dx, right: b.right + dx, bottom: b.bottom + dy, top: b.top + dy });
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
      // The live edit becomes one undo step: restore, then apply as an update (of every region moved along).
      const box = (r: Region) => ({ left: r.left, right: r.right, bottom: r.bottom, top: r.top });
      const moved = d.kind === "move" ? [...d.origs.keys()] : [selected];
      const now = new Map(moved.map((r) => [r, box(r)]));
      for (const r of moved) Object.assign(r, box(d.kind === "move" ? d.origs.get(r)! : d.orig));
      updateAll(moved, (r) => now.get(r)!);
    },
    pointerLeave() { hover.textContent = ""; ed.host.style.cursor = ""; },
    keyDown(e) {
      if ((e.key === "Delete" || e.key === "Backspace") && selected) { deleteSelected(); return true; }
      if (e.key === "Escape" && selected) { selected = null; extra = new Set(); renderPanel(); render(); return true; }
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
    async reloadFile(path) {
      if (!path.startsWith(FILE)) return false;
      await read();
      unsaved = false;
      selected = null;
      extra = new Set();
      if (active) { renderPanel(); render(); }
      return true;
    },
    dispose() { ed.setGroundOverlay(null); ed.setLabels(null); ed.host.style.cursor = ""; },
  };
}
