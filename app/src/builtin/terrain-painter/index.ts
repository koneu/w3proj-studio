// Terrain Painter: the terrain brushes as a tool group of the terrain editor
// (service "w3.terrain"): height, ground textures, cliffs, water, blight, ramps.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { TERRAIN_SERVICE, type TerrainEditorHandle, type TerrainService, type TerrainToolGroupInstance } from "../../extensions/services";
import { parseSlk } from "../../lib/formats/text";
import { TILESETS } from "../../lib/terrain/tilesets";
import { groundHeight, waterLevelAt } from "../../lib/terrain/w3e";
import { h } from "../../workbench/dom";
import { toolIcon } from "./toolicons";
import { applyHeight, applyLayer, matchCliffTypes, paintBlight, paintTexture, Stroke, toggleRamp, type HeightTool, type LayerTarget, type LayerTool } from "./tools";

type Tool = HeightTool | LayerTool | "paint" | "ramp" | "blight" | "unblight";
const LAYER_TOOLS: Tool[] = ["cliffUp", "cliffUp2", "cliffLevel", "cliffDown", "cliffDown2", "shallow", "deep", "dry"];
const isLayerTool = (t: Tool): t is LayerTool => LAYER_TOOLS.includes(t);

/** Maps hold at most this many ground tile types (World Editor limit). */
const MAX_GROUND_TILES = 16;

