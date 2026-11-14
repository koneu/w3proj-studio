// Terrain Painter: the terrain brushes as a tool group of the terrain editor
// (service "w3.terrain"): height, ground textures, cliffs, water, blight, ramps.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { TERRAIN_SERVICE, type TerrainEditorHandle, type TerrainService, type TerrainToolGroupInstance } from "../../extensions/services";
import { parseSlk } from "../../lib/formats/text";
import { TILESETS } from "../../lib/terrain/tilesets";
import { HEIGHT_TICK, HeightStroke, strokePoints } from "../../lib/terrain/strokepath";
import { groundHeight, waterLevelAt, WATER_OFFSET } from "../../lib/terrain/w3e";
import { h } from "../../workbench/dom";
import { toolIcon } from "./toolicons";
import { applyHeight, applyLayer, paintBlight, paintBoundary, paintTexture, retypeCliffs, Stroke, strokeLayer, rampClick, brushOf, brushReach, type HeightTool, type LayerTarget, type LayerTool } from "./tools";

type Tool = HeightTool | LayerTool | "paint" | "ramp" | "blight" | "unblight" | "boundary" | "unboundary";
const LAYER_TOOLS: Tool[] = ["cliffUp", "cliffUp2", "cliffLevel", "cliffDown", "cliffDown2", "shallow", "deep", "dry"];
const isLayerTool = (t: Tool): t is LayerTool => LAYER_TOOLS.includes(t);

/** World units between brush stamps per step of the brush size (half its radius). */
const BRUSH_SPACING = 64;
/** Maps hold at most this many ground tile types (World Editor limit). */
const MAX_GROUND_TILES = 16;

/** The toolbar's sections and their tools: [tool, label, tooltip]. */
const SECTIONS: [string, [Tool, string, string][]][] = [
  ["Paint", [
    ["paint", "Paint", "Paint a ground texture"],
    ["blight", "Blight", "Paint Undead blight"], ["unblight", "Unblight", "Remove blight"],
    ["boundary", "Boundary", "Make tiles unplayable, as past the map's edge: nothing walks there, doodads can stand there"], ["unboundary", "No boundary", "Remove Boundary"],
  ]],
  ["Cliffs", [
    ["cliffUp", "+1", "Raise a cliff level (one above where the stroke starts)"],
    ["cliffUp2", "+2", "Raise two cliff levels (two above where the stroke starts)"],
    ["cliffLevel", "Level", "Bring everything to the cliff level where the stroke starts"],
    ["cliffDown", "−1", "Lower a cliff level (one below where the stroke starts)"],
    ["cliffDown2", "−2", "Lower two cliff levels (two below where the stroke starts)"],
    ["ramp", "Ramp", "Click the edge of a one-level cliff: the corner nearest the pointer and the two below it become ramp, as in the World Editor (Size doesn't matter); click or drag along the edge for a wider ramp; click a ramp to remove it"],
    ["shallow", "Shallow", "Shallow water: one level below where the stroke starts"],
    ["deep", "Deep", "Deep water: two levels below where the stroke starts"],
    ["dry", "Dry", "Remove water (use Cliffs +1 to raise the ground again)"],
  ]],
  ["Terrain", [
    ["raise", "Raise", "Raise the ground"], ["lower", "Lower", "Lower the ground"],
    ["plateau", "Plateau", "Level to the height where the stroke starts"], ["smooth", "Smooth", "Smooth bumps"],
    ["noise", "Noise", "Roughen the ground: every corner under the brush goes up or down at random, while the button is held"],
  ]],
];

const BRUSH_COLORS: Record<Tool, [number, number, number]> = {
  raise: [120, 220, 255], lower: [255, 150, 90], plateau: [255, 230, 120], smooth: [190, 160, 255], noise: [160, 230, 190], paint: [140, 255, 140],
  cliffUp: [255, 200, 120], cliffUp2: [255, 180, 90], cliffLevel: [240, 220, 160], cliffDown: [220, 140, 80], cliffDown2: [200, 110, 60], shallow: [110, 190, 255], deep: [60, 120, 255], dry: [210, 190, 150],
  ramp: [255, 170, 220], blight: [170, 120, 200], unblight: [200, 220, 160], boundary: [120, 120, 130], unboundary: [220, 220, 230],
};

