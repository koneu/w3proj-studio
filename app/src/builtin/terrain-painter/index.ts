// Terrain Painter: the terrain brushes as a tool group of the terrain editor
// (service "w3.terrain"): height, ground textures, cliffs, water, blight, ramps.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { MAP_INFO_SERVICE, TERRAIN_SERVICE, type MapInfoService, type TerrainEditorHandle, type TerrainService, type TerrainToolGroupInstance } from "../../extensions/services";
import { MAP_EXTRA_PATH, readMapExtra } from "../../lib/formats/mapextra";
import { parseSlk } from "../../lib/formats/text";
import { MAX_CLIFF_TYPES } from "../../lib/terrain/cliffs";
import { terrainPath } from "../../lib/terrain/w3etext";
import { HEIGHT_TICK, strokePoints } from "../../lib/terrain/strokepath";
import { h } from "../../workbench/dom";
import { SETTINGS_DOC, settingsEditor } from "./settings";
import { toolIcon } from "./toolicons";
import { applyHeight, applyLayer, paintBlight, paintBoundary, paintTexture, retypeCliffs, Stroke, layerTarget, rampClick, brushOf, brushReach, takesShape, topRefusal, type HeightTool, type LayerTarget, type LayerTool } from "./tools";

type Tool = HeightTool | LayerTool | "paint" | "ramp" | "blight" | "unblight" | "boundary" | "unboundary";
const LAYER_TOOLS: Tool[] = ["cliffUp", "cliffUp2", "cliffLevel", "cliffDown", "cliffDown2", "shallow", "deep", "dry"];
const isLayerTool = (t: Tool): t is LayerTool => LAYER_TOOLS.includes(t);

/** World units between brush stamps per step of the brush size (half its radius). */
const BRUSH_SPACING = 64;
/** How far (world units) the pointer's ground point must have gone from a Raise, Lower or Smooth stroke's last stamp
 *  for the next tick to stamp again: an eighth of a tile, so a hand that shakes a pixel adds nothing. */
const STEP_MOVE = 16;

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
    ["ramp", "Ramp", "Click the edge of a one-level cliff: the corner nearest the pointer and the two below it become ramp, as in the World Editor (Size doesn't matter); click or drag along the edge for a wider ramp; hold Shift to take off what a click there would build"],
    ["shallow", "Shallow", "Shallow water: one level below where the stroke starts"],
    ["deep", "Deep", "Deep water: two levels below where the stroke starts"],
    ["dry", "Dry", "Remove water (use Cliffs +1 to raise the ground again)"],
  ]],
  ["Terrain", [
    ["raise", "Raise", "Raise the ground: a step per click, as the World Editor's (6.4 a Size at the centre), and more while the pointer moves; holding still adds nothing"], ["lower", "Lower", "Lower the ground: a step per click, as the World Editor's, and more while the pointer moves"],
    ["plateau", "Plateau", "Level to the height where the stroke starts"], ["smooth", "Smooth", "Smooth bumps: a step per click, and more while the pointer moves"],
    ["noise", "Noise", "Roughen the ground: every corner under the brush goes up or down by up to 64 at random, once per click or step of the drag"],
  ]],
];

const BRUSH_COLORS: Record<Tool, [number, number, number]> = {
  raise: [120, 220, 255], lower: [255, 150, 90], plateau: [255, 230, 120], smooth: [190, 160, 255], noise: [160, 230, 190], paint: [140, 255, 140],
  cliffUp: [255, 200, 120], cliffUp2: [255, 180, 90], cliffLevel: [240, 220, 160], cliffDown: [220, 140, 80], cliffDown2: [200, 110, 60], shallow: [110, 190, 255], deep: [60, 120, 255], dry: [210, 190, 150],
  ramp: [255, 170, 220], blight: [170, 120, 200], unblight: [200, 220, 160], boundary: [120, 120, 130], unboundary: [220, 220, 230],
};

/** The terrain editors open now (each has a painter), for the Terrain Settings tab; `editorsChanged` when they change. */
const editors = new Set<TerrainEditorHandle>();
const editorsChanged = new Set<() => void>();
const editorsSet = {
  add(ed: TerrainEditorHandle) { editors.add(ed); for (const f of editorsChanged) f(); },
  delete(ed: TerrainEditorHandle) { editors.delete(ed); for (const f of editorsChanged) f(); },
};