const TOOLS: [Tool, string, string][] = [
  ["paint", "Paint", "Paint a ground texture"],
  ["raise", "Raise", "Raise the ground"], ["lower", "Lower", "Lower the ground"],
  ["plateau", "Plateau", "Level to the height where the stroke starts"], ["smooth", "Smooth", "Smooth bumps"],
  ["cliffUp", "Cliff ↑", "Raise a cliff level (one above where the stroke starts)"],
  ["cliffUp2", "Cliff ↑↑", "Raise two cliff levels (two above where the stroke starts)"],
  ["cliffLevel", "Cliff level", "Bring everything to the cliff level where the stroke starts"],
  ["cliffDown", "Cliff ↓", "Lower a cliff level (one below where the stroke starts)"],
  ["cliffDown2", "Cliff ↓↓", "Lower two cliff levels (two below where the stroke starts)"],
  ["shallow", "Shallow water", "Water one level below where the stroke starts"], ["deep", "Deep water", "Water two levels below where the stroke starts"],
  ["dry", "Dry", "Remove water (use Cliff ↑ to raise the ground again)"],
  ["blight", "Blight +", "Paint Undead blight"], ["unblight", "Blight −", "Remove blight"],
  ["ramp", "Ramp", "Click a one-level cliff edge to build a ramp (Size sets its width); click a ramp to remove it"],
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
  let stroke: { s: Stroke; target: number; layer: LayerTarget; last: number } | null = null;

  /** One brush application at a ground point. */
  const applyAt = (p: [number, number, number]) => {
    if (!stroke) return;
    const brush = { x: p[0], y: p[1], radius: size, square };
    const did = tool === "paint"
      ? paintTexture(terrain, brush, paintTex, stroke.s)
      : tool === "blight" || tool === "unblight"
      ? paintBlight(terrain, brush, tool === "blight", stroke.s)
      : isLayerTool(tool)
      ? applyLayer(terrain, brush, tool, stroke.layer, stroke.s)
      : applyHeight(terrain, brush, tool as HeightTool, tool === "plateau" ? stroke.target : strength, stroke.s);
    if (did) ed.terrainChanged();
  };
  const endStroke = () => {
    if (!stroke) return;
    const s = stroke.s;
    stroke = null;
    // Cliffs next to painted ground or new cliffs take the cliff type of their ground tile.
    const chosen = isLayerTool(s.label as Tool) && cliffType >= 0 ? cliffType : undefined;
    const retyped = (s.label === "paint" || isLayerTool(s.label as Tool)) && matchCliffTypes(terrain, s.corners(), ed.cliffGroundTiles(), s, chosen);
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
    tilePanel.replaceChildren(
      h("div.muted", {}, "Draw order: tiles further down are drawn over the ones above them where they meet. Changes are one undo step each."),
      ...t.map((id, i) => {
        const img = h("img", { alt: id });
        void ed.groundTileThumb(id).then((src) => { if (src) img.src = src; });
        const label = `${names.get(id) ?? id} (${id})`;
        if (removing === i) {
          const others = t.map((o, j) => [o, j] as const).filter(([, j]) => j !== i);
          const sel = h("select", {}, ...others.map(([o, j]) => h("option", { value: String(j) }, `${names.get(o) ?? o} (${o})`)));
          return h("div.terrain-tilemgr-row.removing", {}, img, h("span", {}, `Remove ${label}: paint its ${usage[i].toLocaleString()} corners with`), sel,
            h("button", { onclick: () => { removing = null; ed.removeGroundTile(i, Number(sel.value)); } }, "Remove"),
            h("button", { onclick: () => { removing = null; void renderTiles(); } }, "Cancel"));
        }
        return h("div.terrain-tilemgr-row", {}, img,
          h("span.terrain-tilemgr-name", {}, label),
          h("span.muted", { title: `${usage[i].toLocaleString()} corners` }, `${((100 * usage[i]) / total).toFixed(1)}%`),
          h("button", { title: "Move up (drawn earlier, under the others)", disabled: i === 0, onclick: () => ed.moveGroundTile(i, i - 1) }, "↑"),
          h("button", { title: "Move down (drawn later, over the others)", disabled: i === t.length - 1, onclick: () => ed.moveGroundTile(i, i + 1) }, "↓"),
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
  const strengthWrap = h("label.terrain-tool-opt", { title: "Height change per application at the brush centre" }, "Strength ",
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
  const toolbar = h("div.terrain-group-tools", {},
    ...TOOLS.map(([t, label, title]) => {
      const b = h("button.tool-button", { title, onclick: () => setTool(t) }, toolIcon(t), label);
      buttons.set(t, b);
      return b;
    }),
    h("label.terrain-tool-opt", { title: "Brush radius in tiles" }, "Size ",
      h("input", { type: "range", min: "1", max: "10", value: String(size), oninput: (e: Event) => { size = Number((e.target as HTMLInputElement).value); } })),
    h("label.terrain-tool-opt", { title: "Brush shape (not for ramps)" }, "Shape ",
      h("select", { onchange: (e: Event) => { square = (e.target as HTMLSelectElement).value === "square"; ed.focus(); } },
        h("option", { value: "round" }, "Round"), h("option", { value: "square" }, "Square"))),
    strengthWrap, cliffWrap, texWrap, tilePanel,
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
        // Cliff tools step one level from the start point; water goes one or
        // two levels below it, with the surface at its original height.
        const step = ({ cliffUp: 1, cliffUp2: 2, cliffDown: -1, cliffDown2: -2, shallow: -1, deep: -2 } as Partial<Record<Tool, number>>)[tool] ?? 0;
        const layer: LayerTarget = c ? { layer: Math.max(0, Math.min(15, c.layer + step)), waterLevel: waterLevelAt(c.height - 8) } : { layer: 2 };
        stroke = { s: new Stroke(tool), target: c ? groundHeight(c) : 0, layer, last: performance.now() };
        applyAt(g);
      };
      void start();
      return true;
    },
    pointerMove(p) {
      ed.setBrush(p.ground ? { x: p.ground[0], y: p.ground[1], r: size * 128, rgb: BRUSH_COLORS[tool], square: square && tool !== "ramp" } : null);
      // Re-apply while held, a few times per second.
      if (p.down && stroke && p.ground && performance.now() - stroke.last > 40) {
        stroke.last = performance.now();
        applyAt(p.ground);
      }
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
