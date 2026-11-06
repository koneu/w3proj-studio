// Terrain Painter: the terrain brushes as a tool group of the terrain editor
// (service "w3.terrain"): height, ground textures, cliffs, water, blight, ramps.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { TERRAIN_SERVICE, type TerrainEditorHandle, type TerrainService, type TerrainToolGroupInstance } from "../../extensions/services";
import { parseSlk } from "../../lib/formats/text";
import { TILESETS } from "../../lib/terrain/tilesets";
import { HEIGHT_TICK, heightPerPoint, strokePoints } from "../../lib/terrain/strokepath";
import { groundHeight, waterLevelAt, WATER_OFFSET } from "../../lib/terrain/w3e";
import { h } from "../../workbench/dom";
import { toolIcon } from "./toolicons";
import { applyHeight, applyLayer, matchCliffTypes, paintBlight, paintTexture, Stroke, toggleRamp, type HeightTool, type LayerTarget, type LayerTool } from "./tools";

type Tool = HeightTool | LayerTool | "paint" | "ramp" | "blight" | "unblight";
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
  ]],
  ["Cliffs", [
    ["cliffUp", "+1", "Raise a cliff level (one above where the stroke starts)"],
    ["cliffUp2", "+2", "Raise two cliff levels (two above where the stroke starts)"],
    ["cliffLevel", "Level", "Bring everything to the cliff level where the stroke starts"],
    ["cliffDown", "−1", "Lower a cliff level (one below where the stroke starts)"],
    ["cliffDown2", "−2", "Lower two cliff levels (two below where the stroke starts)"],
    ["ramp", "Ramp", "Click a one-level cliff edge to build a ramp (Size sets its width); click a ramp to remove it"],
    ["shallow", "Shallow", "Shallow water: one level below where the stroke starts"],
    ["deep", "Deep", "Deep water: two levels below where the stroke starts"],
    ["dry", "Dry", "Remove water (use Cliffs +1 to raise the ground again)"],
  ]],
  ["Terrain", [
    ["raise", "Raise", "Raise the ground"], ["lower", "Lower", "Lower the ground"],
    ["plateau", "Plateau", "Level to the height where the stroke starts"], ["smooth", "Smooth", "Smooth bumps"],
  ]],
];