/** The project's terrain editor (the newest open one of the project's terrain file), or null. */
function projectEditor(w3: W3Api): TerrainEditorHandle | null {
  const path = terrainPath(w3.workspace.files().map((f) => f.path));
  return [...editors].reverse().find((e) => e.path === path) ?? null;
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  void w3.services.get<TerrainService>(TERRAIN_SERVICE).then((s) => {
    ctx.subscriptions.push(s.registerToolGroup({ id: "terrain", title: "Terrain", order: 10, create: (ed) => painter(w3, ed) }));
  });
  const openEditor = async () => {
    if (!projectEditor(w3)) await w3.commands.execute("w3.terrain.open");
    // The painter is made with the editor's tools: wait for it (a few frames).
    for (let i = 0; i < 100 && !projectEditor(w3); i++) await new Promise((r) => setTimeout(r, 50));
  };
  ctx.subscriptions.push(
    w3.editors.registerProvider(SETTINGS_EDITOR, {
      resolve: (el) => settingsEditor(w3, el, {
        editor: () => projectEditor(w3),
        onEditors: (f) => { editorsChanged.add(f); return { dispose: () => editorsChanged.delete(f) }; },
        openEditor: async () => { await openEditor(); await w3.editors.open(SETTINGS_DOC, SETTINGS_EDITOR); },
        tileNames: () => tileNames(w3),
      }),
    }),
    // Edit Tileset / Terrain Settings: the terrain editor opened behind it if need be (the settings are its edits).
    w3.commands.register("w3.terrain.settings", async () => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      await openEditor();
      await w3.editors.open(SETTINGS_DOC, SETTINGS_EDITOR);
    }),
  );
}

/** The Terrain Settings tab's editor id. */
export const SETTINGS_EDITOR = "w3.terrainSettings";

/** Every ground tile type the game knows: a readable name per id. */
let catalog: Promise<Map<string, string>> | null = null;
const tileNames = (w3: W3Api) => (catalog ??= w3.game.readText("TerrainArt\\Terrain.slk")
  .then((t) => new Map(parseSlk(t).filter((r) => r.tileID).map((r) => [r.tileID, r.comment || r.file])))
  .catch(() => new Map<string, string>()));