export function activate(w3: W3Api, ctx: ExtensionContext) {
  void w3.services.get<TerrainService>(TERRAIN_SERVICE).then((s) => {
    ctx.subscriptions.push(s.registerToolGroup({ id: "terrain", title: "Terrain", order: 10, create: (ed) => painter(w3, ed) }));
  });
}

/** Every ground tile type the game knows: a readable name per id. */
let catalog: Promise<Map<string, string>> | null = null;
const tileNames = (w3: W3Api) => (catalog ??= w3.game.readText("TerrainArt\\Terrain.slk")
  .then((t) => new Map(parseSlk(t).filter((r) => r.tileID).map((r) => [r.tileID, r.comment || r.file])))
  .catch(() => new Map<string, string>()));

function painter(w3: W3Api, ed: TerrainEditorHandle): TerrainToolGroupInstance {
  const terrain = ed.terrain;
  let tool: Tool = "paint", size = 2, strength = 16, paintTex = 0, square = false;
  /** Tile type chosen for painting (may not be in the map yet). */
  let paintTile = terrain.groundTiles[0] ?? "";
  /** `px`: where on the page the pointer was at the last dab (clientX, clientY). */
  let stroke: { s: Stroke; target: number; layer: LayerTarget; last: number; at?: [number, number]; height?: HeightStroke; px?: [number, number] } | null = null;

  /** The World Editor's Enforce Water Height Limits (the terrain editor's switch, on unless set off). */
  const enforceWater = () => w3.settings.get<boolean>("terrain.enforceWaterLimits", true) !== false;
  /** One brush application at a ground point; true if it changed something. */
  const stamp = (x: number, y: number, amount = strength): boolean => {
    if (!stroke) return false;
    const brush = brushOf(tool, terrain, x, y, size, square);
    return tool === "paint"
      ? paintTexture(terrain, brush, paintTex, stroke.s)
      : tool === "blight" || tool === "unblight"
      ? paintBlight(terrain, brush, tool === "blight", stroke.s)
      : tool === "boundary" || tool === "unboundary"
      ? paintBoundary(terrain, brush, tool === "boundary", stroke.s)
      : isLayerTool(tool)
      ? applyLayer(terrain, brush, tool, stroke.layer, stroke.s, enforceWater())
      : applyHeight(terrain, brush, tool as HeightTool, tool === "plateau" ? stroke.target : amount, stroke.s);
  };
  /** The brush at a ground point, and along the way from the last one. */
  const applyAt = (p: [number, number, number]) => {
    if (!stroke) return;
    const points = stroke.at ? strokePoints(stroke.at, [p[0], p[1]], size * BRUSH_SPACING) : [[p[0], p[1]] as [number, number]];
    let did = false;
    for (const [x, y] of points) did = stamp(x, y) || did;
    stroke.at = [p[0], p[1]];
    stroke.last = performance.now();
    if (did) ed.terrainChanged(isLayerTool(tool));
  };
  /** Raise, Lower, Smooth and Noise go by time, not by mouse events: what a moment adds is shared out along
   *  the way the mouse went, so a quick drag is lower but has no gaps, and holding still goes on. */
  let holding: ReturnType<typeof setInterval> | undefined;
  const heightTick = () => {
    if (!stroke?.height) return;
    let did = false;
    for (const { x, y, amount } of stroke.height.tick(performance.now(), strength)) did = stamp(x, y, amount) || did;
    if (did) ed.terrainChanged();
  };
  const startHeight = (g: [number, number, number]) => {
    if (!stroke) return;
    stroke.height = new HeightStroke([g[0], g[1]], performance.now() - HEIGHT_TICK, size * BRUSH_SPACING);
    heightTick();
    holding = setInterval(heightTick, HEIGHT_TICK);
  };
  const endStroke = () => {
    heightTick();
    clearInterval(holding);
    if (!stroke) return;
    const s = stroke.s;
    stroke = null;
    // New cliffs and water take the chosen cliff type (or their ground tile's); painting ground re-types nothing.
    const type = cliffType === "default" ? ed.defaultCliffType() : cliffType;
    const chosen = isLayerTool(s.label as Tool) && type >= 0 ? type : undefined;
    const retyped = retypeCliffs(terrain, s, ed.cliffGroundTiles(), chosen);
    if (!s.finish(terrain)) return;
    ed.commitTerrain({ corners: s.corners(), undo: () => s.undo(terrain), redo: () => s.redo(terrain), cliffs: retyped || isLayerTool(s.label as Tool) || s.label === "ramp" });
  };

  // ---- toolbar -----------------------------------------------------------------------
  const buttons = new Map<Tool, HTMLButtonElement>();
  const thumbs = h("span.terrain-tex-thumbs");
  const texSelect = h("select", { title: "Paint with a tile this map doesn't use yet (it's added on the first stroke)", onchange: () => {
    if (texSelect.value) paintTile = texSelect.value;
    void fillPalette();
  } });
  const fillPalette = async () => {
    const names = await tileNames(w3);
    const opt = (id: string) => h("option", { value: id, selected: id === paintTile }, `${names.get(id) ?? id} (${id})`);
    thumbs.replaceChildren(...terrain.groundTiles.map((id) => {
      const img = h("img", { alt: id });
      void ed.groundTileThumb(id).then((src) => { if (src) img.src = src; });
      return h(`button.terrain-tex-thumb${id === paintTile ? ".on" : ""}`, {
        title: `${names.get(id) ?? id} (${id})`,
        onclick: () => { paintTile = id; void fillPalette(); ed.focus(); },
      }, img);
    }));
    const inMap = new Set(terrain.groundTiles);
    const byTileset = new Map<string, string[]>();
    for (const id of names.keys()) if (!inMap.has(id)) byTileset.set(id[0], [...(byTileset.get(id[0]) ?? []), id]);
    const own = byTileset.get(terrain.tileset) ?? [];
    byTileset.delete(terrain.tileset);
    texSelect.replaceChildren(
      h("option", { value: "", selected: inMap.has(paintTile) }, `Add tile… (${terrain.groundTiles.length}/${MAX_GROUND_TILES})`),
      ...(own.length ? [h("optgroup", { label: `${TILESETS[terrain.tileset] ?? terrain.tileset}: adds to the map` }, ...own.map(opt))] : []),
      ...[...byTileset].sort(([x], [y]) => (TILESETS[x] ?? x).localeCompare(TILESETS[y] ?? y))
        .map(([ts, ids]) => h("optgroup", { label: `${TILESETS[ts] ?? ts}: adds to the map` }, ...ids.map(opt))),
    );
  };
  void fillPalette();

  // ---- the map's tile list: order (drawing order at transitions) and removal ----------
  const tilePanel = h("div.terrain-tilemgr", { hidden: true });
  /** Index whose removal is being confirmed. */
  let removing: number | null = null;
  /** Clean up: the tiles ticked for removal and, for those in use, the tile each one's corners and cliffs get (by
   *  index), for the tile list it was started on. Null when not cleaning up. */
  let cleanup: { list: string; remove: Set<number>; replace: Map<number, number> } | null = null;
  const renderTiles = async () => {
    if (tilePanel.hidden) return;
    const names = await tileNames(w3);
    const usage = ed.groundTileUsage();
    const total = usage.reduce((a, b) => a + b, 0) || 1;
    const t = terrain.groundTiles;
    // Another list (an undo, a tile added) makes the ticks point at other tiles: they go.
    if (cleanup && cleanup.list !== t.join()) cleanup = null;
    const use = ed.groundTileUse();
    const inUse = (i: number) => !use || use.ground[i] + use.cliffs[i] > 0;
    const unused = use ? t.map((_, i) => i).filter((i) => !inUse(i)) : [];
    const tryIt = (f: () => void) => { try { f(); } catch (e) { void w3.window.showWarning((e as Error).message ?? String(e)); } };
    const useText = (i: number) => use ? `${use.ground[i].toLocaleString()} corners${use.cliffs[i] ? `, ${use.cliffs[i].toLocaleString()} cliff tiles` : ""}` : `${usage[i].toLocaleString()} corners`;
    const cleanupBar = h("div.terrain-tilemgr-row.terrain-tilemgr-cleanup", {},
      h("button", {
        title: use ? "Remove the tiles no corner is painted with and no cliff is made of; one undo step" : "Waiting for the game's cliff types",
        disabled: !use || !unused.length || unused.length === t.length,
        onclick: () => { tryIt(() => ed.removeUnusedGroundTiles()); ed.focus(); },
      }, `Remove unused (${unused.length})`),
      h("button", {
        title: "Choose tiles to remove, used ones too: their corners and cliffs get a tile that stays; one undo step",
        disabled: !use || t.length < 2,
        onclick: () => { cleanup = cleanup ? null : { list: t.join(), remove: new Set(unused), replace: new Map() }; removing = null; void renderTiles(); },
      }, cleanup ? "Stop cleaning up" : "Clean up…"));
    /** The cleanup's footer: how many go, and the button. */
    const cleanupFooter = () => {
      if (!cleanup) return null;
      const c = cleanup, kept = t.map((_, i) => i).filter((i) => !c.remove.has(i));
      return h("div.terrain-tilemgr-row.terrain-tilemgr-cleanup", {},
        h("button", {
          disabled: !c.remove.size || !kept.length,
          title: kept.length ? "" : "A map needs at least one ground tile: keep one",
          onclick: () => {
            const replace = new Map([...c.remove].filter(inUse).map((i) => [i, c.replace.get(i) ?? kept[0]] as [number, number]));
            tryIt(() => { ed.removeGroundTiles([...c.remove], replace); cleanup = null; });
            ed.focus();
            void renderTiles();
          },
        }, `Remove ${c.remove.size} tile${c.remove.size === 1 ? "" : "s"}`),
        h("button", { onclick: () => { cleanup = null; void renderTiles(); } }, "Cancel"));
    };
    /** In a cleanup, a row's tick and, for a ticked tile in use, what replaces it. */
    const cleanupCells = (i: number, label: string) => {
      if (!cleanup) return [];
      const c = cleanup;
      const box = h("input", { type: "checkbox", title: `Remove ${label}`, checked: c.remove.has(i), onchange: () => {
        if (box.checked) c.remove.add(i); else c.remove.delete(i);
        // A tile ticked now can't be what replaces another.
        for (const [k, r] of c.replace) if (c.remove.has(r)) c.replace.delete(k);
        void renderTiles();
      } });
      if (!c.remove.has(i) || !inUse(i)) return [box];
      const others = t.map((o, j) => [o, j] as const).filter(([, j]) => !c.remove.has(j));
      if (!others.length) return [box];
      const chosen = c.replace.get(i) ?? others[0][1];
      const sel = h("select.terrain-tilemgr-replace", { title: `What ${label}'s ${useText(i)} get`, onchange: () => c.replace.set(i, Number(sel.value)) },
        ...others.map(([o, j]) => h("option", { value: String(j), selected: j === chosen }, `${names.get(o) ?? o} (${o})`)));
      return [box, h("span.muted", {}, " → "), sel];
    };
    const [sets, mapSet] = await Promise.all([ed.tilesets().catch(() => []), ed.mapTileset().catch(() => null)]);
    const nameOf = (id: string) => sets.find((s) => s.id === id)?.name ?? id;
    // Tileset (water, lighting, blight) and tile templates: a tileset's own tile list.
    const tilesetSelect = h("select", { title: "The terrain's tileset: water, default lighting and blight follow (the ground tiles stay; see Template)",
      onchange: () => { ed.setTileset(tilesetSelect.value); ed.focus(); } },
      ...(sets.some((s) => s.id === terrain.tileset) ? [] : [h("option", { value: terrain.tileset, selected: true }, terrain.tileset)]),
      ...sets.map((s) => h("option", { value: s.id, selected: s.id === terrain.tileset }, s.name)));
    const templateSelect = h("select", { title: "A tileset's own ground tiles" },
      ...sets.map((s) => h("option", { value: s.id, selected: s.id === terrain.tileset }, s.name)));
    const applyTemplate = h("button", {
      title: "Replace the map's ground tiles with this tileset's own, slot by slot (painted ground keeps its slot; cliffs follow); one undo step",
      onclick: () => { const s = sets.find((x) => x.id === templateSelect.value); if (s) ed.replaceGroundTiles(s.tiles); ed.focus(); },
    }, "Use its tiles");
    // Map Properties keeps its own tileset entry: offer to line the two up when they differ.
    const sync = mapSet && mapSet !== terrain.tileset ? h("div.terrain-tilemgr-sync", {},
      h("span", {}, `Map Properties says ${nameOf(mapSet)}.`),
      h("button", { title: "Switch the terrain to Map Properties' tileset", onclick: () => { ed.setTileset(mapSet); ed.focus(); } }, "Use it here"),
      h("button", { title: "Write the terrain's tileset into Map Properties (war3map.w3i)", onclick: () => { void ed.setMapTileset(terrain.tileset).then(() => renderTiles()); } }, `Set Map Properties to ${nameOf(terrain.tileset)}`)) : null;
    tilePanel.replaceChildren(
      h("div.terrain-tilemgr-row", {}, h("span.terrain-tilemgr-name", {}, "Tileset"), tilesetSelect),
      h("div.terrain-tilemgr-row", {}, h("span.terrain-tilemgr-name", {}, "Template"), templateSelect, applyTemplate),
      ...(sync ? [sync] : []),
      h("div.muted", {}, "Draw order: tiles further down are drawn over the ones above them where they meet. Changes are one undo step each."),
      cleanupBar,
      ...(cleanup ? [h("div.muted", {}, "Tick the tiles to remove (the unused ones are ticked). A used one's corners and cliffs get the tile chosen beside it.")] : []),
      ...t.map((id, i) => {
        const img = h("img", { alt: id });
        void ed.groundTileThumb(id).then((src) => { if (src) img.src = src; });
        const label = `${names.get(id) ?? id} (${id})`;
        if (cleanup) {
          const [box, ...replacement] = cleanupCells(i, label);
          return h(`div.terrain-tilemgr-row${cleanup.remove.has(i) ? ".removing" : ""}`, { title: useText(i) },
            box, img,
            h("span.terrain-tilemgr-name", {}, label),
            h("span.muted", { title: useText(i) }, inUse(i) ? `${((100 * usage[i]) / total).toFixed(1)}%` : "unused"),
            ...replacement);
        }
        if (removing === i) {
          const others = t.map((o, j) => [o, j] as const).filter(([, j]) => j !== i);
          const sel = h("select", {}, ...others.map(([o, j]) => h("option", { value: String(j) }, `${names.get(o) ?? o} (${o})`)));
          return h("div.terrain-tilemgr-row.removing", {}, img, h("span", {}, `Remove ${label}: paint its ${usage[i].toLocaleString()} corners with`), sel,
            h("button", { onclick: () => { removing = null; ed.removeGroundTile(i, Number(sel.value)); ed.focus(); } }, "Remove"),
            h("button", { onclick: () => { removing = null; void renderTiles(); } }, "Cancel"));
        }
        return h("div.terrain-tilemgr-row", {}, img,
          h("span.terrain-tilemgr-name", {}, label),
          h("span.muted", { title: `${usage[i].toLocaleString()} corners` }, `${((100 * usage[i]) / total).toFixed(1)}%`),
          h("button", { title: "Move up (drawn earlier, under the others)", disabled: i === 0, onclick: () => { ed.moveGroundTile(i, i - 1); ed.focus(); } }, "↑"),
          h("button", { title: "Move down (drawn later, over the others)", disabled: i === t.length - 1, onclick: () => { ed.moveGroundTile(i, i + 1); ed.focus(); } }, "↓"),
          h("button", { title: "Remove from the map (its corners get another tile)", disabled: t.length < 2, onclick: () => { removing = i; void renderTiles(); } }, "✕"));
      }),
      ...(cleanup ? [cleanupFooter()!] : []),
    );
  };
  const tilesButton = h("button", { title: "The map's ground tiles: drawing order and removal", onclick: () => {
    tilePanel.hidden = !tilePanel.hidden;
    tilesButton.classList.toggle("active", !tilePanel.hidden);
    removing = null;
    void renderTiles();
  } }, "Tiles…");
  const texWrap = h("span.terrain-tool-opt", {}, thumbs, texSelect, tilesButton);
  // Cliff type for the cliff and water tools (the World Editor's cliff palette choice): a cliff type number, -1 to
  // match the ground under the cliff, or until one is chosen the one the World Editor's palette starts on.
  let cliffType: number | "default" = "default";
  const cliffSelect = h("select", { onchange: () => { cliffType = Number(cliffSelect.value); ed.focus(); } });
  const fillCliffTypes = async () => {
    const names = await tileNames(w3);
    const grounds = ed.cliffGroundTiles();
    if (typeof cliffType === "number" && cliffType >= grounds.length) cliffType = "default";
    const shown = cliffType === "default" ? ed.defaultCliffType() : cliffType;
    cliffSelect.replaceChildren(
      h("option", { value: "-1", selected: shown < 0, title: "The cliff type of the ground tile under the cliff, where it has one" }, "Match the ground"),
      ...grounds.map((g, i) => h("option", { value: String(i), selected: shown === i }, `${names.get(g) ?? g} cliff`)));
  };
  const cliffWrap = h("label.terrain-tool-opt", { title: "Which cliff new cliffs get" }, "Cliff type ", cliffSelect);
  const strengthWrap = h("label.terrain-tool-opt", { title: "How fast the ground rises or sinks at the brush's centre, while the button is held" }, "Strength ",
    h("input", { type: "range", min: "2", max: "64", value: String(strength), oninput: (e: Event) => { strength = Number((e.target as HTMLInputElement).value); } }));
  /** While the button is held on the Ramp tool: the drag builds on. What the press had to say, if nothing built. */
  let rampDrag = false, rampProblem: string | null = null;
  const setTool = (t: Tool) => {
    tool = t;
    for (const [k, b] of buttons) b.classList.toggle("active", k === t);
    texWrap.hidden = t !== "paint";
    if (t !== "paint") { tilePanel.hidden = true; tilesButton.classList.remove("active"); }
    strengthWrap.hidden = t !== "raise" && t !== "lower" && t !== "noise";
    cliffWrap.hidden = !isLayerTool(t) || t === "dry";
    if (!cliffWrap.hidden) void fillCliffTypes();
    ed.setBrush(null);
    ed.focus();
  };
  // Row 1: the tools in sections; row 2: the active tool's options.
  const toolbar = h("div.terrain-group-tools.painter-bar", {},
    h("div.painter-sections", {}, ...SECTIONS.map(([name, tools]) => h("div.painter-section", {},
      h("span.painter-section-title", {}, name),
      h("div.painter-section-buttons", {}, ...tools.map(([t, label, title]) => {
        // Narrow toolbars show icons only (the name stays in the tooltip).
        const b = h("button.tool-button", { title: `${label}: ${title}`, onclick: () => setTool(t) }, toolIcon(t), h("span.tool-label", {}, label));
        buttons.set(t, b);
        return b;
      }))))),
    h("div.painter-options", {}, h("label.terrain-tool-opt", { title: "Brush size, as the World Editor's: centred on the corner nearest the pointer, it reaches Size − 1 tiles from it (Size 1: that corner)" }, "Size ",
      h("input", { type: "range", min: "1", max: "10", value: String(size), oninput: (e: Event) => { size = Number((e.target as HTMLInputElement).value); } })),
    h("label.terrain-tool-opt", { title: "Brush shape (not for ramps)" }, "Shape ",
      h("select", { onchange: (e: Event) => { square = (e.target as HTMLSelectElement).value === "square"; ed.focus(); } },
        h("option", { value: "round" }, "Round"), h("option", { value: "square" }, "Square"))),
    strengthWrap, cliffWrap, texWrap),
    tilePanel,
  );
  setTool("paint");

  return {
    toolbar,
    deactivate() { endStroke(); ed.setBrush(null); },
    pointerDown(p) {
      if (!ed.editable || !p.ground) return false;
      const g = p.ground;
      if (tool === "ramp") {
        // The press builds or, on a ramp, takes it off; a drag goes on building from there.
        const s = new Stroke("ramp");
        const r = rampClick(terrain, g[0], g[1], s);
        rampProblem = r.problem ?? null;
        stroke = { s, target: 0, layer: { layer: 2 }, last: performance.now() };
        rampDrag = r.done !== "removed";
        if (r.done !== "none") ed.terrainChanged(true);
        return true;
      }
      const start = async () => {
        if (tool === "paint") {
          const i = await ed.ensureGroundTile(paintTile);
          if (i === null) return;
          paintTex = i;
          void fillPalette();
        }
        const c = terrain.corners[Math.round((g[1] - terrain.offsetY) / 128) * terrain.width + Math.round((g[0] - terrain.offsetX) / 128)];
        // Cliff tools step one level from the start point; water goes one or two levels below
        // it, with the surface the water offset (89.6) under its original ground, as the World
        // Editor does: its shallow water is 38.4 deep, deep water 166.4 (12 game maps).
        // A Decrease from too low a level does nothing, as the editor's (strokeLayer): no stroke, no undo step.
        const to = c && isLayerTool(tool) ? strokeLayer(tool, c.layer) : c?.layer;
        if (to === null) return;
        const layer: LayerTarget = c ? { layer: to ?? c.layer, waterLevel: waterLevelAt(c.height - WATER_OFFSET), start: c.layer } : { layer: 2 };
        stroke = { s: new Stroke(tool), target: c ? groundHeight(c) : 0, layer, last: performance.now(), px: [p.event.clientX, p.event.clientY] };
        if (tool === "raise" || tool === "lower" || tool === "smooth" || tool === "noise") startHeight(g);
        else applyAt(g);
      };
      void start();
      return true;
    },
    pointerMove(p) {
      // The corner brush shows where it acts: round the nearest corner, half a tile past the corners it takes.
      const shown = p.ground && tool !== "ramp" ? brushOf(tool, terrain, p.ground[0], p.ground[1], size, square) : null;
      ed.setBrush(p.ground ? { x: shown?.x ?? p.ground[0], y: shown?.y ?? p.ground[1], r: shown ? brushReach(shown) : 128, rgb: BRUSH_COLORS[tool], square: square && tool !== "ramp" } : null);
      if (tool === "ramp") {
        if (p.down && rampDrag && stroke && p.ground && performance.now() - stroke.last > HEIGHT_TICK) {
          stroke.last = performance.now();
          if (rampClick(terrain, p.ground[0], p.ground[1], stroke.s, true).done === "built") { rampProblem = null; ed.terrainChanged(true); }
        }
        return;
      }
      // Re-apply while held, a few times per second, where the pointer went. Not for a move that stays on the same
      // pixel (a pointer held still can still send them: app-smoke's clicks on Linux did): the ground under it has just risen or sunk, so
      // it would land on the next corner (a +1 click of size 3 took 18 corners, not the World Editor's 13).
      const px: [number, number] = [p.event.clientX, p.event.clientY];
      const still = !!stroke?.px && stroke.px[0] === px[0] && stroke.px[1] === px[1];
      if (p.down && stroke?.height && p.ground) stroke.height.moveTo([p.ground[0], p.ground[1]]);
      else if (p.down && stroke && p.ground && !still && performance.now() - stroke.last > HEIGHT_TICK) { stroke.px = px; applyAt(p.ground); }
    },
    pointerUp() {
      endStroke();
      rampDrag = false;
      // Only now: a press beside the cliff may have led to one on it.
      if (rampProblem) void w3.window.showWarning(rampProblem);
      rampProblem = null;
    },
    pointerLeave() { if (!stroke) ed.setBrush(null); },
    changed(what) {
      // Tile list edits (and their undo) change the palette and the panel.
      if (!what.terrain) return;
      if (paintTex >= terrain.groundTiles.length) paintTex = 0;
      if (!terrain.groundTiles.includes(paintTile)) paintTile = terrain.groundTiles[0] ?? "";
      void fillPalette();
      void renderTiles();
      void fillCliffTypes();
    },
  };
}