const BRUSH_COLORS: Record<Tool, [number, number, number]> = {
  raise: [120, 220, 255], lower: [255, 150, 90], plateau: [255, 230, 120], smooth: [190, 160, 255], paint: [140, 255, 140],
  cliffUp: [255, 200, 120], cliffUp2: [255, 180, 90], cliffLevel: [240, 220, 160], cliffDown: [220, 140, 80], cliffDown2: [200, 110, 60], shallow: [110, 190, 255], deep: [60, 120, 255], dry: [210, 190, 150],
  ramp: [255, 170, 220], blight: [170, 120, 200], unblight: [200, 220, 160],
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
  let stroke: { s: Stroke; target: number; layer: LayerTarget; last: number; at?: [number, number] } | null = null;

  /** One brush application at a ground point; true if it changed something. */
  const stamp = (x: number, y: number, amount = strength): boolean => {
    if (!stroke) return false;
    const brush = { x, y, radius: size, square };
    return tool === "paint"
      ? paintTexture(terrain, brush, paintTex, stroke.s)
      : tool === "blight" || tool === "unblight"
      ? paintBlight(terrain, brush, tool === "blight", stroke.s)
      : isLayerTool(tool)
      ? applyLayer(terrain, brush, tool, stroke.layer, stroke.s)
      : applyHeight(terrain, brush, tool as HeightTool, tool === "plateau" ? stroke.target : amount, stroke.s);
  };
  /** Raise and Lower go by time, not by mouse events: what a moment adds is shared out along the
   *  way the mouse went, so a quick drag is lower but has no gaps, and holding still keeps going. */
  const addsUp = () => tool === "raise" || tool === "lower";
  /** The brush at a ground point, and along the way from the last one. */
  const applyAt = (p: [number, number, number]) => {
    if (!stroke) return;
    const now = performance.now(), first = !stroke.at;
    const points = first ? [[p[0], p[1]] as [number, number]] : strokePoints(stroke.at!, [p[0], p[1]], size * BRUSH_SPACING);
    const amount = addsUp() ? heightPerPoint(strength, first ? HEIGHT_TICK : now - stroke.last, points.length) : strength;
    let did = false;
    for (const [x, y] of points) did = stamp(x, y, amount) || did;
    stroke.at = [p[0], p[1]];
    stroke.last = now;
    if (did) ed.terrainChanged();
  };
  /** While the button is down and the mouse still, height brushes keep working. */
  let holding: ReturnType<typeof setInterval> | undefined;
  const hold = () => {
    clearInterval(holding);
    if (tool !== "raise" && tool !== "lower" && tool !== "smooth") return;
    holding = setInterval(() => {
      if (stroke?.at && performance.now() - stroke.last >= HEIGHT_TICK) applyAt([stroke.at[0], stroke.at[1], 0]);
    }, HEIGHT_TICK);
  };
  const endStroke = () => {
    clearInterval(holding);
    if (!stroke) return;
    const s = stroke.s;
    stroke = null;
    // Cliffs next to painted ground or new cliffs take the cliff type of their ground tile.
    const chosen = isLayerTool(s.label as Tool) && cliffType >= 0 ? cliffType : undefined;
    const retyped = (s.label === "paint" || isLayerTool(s.label as Tool)) && matchCliffTypes(terrain, s.area(), ed.cliffGroundTiles(), s, chosen);
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
  const renderTiles = async () => {
    if (tilePanel.hidden) return;
    const names = await tileNames(w3);
    const usage = ed.groundTileUsage();
    const total = usage.reduce((a, b) => a + b, 0) || 1;
    const t = terrain.groundTiles;
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
      ...t.map((id, i) => {
        const img = h("img", { alt: id });
        void ed.groundTileThumb(id).then((src) => { if (src) img.src = src; });
        const label = `${names.get(id) ?? id} (${id})`;
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
    );
  };
  const tilesButton = h("button", { title: "The map's ground tiles: drawing order and removal", onclick: () => {
    tilePanel.hidden = !tilePanel.hidden;
    tilesButton.classList.toggle("active", !tilePanel.hidden);
    removing = null;
    void renderTiles();
  } }, "Tiles…");
  const texWrap = h("span.terrain-tool-opt", {}, thumbs, texSelect, tilesButton);
  // Cliff type for the cliff and water tools (the World Editor's cliff palette choice): a cliff
  // type number, or -1 to match the ground under the cliff.
  let cliffType = -1;
  const cliffSelect = h("select", { onchange: () => { cliffType = Number(cliffSelect.value); ed.focus(); } });
  const fillCliffTypes = async () => {
    const names = await tileNames(w3);
    const grounds = ed.cliffGroundTiles();
    if (cliffType >= grounds.length) cliffType = -1;
    cliffSelect.replaceChildren(
      h("option", { value: "-1", selected: cliffType < 0, title: "The cliff type of the ground tile under the cliff, where it has one" }, "Match the ground"),
      ...grounds.map((g, i) => h("option", { value: String(i), selected: cliffType === i }, `${names.get(g) ?? g} cliff`)));
  };
  const cliffWrap = h("label.terrain-tool-opt", { title: "Which cliff new cliffs get" }, "Cliff type ", cliffSelect);
  const strengthWrap = h("label.terrain-tool-opt", { title: "How fast the ground rises or sinks at the brush's centre, while the button is held" }, "Strength ",
    h("input", { type: "range", min: "2", max: "64", value: String(strength), oninput: (e: Event) => { strength = Number((e.target as HTMLInputElement).value); } }));
  const setTool = (t: Tool) => {
    tool = t;
    for (const [k, b] of buttons) b.classList.toggle("active", k === t);
    texWrap.hidden = t !== "paint";
    if (t !== "paint") { tilePanel.hidden = true; tilesButton.classList.remove("active"); }
    strengthWrap.hidden = t !== "raise" && t !== "lower";
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
    h("div.painter-options", {}, h("label.terrain-tool-opt", { title: "Brush radius in tiles" }, "Size ",
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
        const s = new Stroke("ramp");
        const problem = toggleRamp(terrain, g[0], g[1], size, s);
        if (problem) w3.window.showWarning(problem);
        else { stroke = { s, target: 0, layer: { layer: 2 }, last: 0 }; endStroke(); }
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
        const step = ({ cliffUp: 1, cliffUp2: 2, cliffDown: -1, cliffDown2: -2, shallow: -1, deep: -2 } as Partial<Record<Tool, number>>)[tool] ?? 0;
        const layer: LayerTarget = c ? { layer: Math.max(0, Math.min(15, c.layer + step)), waterLevel: waterLevelAt(c.height - WATER_OFFSET) } : { layer: 2 };
        stroke = { s: new Stroke(tool), target: c ? groundHeight(c) : 0, layer, last: performance.now() };
        applyAt(g);
        hold();
      };
      void start();
      return true;
    },
    pointerMove(p) {
      ed.setBrush(p.ground ? { x: p.ground[0], y: p.ground[1], r: size * 128, rgb: BRUSH_COLORS[tool], square: square && tool !== "ramp" } : null);
      // Re-apply while held, a few times per second.
      if (p.down && stroke && p.ground && performance.now() - stroke.last > HEIGHT_TICK) applyAt(p.ground);
    },
    pointerUp() { endStroke(); },
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