function painter(w3: W3Api, ed: TerrainEditorHandle): TerrainToolGroupInstance {
  const terrain = ed.terrain;
  let tool: Tool = "paint", size = 2, paintTex = 0, square = false;
  /** Tile type chosen for painting (may not be in the map yet). */
  let paintTile = terrain.groundTiles[0] ?? "";
  /** `px`: where on the page the pointer was at the last dab (clientX, clientY). */
  /** `target`: Plateau's stored ground word. `stepped`: a Raise, Lower, Smooth or Noise stroke's last stamp (ground point,
   *  page pixel) and the pointer's newest place since (steppedTick). */
  let stroke: {
    s: Stroke; target: number; layer: LayerTarget; last: number; at?: [number, number]; px?: [number, number];
    /** The newest move that came inside the HEIGHT_TICK window and wasn't stamped: pointerUp stamps it, so a quick drag keeps its last column. */
    held?: { g: [number, number]; px: [number, number] };
    stepped?: { at: [number, number]; px: [number, number]; next?: { g: [number, number]; px: [number, number] } };
    /** Takes the cliff type the stroke's start appended (claimDefaultCliffType) back out when the stroke changes nothing. */
    takeBack?: () => void;
    /** A cliff or water stroke that paints the chosen tile too (the World Editor's Apply Texture beside Apply Cliff). */
    paints?: boolean;
    /** The cliff brush can do nothing here (a Decrease from the floor): the stroke only paints. */
    paintOnly?: boolean;
  } | null = null;

  /** The World Editor's Enforce Water Height Limits (the terrain editor's switch, on unless set off). */
  const enforceWater = () => w3.settings.get<boolean>("terrain.enforceWaterLimits", true) !== false;
  /** The map's Enforce Terrain Limits as war3mapExtra.txt has it saved: off when the map has none, null while it is
   *  being read or when it is there but can't be read. */
  let savedLimits: boolean | null = null;
  let limitsRead = 0;
  const root = w3.workspace.project()?.root ?? null;
  const readLimits = async () => {
    const n = ++limitsRead;
    let on: boolean | null;
    try {
      on = readMapExtra(await w3.workspace.readText(MAP_EXTRA_PATH)).enforceTerrainLimits === true;
    } catch {
      // Absent is off; a file that is listed but unreadable says nothing (not off: that would let Increase wrap).
      await w3.workspace.filesReady().catch(() => {});
      on = w3.workspace.files().some((f) => f.path.toLowerCase() === MAP_EXTRA_PATH.toLowerCase()) ? null : false;
    }
    // A later read (the file saved again) or another project wins.
    if (n === limitsRead && (w3.workspace.project()?.root ?? null) === root) savedLimits = on;
  };
  void readLimits();
  const stopLimitsWatch = w3.workspace.onDidSave((path) => { if (path.toLowerCase() === MAP_EXTRA_PATH.toLowerCase()) { savedLimits = null; void readLimits(); } });
  let mapInfo: MapInfoService | null = null;
  void w3.services.get<MapInfoService>(MAP_INFO_SERVICE).then((s) => { mapInfo = s; }, () => {});
  /** Enforce Terrain Limits for a cliff stroke: the open Map Properties' (unsaved changes too), else the saved file's;
   *  unknown counts as on, the side that refuses more (strokeLayer). */
  const enforceLimits = () => (root !== null ? mapInfo?.liveEnforceTerrainLimits(root) : null) ?? savedLimits ?? true;
  /** One brush application at a ground point; true if it changed something. */
  const stamp = (x: number, y: number): boolean => {
    if (!stroke) return false;
    const brush = brushOf(tool, terrain, x, y, size, square);
    // Both at once: the tile first, then the cliff, as the two strokes after each other give the Editor's file.
    const painted = !!stroke.paints && paintTexture(terrain, brushOf("paint", terrain, x, y, size, square), paintTex, stroke.s, false);
    const done = stroke.paintOnly ? false : tool === "paint"
      ? paintTexture(terrain, brush, paintTex, stroke.s)
      : tool === "blight" || tool === "unblight"
      ? paintBlight(terrain, brush, tool === "blight", stroke.s)
      : tool === "boundary" || tool === "unboundary"
      ? paintBoundary(terrain, brush, tool === "boundary", stroke.s)
      : isLayerTool(tool)
      ? applyLayer(terrain, brush, tool, stroke.layer, stroke.s, enforceWater())
      : applyHeight(terrain, brush, tool as HeightTool, tool === "plateau" ? stroke.target : 0, stroke.s);
    return done || painted;
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
  /** Raise, Lower, Smooth and Noise stamp as the World Editor's do (steppedTick): once at the press, then at each tick
   *  the pointer has moved on since the last stamp. */
  let holding: ReturnType<typeof setInterval> | undefined;
  const heightTick = () => steppedTick();
  /** A Raise, Lower, Smooth or Noise stroke's tick: one stamp at the pointer's newest place, if it has moved to another pixel
   *  and at least STEP_MOVE world units from the last stamp; nothing for the places between, as the World Editor's
   *  (it stamps only where the pointer is at its own ticks: a pointer held still for 3 s added nothing to the press's
   *  stamp, a drag of 20 steps of 1, 5, 10 and 15 px added 5, 15, 18 and 16 stamps to it; we-drive, 2026-11-15, branch
   *  raise-brush-we). */
  const steppedTick = () => {
    const s = stroke?.stepped;
    if (!s?.next) return;
    const { g, px } = s.next;
    s.next = undefined;
    if (px[0] === s.px[0] && px[1] === s.px[1]) return;
    if (Math.hypot(g[0] - s.at[0], g[1] - s.at[1]) < STEP_MOVE) return;
    s.at = g;
    s.px = px;
    if (stamp(g[0], g[1])) ed.terrainChanged();
  };
  const startHeight = (g: [number, number, number], px: [number, number]) => {
    if (!stroke) return;
    stroke.stepped = { at: [g[0], g[1]], px };
    if (stamp(g[0], g[1])) ed.terrainChanged();
    holding = setInterval(heightTick, HEIGHT_TICK);
  };
  /** The palette's cliff type as a number, or undefined for the ground tile's. */
  const chosenCliffType = (): number | undefined => {
    const type = cliffType === "default" ? ed.defaultCliffType() : cliffType;
    return type >= 0 ? type : undefined;
  };
  const endStroke = () => {
    heightTick();
    clearInterval(holding);
    if (!stroke) return;
    const s = stroke.s, takeBack = stroke.takeBack;
    stroke = null;
    // New cliffs and water take the chosen cliff type (or their ground tile's); painting ground re-types nothing.
    const chosen = isLayerTool(s.label as Tool) ? chosenCliffType() : undefined;
    const retyped = retypeCliffs(terrain, s, ed.cliffGroundTiles(), chosen);
    if (!s.finish(terrain)) { takeBack?.(); return; }
    // A cliff brush stroke (Level, ±1, ±2, the water tools) takes out the special doodads left without their cliff,
    // anywhere on the map, as the World Editor's does (lib/terrain/specialfit.ts); a ground tile stroke keeps them.
    ed.commitTerrain({ corners: s.corners(), undo: () => s.undo(terrain), redo: () => s.redo(terrain), cliffs: retyped || isLayerTool(s.label as Tool) || s.label === "ramp", specials: isLayerTool(s.label as Tool) });
  };

  // ---- toolbar -----------------------------------------------------------------------
  const buttons = new Map<Tool, HTMLButtonElement>();
  const thumbs = h("span.terrain-tex-thumbs");
  const thumbButtons = new Map<string, HTMLButtonElement>();
  /** `reset`: a chosen tile no slot is drawn with goes back to the first slot's (after the list changed). The picker
   *  shows the map's palette only; the palette itself is set up in the Terrain Settings tab (settings.ts). */
  const fillPalette = async (reset = false) => {
    const names = await tileNames(w3);
    // The tiles as drawn: with the w3e flag "custom tilesets" 0 the tileset's own list, not the file's.
    const was = paintTile, shown = await ed.paletteGroundTiles().catch(() => [...new Set(terrain.groundTiles)]);
    if (reset && paintTile === was && !shown.includes(paintTile)) paintTile = shown[0] ?? "";
    // Same tiles as shown: only the highlight moves. Rebuilding the buttons would leave their pictures empty (the row
    // collapsing) until each thumbnail has loaded again.
    if (shown.length === thumbButtons.size && shown.every((id, i) => [...thumbButtons.keys()][i] === id)) {
      for (const [id, b] of thumbButtons) b.classList.toggle("on", id === paintTile);
      return;
    }
    thumbButtons.clear();
    thumbs.replaceChildren(...shown.map((id) => {
      const img = h("img", { alt: id });
      void ed.groundTileThumb(id).then((src) => { if (src) img.src = src; });
      const b = h(`button.terrain-tex-thumb${id === paintTile ? ".on" : ""}`, {
        title: `${names.get(id) ?? id} (${id})`,
        onclick: () => { paintTile = id; void fillPalette(); ed.focus(); },
      }, img);
      thumbButtons.set(id, b);
      return b;
    }));
  };
  void fillPalette(true);

  // The map's tile list itself (tileset, template, order, adding, removal) is set up in the Terrain Settings tab.
  const texWrap = h("span.terrain-tool-opt", { title: "Paint with one of the map's ground tiles (the list: Edit Tileset / Terrain Settings)" }, thumbs);
  // Cliff type for the cliff and water tools (the World Editor's cliff palette choice): a cliff type number, -1 to
  // match the ground under the cliff, or until one is chosen the one the World Editor's palette starts on.
  let cliffType: number | "default" = "default";
  /** The chosen entry's id: when the cliff list changes (the Terrain Settings tab, an undo) the choice follows its entry. */
  let cliffTypeId: string | null = null;
  const cliffSelect = h("select", { onchange: () => {
    cliffType = Number(cliffSelect.value);
    cliffTypeId = cliffType >= 0 ? terrain.cliffTiles[cliffType] ?? null : null;
    ed.focus();
  } });
  const fillCliffTypes = async () => {
    const names = await tileNames(w3);
    const grounds = ed.cliffGroundTiles();
    if (typeof cliffType === "number" && cliffType >= 0 && terrain.cliffTiles[cliffType] !== cliffTypeId) {
      // The list changed under the choice: its entry's new number, or (gone) the palette's start again.
      const at = cliffTypeId === null ? -1 : terrain.cliffTiles.indexOf(cliffTypeId);
      cliffType = at >= 0 && at < MAX_CLIFF_TYPES ? at : "default";
    }
    if (typeof cliffType === "number" && cliffType >= Math.min(grounds.length, MAX_CLIFF_TYPES)) cliffType = "default";
    const shown = cliffType === "default" ? ed.defaultCliffType() : cliffType;
    // Only the first 15 entries: a corner's cliff type is 0 to 14 (15 is reserved), the rest can't be painted.
    cliffSelect.replaceChildren(
      h("option", { value: "-1", selected: shown < 0, title: "The cliff type of the ground tile under the cliff, where it has one" }, "Match the ground"),
      ...grounds.slice(0, MAX_CLIFF_TYPES).flatMap((g, i) => (g ? [h("option", { value: String(i), selected: shown === i }, `${names.get(g) ?? g} cliff (${terrain.cliffTiles[i]})`)] : [])));
  };

  // The cliff list itself (add the game's cliff types, remove entries) is set up in the Terrain Settings tab.
  const cliffWrap = h("span.terrain-tool-opt", {}, h("label.terrain-tool-opt", { title: "Which cliff new cliffs get (the map's cliff types: Edit Tileset / Terrain Settings)" }, "Cliff type ", cliffSelect));
  /** While the button is held on the Ramp tool: the drag builds on. What the press had to say, if nothing built. */
  let rampRemove = false, rampProblem: string | null = null;
  /** The tools whose stroke can paint a tile too: the cliff and water brushes (not Studio's own Dry). */
  const cliffPaints = (t: Tool) => isLayerTool(t) && t !== "dry";
  let paintToo = false;
  const paintTooBox = h("input", { type: "checkbox", onchange: () => { paintToo = paintTooBox.checked; setTool(tool); } }) as HTMLInputElement;
  const paintTooWrap = h("label.terrain-tool-opt.painter-paint-too", { title: "Each stamp paints the chosen ground tile too, as the World Editor's Apply Texture beside Apply Cliff (one undo step)" }, paintTooBox, "Paint texture too");
  const setTool = (t: Tool) => {
    tool = t;
    for (const [k, b] of buttons) b.classList.toggle("active", k === t);
    paintTooWrap.hidden = !cliffPaints(t);
    texWrap.hidden = !(t === "paint" || (paintToo && cliffPaints(t)));
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
    h("label.terrain-tool-opt", { title: "Brush shape (not for Raise, Lower and ramps: they stay round, as the World Editor's)" }, "Shape ",
      h("select", { onchange: (e: Event) => { square = (e.target as HTMLSelectElement).value === "square"; ed.focus(); } },
        h("option", { value: "round" }, "Round"), h("option", { value: "square" }, "Square"))),
    cliffWrap, paintTooWrap, texWrap),
  );
  setTool("paint");
  editorsSet.add(ed);

  return {
    toolbar,
    deactivate() { endStroke(); ed.setBrush(null); },
    dispose() { stopLimitsWatch.dispose(); editorsSet.delete(ed); },
    pointerDown(p) {
      if (!ed.editable || !p.ground) return false;
      const g = p.ground;
      if (tool === "ramp") {
        // A press builds, or with Shift takes off; a drag goes on doing the same, as the World Editor's.
        const s = new Stroke("ramp");
        rampRemove = p.event.shiftKey;
        const r = rampClick(terrain, g[0], g[1], s, rampRemove);
        rampProblem = r.problem ?? null;
        stroke = { s, target: 0, layer: { layer: 2 }, last: performance.now() };
        if (r.done !== "none") ed.terrainChanged(true);
        return true;
      }
      const start = async () => {
        const paints = paintToo && cliffPaints(tool);
        if (tool === "paint" || paints) {
          const i = await ed.ensureGroundTile(paintTile);
          if (i === null) return;
          paintTex = i;
          void fillPalette();
        }
        const cx = Math.round((g[0] - terrain.offsetX) / 128), cy = Math.round((g[1] - terrain.offsetY) / 128);
        const c = terrain.corners[cy * terrain.width + cx];
        // A Decrease from too low a level does nothing, as the editor's (layerTarget): no stroke, no undo step.
        const layer: LayerTarget | null = !c ? { layer: 2 } : isLayerTool(tool) ? layerTarget(terrain, tool, cx, cy, chosenCliffType(), enforceLimits()) : { layer: c.layer };
        let paintOnly = false;
        if (layer === null) {
          // Past the top is refused with a word (topRefusal); a Decrease from the floor stays quiet, as the editor's.
          const why = c && isLayerTool(tool) ? topRefusal(tool, c.layer, enforceLimits()) : null;
          if (why) void w3.window.showWarning(why);
          // With Paint texture too the tile is painted all the same, as the editor does (painted-with-cliff-floor).
          if (!paints || !c) return;
          paintOnly = true;
        }
        // On the palette's default a cliff list without the tileset's default cliff gets it first, as the World
        // Editor's water brush (CAgr CLdi became CAgr CLdi CLgr on Lordaeron Summer; claimDefaultCliffType).
        const claim = !paintOnly && isLayerTool(tool) && tool !== "dry" && cliffType === "default" ? ed.claimDefaultCliffType() : null;
        const target: LayerTarget = layer ?? { layer: c?.layer ?? 2 };
        if (claim) target.cliffType = claim.type >= 0 ? claim.type : undefined;
        stroke = { s: new Stroke(tool), target: c ? c.rawHeight : 0x2000, layer: target, last: performance.now(), px: [p.event.clientX, p.event.clientY], takeBack: claim?.takeBack, paints, paintOnly };
        if (tool === "raise" || tool === "lower" || tool === "smooth" || tool === "noise") startHeight(g, [p.event.clientX, p.event.clientY]);
        else applyAt(g);
      };
      void start();
      return true;
    },
    pointerMove(p) {
      // The corner brush shows where it acts: round the nearest corner, half a tile past the corners it takes.
      const shown = p.ground && tool !== "ramp" ? brushOf(tool, terrain, p.ground[0], p.ground[1], size, square) : null;
      ed.setBrush(p.ground ? { x: shown?.x ?? p.ground[0], y: shown?.y ?? p.ground[1], r: shown ? brushReach(shown) : 128, rgb: BRUSH_COLORS[tool], square: square && takesShape(tool) } : null);
      if (tool === "ramp") {
        if (p.down && stroke && p.ground && performance.now() - stroke.last > HEIGHT_TICK) {
          stroke.last = performance.now();
          if (rampClick(terrain, p.ground[0], p.ground[1], stroke.s, rampRemove).done !== "none") { rampProblem = null; ed.terrainChanged(true); }
        }
        return;
      }
      // Re-apply while held, a few times per second, where the pointer went. Not for a move that stays on the same
      // pixel (a pointer held still can still send them: app-smoke's clicks on Linux did): the ground under it has just risen or sunk, so
      // it would land on the next corner (a +1 click of size 3 took 18 corners, not the World Editor's 13).
      const px: [number, number] = [p.event.clientX, p.event.clientY];
      const still = !!stroke?.px && stroke.px[0] === px[0] && stroke.px[1] === px[1];
      if (p.down && stroke?.stepped && p.ground) stroke.stepped.next = { g: [p.ground[0], p.ground[1]], px };
      else if (p.down && stroke && p.ground && !still) {
        if (performance.now() - stroke.last > HEIGHT_TICK) { stroke.px = px; stroke.held = undefined; applyAt(p.ground); }
        else stroke.held = { g: [p.ground[0], p.ground[1]], px };
      }
    },
    pointerUp() {
      // A last move that came too soon after the previous stamp is stamped now (a different pixel than the last stamp).
      if (stroke?.held && !stroke.stepped) { const h = stroke.held; stroke.held = undefined; stroke.px = h.px; applyAt([h.g[0], h.g[1], 0]); }
      endStroke();
      // Only now: a press beside the cliff may have led to one on it.
      if (rampProblem) void w3.window.showWarning(rampProblem);
      rampProblem = null;
    },
    pointerLeave() { if (!stroke) ed.setBrush(null); },
    changed(what) {
      // Tile list edits (the Terrain Settings tab's, and their undo) change the picker and the cliff types.
      if (!what.terrain) return;
      if (paintTex >= terrain.groundTiles.length) paintTex = 0;
      void fillPalette(true);
      void fillCliffTypes();
    },
  };
}
