import { fogOf } from "../../lib/model/fog";
import { GAME_LIGHT_FILL, toneOf } from "../../lib/model/tone";
import { worldSphere } from "../../lib/model/frustum";
import { watchContextLoss } from "../../lib/model/contextloss";
import { runLayerJobs } from "./layerjobs";
import { deriveFromProject, editMapDoc, updateMinimapIcons as writeMinimapIcons, writeDerived } from "./derive";
import { weatherEffect, type WeatherBox } from "../../lib/model/weather";
import { skyList } from "./skies";
import { matchPlaced, type PlacedLike, type PlacedRef } from "./pickmatch";
import type { EditorDocument, ExtensionContext, W3Api } from "../../extensions/api";
import { customTilesFlag, TILESETS } from "../../lib/terrain/tilesets";
import { joinPath } from "../../lib/paths";
import { errorText, isNotFoundError } from "../../lib/oserror";
import { OBJECTS_SERVICE, TERRAIN_SERVICE, type ObjectsService, type TerrainEditorHandle, type TerrainToolGroupInstance } from "../../extensions/services";
import { TerrainToolRegistry, type HeightCommands, type ViewCommands } from "./toolhost";
import { parseHeight, pastedFlags, pastedHeight, resetFixedHeight, goesOnWater, uniformHeight, unitDrawHeight, unitLooks, unitSwims } from "./objheights";
import { cameraRect, clampPoint, insideBounds, limitTo, pasteSkipText, scaledNudge, waterLimitHits, type Bounds, type PasteSkips } from "./limits";
import { errorView, h } from "../../workbench/dom";
import { boxOf, composeLayers, GRID_STEP, groundPathingColors, layerCameras, layerRegions, navalColors, regionColors, toggleGrid, viewOfBox, type Box, type GridSize, type RegionBox } from "./viewcmds";
import { anyGroundLayer, cameraKey, keyOf, lightRings, nextTerrainLook, OWN_CHORDS, shownView, TERRAIN_LOOKS, viewKeyCommand, type TerrainLook, type ToggleLayer, type ViewSet } from "./viewmodes";
import { cameraColors, type CameraObject } from "../../lib/terrain/cameras";
import { decodeImage, type DecodedImage } from "../../lib/image/index.ts";
import { levelFor } from "../../lib/model/gltexture";
import { TEAM_COLORS, type Vec3 } from "../../lib/model/renderer";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { loadKind } from "../../lib/objects/metadata";
import { entryIds, renamedEntry } from "../../lib/terrain/entryids";
import { cliffList, planCliffs, type CliffType } from "./cliffs";
import { applyTileList, planRemoval, tileUse, unusedTiles } from "./tilecleanup";
import { loadSkins, ObjectLoader, objectsInRect, placement, withObjectArt, type ObjectArt, type Placed, type Stray } from "./objects";
import { cycledId, type RandomGroup } from "../../lib/terrain/randomplace";
import { exportMinimap, type ExportOptions, type ExportSource } from "./minimapexport";
import { buildMinimap, iconKinds, minimapBase, minimapIconImage, minimapSettings } from "./minimapgen";
import { askNewMap, createMap, loadTilesets, mapChoices, playableOf, type NewMapPreset } from "./newmap";
import { compileExpr, compileFilter, evalFor, type ObjVars } from "./massedit";
import { Occupancy } from "./occupancy";
import { buildPathingMap, loadPathingData, type PathingData } from "./pathmap";
import { loadPlacedFile, newEntry, onBuildingGrid, pastedEntry, savePlacedFile, type PlacedFile } from "./placement";
import { SaveMark, Stale, saveSnapshot, serial } from "./savemark";
import { isUprooted, meleeFlagsAfter, placedText, splitOwners } from "../../lib/terrain/owner";
import { jsonPathOf, mapStrings, readMapDoc, readMapDocStrict, requireProject, terrainFacts } from "../../lib/formats/mapdoc";
import { beyondPlayable, borderShade, inArea, isBackdrop, isKeptClear, playableArea, readArea, type Area, type KeepClear } from "../../lib/terrain/area";
import { checkPath, checkRoute, findPockets, nearestObject, type Grid, narrowStrips, widestFrom, widthOf } from "./pathcheck";
import { campsOf, checkMelee } from "./meleecheck";
import { borderFlags, FIXED_HEIGHT, isObjectEditorKey, isRecallKey, joinSteps, OUTSIDE_PLAYABLE, scaled, selectionKey, turnKey, type SelectionKey } from "./selectionkeys";
import { resetVariations } from "../../lib/terrain/variation";
import { adjustLevels, CornerUndo } from "../../lib/terrain/cliffs";
import { areaBetween, changeArea, centreOf, fragmentOf, groundOf, tileOf, groundOrigin, restoreTiles, snapped, stampGround, tileSnapshot, turnAngle, turnFragment, turnOffset, type CornerArea, type Fragment, type FragmentObject, type Turn } from "../../lib/terrain/fragment";
import { findSpots } from "./meleespots";
import { resizedSize } from "../../lib/terrain/resize";
import { replaceableBy, replaceableKinds, dress, followGround, groundSlot, heightColors, heightGrid, hiddenInPicture, lineSpots, outsideAfterResize, paintCorners, paintPath, pathingColors, roughenCorners, replacePlaced, rowSpots, scatterSpots, seededRandom, swapTiles, sculptCorners, spotsAround, terrainSummary, viewOfArea, type Dressing, type ViewAngle, setCliffs, setCliffType, setRamp, setUnitChoices, setWater, twinOf, whyNoRoom, withCliffTypes, type CliffKind, type UnitChoices } from "./aitools";
import { changedTypes, changesImports, changesObjectData, changesPathing, DebouncedReload } from "./filewatch";
import { askReplace, replaceCorners, replaceTitle, swapsOf, type ReplaceRequest, type ReplaceTypes } from "./replace";
import { bounds } from "../../lib/model/renderer";
import type { McpToolHandler } from "../../extensions/api";
import { isTerrainText, w3eFromText, w3eToText } from "../../lib/terrain/w3etext";
import { NO_WALK, NO_BUILD } from "../../lib/terrain/pathing";
import { MCP_EDITS_SERVICE, type McpEditsService, type TerrainOccupancy, type TerrainView } from "../../extensions/services";
import { CLIFF_SHORE_WAVES, loadMapLighting, ROLLING_SHORE_WAVES, WATER_TINTING, type MapLighting } from "./lighting";
import { planShoreline, type ShoreModels } from "./shoreline";
import { loadSplatTable, planSplats, type SplatDef } from "./splats";
import { shadowLookFor, ViewShadows, type Baked } from "./viewshadows";
import { predictShadows } from "./shadowmap";
import { playerRaces, startPreviews, START_PREVIEW_ALPHA } from "./startpreview";
import { lightAt, type SceneLight } from "../../lib/model/dnclight";
import { BLIGHT_TEXTURE, TerrainRenderer, type Marker, type ObjectInstance } from "./renderer";
import { groundHeight, onBoundary, markMapEdge, heightAt, parseW3e, setGroundHeight, waterSurfaceAt, writeW3e, type Corner, type Terrain } from "../../lib/terrain/w3e";
import { readTerrainBytes, TERRAIN_PATHS, terrainPath, writeTerrainBytes } from "../../lib/terrain/w3etext";
import { pictureTarget } from "./picturetarget";
import { firstStart, startLocations, syncPlayers, type PlayerInfo } from "../../lib/terrain/startlocations";
import { clampShift, pushMoveEdit } from "./moveedit";
import { changeAll, propSnapshot, type PropChange, type PropContext, type TypeFacts } from "./unitprops";
import { loadFactsData, typeFacts, type FactsData } from "./typefacts";
import { propsPanel } from "./propspanel";
import { beginResize, resizeHistory, settleWithin } from "../../lib/terrain/resizeundo";
import { cameraBounds, applyResizePathing, planPathingOverrides, playableSize, resizeGrid, resizeProblem, resizeTerrain, worldRect, type Sides } from "../../lib/terrain/resize";

/** Failures already shown, by message: one cause that fails many small reads is said once. */
const reported = new Set<string>();
const reportOnce = (w3: W3Api, what: string, e: unknown) => {
  const text = `${what}: ${e instanceof Error ? e.message : String(e)}`;
  if (reported.has(text)) return;
  reported.add(text);
  void w3.window.showError(text);
};

/** How long a resize or its undo waits for the rebuild due from the last edit. */
const SETTLE_LIMIT = 5 * 60_000;

/** The project's terrain file (binary war3map.w3e or text war3map.w3e.txt), or null. */
const projectTerrain = (w3: W3Api) => terrainPath(w3.workspace.files().map((f) => f.path));
/** TEAM_COLORS index used for neutral players. */
const NEUTRAL = 20;
/** While objects load: the shortest time between two frames the load or animation asks for. */
const LOADING_FRAME_MS = 250;
/** How long a picture waits for models and textures at most: a backend call that never answers
 *  mustn't hang the screenshot tool. What isn't in by then is left out. */
const PICTURE_WAIT_MS = 120_000;
/** How long the shadow map waits for edits to pause before predicting the cells they change (ms). */
const SHADOW_EDIT_DELAY = 700;


const KIND_LABELS: Record<string, string> = { w3u: "Unit", w3t: "Item", w3b: "Destructable", w3d: "Doodad" };

/** Custom object id → base id, from the project's object data (war3map.w3u.json, …). */
/** The object data the terrain view needs (units, items, destructables, doodads): the bases
 *  of custom ids, and the files in the order their art applies — a chapter map's campaign first, then
 *  the map's own, then its Skin files (Reforged keeps art changes there). */
async function mapObjectData(w3: W3Api): Promise<{ bases: Map<string, string>; art: ObjectArt[] }> {
  const kinds = ["w3u", "w3t", "w3b", "w3d"];
  const read = async (path: string, kind: string): Promise<ObjectArt | null> => {
    try { return { ...(JSON.parse(await w3.workspace.readText(path)) as Omit<ObjectArt, "kind">), kind }; } catch { return null; }
  };
  const art: ObjectArt[] = [];
  // A campaign's chapter map also uses the campaign's custom objects.
  const campaign = campaignRoot(w3);
  if (campaign) for (const k of kinds) { const f = await read(joinPath(campaign, "map", `war3campaign.${k}.json`), k); if (f) art.push(f); }
  const files = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
  for (const prefix of ["war3map", "war3mapSkin"]) {
    for (const k of kinds) {
      const path = `map/${prefix}.${k}.json`;
      if (!files.has(path.toLowerCase())) continue;
      const f = await read(path, k);
      if (f) art.push(f);
    }
  }
  const bases = new Map<string, string>();
  for (const f of [...art].reverse()) for (const o of f.custom ?? []) if (o.id && !bases.has(o.id)) bases.set(o.id, o.base);
  return { bases, art };
}

/** Ground tile id → texture path, from TerrainArt\Terrain.slk. */
async function tilePaths(w3: W3Api): Promise<Map<string, string>> {
  return new Map([...(await tileCatalog(w3))].map(([id, t]) => [id, t.path]));
}

/** Every ground tile type the game knows: texture path and a readable name. */
async function tileCatalog(w3: W3Api): Promise<Map<string, { path: string; name: string }>> {
  const rows = parseSlk(await w3.game.readText("TerrainArt\\Terrain.slk"));
  return new Map(rows.filter((r) => r.tileID).map((r) => [r.tileID, { path: `${r.dir}\\${r.file}.blp`, name: r.comment || r.file }]));
}

/** Maps hold at most this many ground tile types (World Editor limit). */
const MAX_GROUND_TILES = 16;

/** A game file, or the map's imported replacement of it. */
/** The campaign project of a chapter map project (…/maps/<file>), or undefined. */
function campaignRoot(w3: W3Api): string | undefined {
  const root = w3.workspace.project()?.root;
  return root ? /^(.*)[\\/]maps[\\/][^\\/]+[\\/]?$/.exec(root)?.[1] : undefined;
}

/** A file the map imports: the project's own, else (chapter maps) the campaign's. In HD and
 *  Reforged modes an import's HD version (`_HD.w3mod\…`, as Reforged maps store them) wins. */
async function readImport(w3: W3Api, path: string): Promise<Uint8Array> {
  const rel = path.replace(/\//g, "\\");
  const names = (w3.settings.get<string>("game.graphicsMode") ?? "hd") !== "sd" ? [`_HD.w3mod\\${rel}`, rel] : [rel];
  const campaign = campaignRoot(w3);
  // The project's own files are known; only those are read (most paths are the game's).
  const files = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
  const own = names.map((n) => `map/${n.replace(/\\/g, "/")}`).filter((p) => files.has(p.toLowerCase()));
  const candidates = [...own, ...(campaign ? names.map((n) => joinPath(campaign, "map", n)) : [])];
  let last: unknown = new Error(`${path} isn't imported`);
  for (const c of candidates) {
    try { return await w3.workspace.readBytes(c); } catch (e) { last = e; }
  }
  throw last;
}

/** A file the map imports, else the game's; `tileset`: the map's, whose own versions of game
 *  files (`_Tilesets/<letter>.w3mod`: water, some creeps' textures, …) win as in the game. */
async function readFile(w3: W3Api, doc: EditorDocument, path: string, tileset?: string): Promise<Uint8Array> {
  if (!doc.path.startsWith("game:") && w3.workspace.project()) {
    try { return await readImport(w3, path); } catch { /* use the game's */ }
  }
  return w3.game.read(path, { tileset });
}

/** A ground tile texture. The map's own import wins; otherwise HD/DE modes use
 *  the Reforged "_Diffuse" texture (the plain name is the classic one). */
async function readGroundTexture(w3: W3Api, doc: EditorDocument, path: string): Promise<{ buf: Uint8Array; name: string }> {
  if (!doc.path.startsWith("game:") && w3.workspace.project()) {
    try { return { buf: await readImport(w3, path), name: path }; } catch { /* use the game's */ }
  }
  if ((w3.settings.get<string>("game.graphicsMode") ?? "hd") !== "sd") {
    const hd = path.replace(/\.\w+$/, "_Diffuse.blp");
    try { return { buf: await w3.game.read(hd), name: hd }; } catch { /* classic texture */ }
  }
  return { buf: await w3.game.read(path), name: path };
}

/** One of the Advanced switches: a boolean setting that is `standard` until it is set. */
/** Flips a switch where its value is kept: a project's own setting (.w3proj/settings.json) wins over the user's, so writing the user's would do nothing. */
const setSwitch = (w3: W3Api, key: string, value: boolean) => w3.settings.set(key, value, w3.settings.inspect(key).project !== undefined ? "project" : "user");
const switchedOn = (w3: W3Api, key: string, standard: boolean) => (standard ? w3.settings.get<boolean>(key, true) !== false : w3.settings.get<boolean>(key, false) === true);

/** What Ctrl+C took: stays over tabs, so it can go into another open map. */
let clipboard: Fragment | null = null;

const GRIDS = ["none", "small", "medium", "large"];
/** What a View item's toggle answered, as what to tell the person: nothing when it was done (a state, or one of
 *  `states`), the reason when it wasn't (game view). */
const why = (answer: boolean | string, states: readonly string[] = []): string | null =>
  typeof answer === "string" && !states.includes(answer) ? answer : null;

/** The View commands: id and what each does to an editor; text back is what to tell the person. */
const viewCommandList: [string, (v: ViewCommands) => string | null | Promise<string | null>][] = [
  ["w3.terrain.viewSelection", (v) => v.viewSelection()],
  ["w3.terrain.viewEntireMap", (v) => { v.viewEntireMap(); return null; }],
  ["w3.terrain.selectInPalette", (v) => v.selectInPalette()],
  ["w3.terrain.toggleNavalPathing", (v) => why(v.toggleLayer("naval"))],
  ["w3.terrain.toggleHeightMap", (v) => why(v.toggleLayer("heights"))],
  ["w3.terrain.toggleCameraObjects", (v) => why(v.toggleLayer("cameras"))],
  ["w3.terrain.toggleGroundPathing", (v) => why(v.toggleLayer("pathing"))],
  ["w3.terrain.toggleRegions", (v) => why(v.toggleLayer("regions"))],
  ["w3.terrain.toggleLightRanges", (v) => why(v.toggleLayer("lightRanges"))],
  ["w3.terrain.toggleDoodads", (v) => why(v.toggleLayer("doodads"))],
  ["w3.terrain.toggleUnits", (v) => why(v.toggleLayer("units"))],
  ["w3.terrain.toggleWater", (v) => why(v.toggleLayer("water"))],
  ["w3.terrain.toggleBlight", (v) => why(v.toggleLayer("blight"))],
  ["w3.terrain.toggleLighting", async (v) => why(await v.toggleSetting("lighting"))],
  ["w3.terrain.toggleWeather", async (v) => why(await v.toggleSetting("weather"))],
  ["w3.terrain.cycleTerrainDisplay", (v) => why(v.cycleTerrain(), ["textured", "wireframe", "hidden"])],
  ["w3.terrain.toggleGameView", async (v) => { await v.toggleGameView(); return null; }],
  ["w3.terrain.toggleSmallGrid", (v) => why(v.toggleGrid("small"), GRIDS)],
  ["w3.terrain.toggleMediumGrid", (v) => why(v.toggleGrid("medium"), GRIDS)],
  ["w3.terrain.toggleLargeGrid", (v) => why(v.toggleGrid("large"), GRIDS)],
  ["w3.terrain.cycleRandomGroupsNext", (v) => v.cycleRandomGroups(1)],
  ["w3.terrain.cycleRandomGroupsPrevious", (v) => v.cycleRandomGroups(-1)],
];

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const toolGroups = new TerrainToolRegistry(() => w3.commands.execute("w3.terrain.open").then(() => undefined));
  /** The open terrain editor, for tools. */
  /** Nearly always a burst of edits: the derived files wait for the last of them. */
  const REBUILD_DELAY = 3000;
  /** `terrain` is left out when the edit didn't touch the ground. */
  type RebuildFrom = { terrain?: Terrain; doodads: Placed[] };
  let rebuild: { key: string; from: RebuildFrom } | null = null, rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  /** After the edits stop: pathing, shadows and the minimap, in the background. `from` is the
   *  state before the first edit: shadows are updated from there. */
  const rebuildSoon = (from: () => RebuildFrom) => {
    const key = w3.workspace.project()?.root ?? "";
    if (rebuild?.key !== key) rebuild = { key, from: from() };
    clearTimeout(rebuildTimer);
    // A failure is shown by the rebuild itself.
    rebuildTimer = setTimeout(() => void runRebuild().catch(() => {}), REBUILD_DELAY);
  };
  /** The rebuilds in a row: one at a time, as they all write the same files (the shadow map is read and written back). */
  let rebuilding: Promise<void> = Promise.resolve();
  const runRebuild = () => {
    const run = rebuilding.then(async () => {
      const job = rebuild;
      if (!job || job.key !== w3.workspace.project()?.root) return;
      const failed = (why: unknown) => {
        const text = `Pathing, shadows and the minimap weren't rebuilt: ${why instanceof Error ? why.message : String(why)}`;
        w3.window.showError(text);
        return new Error(text);
      };
      // The editor of the project's own terrain does the work from what it has loaded. Closed since the edit,
      // it stays closed: the files are made from the project's saved ones.
      const editor = ownEditor();
      if (!editor) {
        const path = projectTerrain(w3);
        if (!path) return;
        rebuild = null;
        const doc = { path } as EditorDocument;
        await deriveFromProject(w3, {
          terrainPath: path,
          from: job.from,
          objects: async () => {
            const [skins, { bases, art }] = await Promise.all([loadSkins(w3), mapObjectData(w3)]);
            return { skins: withObjectArt(skins, art), baseOf: (id: string) => bases.get(id) };
          },
          read: (p) => readFile(w3, doc, p),
          groups: toolGroups.all(),
          // Another project opened meanwhile: nothing of this one's is written into it.
          stillOpen: () => w3.workspace.project()?.root === job.key,
        }).catch((e) => { throw failed(e); });
        return;
      }
      // The wait was long enough for another project to be opened: its job and editor are not this one's.
      if (rebuild !== job || job.key !== w3.workspace.project()?.root || editor.root !== job.key) return;
      rebuild = null;
      await editor.derive(job.from).catch((e) => { throw failed(e); });
    });
    rebuilding = run.catch(() => {});
    return run;
  };
  ctx.subscriptions.push(
    { dispose: () => clearTimeout(rebuildTimer) },
    // What saves or packs the project first waits here: pathing, shadows and the minimap still due from the last edit
    // belong in it (an AI tool's edit is not an unsaved editor, so saving doesn't write them).
    w3.commands.register("w3.terrain.settle", async () => {
      clearTimeout(rebuildTimer);
      await runRebuild();
    }),
    // After a resize or its undo: a rebuild still due was planned for the terrain that was just replaced.
    w3.commands.register("w3.terrain.dropRebuild", () => {
      clearTimeout(rebuildTimer);
      rebuild = null;
    }),
  );

  interface OpenedEditor {
    /** The project it belongs to. */
    root: string;
    handle: TerrainEditorHandle; ready: () => Promise<void>;
    screenshot: (size: number, area: Area | null, angle: ViewAngle, colors: { rgba: Uint8Array; width: number; height: number } | null, hide: ReturnType<typeof hiddenInPicture>) => Promise<string>;
    /** Rebuilds the derived files; without `before` shadows stay, as nothing is known to have changed. */
    derive: (before?: RebuildFrom) => Promise<void>;
    /** What Export Minimap draws, as the editor has it now (unsaved edits included). */
    minimapSource: () => Promise<ExportSource>;
  }
  /** The open terrain editors by document path: a game map's read-only one is another entry. */
  const openedBy = new Map<string, OpenedEditor>();
  /** Terrain editors (by document path) whose 3D view was lost (a GPU reset): nothing is edited there
   *  until it is opened again, so no edit lands on a view that isn't drawn. Saving still works. */
  const lostViews = new Set<string>();
  const VIEW_LOST = "The terrain editor's 3D view stopped (the graphics device was reset): save, then reopen the editor. Nothing is edited there until then.";
  const refuseLostView = (path: string | null | undefined) => { if (path && lostViews.has(path)) throw new Error(VIEW_LOST); };
  /** The editor of the project's own terrain, which is the only one that writes into the project. */
  const ownEditor = () => editorOf(projectTerrain(w3));
  /** The open editor of one of the project's terrain files. */
  const editorOf = (path: string | null) => {
    const found = path ? openedBy.get(path) : undefined;
    return found && found.root === w3.workspace.project()?.root ? found : null;
  };
  /** The view when a terrain editor last closed: an edit from elsewhere (a new map size, an undone resize) reopens it.
   *  Its camera and the selected objects (found again by id and creation number, else spot) come back. */
  let lastView: { key: string; view: TerrainView; selection: PlacedRef[] } | null = null;

  /** The terrain editor, opened if needed, with its objects in place. An edit reopens it, so it can take a moment. */
  /** The editor of the project's terrain, opened if need be. For an edit (the default) it is refused while its 3D view is lost. */
  /** With `path`, that terrain file's editor (one of the project's, see pictureTarget) instead. */
  const liveEditor = async (use: "edit" | "read" = "edit", path?: string) => {
    if (path) await w3.editors.open(path, "w3.terrainViewer");
    else await w3.commands.execute("w3.terrain.open");
    const find = () => (path ? editorOf(path) : ownEditor());
    for (let n = 0; n < 200; n++) {
      const editor = find();
      if (editor) {
        await editor.ready();
        // Taking a change in place can end in reopening: then it's the next one's turn.
        if (find() === editor) {
          if (use === "edit") refuseLostView(path ?? projectTerrain(w3));
          return editor;
        }
      } else await new Promise((done) => setTimeout(done, 100));
    }
    throw new Error("The terrain editor couldn't start (see its tab).");
  };
  const fileKey = (kind: unknown) => (kind === "doodads" ? "doodads" as const : "units" as const);
  /** Which placement file a type belongs in. The type decides: put in the wrong file, an object
   *  silently isn't what was asked for. */
  const fileOfType = (handle: TerrainEditorHandle, id: string, kind: unknown) => {
    const type = handle.objects.type(id)?.kind;
    if (!type) return kind === undefined ? null : fileKey(kind);
    const key = type === "w3d" || type === "w3b" ? "doodads" as const : "units" as const;
    if (kind !== undefined && kind !== key) throw new Error(`${id} is one of the map's ${key}, not ${String(kind)}.`);
    return key;
  };

  /** One edit of a placement file. */
  /** `isItem` (units only): the map stops being a melee map in the same edit once a player owns a placed
   *  unit, as the map script's regeneration does after a save. Done here, it doesn't depend on that running:
   *  it waits for saves to settle, is off with script.generateOnSave, and is lost when the project closes first. */
  const editPlaced = async (title: string, key: "doodads" | "units", change: (f: PlacedFile) => void | Promise<void>, isItem?: (id: string) => boolean) => {
    const { root } = requireProject(w3);
    // Every object tool comes through here (remove_objects without liveEditor too).
    refuseLostView(projectTerrain(w3));
    let before: Placed[] = [];
    const name = key === "units" ? "war3mapUnits.doo" : "war3map.doo", path = jsonPathOf(w3, name);
    const edits = await w3.services.get<McpEditsService>(MCP_EDITS_SERVICE);
    return edits.edit(title, async (read) => {
      const text = await read(path);
      if (text === null) throw new Error(`This project has no ${name}.`);
      const doc = JSON.parse(text) as Record<string, unknown>;
      const list = (doc[key] ??= []) as Placed[];
      splitOwners(list);
      before = key === "doodads" ? structuredClone(list) : [];
      await change({ name, key, doc, list, json: true, dirty: false });
      const files = [{ path, text: await w3.backend.invoke<string>("codec_canonicalize", { root, path, text: placedText(doc) }) }];
      // A w3i kept raw, missing or unreadable is left as it is: the placing doesn't depend on it.
      const infoPath = "map/war3map.w3i.json", infoText = key === "units" && isItem ? await read(infoPath).catch(() => null) : null;
      let info: { flags?: unknown } | null = null;
      try { info = infoText === null ? null : JSON.parse(infoText) as { flags?: unknown }; } catch { /* left alone */ }
      if (info && typeof info.flags === "number") {
        const flags = info.flags, after = meleeFlagsAfter(flags, list, isItem!);
        if (after !== flags) {
          info.flags = after;
          files.push({ path: infoPath, text: await w3.backend.invoke<string>("codec_canonicalize", { root, path: infoPath, text: JSON.stringify(info) }) });
        }
      }
      return files;
    }, async () => {
      // Doodads block pathing and cast shadows. With no editor open the ground is the project's, as the rebuild finds it.
      if (key === "doodads") rebuildSoon(() => ({ doodads: before }));
    });
  };

  /** One edit of the ground, as the terrain editor would make it: objects follow, derived files
   *  are rebuilt. `change` works on the terrain as it's saved, and gives the corners it changed. */
  const editGround = async (title: string, change: (t: Terrain) => number[]) => {
    const { root } = requireProject(w3);
    const path = projectTerrain(w3);
    if (!path) throw new Error("This project has no war3map.w3e.");
    if (!isTerrainText(path)) throw new Error("This project keeps its terrain raw, so it can't be edited here.");
    await liveEditor();
    const edits = await w3.services.get<McpEditsService>(MCP_EDITS_SERVICE);
    const states = { before: null as { terrain: Terrain; doodads: Placed[] } | null, after: null as { terrain: Terrain; doodads: Placed[] } | null };
    let corners = 0, moved = 0;
    const changed = await edits.edit(title, async (read) => {
      const text = await read(path);
      if (text === null) throw new Error("This project has no war3map.w3e.");
      const bytes = w3eFromText(text), terrain = parseW3e(bytes);
      const touched = change(terrain);
      corners = touched.length;
      if (!touched.length) return [];
      const files = [{ path, text: w3eToText(writeW3e(terrain)) }];
      states.before = { terrain: parseW3e(bytes), doodads: [] };
      states.after = { terrain, doodads: [] };
      for (const [name, key] of [["war3map.doo", "doodads"], ["war3mapUnits.doo", "units"]] as const) {
        const json = `map/${name}.json`, doc = await read(json);
        if (doc === null) continue;
        const parsed = JSON.parse(doc) as Record<string, Placed[]>;
        const list = parsed[key] ?? [];
        if (key === "doodads") states.before.doodads = structuredClone(list);
        const count = followGround(list, terrain, touched, key === "doodads");
        if (key === "doodads") states.after.doodads = list;
        moved += count;
        if (count) files.push({ path: json, text: await w3.backend.invoke<string>("codec_canonicalize", { root, path: json, text: JSON.stringify(parsed) }) });
      }
      return files;
    }, async (undoing) => {
      const from = undoing ? states.after : states.before;
      if (from) rebuildSoon(() => from);
    });
    // Pathing, shadows and the minimap follow a moment after the last edit.
    return { changed, corners, objectsMoved: moved };
  };

  /** A place a tool names: [x, y], or a region's middle. */
  const readPlace = async (place: unknown, name: string): Promise<[number, number]> => {
    if (Array.isArray(place) && place.length === 2 && place.every((n) => typeof n === "number")) return [place[0], place[1]];
    if (typeof place === "string") {
      const a = (await readArea(w3, { region: place }))!;
      return [(a.left + a.right) / 2, (a.bottom + a.top) / 2];
    }
    throw new Error(`${name} must be [x, y], or a region's name.`);
  };

  /** The places scatter_objects should leave free. */
  const readKeepClear = async (avoid: unknown): Promise<KeepClear[]> => {
    if (avoid === undefined) return [];
    if (!Array.isArray(avoid)) throw new Error("avoid must be a list of places.");
    return Promise.all(avoid.map(async (item: Record<string, unknown>) => {
      if (Array.isArray(item?.points)) {
        const points = item.points as [number, number][];
        if (!points.length || typeof item.width !== "number") throw new Error("A path in avoid needs points and a width.");
        return { points, width: item.width };
      }
      const a = await readArea(w3, item ?? {});
      if (!a) throw new Error("Each place in avoid is a region, a rectangle, or points with a width.");
      return a;
    }));
  };

  /** What stands by the tight or stuck place of a report: usually the reason. */
  const withNeighbour = <T extends { narrowest?: { at: [number, number] }; stuckAt?: [number, number] }>(handle: TerrainEditorHandle, report: T) => {
    const place = report.stuckAt ?? report.narrowest?.at;
    const near = place ? nearestObject(handle.objects.list(), place) : null;
    return near ? { ...report, standingNearby: { id: near.id, position: near.position } } : report;
  };

  /** All of the map, the border included. */
  const wholeMap = ({ terrain: t }: TerrainEditorHandle) => ({ left: t.offsetX, bottom: t.offsetY, right: t.offsetX + (t.width - 1) * 128, top: t.offsetY + (t.height - 1) * 128 });

  /** The map's playable part, null if it can't be read. */
  const playable = async () => {
    const [info, facts] = await Promise.all([readMapDoc<{ cameraComplements?: number[] }>(w3, "map/war3map.w3i.json"), terrainFacts(w3)]);
    return info && facts ? playableArea(info, facts) : null;
  };

  /** What a unit can't walk on: the pathing map, and what stands there, which it leaves out. */
  const walkGrid = async (handle: TerrainEditorHandle): Promise<Grid> => {
    const [pathing, blockers] = await Promise.all([handle.pathing(), handle.objects.blockers()]);
    const t = handle.terrain;
    const painted = (i: number) => onBoundary(t, t.offsetX + ((i % pathing.width) + 0.5) * 32, t.offsetY + (Math.floor(i / pathing.width) + 0.5) * 32);
    return { blocked: pathing.cells.map((c, i) => (c & NO_WALK || blockers[i] || painted(i) ? 1 : 0)), width: pathing.width, height: pathing.height, offsetX: t.offsetX, offsetY: t.offsetY };
  };

  /** How long Studio waits for a yes. Less than a tool call may take, or the answer goes nowhere. */
  const CONFIRM_TIME = 90_000;

  /** What big changes share, which undo_last_edit doesn't cover: nothing unsaved of the user's,
   *  their yes in Studio, and a checkpoint to go back to. */
  const requireSaved = () => {
    const unsaved = w3.editors.unsavedPaths();
    if (unsaved.length) throw new Error(`Not changed: ${unsaved.join(", ")} ${unsaved.length === 1 ? "has" : "have"} unsaved changes. Ask the user to save or discard them first.`);
  };
  const askUser = async (question: string, yes: string) => {
    requireSaved();
    const asked = Date.now();
    const agreed = await w3.window.confirm(`AI request: ${question}`, yes, CONFIRM_TIME);
    if (agreed) return;
    if (Date.now() - asked >= CONFIRM_TIME - 500) throw new Error("Nobody answered in Studio within 90 seconds, so nothing changed. Tell the user to look there, and try again.");
    throw new Error("The user said no in Studio, so nothing changed. Ask them what they'd like instead.");
  };
  const withConsent = async (question: string, yes: string, setting: string) => {
    // The user can drop the question. What stays is what protects their work.
    if (w3.settings.get<boolean>(setting, true) === false) requireSaved();
    else await askUser(`${question} This can't be undone with AI undo; a checkpoint is made first.`, yes);
    await w3.commands.execute("w3.checkpoints.create", { quiet: true }).catch((e) => { throw new Error(`Nothing changed: the checkpoint failed (${e}).`); });
  };

  let cliffKindsRead: Promise<CliffKind[]> | null = null;
  const cliffKinds = () => (cliffKindsRead ??= w3.game.readText("TerrainArt\\CliffTypes.slk").then((slk) => parseSlk(slk).filter((r) => r.cliffID).map((r) => ({ cliffID: r.cliffID, groundTile: r.groundTile }))));

  /** What the melee tools go by: units, trees, routes, and how wide things are. */
  const meleeFacts = async (size: number) => {
    const { handle } = await liveEditor("read");
    const [balance, weapons, destructables, game, data, grid] = await Promise.all([
      w3.game.readText("Units\\UnitBalance.slk"), w3.game.readText("Units\\UnitWeapons.slk"), w3.game.readText("Units\\DestructableData.slk"),
      w3.game.readText("Units\\MiscGame.txt"), w3.game.readText("Units\\MiscData.txt"), walkGrid(handle),
    ]);
    const levels = new Map(parseSlk(balance).map((r) => [r.unitBalanceID, Number(r.level)]));
    const sights = new Map(parseSlk(weapons).map((r) => [r.unitWeaponID, Number(r.acquire)]));
    const isTree = new Set(parseSlk(destructables).filter((r) => r.targType === "tree").map((r) => r.DestructableID));
    const lookup = <T,>(map: Map<string, T>, id: string) => map.get(id) ?? map.get(handle.objects.baseOf(id) ?? "");
    const placed = handle.objects.list() as unknown as (Placed & { player?: number; targetAcquisition?: number; itemTable?: number; itemSets?: unknown[]; randomLevel?: string })[];
    const units = placed.filter((e) => e.player !== undefined).map((e) => ({
      id: e.id, x: e.position[0], y: e.position[1], player: e.player as number, acquisition: e.targetAcquisition ?? -1,
      drops: (e.itemTable ?? -1) >= 0 || (e.itemSets ?? []).length > 0,
      ...(e.id.startsWith("Y") ? { randomLevel: parseInt((e.randomLevel ?? "").slice(0, 2), 16) || 0 } : {}),
    }));
    const trees = placed.filter((e) => e.player === undefined && (isTree.has(e.id) || isTree.has(handle.objects.baseOf(e.id) ?? ""))).map((e) => [e.position[0], e.position[1]] as [number, number]);
    const at = (u: { x: number; y: number }): [number, number] => [u.x, u.y];
    const starts = units.filter((u) => u.id === "sloc"), mines = units.filter((u) => u.id === "ngol"), taverns = units.filter((u) => u.id === "ntav");
    const routes: { name: string; to?: [number, number]; points?: [number, number][]; problem?: string }[] = [];
    const way = (name: string, from: [number, number], to: [number, number], target?: [number, number], owner?: number) => {
      let report = checkPath(grid, from, to, size, 200);
      // A mine or a building at the end stands in its own way.
      if (!report.walkable && report.nearestFree) report = checkPath(grid, from, report.nearestFree, size, 200);
      routes.push(report.route ? { name, ...(target ? { to: target } : {}), points: report.route, ...(owner === undefined ? {} : { from: owner, length: report.length }) } : { name, problem: report.problem ?? "no way through" });
    };
    for (let i = 0; i < starts.length; i++) for (let j = i + 1; j < starts.length; j++) way(`Start ${i + 1} to start ${j + 1}`, at(starts[i]), at(starts[j]));
    for (const [i, s] of starts.entries()) {
      const gap = (m: typeof s) => Math.hypot(m.x - s.x, m.y - s.y);
      for (const m of mines.filter((x) => gap(x) > 1150).sort((a, b) => gap(a) - gap(b)).slice(0, 3)) way(`Start ${i + 1} to the mine at ${Math.round(m.x)}, ${Math.round(m.y)}`, at(s), at(m), at(m), i);
      for (const t of taverns.slice(0, 1)) way(`Start ${i + 1} to the tavern`, at(s), at(t), at(t));
    }
    const number = (text: string, key: string, fallback: number) => Number(new RegExp(`^${key}=(\\d+)`, "m").exec(text)?.[1] ?? fallback);
    const widest = starts.map((s) => widestFrom(grid, at(s)));
    const t = handle.terrain, counts = new Map<number, number>();
    for (const c of t.corners) if (!c.boundary) counts.set(c.layer, (counts.get(c.layer) ?? 0) + 1);
    const commonLevel = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    const levelAt = (x: number, y: number) => t.corners[Math.round((y - t.offsetY) / 128) * t.width + Math.round((x - t.offsetX) / 128)]?.layer ?? 0;
    return { handle, grid, widest, units, trees, routes, levelAt, commonLevel, levels: (id: string) => lookup(levels, id), sights: (id: string) => lookup(sights, id), number, game, data };
  };

  let placeObjects: McpToolHandler = () => undefined;
  const RESERVED = ".w3proj/reserved-areas.json";
  type Reserved = KeepClear & { name: string };
  const readReserved = async () => JSON.parse(await w3.workspace.readText(RESERVED).catch(() => "[]")) as Reserved[];
  /** The seed a tool was given, or a new one: the answer says it, so any result can be repeated. */
  const seedOf = (seed: unknown) => (typeof seed === "number" ? seed : Math.floor(Math.random() * 1e9));

  const add = (f: PlacedFile, handle: TerrainEditorHandle, id: string, x: number, y: number, player: number | undefined, asked: Dressing, vary: boolean, random: () => number = Math.random) => {
    const entry = newEntry(f, id, [x, y, heightAt(handle.terrain, x, y)], player, handle.objects.type(id)?.kind);
    dress(entry, handle.objects.type(id), asked, vary, random);
    f.list.push(entry);
    return entry;
  };

  /** Doodads past the playable map carry a flag: every one on ladder maps does, and no others. */
  const markBackdrop = (entry: Placed, x: number, y: number, edge: Area | null) => {
    if (edge && !inArea(x, y, edge)) (entry as Placed & { flags?: number }).flags = ((entry as Placed & { flags?: number }).flags ?? 2) | OUTSIDE_PLAYABLE;
  };

  ctx.subscriptions.push(
    w3.mcp.registerTool("terrain_screenshot", async (args) => {
      const hide = hiddenInPicture(args.hide);
      // A project can have two terrain files: the picture is of the one asked for, else the one in front, never a hidden tab.
      const project = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
      const path = pictureTarget(args.file, w3.editors.activePath(), TERRAIN_PATHS.filter((p) => project.has(p)), (p) => !!editorOf(p));
      const editor = await liveEditor("edit", path ?? undefined);
      const area = await readArea(w3, args);
      const size = typeof args.maxSize === "number" && args.maxSize > 0 ? args.maxSize : 1280;
      const angle = args.view === "angled" || args.view === "low" ? args.view : "top";
      let colors = null;
      if (args.overlay === "heights") colors = heightColors(editor.handle.terrain);
      if (args.overlay === "pathing") {
        const [pathing, standing, destructables] = await Promise.all([editor.handle.pathing(), editor.handle.objects.standing(), editor.handle.objects.destructables()]);
        colors = { rgba: pathingColors(pathing.cells, standing, destructables), width: pathing.width, height: pathing.height };
      }
      const data = await editor.screenshot(size, area, angle, colors, hide);
      const image = { type: "image", data, mimeType: "image/png" };
      return area ? [image, { type: "text", text: `Shows ${area.name ?? "the area"} (x ${area.left} to ${area.right}, y ${area.bottom} to ${area.top}), outlined, with north up.` }] : image;
    }),
    w3.mcp.registerTool("replace_objects", async (args) => {
      const swaps = args.swaps as Record<string, string> | undefined;
      if (!swaps || typeof swaps !== "object" || !Object.keys(swaps).length) throw new Error("swaps must say what becomes what, like {\"LTlt\": \"FTtw\"}.");
      const area = await readArea(w3, args);
      const { handle } = await liveEditor();
      const look = (id: string) => handle.objects.type(id);
      for (const to of Object.values(swaps)) if (!look(to)) throw new Error(`"${to}" isn't an object type here. list_objects gives them.`);
      let changed = 0;
      await editPlaced(`Replace ${Object.keys(swaps).join(", ")}`, fileKey(args.kind ?? "doodads"), (f) => {
        changed = replacePlaced(f.list as Parameters<typeof replacePlaced>[0], swaps, area, (id) => look(id)?.numVar ?? 1);
        if (!changed) throw new Error("Nothing placed matches that.");
      });
      return { changed };
    }),
    w3.mcp.registerTool("new_map", async (args) => {
      const open = w3.workspace.project()?.root.replace(/[\\/]+$/, "") ?? null;
      const here = open?.includes("\\") || open?.includes("/") ? open.replace(/[\\/][^\\/]*$/, "") : null;
      const data = await loadTilesets(w3);
      const o = mapChoices(args, data, here);
      if (await w3.backend.invoke<boolean>("fs_exists", { path: o.dir })) throw new Error(`${o.dir} already exists. Give another name or folder.`);
      const [playableWidth, playableHeight] = playableOf(o.width, o.height);
      const plan = {
        name: o.name, folder: o.dir, width: o.width, height: o.height, playableWidth, playableHeight, tileset: o.tileset, baseTile: o.baseTile,
        cliffLevel: o.layer, water: o.water, hills: o.noise, script: o.lua ? "lua" : "jass",
      };
      if (args.dryRun === true) return plan;
      await askUser(`create the map "${o.name}" (${o.width} × ${o.height}) in ${o.dir} and switch to it?${open ? " The open project closes, and stays as it was saved." : ""}`, "Create map");
      await w3.window.withProgress(`Creating ${o.name}…`, () => createMap(w3, o));
      return { ...plan, opened: w3.workspace.project()?.root ?? null };
    }),
    w3.mcp.registerTool("set_tileset", async ({ tileset, replaceTiles, dryRun }) => {
      if (typeof tileset !== "string") throw new Error("tileset must be a letter; terrain_info lists them.");
      requireProject(w3);
      // A dry run only reads; the change itself is refused on a lost view (before and after the question).
      const { handle } = await liveEditor("read");
      const sets = await handle.tilesets();
      const set = sets.find((s) => s.id === tileset);
      if (!set) throw new Error(`"${tileset}" isn't a tileset. They are: ${sets.map((s) => `${s.id} (${s.name})`).join(", ")}.`);
      const t = handle.terrain, old = sets.find((s) => s.id === t.tileset);
      const swap = replaceTiles !== false, before = [...t.groundTiles];
      const { tiles, kept } = swap ? swapTiles(before, old?.tiles ?? [], set.tiles) : { tiles: before, kept: [] };
      const plan = { tileset: set.id, name: set.name, tiles: before.map((from, i) => ({ from, to: tiles[i] })), keptFromOtherTilesets: kept };
      if (dryRun === true) return plan;
      refuseLostView(projectTerrain(w3));
      const stays = kept.length ? `, keeping ${kept.join(", ")}` : "";
      await withConsent(`change the tileset from ${old?.name ?? t.tileset} to ${set.name}${swap ? `, replacing its ground tiles${stays}` : ""}?`, "Change tileset", "mcp.confirmTileset");
      refuseLostView(projectTerrain(w3));
      handle.setTileset(set.id);
      // The custom tiles flag follows the new list and tileset in both (see customTilesFlag), in the same undo step.
      if (swap) handle.replaceGroundTiles(tiles);
      await handle.setMapTileset(set.id);
      await w3.editors.saveAll();
      return { ...plan, groundTiles: t.groundTiles };
    }),
    w3.mcp.registerTool("resize_map", async ({ left, right, bottom, top, border, dryRun }) => {
      const side = (n: unknown) => (n === undefined ? 0 : n);
      const change = [left, right, bottom, top].map(side) as Sides;
      if (!change.every((n) => Number.isInteger(n))) throw new Error("left, right, bottom and top must be whole numbers of tiles.");
      if (border !== undefined && !(Array.isArray(border) && border.length === 4 && border.every((n) => Number.isInteger(n) && n >= 0))) throw new Error("border must be [left, right, bottom, top].");
      requireProject(w3);
      // A dry run only reads; the resize itself is refused on a lost view (before and after the question).
      const { handle } = await liveEditor("read");
      const t = handle.terrain;
      const info = await readMapDoc<{ cameraComplements?: number[] }>(w3, "map/war3map.w3i.json");
      const complements = (border ?? info?.cameraComplements ?? [0, 0, 0, 0]) as Sides;
      const same = change.every((n) => n === 0) && complements.every((n, k) => n === info?.cameraComplements?.[k]);
      if (same) throw new Error("That changes nothing.");
      const problem = resizeProblem(t, change, complements);
      if (problem) throw new Error(problem);
      const [width, height] = resizedSize(t, change);
      const removed = outsideAfterResize(handle.objects.list(), t, change);
      const grows = change.some((n) => n > 0);
      const result = {
        width, height, border: complements, playable: playableSize({ ...t, width: width + 1, height: height + 1 }, complements), objectsRemoved: removed,
        ...(grows ? { note: "New ground continues the map's edge: the same tile and height as far as it reaches, and the tiles repeat. Paint it afterwards to hide that." } : {}),
      };
      if (dryRun === true) return result;
      refuseLostView(projectTerrain(w3));
      await withConsent(`resize the map from ${t.width - 1} × ${t.height - 1} to ${width} × ${height}${removed ? `, removing ${removed} object${removed === 1 ? "" : "s"} outside it` : ""}? Undo Resize in Studio takes it back until Studio closes.`, "Resize map", "mcp.confirmResize");
      refuseLostView(projectTerrain(w3));
      const done = await w3.window.withProgress("Changing the map size", () => handle.resizeMap(change, complements));
      return { ...result, objectsRemoved: done.removed, undo: "undo_last_edit doesn't cover this. The user can take the resize back with Undo Resize (or Ctrl+Z in the terrain editor) until Studio closes; the checkpoint just made stays." };
    }),
    w3.mcp.registerTool("check_path", async ({ from, to, unitSize }) => {
      const [start, goal] = [await readPlace(from, "from"), await readPlace(to, "to")];
      const size = typeof unitSize === "number" && unitSize >= 0 ? unitSize : 32;
      const { handle } = await liveEditor("read");
      return withNeighbour(handle, checkPath(await walkGrid(handle), start, goal, size));
    }),
    w3.mcp.registerTool("check_route", async ({ points, unitSize, corridorWidth }) => {
      if (!Array.isArray(points) || points.length < 2 || !points.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number"))) throw new Error("points must be at least two [x, y].");
      const { handle } = await liveEditor("read");
      const size = typeof unitSize === "number" && unitSize >= 0 ? unitSize : 32, wide = typeof corridorWidth === "number" && corridorWidth > 0 ? corridorWidth : 400;
      return withNeighbour(handle, checkRoute(await walkGrid(handle), points as [number, number][], size, wide));
    }),
    w3.mcp.registerTool("find_pockets", async (args) => {
      const { handle } = await liveEditor("read");
      const grid = await walkGrid(handle), bounds = await playable().catch(() => null);
      // What's past the playable part isn't ground anyone walks on.
      if (bounds) for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
        if (!inArea(grid.offsetX + (x + 0.5) * 32, grid.offsetY + (y + 0.5) * 32, bounds)) grid.blocked[y * grid.width + x] = 1;
      }
      const size = typeof args.unitSize === "number" && args.unitSize >= 0 ? args.unitSize : 32;
      const found = findPockets(grid, size, await readArea(w3, args), typeof args.smallest === "number" ? args.smallest : 16);
      const t = handle.terrain;
      const levelAt = ([x, y]: readonly number[]) => t.corners[Math.round((y - t.offsetY) / 128) * t.width + Math.round((x - t.offsetX) / 128)]?.layer;
      const main = found.mainAt ? levelAt(found.mainAt) : undefined;
      return {
        ...found,
        pockets: found.pockets.map((p) => {
          const level = levelAt(p.somewhereInside);
          return { ...p, cliffLevel: level, ...(main !== undefined && level > main ? { highGround: true, note: "Above the main ground with no way up: fine for a mesa, or give it a ramp." } : {}) };
        }),
      };
    }),
    w3.mcp.registerTool("reserve_area", async (args) => {
      const { name } = args;
      if (typeof name !== "string" || !name.trim()) throw new Error("reserve_area needs a name.");
      const [place] = await readKeepClear([args]);
      const rest = (await readReserved()).filter((r) => r.name !== name.trim());
      await w3.workspace.writeText(RESERVED, JSON.stringify([...rest, { ...place, name: name.trim() }], null, 2));
      return `"${name.trim()}" stays free from now on.`;
    }),
    w3.mcp.registerTool("release_area", async ({ name }) => {
      const all = await readReserved(), rest = all.filter((r) => r.name !== name);
      if (rest.length === all.length) throw new Error(`No area is reserved as "${String(name)}".`);
      await w3.workspace.writeText(RESERVED, JSON.stringify(rest, null, 2));
      return `Released "${String(name)}".`;
    }),
    w3.mcp.registerTool("list_reserved_areas", readReserved),
    w3.mcp.registerTool("fill_rows", async (args) => {
      const { id, spacingX, spacingY, jitter, facing } = args;
      if (typeof spacingX !== "number" || typeof spacingY !== "number" || spacingX <= 0 || spacingY <= 0) throw new Error("spacingX and spacingY must be above 0.");
      const area = await readArea(w3, args);
      if (!area) throw new Error("fill_rows needs a region, or left, bottom, right and top.");
      const seed = seedOf(args.seed), keep = await readReserved();
      const spots = rowSpots(area, spacingX, spacingY, typeof jitter === "number" ? jitter : 0, seededRandom(seed)).filter((s) => !isKeptClear(s.x, s.y, keep));
      const objects = spots.map((s) => ({ id, x: s.x, y: s.y, ...(typeof facing === "number" ? { facing } : {}) }));
      return { seed, ...(await placeObjects({ kind: args.kind, objects, ignoreRoom: args.ignoreRoom, seed, mirror: args.mirror })) as object };
    }),
    w3.mcp.registerTool("list_ground_tiles", async ({ filter }) => {
      const { handle } = await liveEditor("read");
      const wanted = typeof filter === "string" ? filter.toLowerCase() : "";
      const seen = new Map<string, string[]>();
      for (const s of await handle.tilesets()) for (const id of s.tiles) seen.set(id, [...(seen.get(id) ?? []), s.name]);
      const inMap = handle.terrain.groundTiles;
      const cliffs = new Set((await cliffKinds()).map((k) => k.groundTile));
      return {
        inMap, free: 16 - inMap.length,
        tiles: [...seen].filter(([id, sets]) => !wanted || id.toLowerCase().includes(wanted) || sets.some((n) => n.toLowerCase().includes(wanted))).map(([id, tilesets]) => ({ id, ...(cliffs.has(id) ? { cliff: true } : {}), tilesets, ...(inMap.includes(id) ? { inMap: true } : {}) })),
      };
    }),
    w3.mcp.registerTool("paint_path", async (args) => {
      const { tile, points, width, edge, flatten } = args;
      if (typeof tile !== "string" || tile.length !== 4) throw new Error("tile must be four characters, like Ldrt. terrain_info lists them.");
      if (!Array.isArray(points) || points.length < 2 || !points.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number"))) throw new Error("points must be at least two [x, y].");
      const known = (await (await liveEditor()).handle.tilesets()).flatMap((s) => s.tiles);
      if (!known.includes(tile)) throw new Error(`"${tile}" isn't one of the game's ground tiles. terrain_info lists them.`);
      const across = typeof width === "number" && width > 0 ? width : 256;
      const fray = typeof edge === "number" ? Math.min(1, Math.max(0, edge)) : 0.4;
      const seed = seedOf(args.seed), random = seededRandom(seed);
      const kinds = await cliffKinds();
      return { seed, ...await editGround(`Paint a path of ${tile}`, (t) => withCliffTypes(t, paintPath(t, points as [number, number][], across, groundSlot(t, tile, kinds), fray, flatten === true, random), kinds)) };
    }),
    w3.mcp.registerTool("paint_terrain", async (args) => {
      const { tile } = args;
      if (typeof tile !== "string" || tile.length !== 4) throw new Error("tile must be four characters, like Lgrs. terrain_info lists them.");
      const area = await readArea(w3, args);
      if (!area) throw new Error("paint_terrain needs a region, or left, bottom, right and top.");
      const known = (await (await liveEditor()).handle.tilesets()).flatMap((s) => s.tiles);
      if (!known.includes(tile)) throw new Error(`"${tile}" isn't one of the game's ground tiles. terrain_info lists them.`);
      const edge = typeof args.edge === "number" ? Math.min(1, Math.max(0, args.edge)) : 0.3;
      const shape = args.shape === "box" ? "box" : "ellipse";
      const seed = seedOf(args.seed), random = seededRandom(seed);
      const kinds = await cliffKinds();
      return { seed, ...await editGround(`Paint ${tile} in ${area.name ?? "an area"}`, (t) => withCliffTypes(t, paintCorners(t, area, shape, groundSlot(t, tile, kinds), edge, random), kinds)) };
    }),
    w3.mcp.registerTool("sculpt_terrain", async (args) => {
      const { mode, amount } = args;
      if (mode !== "raise" && mode !== "lower" && mode !== "flatten" && mode !== "smooth" && mode !== "roughen") throw new Error("mode must be raise, lower, flatten, smooth or roughen.");
      if (amount !== undefined && (typeof amount !== "number" || !Number.isFinite(amount))) throw new Error("amount must be a number.");
      if (typeof amount === "number" && mode !== "flatten" && (amount <= 0 || amount > 1000)) throw new Error("amount must be above 0, at most 1000.");
      const area = await readArea(w3, args);
      if (!area) throw new Error("sculpt_terrain needs a region, or left, bottom, right and top.");
      const shape = args.shape === "box" ? "box" : "ellipse";
      if (mode === "roughen") {
        const seed = seedOf(args.seed), random = seededRandom(seed);
        return { seed, ...await editGround(`Roughen ground in ${area.name ?? "an area"}`, (t) => roughenCorners(t, area, shape, typeof amount === "number" ? amount : 24, random)) };
      }
      return editGround(`${mode[0].toUpperCase()}${mode.slice(1)} ground in ${area.name ?? "an area"}`, (t) => sculptCorners(t, area, shape, mode, typeof amount === "number" ? amount : undefined));
    }),
    w3.mcp.registerTool("set_cliff_level", async (args) => {
      const { level, by, cliffTile } = args;
      if ((level === undefined) === (by === undefined)) throw new Error("Give level, or by: one of them.");
      for (const n of [level, by]) if (n !== undefined && !Number.isInteger(n)) throw new Error("level and by must be whole numbers.");
      if (cliffTile !== undefined && typeof cliffTile !== "string") throw new Error("cliffTile must be a ground tile, like Lrok.");
      const area = await readArea(w3, args);
      if (!area) throw new Error("set_cliff_level needs a region, or left, bottom, right and top.");
      const kinds = await cliffKinds();
      const target = { level: level as number | undefined, by: by as number | undefined };
      return editGround(`Cliffs in ${area.name ?? "an area"}`, (t) => setCliffs(t, area, args.shape === "box" ? "box" : "ellipse", target, kinds, cliffTile));
    }),
    w3.mcp.registerTool("set_cliff_type", async (args) => {
      const { tile } = args;
      if (typeof tile !== "string" || tile.length !== 4) throw new Error("tile must be four characters, like Ldrt. list_ground_tiles marks those with a cliff.");
      const area = await readArea(w3, args);
      if (!area) throw new Error("set_cliff_type needs a region, or left, bottom, right and top.");
      const kinds = await cliffKinds();
      return editGround(`Cliffs of ${tile} in ${area.name ?? "an area"}`, (t) => setCliffType(t, area, args.shape === "box" ? "box" : "ellipse", tile, kinds));
    }),
    w3.mcp.registerTool("set_water", async (args) => {
      const { mode, points, width } = args;
      if (mode !== "ford" && mode !== "lake" && mode !== "shallow" && mode !== "deep" && mode !== "dry") throw new Error("mode must be ford, lake, shallow, deep or dry.");
      const line = points !== undefined;
      if (line && !(Array.isArray(points) && points.length >= 2 && points.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number")))) throw new Error("points must be at least two [x, y].");
      if (width !== undefined && !(typeof width === "number" && width >= 128)) throw new Error("width must be at least 128.");
      const area = line ? null : await readArea(w3, args);
      if (!line && !area) throw new Error("set_water needs points, a region, or left, bottom, right and top.");
      const place = area ?? { points: points as [number, number][], width: typeof width === "number" ? width : 384 };
      const kinds = await cliffKinds();
      const where = area ? area.name ?? "an area" : "a line";
      return editGround(`${mode === "dry" ? "Dry out" : `${mode[0].toUpperCase()}${mode.slice(1)} water in`} ${where}`, (t) => setWater(t, place, args.shape === "box" ? "box" : "ellipse", mode, kinds));
    }),
    w3.mcp.registerTool("rebuild_map", async () => {
      // Only the derived files are written, without the GPU: it works on a lost view too.
      const editor = await liveEditor("read");
      await editor.derive();
      return "Pathing and the minimap are rebuilt from the map as it is. Shadows only follow the edits that make them.";
    }),
    w3.mcp.registerTool("set_ramp", async ({ at, width, remove }) => {
      const [x, y] = await readPlace(at, "at");
      const wide = width === undefined ? 2 : width;
      if (!Number.isInteger(wide) || (wide as number) < 2 || (wide as number) > 16 || (wide as number) % 2) throw new Error("width must be an even number of tiles, from 2 to 16.");
      return editGround(remove === true ? "Remove a ramp" : "Build a ramp", (t) => setRamp(t, x, y, wide as number, remove === true));
    }),
    w3.mcp.registerTool("check_melee", async ({ unitSize }) => {
      const f = await meleeFacts(typeof unitSize === "number" && unitSize > 0 ? unitSize : 32);
      return checkMelee({
        units: f.units, trees: f.trees, routes: f.routes, level: f.levels, sight: f.sights,
        callForHelp: f.number(f.game, "CreepCallForHelp", 600), shopNotify: f.number(f.data, "NeutralUseNotifyRadius", 900),
        narrow: narrowStrips(f.grid), levelAt: f.levelAt, commonLevel: f.commonLevel,
        widestTo: (x, y) => {
          // Creeps and what stands by a camp fill its middle: the way to the place beside it counts.
          let best = 0;
          const { width: w, height: h, offsetX, offsetY } = f.grid;
          const cx = Math.floor((x - offsetX) / 32), cy = Math.floor((y - offsetY) / 32);
          for (let b = -3; b <= 3; b++) for (let a = -3; a <= 3; a++) {
            if (cx + a < 0 || cy + b < 0 || cx + a >= w || cy + b >= h) continue;
            for (const field of f.widest) best = Math.max(best, field[(cy + b) * w + cx + a]);
          }
          return widthOf(best);
        },
      });
    }),
    w3.mcp.registerTool("find_spots", async ({ kind, count, mirror }) => {
      if (kind !== "camp" && kind !== "expansion") throw new Error("kind must be camp or expansion.");
      const f = await meleeFacts(32);
      const starts = f.units.filter((u) => u.id === "sloc").map((u) => [u.x, u.y] as [number, number]);
      if (!starts.length) throw new Error("Place the start locations (sloc) first: spots go by them.");
      const pathing = await f.handle.pathing(), t = f.handle.terrain;
      const combined = new Uint16Array(f.grid.width * f.grid.height);
      for (const field of f.widest) for (let i = 0; i < combined.length; i++) combined[i] = Math.max(combined[i], field[i]);
      return findSpots(kind, {
        grid: f.grid, widest: combined, starts, whole: wholeMap(f.handle), levelAt: f.levelAt,
        mines: f.units.filter((u) => u.id === "ngol").map((u) => [u.x, u.y] as [number, number]),
        camps: campsOf(f.units, { level: f.levels }).map((c) => c.centre),
        routes: f.routes.flatMap((r) => (r.points ? [r.points] : [])),
        noBuild: (x, y) => ((pathing.cells[Math.floor((y - t.offsetY) / 32) * pathing.width + Math.floor((x - t.offsetX) / 32)] ?? NO_BUILD) & NO_BUILD) !== 0,
      }, typeof count === "number" ? Math.max(1, Math.min(30, count)) : 12, mirror === true);
    }),
    w3.mcp.registerTool("terrain_info", async (args) => {
      const editor = await liveEditor("read");
      const t = editor.handle.terrain;
      const whole = { left: t.offsetX, bottom: t.offsetY, right: t.offsetX + (t.width - 1) * 128, top: t.offsetY + (t.height - 1) * 128 };
      // The game's pathing file leaves out trees and other destructables: what stands there counts.
      const [pathing, room] = await Promise.all([editor.handle.pathing(), editor.handle.objects.occupancy()]);
      const cells = pathing.cells.map((c, i) => (room.blocked[i] ? c | NO_WALK : c));
      const area = (await readArea(w3, args)) ?? whole;
      const tiles = (await editor.handle.tilesets()).find((s) => s.id === t.tileset)?.tiles ?? [];
      const bounds = await playable().catch(() => null);
      const past = bounds && beyondPlayable(area, bounds);
      return {
        ...terrainSummary(t, { ...pathing, cells }, area),
        ...(bounds ? { playable: bounds } : {}), ...(past ? { warning: past } : {}),
        tilesInMap: t.groundTiles, otherTilesOfTheTileset: tiles.filter((id) => !t.groundTiles.includes(id)),
        tilesets: (await editor.handle.tilesets()).map((s) => ({ id: s.id, name: s.name })),
        ...(args.heights === true ? { heights: heightGrid(t, area) } : {}),
      };
    }),
    w3.mcp.registerTool("place_line", async ({ kind, id, from, to, spacing, facingOffset, ignoreRoom, dryRun, mirror }) => {
      if (typeof id !== "string" || id.length !== 4) throw new Error("id must be four characters, like LTlt.");
      const [start, end] = [await readPlace(from, "from"), await readPlace(to, "to")];
      const { handle } = await liveEditor();
      const type = handle.objects.type(id);
      if (!type) throw new Error(`"${id}" isn't an object type here. list_objects gives them.`);
      const room = await handle.objects.occupancy();
      const fp = await room.footprint(type.kind, id);
      const shape = await handle.objects.modelShape(id);
      const step = typeof spacing === "number" && spacing > 0 ? spacing : shape?.length ?? (fp ? Math.max(fp.width, fp.height) * 32 : 0);
      if (!step) throw new Error(`${id} has no length to go by: give spacing.`);
      // Turned by the model's own long side.
      const turn = typeof facingOffset === "number" ? facingOffset : shape && !shape.alongX ? 90 : 0;
      const objects = lineSpots(start, end, step, turn).map((s) => ({ id, x: s.x, y: s.y, facing: s.facing }));
      const report = await placeObjects({ kind, objects, ignoreRoom, dryRun, ownPieces: step, mirror });
      return { spacing: step, facingOffset: turn, ...(report as object) };
    }),
    w3.mcp.registerTool("place_objects", placeObjects = async ({ kind, objects, ignoreRoom, nearest, dryRun, seed, ownPieces, mirror }) => {
      if (!Array.isArray(objects) || !objects.length || objects.length > 3000) throw new Error("objects must list 1 to 3000 things to place.");
      const wanted = objects as ({ id: unknown; x: unknown; y: unknown; player?: unknown; facing?: number; scale?: number; variation?: number } & UnitChoices)[];
      const { handle } = await liveEditor();
      const files = new Set(wanted.map((o) => (typeof o.id === "string" ? fileOfType(handle, o.id, kind) : null)).filter(Boolean));
      if (files.size > 1) throw new Error("objects mixes units and doodads: place each in its own call.");
      const key = [...files][0] ?? fileKey(kind ?? "doodads");
      const owners = wanted.map((o) => (typeof o.player === "number" ? o.player - 1 : 0));
      for (const [i, o] of wanted.entries()) {
        if (typeof o.id !== "string" || o.id.length !== 4 || typeof o.x !== "number" || typeof o.y !== "number") throw new Error(`objects[${i}] needs an id of four characters, and x and y.`);
        if (key === "units" && (!Number.isInteger(owners[i]) || owners[i] < 0 || owners[i] > 27)) throw new Error(`objects[${i}]: player counts from 1, to 28.`);
        if (key === "doodads" && (o.camp !== undefined || o.gold !== undefined || o.drops !== undefined)) throw new Error(`objects[${i}]: camp, gold and drops are for units.`);
        try { setUnitChoices(o); } catch (e) { throw new Error(`objects[${i}]: ${(e as Error).message}`); }
      }
      const edge = await playable().catch(() => null);
      const whole = wholeMap(handle);
      const pathing = await handle.pathing();
      const why = (x: number, y: number) => whyNoRoom(handle.terrain, pathing, nearestObject(handle.objects.list(), [x, y]), x, y);
      const random = typeof seed === "number" ? seededRandom(seed) : Math.random;
      const skipped: { index: number; id: string; x: number; y: number; reason: string }[] = [];
      const shifted: { index: number; id: string; from: [number, number]; to: [number, number] }[] = [];
      /** Works out what fits; `place` then puts it there. A dry run marks what it finds on a copy of the
       *  editor's map of what's taken, so it refuses the same overlaps among its own objects a real run does. */
      const plan = async (place: ((o: typeof wanted[number], i: number, x: number, y: number, facing: number) => Promise<void>) | null) => {
        skipped.length = shifted.length = 0;
        const shared = ignoreRoom === true ? null : await handle.objects.occupancy();
        const room = place ? shared : shared?.scratch() ?? null;
        let placed = 0;
        for (const [i, o] of wanted.entries()) {
          const id = o.id as string, x = o.x as number, y = o.y as number, type = handle.objects.type(id), kindOf = type?.kind ?? "w3u";
          if (!type) { skipped.push({ index: i, id, x, y, reason: "no such object type here" }); continue; }
          // Decided here: a footprint is checked at the facing the object ends up with.
          const facing = type.fixedRot ?? o.facing ?? (key === "doodads" ? random() * 360 : 270);
          const angle = (facing * Math.PI) / 180;
          let spot: [number, number] | null = [x, y];
          // At a corner a line runs into the end of the last one, of the same fence: that's meant.
          const joins = typeof ownPieces === "number" && handle.objects.list().some((p) => p.id === id && Math.hypot(p.position[0] - x, p.position[1] - y) <= ownPieces * 0.75);
          if (room && !joins && !isBackdrop(kindOf, x, y, edge, whole) && !(await room.fits(kindOf, id, x, y, angle))) {
            spot = null;
            if (nearest === true) {
              for (const s of spotsAround(x, y)) if (await room.fits(kindOf, id, s[0], s[1], angle)) { spot = s; break; }
            }
            if (!spot) {
              skipped.push({ index: i, id, x, y, reason: edge && !inArea(x, y, edge) ? "units and items can't stand outside the playable map" : why(x, y) });
              continue;
            }
            shifted.push({ index: i, id, from: [x, y], to: spot });
          }
          // Both sides or neither, or a skipped object would break the symmetry unseen.
          const twin = mirror === true ? twinOf(spot[0], spot[1], whole) : null;
          const paired = twin && Math.hypot(twin[0] - spot[0], twin[1] - spot[1]) > 16;
          const twinFacing = type.fixedRot ?? (facing + 180) % 360, twinAngle = (twinFacing * Math.PI) / 180;
          if (paired && room && !isBackdrop(kindOf, twin[0], twin[1], edge, whole) && !(await room.fits(kindOf, id, twin[0], twin[1], twinAngle))) {
            skipped.push({ index: i, id, x, y, reason: `its twin at ${Math.round(twin[0])}, ${Math.round(twin[1])} has no room: ${why(twin[0], twin[1])}` });
            continue;
          }
          await place?.(o, i, spot[0], spot[1], facing);
          // A line's pieces touch each other on purpose.
          if (ownPieces === undefined) await room?.mark(kindOf, id, spot[0], spot[1], angle);
          if (paired) {
            await place?.(o, i, twin[0], twin[1], twinFacing);
            if (ownPieces === undefined) await room?.mark(kindOf, id, twin[0], twin[1], twinAngle);
          }
          placed += paired ? 2 : 1;
        }
        return placed;
      };
      if (dryRun === true) return { wouldPlace: await plan(null), shifted, skipped };
      let placed = 0;
      await editPlaced(`Place ${wanted.length} object${wanted.length === 1 ? "" : "s"}`, key, async (f) => {
        placed = await plan(async (o, i, x, y, facing) => {
          const [atX, atY] = key === "units" ? await handle.objects.buildingSpot(o.id as string, x, y) : [x, y];
          const entry = add(f, handle, o.id as string, atX, atY, key === "units" ? owners[i] : undefined, { ...o, facing }, key === "doodads", random);
          if (key === "units") setUnitChoices(o, entry as unknown as Parameters<typeof setUnitChoices>[1]);
          else markBackdrop(entry, x, y, edge);
        });
        if (!placed) throw new Error(`Nothing was placed: ${JSON.stringify(skipped.slice(0, 10))}`);
      }, (id) => handle.objects.type(id)?.kind === "w3t");
      return { placed, shifted, skipped };
    }),
    w3.mcp.registerTool("scatter_objects", async (args) => {
      const ids = args.ids;
      if (!Array.isArray(ids) || !ids.length || !ids.every((i) => typeof i === "string" && i.length === 4)) throw new Error("ids must list object types of four characters.");
      const area = await readArea(w3, args);
      if (!area) throw new Error("scatter_objects needs a region, or left, bottom, right and top.");
      const density = typeof args.density === "number" ? Math.min(1, Math.max(0.05, args.density)) : 0.7;
      const limit = typeof args.limit === "number" && args.limit > 0 ? args.limit : 3000;
      const range = args.scaleRange;
      if (range !== undefined && !(Array.isArray(range) && range.length === 2 && range.every((n) => typeof n === "number" && n > 0) && range[0] <= range[1])) throw new Error("scaleRange must be [smallest, biggest].");
      const scaleRange = range as [number, number] | undefined;
      const keep = [...await readKeepClear(args.avoid), ...(args.ignoreReserved === true ? [] : await readReserved())];
      const seed = seedOf(args.seed), random = seededRandom(seed);
      const { handle } = await liveEditor();
      const files = new Set((ids as string[]).map((i) => fileOfType(handle, i, args.kind)).filter(Boolean));
      if (files.size > 1) throw new Error("ids mixes units and doodads: scatter each in its own call.");
      const edge = await playable().catch(() => null), whole = wholeMap(handle);
      const key = [...files][0] ?? fileKey(args.kind ?? "doodads");
      const counts = new Map<string, number>();
      let noRoom = 0, keptClear = 0;
      await editPlaced(`Scatter ${(ids as string[]).join(", ")} in ${area.name ?? "an area"}`, key, async (f) => {
        const room = await handle.objects.occupancy();
        const types = (ids as string[]).map((id) => {
          const type = handle.objects.type(id);
          if (!type) throw new Error(`"${id}" isn't an object type here. list_objects gives them.`);
          return { id, type };
        });
        const sizes = await Promise.all(types.map(({ id, type }) => room.footprint(type.kind, id)));
        // The smallest sets the spacing: a rock among trees shouldn't thin out the trees. Whatever
        // doesn't fit at a spot is left out there.
        const smallest = Math.min(...sizes.map((fp) => (fp ? Math.max(fp.width, fp.height) * 32 : 128)));
        const spacing = Math.max(64, smallest) / Math.sqrt(density);
        for (const spot of scatterSpots(area, spacing, args.shape === "box" ? "box" : "ellipse", random)) {
          if ([...counts.values()].reduce((a, b) => a + b, 0) >= limit) break;
          if (isKeptClear(spot.x, spot.y, keep)) { keptClear++; continue; }
          const { id, type } = types[Math.floor(random() * types.length)];
          const facing = type.fixedRot ?? random() * 360, angle = (facing * Math.PI) / 180;
          if (!isBackdrop(type.kind, spot.x, spot.y, edge, whole) && !(await room.fits(type.kind, id, spot.x, spot.y, angle))) { noRoom++; continue; }
          const twin = args.mirror === true ? twinOf(spot.x, spot.y, whole) : null;
          const twinFacing = type.fixedRot ?? (facing + 180) % 360, twinAngle = (twinFacing * Math.PI) / 180;
          if (twin) {
            if (isKeptClear(twin[0], twin[1], keep)) { keptClear++; continue; }
            if (!isBackdrop(type.kind, twin[0], twin[1], edge, whole) && !(await room.fits(type.kind, id, twin[0], twin[1], twinAngle))) { noRoom++; continue; }
          }
          await room.mark(type.kind, id, spot.x, spot.y, angle);
          markBackdrop(add(f, handle, id, spot.x, spot.y, undefined, { facing, scaleRange }, true, random), spot.x, spot.y, edge);
          if (twin) {
            await room.mark(type.kind, id, twin[0], twin[1], twinAngle);
            markBackdrop(add(f, handle, id, twin[0], twin[1], undefined, { facing: twinFacing, scaleRange }, true, random), twin[0], twin[1], edge);
          }
          counts.set(id, (counts.get(id) ?? 0) + (twin ? 2 : 1));
        }
        if (!counts.size) throw new Error("There's no free ground there for these.");
      });
      return { placed: [...counts.values()].reduce((a, b) => a + b, 0), byType: Object.fromEntries(counts), spotsWithoutRoom: noRoom, spotsKeptClear: keptClear, seed, area };
    }),
    w3.mcp.registerTool("move_object", async ({ kind, index, id, x, y, facing, scale }) => {
      if (typeof x !== "number" || typeof y !== "number") throw new Error("x and y must be numbers.");
      const { handle } = await liveEditor();
      await editPlaced(`Move ${String(id)}`, fileKey(kind), (f) => {
        const e = f.list[Number(index)];
        if (!e || e.id !== id) throw new Error(`Number ${String(index)} isn't a ${String(id)} any more. list_placed gives the numbers.`);
        e.position = [x, y, heightAt(handle.terrain, x, y)];
        if (typeof facing === "number") e.angle = (facing * Math.PI) / 180;
        if (typeof scale === "number") e.scale = [scale, scale, scale];
      });
      return `Moved ${String(id)} to ${x}, ${y}.`;
    }),
    w3.mcp.registerTool("remove_objects", async (args) => {
      const { items, id, player } = args;
      const area = await readArea(w3, args);
      const listed = Array.isArray(items) ? items as { index: number; id: string }[] : null;
      if (!listed && !area && typeof id !== "string" && typeof player !== "number") throw new Error("Say what to remove: items, or an area, id or player.");
      let removed = 0;
      await editPlaced(`Remove objects${area?.name ? ` in ${area.name}` : ""}`, fileKey(args.kind), (f) => {
        const gone = new Set<Placed>();
        for (const it of listed ?? []) {
          const e = f.list[it.index];
          if (!e || e.id !== it.id) throw new Error(`Number ${it.index} isn't a ${it.id} any more. list_placed gives the numbers.`);
          gone.add(e);
        }
        if (!listed) {
          for (const e of f.list) {
            if ((typeof id !== "string" || e.id === id) && (typeof player !== "number" || (e as Placed & { player?: number }).player === player - 1)
              && (!area || inArea(e.position[0], e.position[1], area))) gone.add(e);
          }
        }
        if (!gone.size) throw new Error("Nothing matches that.");
        removed = gone.size;
        f.list.splice(0, f.list.length, ...f.list.filter((e) => !gone.has(e)));
      });
      return { removed };
    }),
    w3.services.provide(TERRAIN_SERVICE, toolGroups),
    // The dialog, or `given` options as they are (scripts and tests); the picture is of the terrain editor as it is.
    w3.commands.register("w3.terrain.exportMinimap", (given?: Partial<ExportOptions>) =>
      exportMinimap(w3, async () => (await liveEditor("read")).minimapSource(), given)),
    w3.commands.register("w3.terrain.open", async () => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      const path = projectTerrain(w3);
      if (!path) throw new Error("This project has no war3map.w3e.");
      await w3.editors.open(path, "w3.terrainViewer");
    }),
    // Shows a world point in the terrain editor (opening it first); used by the Object Manager.
    w3.commands.register("w3.terrain.showPoint", async (x?: number, y?: number, ref?: { id?: string; editorId?: number }) => {
      if (typeof x !== "number" || typeof y !== "number") return w3.commands.execute("w3.terrain.open");
      // `ref` (optional) also selects that placed object after centring.
      const pick: PlacedRef | undefined = ref ? { id: typeof ref.id === "string" ? ref.id : undefined, editorId: typeof ref.editorId === "number" ? ref.editorId : undefined, x, y } : undefined;
      toolGroups.pendingLook = [x, y, pick];
      await w3.commands.execute("w3.terrain.open");
      // The editor of the project's terrain, not whichever tab opened last.
      const look = toolGroups.look.get(projectTerrain(w3) ?? "");
      if (look && toolGroups.pendingLook) { look(x, y, pick); toolGroups.pendingLook = null; }
    }),
    // The View commands act on the terrain editor in front: another tab's would change what no one sees.
    ...viewCommandList.map(([id, run]) => w3.commands.register(id, async () => {
      const path = w3.editors.activePath();
      const view = path ? toolGroups.viewCommands.get(path) : undefined;
      if (!view) throw new Error("Switch to a terrain editor first.");
      refuseLostView(path);
      const why = await run(view);
      if (why) void w3.window.showInfo(why);
    })),
    // Object heights, on the terrain editor that has the focus.
    w3.commands.register("w3.terrain.setUniformDoodadHeights", async (given?: number) => {
      const view = (w3.editors.activePath() ? toolGroups.heightCommands.get(w3.editors.activePath()!) : undefined) ?? toolGroups.heightCommands.get(projectTerrain(w3) ?? "");
      if (!view) throw new Error("Switch to a terrain editor first.");
      let height = typeof given === "number" ? given : undefined;
      if (height === undefined) {
        const first = view.firstDoodadHeight();
        if (first === null) { void w3.window.showInfo("No doodads are selected: select doodads or destructables first."); return; }
        const typed = await w3.window.inputBox({ prompt: "Height for every selected doodad (world units, over the map's zero)", value: String(Math.round(first * 100) / 100) });
        if (typed === undefined) return;
        const n = parseHeight(typed);
        if (n === null) { void w3.window.showWarning(`"${typed}" isn't a height: type a number.`); return; }
        height = n;
      }
      const why = await view.setUniformHeights(height);
      if (why) void w3.window.showInfo(why);
    }),
    w3.commands.register("w3.terrain.resetFixedObjectHeights", () => {
      const view = (w3.editors.activePath() ? toolGroups.heightCommands.get(w3.editors.activePath()!) : undefined) ?? toolGroups.heightCommands.get(projectTerrain(w3) ?? "");
      if (!view) throw new Error("Switch to a terrain editor first.");
      const why = view.resetFixedHeights();
      if (why) void w3.window.showInfo(why);
    }),
    // The Advanced switches are settings, so they hold for every terrain editor and stay for the next session.
    ...([["w3.terrain.togglePreserveCopiedHeight", "terrain.preserveCopiedHeight", true], ["w3.terrain.toggleEnforceWaterLimits", "terrain.enforceWaterLimits", false], ["w3.terrain.toggleEnforceCameraBounds", "terrain.enforceCameraBounds", false],
      // View > Shadows: a view setting, also for every terrain editor.
      ["w3.terrain.toggleShadows", "terrain.shadows.visible", true]] as const)
      .map(([id, key, standard]) => w3.commands.register(id, () => setSwitch(w3, key, !switchedOn(w3, key, standard)))),
    w3.commands.register("w3.terrain.resetVariations", async () => {
      const path = w3.editors.activePath();
      const reset = path ? toolGroups.resetVariations.get(path) : undefined;
      if (!reset) throw new Error("Switch to a terrain editor first.");
      refuseLostView(path);
      if (!reset()) void w3.window.showInfo("Every ground tile is plain already.");
    }),
    // Replace Cliff Type, Tiles, Doodads, Units: the dialog, or `req` as given (scripts and tests). How many changed.
    ...([["w3.terrain.replaceCliffType", "cliffs"], ["w3.terrain.replaceTiles", "tiles"], ["w3.terrain.replaceDoodads", "doodads"], ["w3.terrain.replaceUnits", "units"]] as const)
      .map(([id, kind]) => w3.commands.register(id, async (given?: ReplaceRequest) => {
        const path = w3.editors.activePath();
        const at = path && toolGroups.replaceTypes.has(path) ? path : projectTerrain(w3);
        const replacer = at ? toolGroups.replaceTypes.get(at) : undefined;
        if (!replacer || !at) throw new Error("Open the terrain editor first.");
        refuseLostView(at);
        let req: ReplaceRequest | null = given ?? null;
        if (!req) {
          const choices = await replacer.choices(kind);
          if (!choices.from.length) {
            void w3.window.showInfo(kind === "doodads" ? "This map has no doodads to replace." : kind === "units" ? "This map has no units to replace." : "There is nothing to replace.");
            return 0;
          }
          req = await askReplace(kind, choices, kind === "doodads" || kind === "units" ? (from) => replacer.pickType!(kind, from) : undefined);
          if (!req) return 0;
        }
        // The editor may have closed while the dialog was open.
        if (toolGroups.replaceTypes.get(at) !== replacer) throw new Error("The terrain editor closed meanwhile; nothing was replaced.");
        const n = await replacer.run(kind, req);
        if (!given) void w3.window.showInfo(n ? `${replaceTitle(kind)}: ${n.toLocaleString()} ${kind === "tiles" || kind === "cliffs" ? "corners" : kind} changed. Undo takes it back.` : "Nothing to replace.");
        return n;
      })),
    w3.commands.register("w3.terrain.removeUnusedTiles", () => {
      const path = w3.editors.activePath();
      const editor = editorOf(path) ?? ownEditor();
      if (!editor) throw new Error("Open the terrain editor first.");
      refuseLostView(path && editorOf(path) ? path : projectTerrain(w3));
      const removed = editor.handle.removeUnusedGroundTiles();
      if (removed === null) throw new Error("The game's cliff types aren't read yet, so it isn't known which tiles cliffs use. Try again in a moment.");
      void w3.window.showInfo(removed.length ? `Removed ${removed.length} unused ground tile${removed.length === 1 ? "" : "s"}: ${removed.join(", ")}. Undo takes it back.` : "Every ground tile of the map is in use.");
      return removed;
    }),
    // `opts` (other extensions): dialog preset, and a step before the map is created (and opened).
    w3.commands.register("w3.map.new", async (opts?: NewMapPreset & { beforeCreate?(o: { dir: string; name: string }): Promise<void> }) => {
      const o = await askNewMap(w3, opts ?? {});
      if (!o) return null;
      // The new map opens as the project: unsaved changes are settled first.
      if (!(await w3.editors.closeAllAsking())) return null;
      await opts?.beforeCreate?.(o);
      await w3.window.withProgress(`Creating ${o.name}…`, () => createMap(w3, o));
      return o.dir;
    }),

    // Activity bar entry (like the World Editor's terrain palette): map facts and
    // a way into the 3D view.
    w3.views.register("w3.terrain.overview", {
      render(el) {
        if (!w3.workspace.project()) {
          el.append(h("div.view-empty", {}, "Open or import a project to view its terrain."));
          return;
        }
        const path = projectTerrain(w3);
        if (!path) {
          el.append(h("div.view-empty", {}, "This project has no war3map.w3e."));
          return;
        }
        const open = () => w3.commands.execute("w3.terrain.open").catch((e) => w3.window.showError(String(e)));
        const facts = h("div.terrain-facts.muted", {}, "Reading terrain…");
        el.append(
          h("div.tree", {}, h("div.tree-row.obj-kind", { onclick: open, title: "F3" },
            h("span.tree-icon", {}, "›"), h("span.tree-label", {}, "Open 3D view"))),
          facts,
        );
        readTerrainBytes(path, { readText: () => w3.workspace.readText(path), readBytes: () => w3.workspace.readBytes(path) }).then((buf) => {
          const t = parseW3e(buf);
          facts.replaceChildren(
            h("div", {}, TILESETS[t.tileset] ?? `Tileset ${t.tileset}`),
            h("div", {}, `${t.width - 1} × ${t.height - 1} tiles · w3e v${t.version}`),
            h("div", {}, `Ground: ${t.groundTiles.join(", ")}`),
          );
        }).catch((e) => { facts.textContent = String((e as Error).message ?? e); });
      },
    }),
    w3.workspace.onDidChange(() => w3.views.refresh("w3.terrain.overview")),

    w3.editors.registerProvider("w3.terrainViewer", {
      async resolve(el, doc) {
        let terrain: Terrain;
        /** The terrain as last saved: the baseline for updating shadows. */
        let savedW3e: Uint8Array;
        try {
          savedW3e = await readTerrainBytes(doc.path, doc);
          terrain = parseW3e(savedW3e);
        } catch (e) {
          el.append(errorView(`Can't read ${doc.path}: ${errorText(e)}`, h("button.link-inline", { onclick: () => w3.editors.open(doc.path, "w3.hexViewer") }, "Open in Binary Viewer")));
          return {};
        }
        const canvas = h("canvas.model-canvas");
        /** The keys go back to the map (after a toolbar control was used). Once now and once after the event: WebKitGTK
         *  (Linux) focuses a checkbox or button after its click handlers ran, which would take the keys back. */
        const keysToMap = () => {
          const focus = () => { if (canvas.isConnected) canvas.focus({ preventScroll: true }); };
          focus();
          setTimeout(focus);
        };
        let renderer: TerrainRenderer;
        try {
          renderer = new TerrainRenderer(canvas, terrain);
          // The art and the lighting come in the graphics mode the view opened with; so does the picture's tone.
          renderer.tone = toneOf(w3.settings.get<string>("game.graphicsMode"));
        } catch (e) {
          el.append(errorView(`WebGL: ${errorText(e)}`));
          return {};
        }
        // A lost context (a GPU reset, a driver hiccup) takes every texture, mesh and model on the GPU
        // with it, and they come from a long load (ground, cliffs, doodads, units, splats, shadows,
        // weather) that this view can't run again in place. Opening the editor again would, but it reads
        // the terrain from disk: unsaved edits would be gone. So drawing stops for good and a message says
        // so, over the view. No edit lands on a view that isn't drawn: the message takes the mouse, the
        // toolbar and panels go inert, keys, undo and redo do nothing, and the commands and MCP tools that
        // edit refuse (lostViews). The edits stay in memory and saving works as before; Reopen is refused
        // while some are unsaved.
        /** Set at a loss, and never cleared: the renderer's GPU objects are gone even once the context is back. */
        let glDead = false;
        const glMessage = h("div.gl-lost-text");
        const glLost = h("div.gl-lost", { hidden: true }, glMessage);
        const reopenAfterLoss = async () => {
          if (w3.editors.isDirty(doc.path)) {
            void w3.window.showWarning("Save first (Ctrl+S): opening the editor again reads the terrain from disk, and the unsaved edits would be lost.");
            return;
          }
          await w3.editors.close(doc.path);
          await w3.editors.open(doc.path, "w3.terrainViewer");
        };
        const glWatch = watchContextLoss(canvas, {
          lost: () => {
            glDead = true;
            lostViews.add(doc.path);
            // The toolbar, the tool tabs and the side panels can't be used either: only the message and saving.
            for (const x of el.querySelectorAll<HTMLElement>(".model-main > :not(.model-stage), .model-side")) x.inert = true;
            glMessage.replaceChildren(
              h("div", {}, "The graphics device was reset (WebGL context lost), and the 3D view stopped."),
              h("div", {}, "Your edits are kept, and saving works. Save (Ctrl+S), then open the editor again to see the map."),
              h("button", { onclick: () => void reopenAfterLoss() }, "Reopen editor"));
            glLost.hidden = false;
          },
          restored: () => {},
        });
        let dirty = true, loadDirty = false;
        const redraw = () => { dirty = true; };
        /** A texture or other art came in: drawn with the next frame the load lets through (see tick). */
        const loadRedraw = () => { loadDirty = true; };
        /** Art that loads besides the loader's models and textures (ground, water, ground marks): a
         *  picture waits for it as for the models, or a goldmine's mark could be missing from it. */
        const artLoads = new Set<Promise<unknown>>();
        const artLoad = <T,>(load: Promise<T>): Promise<T> => {
          artLoads.add(load);
          const done = () => { artLoads.delete(load); };
          load.then(done, done);
          return load;
        };
        const artSettled = async () => { while (artLoads.size) await Promise.allSettled([...artLoads]); };
        const labelLayer = h("div.terrain-labels");
        let labels: { x: number; y: number; el: HTMLElement }[] = [];

        // ---- day/night lighting ---------------------------------------------------------
        // Settings: on/off (off: an even light) and the hour; both remembered across maps.
        let lighting: MapLighting | null = null;
        const lightOn = () => w3.settings.get<boolean>("terrain.lighting.enabled", true) !== false;
        const lightHour = () => Math.max(0, Math.min(23, Math.round(Number(w3.settings.get<number>("terrain.lighting.hour", 12)) || 0)));
        const lightBox = h("input", { type: "checkbox", checked: lightOn(), onchange: () => { void w3.settings.set("terrain.lighting.enabled", lightBox.checked); keysToMap(); } });
        const lightSelect = h("select", { onchange: () => { void w3.settings.set("terrain.lighting.hour", Number(lightSelect.value)); keysToMap(); } },
          ...Array.from({ length: 24 }, (_, hr) => h("option", { value: String(hr), selected: lightHour() === hr }, `${hr}:00`)));
        /** Game view (V, View > Lock to Game View Settings): the map as the game shows it (viewmodes.ts shownView).
         *  A setting, so it holds for every terrain editor and stays for the next session. */
        const gameViewOn = () => w3.settings.get<boolean>("terrain.gameView", false) === true;
        /** In the view's upper right while game view is on, as the World Editor's "Game View Settings". */
        const gameBadge = h("div.terrain-gameview-badge", { hidden: !gameViewOn(), title: "Game view (V): lit and fogged as in the game, without the editor's marks" }, "Game View");
        /** Set with the View commands (below): draws the view again after a setting it depends on changed. */
        let viewChanged = () => {};
        /** Set with the layers (below): after another tab opened, the layers that tab draws itself. */
        let layersAfterTab = () => {};
        const applyLight = () => {
          // Game view lights the map whatever the Lighting box says (the box keeps its choice for afterwards).
          const on = lightOn() || gameViewOn(), hour = lightHour();
          lightBox.checked = lightOn();
          lightBox.disabled = gameViewOn();
          lightSelect.value = String(hour);
          lightSelect.disabled = !on;
          renderer.gameView = on;
          // The game's own lighting models light HD's real shadows more than a map's own do (tone.ts GAME_LIGHT_FILL).
          const filled = (l: SceneLight | null, own: boolean | undefined): SceneLight | null => (l && !own ? { ...l, fill: GAME_LIGHT_FILL } : l);
          renderer.terrainLight = on && lighting?.terrain ? filled(lightAt(lighting.terrain, hour), lighting.own.terrain) : null;
          renderer.waterTint = lighting && lighting.flags & WATER_TINTING ? lighting.waterTint : null;
          renderer.unitLight = on && lighting?.unit ? filled(lightAt(lighting.unit, hour), lighting.own.unit) : null;
          redraw();
        };
        const showBoundary = () => w3.settings.get<boolean>("terrain.boundary", true) !== false;
        /** The playable part as last read from the map; null until then. */
        let playableEdge: Area | null = null;
        const loadBorder = async () => {
          const info = await readMapDoc<{ cameraComplements?: number[]; cameraBounds?: number[] } & Parameters<typeof fogOf>[0]>(w3, "map/war3map.w3i.json").catch(() => null);
          if (!info) return;
          cameraArea = cameraRect(info);
          renderer.fog = fogOf(info);
          playableEdge = playableArea(info, terrain);
          renderer.setBorder(borderShade(terrain.width - 1, terrain.height - 1, info.cameraComplements), terrain.width - 1, terrain.height - 1);
          redraw();
        };
        renderer.showBorder = showBoundary();
        renderer.showFog = w3.settings.get<boolean>("terrain.fog", true) !== false;
        /** The game's skies, for the view: a map doesn't keep one, the World Editor has it as a preference. */
        const skySelect = h("select", { title: "The sky in this view. It isn't part of the map", onchange: () => { void w3.settings.set("terrain.sky", skySelect.value); keysToMap(); } }, h("option", { value: "" }, "No sky"));
        const showSkyChoice = async () => {
          const path = w3.settings.get<string>("terrain.sky", "") ?? "";
          skySelect.value = path;
          if (!path) { renderer.sky = null; redraw(); return; }
          const { batches, failed } = await loader.loadModels("sky", [{ path: path.replace(/\.mdl$/i, ".mdx"), replaceable: {}, instances: [{ world: new Float32Array(16), team: 0 } as unknown as ObjectInstance] }]);
          if (failed.length) { void w3.window.showWarning(`The sky didn't load: ${failed[0].error}`); return; }
          const b = bounds(batches[0].gpu.model);
          renderer.sky = { gpu: batches[0].gpu, radius: Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2 };
          redraw();
        };
        Promise.all([w3.game.readText("UI\\WorldEditData.txt"), w3.game.readText("UI\\WorldEditStrings.txt")]).then(([data, strings]) => {
          skySelect.append(...skyList(data, strings).map((s) => h("option", { value: s.path }, s.name)));
          return showSkyChoice();
        }).catch(() => { /* no list, no sky */ });
        void loadBorder();
        /** The map's weather as last shown, so that only a change starts it over. */
        let weatherShown = "";
        const loadWeather = async () => {
          const [info, regions] = await Promise.all([
            readMapDoc<{ weather?: string }>(w3, "map/war3map.w3i.json").catch(() => null),
            readMapDoc<{ regions: ({ weather: string } & WeatherBox)[] }>(w3, "map/war3map.w3r.json").catch(() => null),
          ]);
          const real = (id?: string) => !!id && id !== "0x00000000";
          const wanted = [...(real(info?.weather) ? [{ id: info!.weather!, box: null as WeatherBox | null }] : []),
            ...(regions?.regions ?? []).filter((r) => real(r.weather)).map((r) => ({ id: r.weather, box: { left: r.left, right: r.right, bottom: r.bottom, top: r.top } as WeatherBox | null }))];
          const key = JSON.stringify(wanted);
          if (key === weatherShown) return;
          weatherShown = key;
          const rows = wanted.length ? new Map(parseSlk(await w3.game.readText("TerrainArt\\Weather.slk").catch(() => "")).map((r) => [r.effectID, r])) : new Map<string, Record<string, string>>();
          const list = renderer.setWeather(wanted.filter((w) => rows.has(w.id)).map((w) => ({ effect: weatherEffect(rows.get(w.id)!), box: w.box })));
          for (const w of list) {
            const read = (ext: string) => readFile(w3, doc, w.effect.texture + ext).then((buf) => renderer.setWeatherTexture(w, decodeImage(buf, w.effect.texture + ext)));
            void read(".blp").catch(() => read(".dds")).catch(() => { /* white streaks show it's there */ });
          }
          redraw();
        };
        renderer.showWeather = w3.settings.get<boolean>("terrain.weather", true) !== false;
        void loadWeather();
        const stopWeatherWatch = w3.workspace.onDidChange(() => void loadWeather());
        const stopWeatherSaves = w3.workspace.onDidSave((path) => { if (/war3map\.w3[ir]\.json$/i.test(path)) void loadWeather(); if (/war3map\.w3i\.json$/i.test(path)) void loadBorder(); });
        const stopLightSettings = w3.settings.onDidChange((key) => {
          if (key === "terrain.boundary") { renderer.showBorder = showBoundary(); void loadBorder(); }
          if (key === "terrain.sky") void showSkyChoice();
          if (key === "terrain.preserveCopiedHeight" || key === "terrain.enforceWaterLimits" || key === "terrain.enforceCameraBounds") viewSyncs.forEach((f) => f());
          if (key.startsWith("terrain.lighting.")) applyLight();
          if (key === "terrain.gameView" || key === "terrain.fog" || key === "terrain.weather") viewChanged();
          if (key === "terrain.animate") { renderer.setAnimate(w3.settings.get<boolean>("terrain.animate", true) !== false); redraw(); }
        });
        renderer.setAnimate(w3.settings.get<boolean>("terrain.animate", true) !== false);
        const reloadLighting = () => void loadMapLighting(w3, terrain.tileset).then((l) => {
          lighting = l;
          lightBox.title = `The map's day/night lighting (${l.source}); off: an even light`;
          lightSelect.title = "Time of day";
          applyLight();
          // The map's wave flags decide where shoreline foam goes.
          void replanShore();
        }, () => {});
        // Saved lighting, map properties (light environment) or lighting models change the light.
        const stopLightWatch = w3.workspace.onDidSave((p) => { if (/war3map\.w3[li](\.json)?$|\.mdl$/i.test(p)) reloadLighting(); });
        reloadLighting();

        // ---- editing ------------------------------------------------------------------
        const editable = !doc.readOnly;
        // The World Editor's Advanced switches for this kind of work; the settings are shared by every terrain editor.
        const preserveHeight = () => switchedOn(w3, "terrain.preserveCopiedHeight", true);
        const enforceWater = () => switchedOn(w3, "terrain.enforceWaterLimits", false);
        /** The map's camera bounds as last read; null until then, or when the map has none. */
        let cameraArea: Bounds | null = null;
        /** The bounds objects are held to: none unless Enforce Camera Bounds is on. */
        /** Where a moved object may stand: the map (the playable part, for units and items) cut by the camera bounds when enforced. */
        const moveBounds = (e: Placed): Bounds => limitTo(dooFile?.list.includes(e) ? wholeMap(handle) : playableEdge ?? wholeMap(handle), heldTo());
        const heldTo = (): Bounds | null => (switchedOn(w3, "terrain.enforceCameraBounds", false) ? cameraArea : null);
        /** One undoable change: a terrain stroke or an object edit. */
        interface Edit { undo(): void; redo(): void; terrain: boolean; objects: boolean }
        /** Undo history; `at` edits are applied, `mark` knows which position the files match. */
        const history: Edit[] = [];
        let at = 0;
        const mark = new SaveMark();
        /** Set by every edit; the minimap is redrawn on the next save. */
        const minimapStale = new Stale();
        /** Tool groups of other extensions, by group id. */
        const groupInsts = new Map<string, TerrainToolGroupInstance>();
        const notifyGroups = (e: Edit) => { for (const g of groupInsts.values()) g.changed?.({ terrain: e.terrain, objects: e.objects }); };
        const changed = (e: Edit) => {
          notifyGroups(e);
          minimapStale.set();
          occupancyPromise = walkPromise = destructablePromise = standingPromise = null;
          if (e.terrain && areaPanel) void showAreaPanel();
          if (e.terrain) { replanCliffs(); renderer.terrainChanged(); if (!e.objects) refloat(); }
          if (e.objects) { objectsTouched = true; void rebuildObjects(); }
          shadowEditsSoon();
          refreshLayersSoon();
          doc.setDirty(mark.isDirty(at));
          redraw();
        };
        // Past its own steps, undo and redo go on to a map resize (Map Size), which reopens the editor.
        const resizeStep = (which: "undo" | "redo") => void w3.commands.execute(`w3.terrainMapSize.${which}`, { quiet: true }).catch(() => {});
        /** True, with a warning, when the view is lost: then nothing is edited (see lostViews). */
        const refuseLost = () => { if (glDead) void w3.window.showWarning(VIEW_LOST); return glDead; };
        const undo = () => { if (refuseLost()) return; if (at > 0) { const e = history[--at]; e.undo(); changed(e); } else resizeStep("undo"); };
        const redo = () => { if (refuseLost()) return; if (at < history.length) { const e = history[at++]; e.redo(); changed(e); } else resizeStep("redo"); };
        /** While a key edits: whether it's the first press or a repeat of a held key. */
        let keyPress: "first" | "repeat" | null = null;
        /** The undo step a held key is building; a repeat joins it. */
        let keyStep: Edit | null = null;
        const pushEdit = (e: Edit) => {
          // A stroke commits here, not through changed(): the view layers follow every edit.
          refreshLayersSoon();
          notifyGroups(e);
          shadowEditsSoon();
          minimapStale.set();
          occupancyPromise = walkPromise = destructablePromise = standingPromise = null;
          if (keyPress === "repeat" && keyStep && history[at - 1] === keyStep && at === history.length && mark.isDirty(at) && !mark.pending(at)) {
            history[at - 1] = keyStep = joinSteps(keyStep, e);
            doc.setDirty(true);
            return;
          }
          mark.truncated(at);
          history.length = at;
          history.push(e);
          at = history.length;
          keyStep = keyPress ? e : null;
          doc.setDirty(mark.isDirty(at));
        };
        /** Runs a key's edit; however long the key is held, it's one undo step. */
        const byKey = (e: KeyboardEvent, edit: () => void) => {
          keyPress = e.repeat ? "repeat" : "first";
          try { edit(); } finally { keyPress = null; }
        };
        const groundAt = (e: MouseEvent) => {
          const rect = canvas.getBoundingClientRect();
          return renderer.pickGround(renderer.ray(e.clientX - rect.left, e.clientY - rect.top));
        };
        /** A finished terrain stroke as one undo step; objects on the edited
         *  ground follow it (doodads with a fixed height, flag 4, keep theirs). */
        const commitTerrain = (st: { corners: number[]; undo(): void; redo(): void; cliffs?: boolean }): boolean => {
          if (enforceWater()) {
            // Enforce Water Height Limits: water pushed against the limit of the stored level is cut off
            // there and loses its shape, so the whole edit is refused instead.
            const word = () => st.corners.map((i) => ({ hasWater: terrain.corners[i].hasWater, rawWater: terrain.corners[i].rawWater }));
            const after = word();
            st.undo();
            const hits = waterLimitHits(word(), after);
            if (hits.length) {
              if (st.cliffs) replanCliffs(); else void replanShore();
              renderer.terrainChanged();
              redraw();
              void w3.window.showWarning(`Not done: the water at ${hits.length} corner${hits.length === 1 ? "" : "s"} would go past the game's lowest or highest water height. Turn off Enforce Water Height Limits to have it cut off there.`);
              return false;
            }
            st.redo();
          }
          const follow = groundFollowers(st.corners);
          const setZ = (z: number[]) => follow.forEach((p, i) => { p.position = [p.position[0], p.position[1], z[i]]; });
          const zBefore = follow.map((p) => p.position[2]);
          const zAfter = follow.map((p) => heightAt(terrain, p.position[0], p.position[1]));
          const moved = zAfter.some((z, i) => Math.abs(z - zBefore[i]) > 0.01);
          pushEdit({
            undo: () => { st.undo(); if (moved) setZ(zBefore); },
            redo: () => { st.redo(); if (moved) setZ(zAfter); },
            terrain: true, objects: moved,
          });
          if (moved) { setZ(zAfter); objectsTouched = true; void rebuildObjects(); } else refloat();
          if (st.cliffs) replanCliffs(); else void replanShore();
          renderer.terrainChanged();
          redraw();
          return true;
        };

        // ---- side panel ---------------------------------------------------------
        const texList = h("div.model-list");
        const markerList = h("div.model-list");
        const status = (row: HTMLElement, cls: string, title?: string) => {
          row.firstElementChild!.className = `model-dot ${cls}`;
          if (title) row.title = title;
        };
        const texHeading = h("h4", {}, `Ground textures (${terrain.groundTiles.length})`);
        const groundFacts = h("div");
        /** Adds tile i's row to the side list and loads its texture. */
        const loadTile = (i: number, paths: Map<string, string>) => {
          const id = terrain.groundTiles[i], path = paths.get(id);
          const row = h("div.model-row", { title: path ?? id }, h("span.model-dot.pending", {}, "●"), h("span", {}, `${id} `), h("small.muted", {}, path?.split("\\").pop() ?? "unknown tile"));
          texList.append(row);
          texHeading.textContent = `Ground textures (${terrain.groundTiles.length})`;
          groundFacts.textContent = `${terrain.groundTiles.length} ground · ${terrain.cliffTiles.length} cliff textures`;
          if (!path) { status(row, "missing"); return; }
          let img = tileImages.get(id);
          if (!img) {
            img = readGroundTexture(w3, doc, path).then(({ buf, name }) => ({ img: decodeImage(buf, name), name }));
            tileImages.set(id, img);
          }
          void artLoad(img.then(({ img: mip, name }) => {
            // The list may have changed meanwhile; only the current index gets it.
            if (terrain.groundTiles[i] !== id) return;
            renderer.setGroundTexture(i, mip);
            row.title = name;
            status(row, "ok");
            loadRedraw();
          }).catch((e) => status(row, "missing", `${path}: ${(e as Error).message ?? e}`)));
        };
        /** Decoded ground textures by tile id. */
        const tileImages = new Map<string, Promise<{ img: DecodedImage; name: string }>>();
        /** Rebuilds the side list and the renderer's textures after the tile list changed. */
        const syncTileList = async () => {
          const paths = await tilePaths(w3);
          // Emptied only now: rows added meanwhile (another sync, a tile being added) would stay otherwise.
          texList.replaceChildren();
          texHeading.textContent = `Ground textures (${terrain.groundTiles.length})`;
          groundFacts.textContent = `${terrain.groundTiles.length} ground · ${terrain.cliffTiles.length} cliff textures`;
          terrain.groundTiles.forEach((_, i) => loadTile(i, paths));
        };

        /** Each tileset's own ground tiles, once read: a tile list equal to its tileset's isn't custom. */
        let ownTiles: Map<string, string[]> | null = null;
        const tilesetList = () => loadTilesets(w3).then((d) => {
          const sets = d.sets.map((s) => ({ id: s.id, name: s.name, tiles: s.tiles.map((t) => t.id) }));
          ownTiles = new Map(sets.map((s) => [s.id, s.tiles]));
          return sets;
        });
        void tilesetList().catch(() => { /* the flag stays set; the palettes say what's missing */ });
        /** Changes the map's ground tile list: `tiles` is the new list, `map`
         *  gives each old index's new index. Corners and cliff types are
         *  remapped; one undo step. */
        const changeTileList = (tiles: string[], map: (oldIndex: number) => number) => {
          const snap = () => ({
            ground: [...terrain.groundTiles], cliffs: [...terrain.cliffTiles], custom: terrain.customTilesetsRaw,
            tex: terrain.corners.map((c) => c.texture), ctex: terrain.corners.map((c) => c.cliffTexture),
          });
          const restore = (v: ReturnType<typeof snap>) => {
            terrain.groundTiles = [...v.ground];
            terrain.cliffTiles = [...v.cliffs];
            terrain.customTilesetsRaw = v.custom;
            terrain.customTilesets = v.custom !== 0;
            terrain.corners.forEach((c, i) => { c.texture = v.tex[i]; c.cliffTexture = v.ctex[i]; });
            void syncTileList();
          };
          const before = snap();
          // Cliff types follow the ground tile order (see cliffs.ts); the custom tiles flag follows the list: exactly
          // the tileset's own (a template) isn't custom, as the World Editor writes it.
          applyTileList(terrain, tiles, map, cliffData?.types ?? new Map<string, CliffType>(), ownTiles?.get(terrain.tileset));
          const after = snap();
          pushEdit({ undo: () => restore(before), redo: () => restore(after), terrain: true, objects: false });
          void syncTileList();
          replanCliffs();
          renderer.terrainChanged();
          minimapStale.set();
          redraw();
        };
        /** Takes ground tiles out of the list in one undo step (see planRemoval): the removed ids. Refused until the
         *  game's cliff types are read, since what a cliff is made of isn't known before. */
        const removeTiles = (remove: readonly number[], replace: ReadonlyMap<number, number>): string[] => {
          if (!editable) throw new Error("This terrain is read-only.");
          if (!cliffData) throw new Error("The game's cliff types aren't read yet, so it isn't known which tiles cliffs use. Try again in a moment.");
          const plan = planRemoval(terrain.groundTiles, remove, replace, tileUse(terrain, cliffData.types));
          changeTileList(plan.tiles, plan.map);
          return plan.removed;
        };
        /** Removes the tiles nothing uses (one undo step; none, no step): their ids, or null while the cliff types
         *  aren't read. */
        const removeUnusedTiles = (): string[] | null => {
          if (!cliffData) return null;
          const unused = unusedTiles(tileUse(terrain, cliffData.types));
          // A list nothing uses at all (no corners): the first tile stays.
          const remove = unused.length === terrain.groundTiles.length ? unused.slice(1) : unused;
          return remove.length ? removeTiles(remove, new Map()) : [];
        };
        /** What the tileset decides besides the tiles: blight, water, shoreline, default lighting. */
        const loadTilesetArt = () => {
        // The tileset's blight texture (UI\WorldEditData.txt, [TileSets]: name,texture).
        void artLoad(w3.game.readText("UI\\WorldEditData.txt").then(async (text) => {
          const entry = parseIni(text).get("TileSets")?.get(terrain.tileset.toLowerCase());
          const path = entry?.split(",")[1]?.trim();
          if (!path) return;
          const { buf, name } = await readGroundTexture(w3, doc, `${path}.blp`);
          renderer.setGroundTexture(BLIGHT_TEXTURE, decodeImage(buf, name));
          loadRedraw();
        }).catch(() => { /* blight shows as the placeholder colour */ }));
        tilePaths(w3).then((paths) => terrain.groundTiles.forEach((_, i) => loadTile(i, paths)))
          .catch((e) => texList.replaceChildren(h("div.model-warn", {}, `Terrain.slk: ${(e as Error).message ?? e}`)));
        // The tileset's water (TerrainArt\Water.slk, row "<tileset>Sha"): animation frames
        // <texFile>00…, frames per second, and the shallow/deep colour ramp (alpha, r, g, b).
        void artLoad(w3.game.readText("TerrainArt\\Water.slk").then((text) => {
          const rows = parseSlk(text);
          const row = rows.find((r) => r.waterID === `${terrain.tileset}Sha`) ?? rows.find((r) => r.waterID?.toLowerCase() === `${terrain.tileset}sha`.toLowerCase());
          if (!row) return;
          // Shoreline models: <shoreDir>\<file>\<file>0.mdx.
          const shore = (file: string) => `${row.shoreDir}\\${file}\\${file}0.mdx`;
          if (row.shoreDir && row.shoreSFile) {
            shoreModels = { straight: shore(row.shoreSFile), outside: shore(row.shoreOCFile || row.shoreSFile), inside: shore(row.shoreICFile || row.shoreSFile) };
            void replanShore();
          }
          const argb = (k: string) => [`${k}_R`, `${k}_G`, `${k}_B`, `${k}_A`].map((c) => Number(row[c] ?? 255) / 255);
          const frames = Math.max(1, Number(row.numTex) || 1);
          renderer.setWaterLook({ rate: Number(row.texRate) || 1, shallowMin: argb("Smin"), shallowMax: argb("Smax"), deepMin: argb("Dmin"), deepMax: argb("Dmax") }, frames);
          for (let i = 0; i < frames; i++) {
            const path = frames > 1 ? `${row.texFile}${String(i).padStart(2, "0")}.blp` : `${row.texFile}.blp`;
            // The tileset's own water frames (`_Tilesets/<letter>.w3mod`) where it has them.
            void artLoad(readFile(w3, doc, path, terrain.tileset).then((buf) => { renderer.setWaterFrame(i, decodeImage(buf, path)); loadRedraw(); }, () => {}));
          }
        }).catch(() => { /* the default water colour */ }));
        };
        loadTilesetArt();
        const thumbCache = new Map<string, Promise<string | null>>();
        /** Data URL of a ground texture's first cell (the plain tile). */
        const tileThumb = (path: string) => {
          let p = thumbCache.get(path);
          if (!p) {
            p = readGroundTexture(w3, doc, path).then(({ buf, name }) => {
              // Four rows of cells, a thumbnail each: no need to decode a Reforged tile's full size for that.
              const image = decodeImage(buf, name), mip = image.mip(levelFor(image, 4 * 32)), cell = mip.height / 4;
              const full = document.createElement("canvas");
              full.width = mip.width; full.height = mip.height;
              full.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(mip.rgba), mip.width, mip.height), 0, 0);
              const out = document.createElement("canvas");
              out.width = out.height = 32;
              out.getContext("2d")!.drawImage(full, 0, 0, cell, cell, 0, 0, 32, 32);
              return out.toDataURL();
            }).catch(() => null);
            thumbCache.set(path, p);
          }
          return p;
        };
        /** Index of a ground tile type, adding it to the map's list if needed
         *  (null when the list is full). At once, with no wait: see placePaste. */
        const ensureTile = (id: string): number | null => {
          const have = terrain.groundTiles.indexOf(id);
          if (have >= 0) return have;
          if (terrain.groundTiles.length >= MAX_GROUND_TILES) {
            w3.window.showWarning(`This map already uses ${MAX_GROUND_TILES} ground tile types, the most a map can have.`);
            return null;
          }
          terrain.groundTiles.push(id);
          // The tile list no longer matches the tileset's default (as a rule).
          terrain.customTilesetsRaw = customTilesFlag(terrain.groundTiles, ownTiles?.get(terrain.tileset));
          terrain.customTilesets = terrain.customTilesetsRaw !== 0;
          // A tile with its own cliff type adds that type (cliff indices follow the tile order).
          if (cliffData) {
            const ct = [...cliffData.types.values()].find((c) => c.groundTile === id);
            if (ct && !terrain.cliffTiles.includes(ct.cliffID)) terrain.cliffTiles.push(ct.cliffID);
          }
          const added = terrain.groundTiles.length - 1;
          // Load in the background so the stroke starts right away. A paste that was refused took it out again meanwhile.
          void tilePaths(w3).then((paths) => { if (terrain.groundTiles[added] === id) loadTile(added, paths); });
          minimapStale.set();
          return terrain.groundTiles.length - 1;
        };

        /** The side panel's Doodads and Units boxes: the same View items as the toolbar's (kept in step by applyView). */
        const markerBoxes = new Map<"doodads" | "units", HTMLInputElement>();
        const markerToggle = (name: "doodads" | "units", label: string, count: number) => {
          const box = h("input", { type: "checkbox", checked: viewState[name], disabled: gameViewOn(), onchange: () => {
            if (box.checked !== viewState[name]) toggleLayer(name);
          } });
          markerBoxes.set(name, box);
          return h("label.model-row", {}, box, h("span", {}, ` ${label}`), h("small.muted", {}, ` ${count.toLocaleString()}`));
        };
        const problems = h("div.model-list");
        const texInfo = h("div.muted");
        const loader = new ObjectLoader(renderer.gl, (p) => readFile(w3, doc, p, terrain.tileset), () => {
          loadRedraw();
          const list = [...loader.missing];
          // Click: the placed objects whose model uses the texture.
          const users = (tex: string) => {
            const models = loader.modelsUsing(tex);
            return renderer.batches.flatMap((b) => b.instances).filter((i) => i.pick?.placed && models.has(i.pick.model.toLowerCase())).map((i) => i.pick!.placed);
          };
          // Textures missing in models the map imports are the map's to fix; the game's own models
          // have a few broken references too (the DE Sheep names textures in the wrong folder).
          const mapFiles = new Set(w3.workspace.project() ? w3.workspace.files().map((f) => f.path.replace(/\\/g, "/").toLowerCase()) : []);
          const fromMap = (tex: string) => [...loader.modelsUsing(tex)].some((m) => mapFiles.has(`map/${m.replace(/\\/g, "/")}`));
          const ours = list.filter(([p]) => fromMap(p)), game = list.filter(([p]) => !fromMap(p));
          const line = ([p, e]: [string, string], cls: string) => h(`div.${cls}.clickable`, { title: `${p}: ${e}\nClick: show the objects using it`,
            onclick: () => showEntries(users(p)) }, `${p}: ${e}`);
          texInfo.replaceChildren(
            ours.length ? `${ours.length} texture${ours.length === 1 ? "" : "s"} of the map's models not found` : "",
            ...ours.slice(0, 3).map((x) => line(x, "model-warn")),
            ...(game.length ? [h("details.terrain-game-tex", {},
              h("summary", { title: "The game's own models reference these, but the game data doesn't have them there. Nothing the map can fix." },
                `${game.length} texture${game.length === 1 ? "" : "s"} missing in the game's own models`),
              ...game.slice(0, 20).map((x) => line(x, "muted")))] : []));
          texInfo.title = list.map(([p, e]) => `${p}: ${e}`).join("\n");
        });
        const cliffInfo = h("div.muted", {}, "Loading cliffs…");
        /** Cliff types and the game's file list, once loaded. */
        let cliffData: { types: Map<string, CliffType>; exists: (p: string) => boolean } | null = null;
        /** Bumped per re-plan so a slow older one can't overwrite a newer one. */
        let cliffGen = 0;
        /** The tileset's shoreline models (from Water.slk), once known. */
        let shoreModels: ShoreModels | null = null;
        let shoreGen = 0;
        /** Places shoreline foam where water meets the ground (initially and after edits). */
        async function replanShore() {
          if (!shoreModels) return;
          const gen = ++shoreGen;
          const flags = lighting?.flags ?? CLIFF_SHORE_WAVES | ROLLING_SHORE_WAVES;
          const waves = { cliffShores: (flags & CLIFF_SHORE_WAVES) !== 0, rollingShores: (flags & ROLLING_SHORE_WAVES) !== 0 };
          const { batches } = await loader.loadModels("shoreline", planShoreline(terrain, shoreModels, waves));
          if (gen !== shoreGen) return;
          renderer.setGroup("shoreline", batches);
          redraw();
        }
        /** Places cliff models for the current layers (initially and after edits). */
        async function replanCliffs(shore = true) {
          if (shore) void replanShore();
          if (!cliffData) return;
          const gen = ++cliffGen;
          const { requests, groundOverrides } = planCliffs(terrain, cliffData.types, cliffData.exists);
          const { batches, failed } = await loader.loadModels("cliffs", requests);
          if (gen !== cliffGen) return;
          const broken = new Set(failed.map((f) => f.index));
          renderer.setGroup("cliffs", batches.map((b) => ({ ...b, followGround: true })));
          renderer.setCliffTiles(new Set(requests.flatMap((r, i) => (broken.has(i) ? [] : r.tiles))), groundOverrides);
          const tiles = requests.reduce((n, r) => n + r.tiles.length, 0);
          cliffInfo.textContent = `${tiles.toLocaleString()} cliff tiles · ${requests.length} cliff models${failed.length ? ` · ${failed.length} failed` : ""}`;
          cliffInfo.title = failed.map((f) => f.error).join("\n");
          redraw();
        }
        /** Cliffs during a stroke: one replan at a time and the newest state after it, or a drag faster than
         *  the models load would never see any. The shore, which takes longer, waits for the end of the stroke. */
        let cliffsBusy = false, cliffsAgain = false;
        const liveCliffs = async () => {
          if (cliffsBusy) { cliffsAgain = true; return; }
          cliffsBusy = true;
          try {
            do { cliffsAgain = false; await replanCliffs(false); } while (cliffsAgain);
          } finally { cliffsBusy = false; }
        };
        Promise.all([w3.game.readText("TerrainArt\\CliffTypes.slk"), w3.game.list()]).then(async ([slk, list]) => {
          const types = new Map(parseSlk(slk).filter((r) => r.cliffID).map((r) => [r.cliffID, r as unknown as CliffType]));
          // Stored paths look like "War3.w3mod:_HD.w3mod:Doodads/…". Only the art
          // layers of the current graphics mode count: HD has cliff variations
          // the classic art lacks.
          const mode = w3.settings.get<string>("game.graphicsMode") ?? "hd";
          const skip = mode === "sd" ? /_(hd|de)\.w3mod:/i : mode === "hd" ? /_de\.w3mod:/i : null;
          const files = new Set(list.filter((p) => !skip?.test(p)).map((p) => p.slice(p.lastIndexOf(":") + 1).toLowerCase()));
          cliffData = { types, exists: (p) => files.has(p.replace(/\\/g, "/").toLowerCase()) };
          await replanCliffs();
        }).catch((e) => { cliffInfo.textContent = `Cliffs: ${(e as Error).message ?? e}`; });

        // ---- placed objects -----------------------------------------------------------
        let dooFile: PlacedFile | null = null, unitsFile: PlacedFile | null = null;
        /** Start locations as last saved: the map's players follow their changes (see syncPlayers). */
        let savedStarts = new Map<number, number[]>();
        /** Doodads as last saved (shadow baseline, like savedW3e). */
        let savedDoodads: Placed[] | null = null;
        let objCtx: { skins: Awaited<ReturnType<typeof loadSkins>>; bases: Map<string, string> } | null = null;
        /** Set once an object was edited: the placement files are saved too. */
        let objectsTouched = false;
        /** An object to select once the placed objects have models (Object Manager double-click). */
        let pendingSel: PlacedRef | null = null;
        /** Cycle Random Groups: 0 shows objects placed from a random group as the question mark, n as what the group's
         *  nth line puts there (a shorter group wraps). `randomGroups` is Map Properties' list, read when cycling starts
         *  and again after war3map.w3i is saved. A view setting: nothing in the map changes. */
        let groupCycle = 0;
        let randomGroups: RandomGroup[] = [];
        const shownAs = (p: Placed) => (groupCycle > 0 ? cycledId(p as Placed & { randomType?: number }, randomGroups, groupCycle - 1) : undefined);
        const marker =(p: Placed, rgb: Vec3): Marker => ({ x: p.position[0], y: p.position[1], z: drawnZ(p), rgb });
        // Units take their player's colour; neutral players (24+) show as Coal.
        const team = (p: Placed) => (p.player !== undefined && p.player < TEAM_COLORS.length ? p.player : NEUTRAL);
        const NEUTRALS: Record<number, string> = { 24: "Neutral Hostile", 25: "Neutral Extra", 26: "Neutral Victim", 27: "Neutral Passive" };
        const ownerName = (n: number) => (n < 24 ? `Player ${n + 1} (${TEAM_COLORS[n]?.[0] ?? "?"})` : NEUTRALS[n] ?? `Player ${n + 1}`);
        /** Stand-ins for the objects that only show as markers (unknown ids, models that didn't load), so
         *  they can be selected like the others. */
        let strays: Stray[] = [];
        let unresolvedDoodads: Placed[] = [], unresolvedUnits: Placed[] = [];
        const drawMarkers = () => {
          renderer.setMarkers("doodads", unresolvedDoodads.map((p) => marker(p, [90, 200, 90])));
          renderer.setMarkers("units", unresolvedUnits.filter((p) => p.id !== "sloc").map((p) => marker(p, TEAM_COLORS[team(p)][1])));
          // Start locations without their model: hidden with the units, and in game view.
          renderer.setMarkers("starts", unresolvedUnits.filter((p) => p.id === "sloc").map((p) => marker(p, [255, 255, 255])));
        };
        /** Every selectable placed object: those with a model and the strays. */
        const allInstances = (): Stray[] => [...renderer.batches.flatMap((b) => b.instances.map((inst) => ({ group: b.group, inst }))), ...strays];
        /** Those a box or Select All can take: not the start locations while game view leaves them out. */
        const shownInstances = (): Stray[] => (renderer.showEditorOnly ? allInstances()
          : [...renderer.batches.filter((b) => !b.editorOnly).flatMap((b) => b.instances.map((inst) => ({ group: b.group, inst }))), ...strays.filter((s) => s.inst.pick?.id !== "sloc")]);
        const findInstance = (entry: Placed): ObjectInstance | null => {
          for (const b of renderer.batches) for (const inst of b.instances) if (inst.pick?.placed === entry) return inst;
          return strays.find((s) => s.inst.pick?.placed === entry)?.inst ?? null;
        };
        /** Models for the current entries (initially and after object edits). */
        /** Splats\UberSplatData.slk, once read; splat textures asked for. */
        let splatTable: Promise<Map<string, SplatDef>> | null = null;
        const splatImages = new Set<string>();
        /** The ground marks, from where the buildings are now. */
        const showSplats = async () => {
          if (!objCtx) return;
          const { skins, bases } = objCtx;
          const table = await (splatTable ??= loadSplatTable(w3).catch(() => new Map<string, SplatDef>()));
          const splats = planSplats(unitsFile?.list ?? [], skins, table, (id) => bases.get(id));
          renderer.setSplats(splats.map((s) => ({ x: s.x, y: s.y, scale: s.def.scale, texture: s.def.texture, blend: s.def.blend, color: s.def.color })));
          for (const tex of new Set(splats.map((s) => s.def.texture))) {
            if (splatImages.has(tex.toLowerCase())) continue;
            splatImages.add(tex.toLowerCase());
            void artLoad(readFile(w3, doc, tex, terrain.tileset).then((buf) => { renderer.setSplatTexture(tex, decodeImage(buf, tex)); loadRedraw(); }, () => {}));
          }
          redraw();
        };
        /** Set while a redraw of the marks is on its way: a drag moves a building many times a frame. */
        let splatsDue = false;
        const moveSplats = () => {
          if (splatsDue) return;
          splatsDue = true;
          requestAnimationFrame(() => { splatsDue = false; void showSplats(); showShadowObjects(); });
        };
        // ---- shadows (View > Shadows) ---------------------------------------------------
        // The project's terrain shows its war3map.shd (classic graphics), with the cells unsaved edits change
        // predicted; a game map's view only the objects' own shadows (see viewshadows.ts).
        renderer.shadowLook = shadowLookFor(renderer.tone);
        renderer.showShadows = switchedOn(w3, "terrain.shadows.visible", true);
        const viewShadows = new ViewShadows({
          terrain, target: renderer, redraw: loadRedraw,
          readBaked: async (): Promise<Baked> => {
            if (doc.path.startsWith("game:") || !w3.workspace.project()) return "absent";
            // A file that isn't there is no shadows; one that's there but can't be read isn't predicted over.
            return w3.workspace.readBytes("map/war3map.shd").then((bytes) => ({ bytes }), (e): Baked => (isNotFoundError(e) ? "absent" : "unreadable"));
          },
          readImage: async (path) => {
            const read = (p: string) => readFile(w3, doc, p, terrain.tileset).then((buf) => decodeImage(buf, p));
            return read(path).catch(() => read(path.replace(/\.blp$/i, ".dds")));
          },
          predict: editable ? (t, doodads, pause) => {
            const sun = { azimuth: w3.settings.get<number>("terrain.shadows.sunAzimuth") ?? 225, elevation: w3.settings.get<number>("terrain.shadows.sunElevation") ?? 30 };
            return predictShadows(t, doodads, objCtx?.skins ?? new Map(), (id) => objCtx?.bases.get(id), (p) => readFile(w3, doc, p), sun, pause);
          } : null,
        });
        void artLoad(viewShadows.reloadBaked());
        const showShadowObjects = () => { if (objCtx) void viewShadows.objectsChanged(unitsFile?.list ?? [], dooFile?.list ?? [], skinOf); };
        /** Set while a new prediction of the shadow map is due: it waits for the edits to pause. */
        let shadowTimer: ReturnType<typeof setTimeout> | undefined;
        const NO_DOODADS: Placed[] = [];
        const shadowEditsSoon = () => {
          viewShadows.editing();
          clearTimeout(shadowTimer);
          shadowTimer = setTimeout(() => {
            if (disposed || !objCtx) return;
            const key = savedW3e, saved = savedDoodads ?? NO_DOODADS;
            void viewShadows.editsChanged({ key, terrain: () => parseW3e(key), doodads: saved }, structuredClone(dooFile?.list ?? []));
          }, SHADOW_EDIT_DELAY);
        };
        // Saving (or a rebuild after a tool's edit) wrote the shadow map: it's what's stored now.
        const stopShadowSaves = w3.workspace.onDidSave((path) => { if (path.toLowerCase() === "map/war3map.shd") void viewShadows.reloadBaked(); });
        const stopShadowSetting = w3.settings.onDidChange((key) => {
          if (key !== "terrain.shadows.visible") return;
          renderer.showShadows = switchedOn(w3, "terrain.shadows.visible", true);
          viewSyncs.forEach((f) => f());
          redraw();
        });
        const stopShadows = () => { clearTimeout(shadowTimer); viewShadows.dispose(); stopShadowSaves.dispose(); stopShadowSetting.dispose(); };
        /** Pathing texture size of each unit type met so far, null for those without: buildings have one. */
        const buildingCells = new Map<string, [number, number] | null>();
        const loadCells = async (id: string) => {
          if (buildingCells.has(id) || id === "sloc") return;
          pathingData ??= loadPathingData(w3, (p) => readFile(w3, doc, p), (x) => objCtx?.bases.get(x));
          const data = await pathingData, shape = data.unitShape(id);
          const image = shape?.path ? await data.texture(shape.path).catch(() => null) : null;
          buildingCells.set(id, image ? [image.width, image.height] : null);
        };
        const onGrid = (id: string, x: number, y: number): [number, number] => {
          const cells = buildingCells.get(id);
          return cells ? [onBuildingGrid(x, cells[0]), onBuildingGrid(y, cells[1])] : [x, y];
        };
        /** Object data being taken in by a reload, until it's drawn. */
        let nextCtx: { skins: Awaited<ReturnType<typeof loadSkins>>; bases: Map<string, string> } | null = null;
        /** Each rebuild takes a number: one that is overtaken by a later one drops its result, or an older
         *  load finishing last would draw old skins over new. */
        let rebuildGen = 0;
        /** The movement type of a placed object's type (units; see Skin.moveType). */
        function moveTypeOf(p: Placed): string | undefined {
          return (objCtx?.skins.get(p.id) ?? objCtx?.skins.get(objCtx.bases.get(p.id) ?? ""))?.moveType;
        }
        /** The height an object is drawn at: ships, and amphibious units in water, on the water's surface
         *  (as the game puts them); anything else at its stored height. The stored height doesn't change. */
        function drawnZ(p: Placed, moveType = moveTypeOf(p)): number {
          return unitDrawHeight(moveType, p.position[2], moveType ? waterSurfaceAt(terrain, p.position[0], p.position[1]) : null);
        }
        /** Whether a unit is drawn in its model's swim look (an amphibious unit in deep water). */
        function swims(p: Placed, moveType = moveTypeOf(p)): boolean {
          if (moveType?.toLowerCase() !== "amph") return false;
          const [x, y] = p.position;
          return unitSwims(moveType, heightAt(terrain, x, y), waterSurfaceAt(terrain, x, y));
        }
        /** After the water or the ground changed: ships and amphibious units go to the new surface, in place. A unit
         *  that starts or stops swimming needs its other look: the objects are made again. */
        function refloat() {
          let moved = false;
          for (const b of renderer.batches) {
            if (b.group !== "units") continue;
            for (const inst of b.instances) {
              const p = inst.pick?.placed;
              if (!p || !goesOnWater(moveTypeOf(p))) continue;
              // (A checkered cube, model "", has no looks.)
              if (inst.pick!.model && swims(p) !== b.gpu.props.includes("swim")) { void rebuildObjects(); return; }
              const z = drawnZ(p);
              if (Math.abs(inst.world[14] - z) < 0.01) continue;
              inst.world = placement(p, inst.pick!.extraScale, z);
              if (inst.bounds) inst.sphere = worldSphere(inst.world, inst.bounds);
              moved = true;
            }
          }
          if (!moved) return;
          if (selected?.pick) selectObject(selected);
          if (group.length) { groupRingsStale = true; refreshGroupRings(); }
        }
        async function rebuildObjects() {
          const ctx = nextCtx ?? objCtx;
          if (!ctx) return;
          const gen = ++rebuildGen;
          const { skins, bases } = ctx;
          const doodads = dooFile?.list ?? [], units = unitsFile?.list ?? [];
          markerList.replaceChildren(markerToggle("doodads", "Doodads", doodads.length), markerToggle("units", "Units & items", units.length));
          const baseOf = (id: string) => bases.get(id);
          const [d, u, s] = await Promise.all([loader.load("doodads", doodads, skins, () => 0, baseOf),
            loader.load("units", units, skins, team, baseOf, (p, skin) => drawnZ(p, skin.moveType), true, shownAs,
              (p, skin) => unitLooks(isUprooted(p), swims(p, skin.moveType))),
            loader.load("units", startPreviews(units, startRaces), skins, team, undefined, undefined, false)]);
          // The later rebuild does the selection and the rest.
          if (gen !== rebuildGen) return;
          renderer.setGroup("doodads", d.batches);
          // The start buildings inside the start locations' rings: drawn see-through without their particles
          // (the editor shows no fire on an orc hall's preview), never picked (no pick), shown and hidden with
          // the units; a town hall that doesn't load is just left out.
          for (const b of s.batches) for (const inst of b.instances) delete inst.pick;
          // The start locations' model and the start buildings are the editor's: game view leaves them out.
          const startsOnly = (b: { instances: ObjectInstance[] }) => b.instances.length > 0 && b.instances.every((i) => i.pick?.id === "sloc");
          renderer.setGroup("units", [...u.batches.map((b) => (startsOnly(b) ? { ...b, editorOnly: true } : b)),
            ...s.batches.map((b) => ({ ...b, effects: undefined, tint: [1, 1, 1, START_PREVIEW_ALPHA] as [number, number, number, number], editorOnly: true }))]);
          void artLoad(showSplats());
          showShadowObjects();
          for (const id of new Set(units.map((p) => p.id))) void loadCells(id).catch(() => { /* stays free */ });
          // Objects without a model (start locations, unknown ids) stay markers.
          unresolvedDoodads = d.unresolved;
          unresolvedUnits = u.unresolved;
          strays = [...d.strays, ...u.strays];
          drawMarkers();
          // Each problem shows its objects when clicked; those without a model can be removed at once.
          const found = [...d.problems, ...u.problems];
          const broken = found.flatMap((p) => p.items);
          problems.replaceChildren(
            ...found.slice(0, 20).map((p) => h("div.model-warn.clickable", {
              title: `${p.message}\nClick: show ${p.items.length === 1 ? "the object" : `the ${p.items.length} objects`}`,
              onclick: () => showEntries(p.items),
            }, `${p.message} (${p.items.length})`)),
            ...(found.length > 20 ? [h("div.muted", {}, `… ${found.length - 20} more`)] : []),
            ...(broken.length && editable ? [h("button.terrain-cleanup", {
              title: "Deletes every placed object whose model doesn't load or whose id is unknown (one undo step)",
              onclick: async () => {
                const c = await w3.window.showWarning(`Delete ${broken.length} placed object${broken.length === 1 ? "" : "s"} without a model? (Ctrl+Z undoes it)`, "Delete", "Cancel");
                if (c === "Delete" && !refuseLost()) deleteEntries(broken);
              },
            }, `Remove ${broken.length} without a model`)] : []));
          // Keep the selection on the same entries.
          if (group.length) selectEntries(group.filter((p) => fileOf(p)));
          else {
            const entry = selected?.pick?.placed;
            const again = entry ? findInstance(entry) : null;
            if (again) selectObject(again); else if (selected) clearSelection();
          }
          if (pendingSel) trySelect(pendingSel);
          pendingSel = null;
          // The light ranges of the objects as they are now.
          showLightRanges();
          redraw();
        }
        // Object data (models, scales, …), the import list or imported files saved elsewhere (the
        // Object Editor, a Problems fix, the Import Manager): the placed objects are loaded
        // again, imports read anew, and the problem list follows.
        let importsChanged = false;
        // Waited for by ready(): a tool that follows the save (create_object, then place_objects)
        // sees the new types. Selection, camera, undo steps and the dirty flag aren't touched.
        let pathingChanged = false;
        /** A project's terrain has placed objects from the project's object data; a game map's view has none. */
        const projectObjects = !doc.path.startsWith("game:") && !!w3.workspace.project();
        const objectReload = new DebouncedReload(async () => {
          // A save while the first load still reads: that load may have read the old files, so this reload follows it.
          await firstLoad.catch(() => {});
          const imports = importsChanged, pathing = pathingChanged;
          importsChanged = pathingChanged = false;
          try {
            if (imports) loader.reset();
            // Footprints come from the object data, which the skins don't show: read them again.
            if (pathing) {
              pathingData = null;
              buildingCells.clear();
              occupancyPromise = walkPromise = destructablePromise = standingPromise = null;
            }
            const before = objCtx;
            const [skins, { bases, art: data }] = await Promise.all([loadSkins(w3), mapObjectData(w3)]);
            const next = { skins: withObjectArt(skins, data), bases };
            // Only what is placed with a type that looks different is drawn again; models stay loaded.
            const placedTypes = new Set([...(dooFile?.list ?? []), ...(unitsFile?.list ?? [])].map((p) => p.id));
            const changed = before ? changedTypes(before, next, placedTypes) : placedTypes;
            for (const id of changed) buildingCells.delete(id);
            if (changed.size) occupancyPromise = walkPromise = destructablePromise = standingPromise = null;
            // A rebuild that starts meanwhile (a file taken in place) draws with the new data too.
            nextCtx = next;
            try {
              if (imports || changed.size) await rebuildObjects();
              objCtx = next;
            } finally { nextCtx = null; }
          } catch (e) {
            // What changed is still to be taken in: the next reload compares against what is drawn.
            importsChanged ||= imports;
            pathingChanged ||= pathing;
            throw e;
          }
        },(e) => void w3.window.showError(`The placed objects couldn't be loaded again after the save: ${(e as Error).message ?? e}`));
        const stopObjectWatch = w3.workspace.onDidSave((p) => {
          if (projectObjects && /(^|\/)war3map\.w3i(\.json)?$/i.test(p)) void reloadRaces();
          if (projectObjects && groupCycle > 0 && /(^|\/)war3map\.w3i(\.json)?$/i.test(p)) void readRandomGroups().then((g) => { if (g && !disposed) { randomGroups = g; void rebuildObjects(); } });
          // The properties panel reads its lists and the types' facts anew.
          if (/(^|\/)war3map(\.w3[ir]|\.wts)(\.json)?$/i.test(p)) mapLists = null;
          if (/(^|\/)war3map(Skin)?\.w3[ua](\.json)?$|(^|\/)war3mapMisc\.txt$/i.test(p)) factsData = null;
          const art = changesObjectData(p);
          const imported = changesImports(p);
          // Also before the first load is done (see objectReload): it may have read the file before this save.
          if (!projectObjects || (!art && !imported)) return;
          importsChanged ||= imported;
          pathingChanged ||= changesPathing(p);
          objectReload.schedule();
        });
        /** Player id → race (war3map.w3i), for the start buildings the start locations show. A file that can't
         *  be read keeps the races last read: they only change what is drawn. */
        let startRaces = new Map<number, number>();
        /** Map Properties' random groups; null when war3map.w3i can't be read (what is shown stays). */
        const readRandomGroups = async (): Promise<RandomGroup[] | null> => {
          // A file that isn't there has no groups; one that can't be read keeps what is shown.
          return readMapDocStrict<{ unitTables?: RandomGroup[] }>(w3, "map/war3map.w3i.json").then((i) => i?.unitTables ?? [], () => null);
        };
        /** Cycle Random Groups - Next (1) or Previous (-1): what is shown now, for the status line. */
        const cycleRandomGroups = async (step: 1 | -1): Promise<string> => {
          const groups = (await readRandomGroups()) ?? randomGroups;
          if (disposed) return "";
          randomGroups = groups;
          const most = Math.max(0, ...groups.map((g) => g.lines?.length ?? 0));
          if (!most) { groupCycle = 0; void rebuildObjects(); return "This map has no random groups with lines (Map Properties › Random Groups)."; }
          groupCycle = (((groupCycle + step) % (most + 1)) + most + 1) % (most + 1);
          await rebuildObjects();
          return groupCycle === 0 ? "Random groups: objects from a group show as the question mark." : `Random groups: showing line ${groupCycle} of each group.`;
        };
        const readRaces = async (): Promise<Map<number, number> | null> => {
          const info = await readMapDoc<Parameters<typeof playerRaces>[0]>(w3, "map/war3map.w3i.json").catch(() => null);
          return info ? playerRaces(info) : null;
        };
        /** After the map's players were saved (Map Properties): the start buildings follow their races. */
        const reloadRaces = async () => {
          await firstLoad.catch(() => {});
          const races = await readRaces();
          if (!races || disposed || JSON.stringify([...races]) === JSON.stringify([...startRaces])) return;
          startRaces = races;
          await rebuildObjects();
        };
        let objectsPlaced: Promise<void> = Promise.resolve();
        /** The first load of the placed objects and their types. */
        let firstLoad: Promise<void> = Promise.resolve();
        if (projectObjects) {
          objectsPlaced = firstLoad = Promise.all([
            loadPlacedFile(w3, "war3map.doo", "doodads").catch(() => null),
            loadPlacedFile(w3, "war3mapUnits.doo", "units").catch(() => null),
            loadSkins(w3),
            mapObjectData(w3),
            readRaces(),
          ]).then(async ([df, uf, skins, { bases, art }, races]) => {
            if (races) startRaces = races;
            dooFile = df;
            savedDoodads = structuredClone(df?.list ?? []);
            unitsFile = uf;
            savedStarts = startLocations(uf?.list ?? []);
            objCtx = { skins: withObjectArt(skins, art), bases };
            await rebuildObjects();
          });
        }
        const fileOf = (entry: Placed) => (dooFile?.list.includes(entry) ? dooFile : unitsFile?.list.includes(entry) ? unitsFile : null);
        /** Placed objects standing on the given corners' tiles that follow the
         *  ground: units, items and doodads without a fixed height (flag 4). */
        const groundFollowers = (corners: number[]): Placed[] => {
          if (!corners.length) return [];
          let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
          for (const i of corners) {
            const cx = i % terrain.width, cy = Math.floor(i / terrain.width);
            x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
          }
          // Tiles next to a changed corner change too.
          const minX = terrain.offsetX + (x0 - 1) * 128, maxX = terrain.offsetX + (x1 + 1) * 128;
          const minY = terrain.offsetY + (y0 - 1) * 128, maxY = terrain.offsetY + (y1 + 1) * 128;
          const inside = (p: Placed) => p.position[0] >= minX && p.position[0] <= maxX && p.position[1] >= minY && p.position[1] <= maxY;
          const doodads = (dooFile?.list ?? []).filter((p) => !(((p as Placed & { flags?: number }).flags ?? 0) & 4));
          return [...doodads, ...(unitsFile?.list ?? [])].filter(inside);
        };
        /** Objects placed or moved since the last save: saving sets their border flag. Others keep what they have. */
        const repositioned = new Set<Placed>();
        /** Moves/turns an entry and its model in place (no rebuild). */
        const setPlacement = (entry: Placed, wanted: [number, number, number], angle: number) => {
          const inst = findInstance(entry);
          const [gx, gy] = onGrid(entry.id, wanted[0], wanted[1]);
          const position: [number, number, number] = gx === wanted[0] && gy === wanted[1] ? wanted : [gx, gy, heightAt(terrain, gx, gy)];
          const dx = position[0] - entry.position[0], dy = position[1] - entry.position[1];
          if (dx || dy) {
            repositioned.add(entry);
            const skin = skinOf(entry);
            // Ground marks and shadows go with the object.
            if (skin?.uberSplat || skin?.unitShadow || skin?.buildingShadow) moveSplats();
          }
          entry.position = position;
          entry.angle = angle;
          objectsTouched = true;
          if (inst?.pick) {
            // The drawn height moves, which for a ship on the water isn't the stored one's move.
            const wasZ = inst.world[14];
            inst.world = placement(entry, inst.pick.extraScale, drawnZ(entry));
            const dz = inst.world[14] - wasZ;
            // Turning an off-centre model (a wall, a bridge) swings its bounds round too: placed again from the model's own.
            if (inst.bounds) inst.sphere = worldSphere(inst.world, inst.bounds);
            else if (inst.sphere) inst.sphere = [inst.sphere[0] + dx, inst.sphere[1] + dy, inst.sphere[2] + dz, inst.sphere[3]];
            if (inst === selected) selectObject(inst);
            if (strays.some((s) => s.inst === inst)) drawMarkers();
          }
          if (group.includes(entry)) groupRingsStale = true;
          redraw();
        };
        /** Group rings are rebuilt once per frame batch of moves, not per object. */
        let groupRingsStale = false;
        const refreshGroupRings = () => {
          if (!groupRingsStale) return;
          groupRingsStale = false;
          renderer.setSelection(group.map(findInstance).filter((i): i is ObjectInstance => !!i?.pick).map(ringOf));
        };
        type Pose = { position: [number, number, number]; angle: number };
        const poseOf = (p: Placed): Pose => ({ position: [...p.position] as [number, number, number], angle: p.angle });
        /** One undo step for moving/turning several entries. */
        const moveEdits = (entries: Placed[], before: Pose[]) =>
          pushMoveEdit(entries, before, entries.map(poseOf), { setPlacement, refreshRings: refreshGroupRings, pushEdit });
        /** Sets the border flag of what was placed or moved, from where it ended up, and puts any building
         *  that got past the keys and the mouse on its grid: typed coordinates and the "Edit all" fields. */
        const settleMoved = async () => {
          for (const p of unitsFile?.list ?? []) {
            if (!repositioned.has(p)) continue;
            const [x, y] = onGrid(p.id, p.position[0], p.position[1]);
            if (x !== p.position[0] || y !== p.position[1]) p.position = [x, y, heightAt(terrain, x, y)];
          }
          if (!dooFile || !repositioned.size) return;
          // Taken out before the await: what is moved meanwhile stays in the set for the next save.
          const moved = new Set(repositioned);
          repositioned.clear();
          const info = await readMapDoc<{ cameraComplements?: number[] }>(w3, "map/war3map.w3i.json").catch(() => null);
          if (!info) { for (const p of moved) repositioned.add(p); return; }
          const edge = playableArea(info, terrain);
          for (const p of dooFile.list) {
            const flags = flagsOf(p);
            if (moved.has(p) && flags !== undefined) (p as Placed & { flags?: number }).flags = borderFlags(flags, !inArea(p.position[0], p.position[1], edge));
          }
        };
        const deleteSelected = () => deleteEntries(selectedEntries());
        /** Deletes placements as one undo step. */
        const deleteEntries = (entries: Placed[]) => {
          // Each entry with its file and index, so undo restores the order.
          const items = entries.map((entry) => ({ entry, f: fileOf(entry)! })).filter((x) => x.f)
            .map((x) => ({ ...x, i: x.f.list.indexOf(x.entry) })).sort((a, b) => a.i - b.i);
          if (!items.length) return;
          const doIt = () => { for (const { entry, f } of items) f.list.splice(f.list.indexOf(entry), 1); };
          doIt();
          clearSelection();
          pushEdit({ undo: () => { for (const { entry, f, i } of items) f.list.splice(i, 0, entry); }, redo: doIt, terrain: false, objects: true });
          objectsTouched = true;
          void rebuildObjects();
        };
        /** Fields the selection panel edits. */
        type Props = Pick<Placed, "player" | "variation" | "scale" | "position" | "angle"> & { flags?: number };
        const flagsOf = (e: Placed) => (e as Placed & { flags?: number }).flags;
        const snapshot = (e: Placed): Props => structuredClone({
          ...(e.player !== undefined ? { player: e.player } : {}), ...(flagsOf(e) !== undefined ? { flags: flagsOf(e) } : {}),
          variation: e.variation, scale: e.scale, position: e.position, angle: e.angle,
        });
        const editProps = (entry: Placed, change: Partial<Props>) => {
          const before = snapshot(entry);
          Object.assign(entry, change);
          if (change.position) repositioned.add(entry);
          const after = snapshot(entry);
          pushEdit({ undo: () => Object.assign(entry, structuredClone(before)), redo: () => Object.assign(entry, structuredClone(after)), terrain: false, objects: true });
          objectsTouched = true;
          void rebuildObjects();
        };
        // ---- properties: hit points, hero, inventory, drops, … (unitprops.ts) ---------------------
        /** The types' facts, read once and again after the object data or gameplay constants are saved. */
        let factsData: Promise<FactsData> | null = null;
        /** The map's item tables and regions, for the drops and the waygate destination; read again after they're saved. */
        let mapLists: Promise<{ tables: { number: number; name: string }[] | null; regions: { index: number; name: string }[] }> | null = null;
        const loadMapLists = () => mapLists ??= (async () => {
          const text = await mapStrings(w3).catch(() => (v: string) => v);
          // A file that isn't there has no tables or regions; one that can't be read leaves the tables unknown (null):
          // then nothing is refused for naming a table, and nothing is offered either.
          const info = await readMapDocStrict<{ itemTables?: { number: number; name: string }[] }>(w3, "map/war3map.w3i.json").then(
            (i) => (i?.itemTables ?? []).map((t) => ({ number: t.number, name: text(t.name) })), () => null);
          const regions = await readMapDoc<{ regions?: { index: number; name: string }[] }>(w3, "map/war3map.w3r.json").catch(() => null);
          return { tables: info, regions: (regions?.regions ?? []).map((r) => ({ index: r.index, name: text(r.name) })) };
        })();
        const kindOfEntry = (p: Placed) => {
          const k = skinOf(p)?.kind;
          return fileOf(p) === dooFile ? (k === "w3d" ? "w3d" : k ?? "w3d") : k === "w3t" ? "w3t" : "w3u";
        };
        const factsOf = async (entries: Placed[]): Promise<{ entry: Placed; facts: TypeFacts }[]> => {
          const load = factsData ??= loadFactsData(w3);
          // A failed read is tried again next time.
          const d = await load.catch((e) => { if (factsData === load) factsData = null; throw e; });
          return entries.map((entry) => ({ entry, facts: typeFacts(entry.id, kindOfEntry(entry), d) }));
        };
        /** A properties change to the objects as one undo step; the reason when it's refused, and then nothing changed. */
        const changeProps = (items: { entry: Placed; facts: TypeFacts }[], c: PropChange, ctx: PropContext): string | null => {
          if (refuseLost()) return null;
          // Objects deleted or reloaded since the panel was made aren't changed.
          if (items.some((it) => !fileOf(it.entry)?.list.includes(it.entry))) return "the selection changed meanwhile; select the objects again.";
          const before = items.map((it) => propSnapshot(it.entry));
          const r = changeAll(items, c, ctx);
          if ("error" in r) return r.error;
          if (!r.changed.length) return null;
          const after = items.map((it) => propSnapshot(it.entry));
          const set = (v: Record<string, unknown>[]) => items.forEach((it, i) => Object.assign(it.entry, structuredClone(v[i])));
          pushEdit({ undo: () => set(before), redo: () => set(after), terrain: false, objects: true });
          objectsTouched = true;
          void rebuildObjects();
          return null;
        };
        /** The Properties part of the selection panel for `entries`, filled in once the types' facts are read. Nothing
         *  is shown if the selection has moved on by then. */
        const propsSlot = (entries: Placed[]) => {
          const slot = h("div.terrain-props-slot");
          const stillShown = () => slot.isConnected && JSON.stringify(selectedEntries().map((p) => fileOf(p)?.list.indexOf(p))) === JSON.stringify(entries.map((p) => fileOf(p)?.list.indexOf(p)));
          void Promise.all([factsOf(entries), loadMapLists()]).then(([items, lists]) => {
            if (!stillShown()) return;
            const ctx: PropContext = { tables: lists.tables?.map((t) => t.number), regions: lists.regions.map((r) => r.index) };
            const show = () => { const panel = propsPanel(host); slot.replaceChildren(...(panel ? [panel] : [])); };
            const host: Parameters<typeof propsPanel>[0] = {
              items, tables: lists.tables, regions: lists.regions, readOnly: !editable,
              change: (c) => changeProps(items, c, ctx),
              name: (id, kinds) => w3.services.get<ObjectsService>(OBJECTS_SERVICE).then((s) => s.name(id, kinds)),
              pick: (title, kinds) => w3.services.get<ObjectsService>(OBJECTS_SERVICE).then((s) => s.pick(el, { title, kinds })).then((o) => o?.id),
              colorName: (n) => TEAM_COLORS[n]?.[0] ?? `#${n}`,
              warn: (m) => {
                void w3.window.showWarning(m);
                // The boxes show the values again, not what was typed.
                if (stillShown()) show();
              },
              openItemTables: () => void w3.commands.execute("w3.mapInfo.itemTables").catch((e) => w3.window.showError(String((e as Error).message ?? e))),
              createItemTable: async () => {
                const root = w3.workspace.project()?.root;
                let made: { number: number; name: string };
                try {
                  // Made in Map Properties, one undo step there, and opened on it for its items.
                  made = await w3.commands.execute<{ number: number; name: string }>("w3.mapInfo.createItemTable");
                } catch (e) {
                  void w3.window.showError(`No item table was made: ${(e as Error).message ?? e}`);
                  return;
                }
                // Another project, or this editor closed meanwhile: the table isn't this one's to use.
                if (disposed || w3.workspace.project()?.root !== root) return;
                // Not saved yet, so not in the file the lists come from: known here until war3map.w3i is saved
                // and the lists are read again (a table discarded unsaved then shows as not in the map).
                if (lists.tables && !lists.tables.some((t) => t.number === made.number)) lists.tables.push(made);
                ctx.tables = lists.tables?.map((t) => t.number);
                if (!stillShown()) {
                  void w3.window.showInfo(`Made ${made.name} (#${made.number}). The selection changed meanwhile: choose it under Drops › Map item table.`);
                  return;
                }
                const why = changeProps(items, { field: "drops", value: { mode: "table", table: made.number } }, ctx);
                if (why) host.warn(`Not changed: ${why}`);
              },
            };
            show();
          }).catch((e) => {
            if (stillShown()) slot.replaceChildren(h("div.muted", {}, `Properties couldn't be read: ${(e as Error).message ?? e}`));
          });
          return slot;
        };
        // ---- mass edit, select by type/filter, face point ---------------------------------
        const skinOf = (p: Placed) => objCtx?.skins.get(p.id) ?? objCtx?.skins.get(objCtx.bases.get(p.id) ?? "");
        const DEG = 180 / Math.PI;
        const varsOf = (p: Placed): ObjVars => ({
          x: p.position[0], y: p.position[1], z: p.position[2],
          facing: (((p.angle * DEG) % 360) + 360) % 360, scale: p.scale[0], variation: p.variation,
          owner: p.player !== undefined ? p.player + 1 : 0,
        });
        type MassField = "x" | "y" | "z" | "facing" | "scale" | "variation" | "owner";
        /** Applies new values to entries as one undo step (x/y moves keep objects on the ground). */
        const applyMass = (entries: Placed[], change: (p: Placed, i: number) => Partial<Props> | null) => {
          const before = entries.map(snapshot);
          let n = 0;
          entries.forEach((p, i) => { const c = change(p, i); if (c) { Object.assign(p, c); n++; if (c.position) repositioned.add(p); } });
          if (!n) return;
          const after = entries.map(snapshot);
          const set = (v: Props[]) => entries.forEach((p, i) => Object.assign(p, structuredClone(v[i])));
          pushEdit({ undo: () => set(before), redo: () => set(after), terrain: false, objects: true });
          objectsTouched = true;
          void rebuildObjects();
        };
        /** Sets `field` of every entry to the expression's value; returns an error message or null. */
        const massEdit = (entries: Placed[], field: MassField, src: string): string | null => {
          let node, heldBack = 0;
          try { node = compileExpr(src); } catch (e) { return (e as Error).message; }
          const vals = entries.map((p, i) => { const v = varsOf(p); return evalFor(node, v, v[field], i, entries.length); });
          if (vals.some((v) => !Number.isFinite(v))) return "the expression gives no number for some objects";
          applyMass(entries, (p, i) => {
            const v = vals[i];
            switch (field) {
              case "x": case "y": {
                const wantX = field === "x" ? v : p.position[0], wantY = field === "y" ? v : p.position[1];
                const [x, y] = clampPoint(heldTo(), wantX, wantY);
                if (x !== wantX || y !== wantY) heldBack++;
                return { position: [x, y, heightAt(terrain, x, y)] };
              }
              case "z": return { position: [p.position[0], p.position[1], v] };
              case "facing": return { angle: v / DEG };
              case "scale": return v > 0 ? { scale: [v, v, v] } : null;
              case "variation": return { variation: Math.max(0, Math.min((skinOf(p)?.numVar ?? 1) - 1, Math.round(v))) };
              case "owner": return p.player !== undefined ? { player: Math.max(0, Math.min(27, Math.round(v) - 1)) } : null;
            }
          });
          if (heldBack) void w3.window.showWarning(`${heldBack} object${heldBack === 1 ? "" : "s"} stopped at the camera bounds. Turn off Enforce Camera Bounds to go past them.`);
          return null;
        };
        /** Every placed object with a model (the groups not hidden). */
        const allPlaced = (): { p: Placed; kind: string; id: string }[] => {
          const out: { p: Placed; kind: string; id: string }[] = [];
          for (const { group, inst } of shownInstances()) {
            if ((group !== "doodads" && group !== "units") || renderer.hiddenGroups.has(group)) continue;
            if (inst.pick) out.push({ p: inst.pick.placed, kind: inst.pick.kind, id: inst.pick.id });
          }
          return out;
        };
        const selectSameTypes = () => {
          const ids = new Set(selectedEntries().map((p) => p.id));
          selectEntries(allPlaced().filter((o) => ids.has(o.id)).map((o) => o.p));
        };
        /** Selects every object matching a filter; returns an error message or null. */
        const selectMatching = async (src: string): Promise<string | null> => {
          let test;
          try { test = compileFilter(src); } catch (e) { return (e as Error).message; }
          const names = new Map<string, string>();
          for (const k of ["w3u", "w3t", "w3b", "w3d"]) {
            const kd = await loadKind(w3, k).catch(() => null);
            if (kd) for (const [id, n] of kd.names) names.set(id, n);
          }
          const nameOf = (id: string) => names.get(id) ?? names.get(objCtx?.bases.get(id) ?? "") ?? id;
          const found = allPlaced().filter((o) => boxKinds.has(o.kind) && test({ ...varsOf(o.p), id: o.id, kind: o.kind, name: nameOf(o.id) })).map((o) => o.p);
          selectEntries(found);
          if (!found.length) w3.window.showInfo("No objects match.");
          return null;
        };
        /** The height of a doodad that has one of its own, which moving it mustn't lose. */
        const ownHeight = (p: Placed) => (((flagsOf(p) ?? 0) & FIXED_HEIGHT) !== 0 ? p.position[2] : null);
        /** The World Editor's keys for the selection. Height and size are for doodads and destructables. */
        const keyEdit = (key: SelectionKey) => {
          const entries = selectedEntries(), doodads = entries.filter((p) => dooFile?.list.includes(p));
          if ("rotate" in key) rotateSelected(key.rotate);
          else if ("nudge" in key) {
            const before = entries.map(poseOf);
            // The building grid is twice as fine as a nudge: half a step would round back one way. The bounds
            // are applied to the nudge as it will be moved, steps and all.
            const moves = scaledNudge(entries.map((p) => [p.position[0], p.position[1]] as const), entries.map(moveBounds), entries.map((p) => (buildingCells.get(p.id) ? 2 : 1)), key.nudge);
            for (const [i, p] of entries.entries()) {
              const x = p.position[0] + moves[i][0], y = p.position[1] + moves[i][1];
              setPlacement(p, [x, y, ownHeight(p) ?? heightAt(terrain, x, y)], p.angle);
            }
            moveEdits(entries, before);
          } else if ("raise" in key) {
            applyMass(doodads, (p) => ({ position: [p.position[0], p.position[1], p.position[2] + key.raise], flags: (flagsOf(p) ?? 2) | FIXED_HEIGHT }));
          } else applyMass(doodads, (p) => ({ scale: scaled(p.scale, key.scale) }));
        };
        /** The selection mirrored or turned a quarter around its middle, as one undo step. */
        const turnSelection = (turn: Turn) => {
          const entries = selectedEntries(), before = entries.map(poseOf), [cx, cy] = centreOf(entries.map((p) => p.position));
          const held = heldTo();
          if (held && entries.some((p) => { const [dx, dy] = turnOffset(turn, p.position[0] - cx, p.position[1] - cy); return !insideBounds(held, cx + dx, cy + dy); })) {
            void w3.window.showWarning("Not done: part of the selection would end up outside the camera bounds. Turn off Enforce Camera Bounds to allow it.");
            return;
          }
          for (const p of entries) {
            const [dx, dy] = turnOffset(turn, p.position[0] - cx, p.position[1] - cy), x = cx + dx, y = cy + dy;
            setPlacement(p, [x, y, ownHeight(p) ?? heightAt(terrain, x, y)], turnAngle(turn, p.angle));
          }
          moveEdits(entries, before);
          refreshGroupRings();
        };
        /** Placed objects become other types where they stand (`swaps`: old id → new id), as one undo step; with
         *  `newVariations` each takes a random variation of its new type. How many changed (0 when the view was lost). */
        const replaceEntries = async (entries: Placed[], swaps: Record<string, string>, newVariations = false): Promise<number> => {
          const swapped = entries.filter((p) => swaps[p.id] !== undefined && swaps[p.id] !== p.id);
          if (!swapped.length) return 0;
          for (const id of new Set(swapped.map((p) => swaps[p.id]))) await loadCells(id).catch(() => { /* stays free */ });
          if (refuseLost()) return 0;
          type Look = Props & { id: string; skinId?: string };
          const look = (p: Placed): Look => ({ ...snapshot(p), id: p.id, ...("skinId" in p ? { skinId: (p as { skinId?: string }).skinId } : {}) });
          const before = swapped.map(look);
          const numVar = (id: string) => handle.objects.type(id)?.numVar ?? 1;
          replacePlaced(swapped as Parameters<typeof replacePlaced>[0], swaps, null, numVar);
          for (const p of swapped) {
            if (newVariations && p.variation !== undefined) p.variation = Math.floor(Math.random() * numVar(p.id));
            // A building of another size has another spot on the grid.
            const [x, y] = onGrid(p.id, p.position[0], p.position[1]);
            if (x !== p.position[0] || y !== p.position[1]) { p.position = [x, y, heightAt(terrain, x, y)]; repositioned.add(p); }
          }
          const after = swapped.map(look);
          const put = (v: Look[]) => { swapped.forEach((p, i) => Object.assign(p, structuredClone(v[i]))); };
          pushEdit({ undo: () => put(before), redo: () => put(after), terrain: false, objects: true });
          objectsTouched = true;
          await rebuildObjects();
          return swapped.length;
        };
        /** The selection becomes another type where it stands, as one undo step. */
        const replaceSelected = async () => {
          const entries = selectedEntries().filter((p) => p.id !== "sloc");
          const kinds = new Map(entries.map((p) => [p, findInstance(p)?.pick?.kind ?? (dooFile?.list.includes(p) ? "w3d" : "w3u")]));
          if (!kinds.size) return;
          const objects = await w3.services.get<ObjectsService>(OBJECTS_SERVICE);
          const chosen = await objects.pick(el, { title: `Replace ${entries.length === 1 ? "this" : `these ${entries.length}`} with…`, kinds: replaceableKinds(kinds.values()) });
          keysToMap();
          if (!chosen || refuseLost()) return;
          const swapped = entries.filter((p) => replaceableBy(kinds.get(p) as string, chosen.kind) && p.id !== chosen.id);
          if (!swapped.length) return;
          if (!(await replaceEntries(swapped, Object.fromEntries(swapped.map((p) => [p.id, chosen.id]))))) return;
          selectEntries(entries);
          const left = entries.length - swapped.length;
          if (left) void w3.window.showInfo(`Replaced ${swapped.length}. The other ${left} can't become ${chosen.name}, or already are.`);
        };
        const turnButtons = () => [
          ...([["mirrorX", "Mirror ↔", "Mirror east to west (H)"], ["mirrorY", "Mirror ↕", "Mirror north to south (V)"], ["cw", "Turn 90°", "Turn a quarter clockwise (R, back with Shift+R)"]] as const)
            .map(([turn, label, title]) => h("button", { title, onclick: () => turnSelection(turn) }, label)),
          h("button", { title: "Swap what's selected for another type, where it stands", onclick: () => void replaceSelected().catch((e) => w3.window.showError(String(e))) }, "Replace…"),
        ];

        // ---- heights: Set Uniform Doodad Heights, Reset Fixed Object Heights ---------------------
        const selectedDoodads = () => selectedEntries().filter((p) => dooFile?.list.includes(p));
        const heightCommands: HeightCommands = {
          firstDoodadHeight: () => selectedDoodads()[0]?.position[2] ?? null,
          setUniformHeights: async (height) => {
            if (!editable) return "This terrain is read-only.";
            if (glDead) return VIEW_LOST;
            const doodads = selectedDoodads();
            if (!doodads.length) return "No doodads are selected: select doodads or destructables first.";
            const z = height ?? doodads[0].position[2];
            if (!Number.isFinite(z)) return "That isn't a height.";
            const steps = history.length, atBefore = at;
            applyMass(doodads, (p) => uniformHeight({ position: p.position, flags: flagsOf(p) }, z));
            return history.length === steps && at === atBefore ? "The selected doodads stand at that height already." : null;
          },
          resetFixedHeights: () => {
            if (!editable) return "This terrain is read-only.";
            if (glDead) return VIEW_LOST;
            const doodads = selectedDoodads();
            if (!doodads.length) return "No doodads are selected: select doodads or destructables first.";
            const steps = history.length, atBefore = at;
            applyMass(doodads, (p) => resetFixedHeight({ position: p.position, flags: flagsOf(p) }, heightAt(terrain, p.position[0], p.position[1])));
            return history.length === steps && at === atBefore ? "None of the selected doodads has a fixed height." : null;
          },
        };
        toolGroups.heightCommands.set(doc.path, heightCommands);
        const heightButtons = () => !selectedDoodads().length ? [] : [
          h("button", { title: "Put the selected doodads at one height (command: Set Uniform Doodad Heights)", onclick: () => void w3.commands.execute("w3.terrain.setUniformDoodadHeights").then(() => keysToMap()) }, "Set height…"),
          h("button", { title: "Put the selected doodads that have a height of their own back onto the ground (command: Reset Fixed Object Heights)", onclick: () => void w3.commands.execute("w3.terrain.resetFixedObjectHeights").then(() => keysToMap()) }, "Reset height"),
        ];

        // ---- copy and paste ----------------------------------------------------------------
        /** While pasting: what's being pasted. Each click places a copy, until Esc. */
        let pasting: Fragment | null = null;
        /** Where the pointer last was over the ground. */
        let pasteAt: Vec3 | null = null;
        type Ghost = NonNullable<typeof renderer.ghost>;
        let pasteModels: ({ gpu: Ghost["gpu"]; modelScale: number } | null)[] = [];
        /** More would slow the view down, and the shape shows long before that. */
        const MAX_GHOSTS = 300;
        /** What's copied: start locations belong to their players. */
        const copyable = () => selectedEntries().filter((p) => p.id !== "sloc");
        /** Custom types among the copied objects need their abilities and the like in another map: the clipboard takes
         *  them from this map's object data as it goes on. */
        const takeTypes = (f: Fragment) => {
          // The type of each, and what it carries, can do, drops or picks from.
          const ids = [...new Set(f.objects.flatMap((o) => entryIds(o.entry)))];
          // Read from the project the objects are copied in, even if another one is open when this finishes. The fragment
          // holds the promise from the start, so a paste or a turn before it is done waits for it.
          const root = w3.workspace.project()?.root;
          f.typesReady = w3.services.get<ObjectsService>(OBJECTS_SERVICE).then((s) => s.typesFor(ids, root)).then((types) => { if (types.length) f.types = types; return types; },
            (e) => { void w3.window.showWarning(`The custom objects these refer to couldn't be gathered (${(e as Error).message ?? e}). Pasting them elsewhere won't bring their abilities and the like.`); return []; });
        };
        const copySelection = () => {
          const entries = copyable();
          if (!entries.length) return false;
          clipboard = fragmentOf(entries.map((entry) => ({ list: dooFile?.list.includes(entry) ? "doodads" as const : "units" as const, entry })), (x, y) => heightAt(terrain, x, y));
          takeTypes(clipboard);
          return true;
        };
        /** The block of ground Ctrl+C takes. */
        let terrainArea: (CornerArea & { objects: boolean }) | null = null;
        /** The area drawn on the ground, as one overlay: the Terrain tab's selection, or what's being pasted. */
        let areaShown = "";
        const drawArea = (a: CornerArea | null) => {
          const key = a ? `${a.x0},${a.y0},${a.x1},${a.y1}` : "";
          if (key === areaShown) return;
          areaShown = key;
          if (!a) { renderer.setGroundOverlay(null); redraw(); return; }
          const W = terrain.width - 1, H = terrain.height - 1, rgba = new Uint8Array(W * H * 4);
          for (let y = Math.max(0, a.y0); y < Math.min(H, a.y1); y++) for (let x = Math.max(0, a.x0); x < Math.min(W, a.x1); x++) {
            const edge = x === a.x0 || y === a.y0 || x === a.x1 - 1 || y === a.y1 - 1;
            rgba.set([255, 255, 255, edge ? 110 : 45], (y * W + x) * 4);
          }
          renderer.setGroundOverlay(rgba, W, H);
          redraw();
        };
        const setArea = (a: typeof terrainArea) => {
          terrainArea = a;
          drawArea(a);
          if (!a && areaPanel) { areaPanel = false; clearSelection(); }
        };
        /** Whether the side panel shows the area. */
        let areaPanel = false;
        /** Tile names by id, once read. */
        let tileNames: Promise<Map<string, string>> | null = null;
        const readTileNames = () => (tileNames ??= w3.game.readText("TerrainArt\\Terrain.slk").then((text) => new Map(parseSlk(text).filter((r) => r.tileID).map((r) => [r.tileID, r.comment || r.tileID]))).catch(() => new Map<string, string>()));
        const replaceRow = (label: string, from: [string, string][], to: [string, string][], run: (from: string, to: string) => void | Promise<void>) => {
          const pick = (options: [string, string][]) => h("select", {}, ...options.map(([value, text]) => h("option", { value }, text)));
          const fromEl = pick(from), toEl = pick(to);
          return h("div.terrain-sel-area", {},
            h("div.terrain-sel-sub.muted", {}, label),
            h("div.terrain-sel-row", {}, h("span.muted", {}, "Replace"), fromEl),
            h("div.terrain-sel-row", {}, h("span.muted", {}, "with"), toEl),
            h("div.terrain-sel-actions", {}, h("button", { onclick: () => void Promise.resolve(run(fromEl.value, toEl.value)).catch((e) => w3.window.showError(String(e))) }, "Replace")));
        };
        const showAreaPanel = async () => {
          const a = terrainArea;
          if (!a) return;
          areaPanel = true;
          const names = await readTileNames(), sets = await handle.tilesets().catch(() => []);
          if (terrainArea !== a) return;
          const cliffGrounds = handle.cliffGroundTiles();
          const inArea: Corner[] = [];
          for (let y = a.y0; y <= a.y1; y++) for (let x = a.x0; x <= a.x1; x++) inArea.push(terrain.corners[y * terrain.width + x]);
          const label = (id: string) => [id, `${names.get(id) ?? id} (${id})`] as [string, string];
          const usedTiles = [...new Set(inArea.map((c) => terrain.groundTiles[c.texture]))];
          const ownTiles = sets.find((s) => s.id === terrain.tileset)?.tiles ?? [];
          // A cliff's number past the list stands for the first type, as when it's drawn.
          const cliffOf = (c: Corner) => (c.cliffTexture < cliffGrounds.length ? c.cliffTexture : 0);
          const layers = new Set(inArea.map((c) => c.layer));
          const usedCliffs = layers.size > 1 ? [...new Set(inArea.map(cliffOf))] : [];
          const commit = (st: ReturnType<typeof changeArea>, nothing = "Nothing to replace there.") => {
            if (!st.corners.length) { void w3.window.showInfo(nothing); return; }
            commitTerrain({ ...st, cliffs: true });
            void showAreaPanel();
          };
          const adjust = (by: number) => {
            const log = new CornerUndo();
            adjustLevels(terrain, a, by, cliffGrounds, log);
            commit(log.step(terrain));
          };
          const lowest = Math.min(...layers), highest = Math.max(...layers);
          const levelButton = (by: number, text: string) => h("button", { title: `Move all of this ${by > 0 ? "up" : "down"} a cliff level, with what's on it`, disabled: lowest + by < 0 || highest + by > 15, onclick: () => adjust(by) }, text);
          selInfo.className = "terrain-selection";
          selInfo.replaceChildren(
            h("div.terrain-sel-title", {}, h("div.terrain-sel-name", {}, `${a.x1 - a.x0} × ${a.y1 - a.y0} tiles`)),
            h("div.muted", {}, "Ctrl+C copies it · Esc clears it"),
            replaceRow("Ground tile", usedTiles.map(label), [...new Set([...terrain.groundTiles, ...ownTiles])].map(label), async (from, to) => {
              const number = await handle.ensureGroundTile(to);
              if (number === null) { void w3.window.showWarning("This map can't take another ground tile."); return; }
              const was = terrain.groundTiles.indexOf(from);
              commit(changeArea(terrain, a, (c) => { if (c.texture !== was || was === number) return false; c.texture = number; return true; }));
            }),
            ...(usedCliffs.length && cliffGrounds.length ? [replaceRow("Cliff type", usedCliffs.map((n) => [String(n), label(cliffGrounds[n])[1]] as [string, string]),
              cliffGrounds.map((g, n) => [String(n), label(g)[1]] as [string, string]), (from, to) => {
                const was = Number(from), number = Number(to);
                commit(changeArea(terrain, a, (c) => { if (cliffOf(c) !== was || was === number) return false; c.cliffTexture = number; return true; }));
              })] : []),
            h("div.terrain-sel-area", {},
              h("div.terrain-sel-sub.muted", {}, highest === lowest ? `Cliff level ${lowest}` : `Cliff levels ${lowest}–${highest}`),
              h("div.terrain-sel-actions.wrap", {},
                levelButton(-1, "Level −1"), levelButton(1, "Level +1"),
                h("button", { title: "Flatten hills and dips, keeping the cliff levels", onclick: () => commit(changeArea(terrain, a, (c) => { if (groundHeight(c) === 0) return false; setGroundHeight(c, 0); return true; }), "This ground is flat already.") }, "Reset height field"))),
          );
        };
        /** The Select tab's mode: dragging selects objects or a block of ground. Holding A does an area in either. */
        let areaMode = false, withObjects = true, areaKey = false;
        /** A press on the way to being an area: where it began. */
        let areaPress: { from: [number, number]; x: number; y: number; moved: boolean } | null = null;
        /** A block of ground, with what stands on it if so chosen. */
        const copyArea = (a: NonNullable<typeof terrainArea>) => {
          const worldX = (x: number) => terrain.offsetX + x * 128, worldY = (y: number) => terrain.offsetY + y * 128;
          const centre = centreOf([[worldX(a.x0), worldY(a.y0)], [worldX(a.x1), worldY(a.y1)]]);
          const inside = { left: worldX(a.x0), right: worldX(a.x1), bottom: worldY(a.y0), top: worldY(a.y1) };
          const items = !a.objects ? [] : ([["doodads", dooFile], ["units", unitsFile]] as const).flatMap(([list, f]) => (f?.list ?? [])
            .filter((p) => p.id !== "sloc" && inArea(p.position[0], p.position[1], inside)).map((entry) => ({ list, entry })));
          clipboard = { ...fragmentOf(items, (x, y) => heightAt(terrain, x, y), centre), ground: groundOf(terrain, a, centre) };
          takeTypes(clipboard);
        };
        /** Where the fragment's centre lands for a pointer on the ground: ground goes on whole tiles. */
        const pasteCentre = (f: Fragment, g: Vec3): [number, number] => {
          if (!f.ground) return [snapped(g[0]), snapped(g[1])];
          const [x, y] = groundOrigin(terrain, f.ground, g[0], g[1]);
          return [terrain.offsetX + x * 128 - f.ground.at[0], terrain.offsetY + y * 128 - f.ground.at[1]];
        };
        /** Where an object of the fragment lands, null if that's off the map. */
        const pasteSpot = (o: FragmentObject, g: Vec3): [number, number, number] | null => {
          const [cx, cy] = pasteCentre(pasting as Fragment, g);
          const [x, y] = o.list === "units" ? onGrid(String(o.entry.id), cx + o.at[0], cy + o.at[1]) : [cx + o.at[0], cy + o.at[1]];
          if (!inArea(x, y, wholeMap(handle))) return null;
          const fixed = ((Number(o.entry.flags) || 0) & FIXED_HEIGHT) !== 0, ground = heightAt(terrain, x, y);
          return [x, y, pastedHeight(ground, o.at[2], fixed, preserveHeight())];
        };
        const showPaste = (g: Vec3) => {
          pasteAt = g;
          const f = pasting;
          if (!f) return;
          if (f.ground) {
            const [x, y] = groundOrigin(terrain, f.ground, g[0], g[1]);
            drawArea({ x0: x, y0: y, x1: x + f.ground.width - 1, y1: y + f.ground.height - 1 });
          }
          renderer.ghosts = pasteModels.flatMap((m, i) => {
            const o = f.objects[i], position = pasteSpot(o, g);
            if (!m || !position) return [];
            const entry = { ...(o.entry as unknown as Placed), position, angle: o.angle };
            const team = entry.player !== undefined && entry.player < TEAM_COLORS.length ? entry.player : NEUTRAL;
            return [{ gpu: m.gpu, world: placement(entry, m.modelScale, drawnZ(entry)), team, ok: true }];
          });
          redraw();
        };
        /** The types of what's being pasted, in this map: asked at every click. The service answers at once while
         *  what it did before is still there (an undo may have taken it away, then it asks again); only a question
         *  still open is shared, so a double click doesn't ask twice. */
        let bringing: { types: Fragment["typesReady"]; renames: Promise<Map<string, string> | null> } | null = null;
        const bringTypes = (f: Fragment): Promise<Map<string, string> | null> => {
          if (!f.typesReady) return Promise.resolve(new Map<string, string>());
          if (bringing?.types !== f.typesReady) {
            const label = `${f.objects.length} copied object${f.objects.length === 1 ? "" : "s"}`;
            const renames = f.typesReady.then((types) => (types.length ? w3.services.get<ObjectsService>(OBJECTS_SERVICE).then((s) => s.bringTypes(types, label)) : new Map<string, string>()));
            const mine = { types: f.typesReady, renames };
            bringing = mine;
            const done = () => { if (bringing === mine) bringing = null; };
            void renames.then(done, done);
          }
          return bringing.renames;
        };
        const startPaste = () => {
          if (!clipboard) return false;
          setArea(null);
          showTab(null);
          clearSelection();
          const f = pasting = clipboard;
          pasteModels = [];
          const what = [...(f.ground ? [`${f.ground.width - 1} × ${f.ground.height - 1} tiles`] : []), ...(f.objects.length || !f.ground ? [`${f.objects.length} object${f.objects.length === 1 ? "" : "s"}`] : [])];
          selInfo.textContent = `Pasting ${what.join(" and ")}. Click to place, as often as you like · H and V mirror · R turns · Esc ends.`;
          // The clipboard may come from another map, with buildings this one hasn't met.
          for (const id of new Set(f.objects.filter((o) => o.list === "units").map((o) => String(o.entry.id)))) void loadCells(id).catch(() => { /* stays free */ });
          void Promise.all(f.objects.slice(0, MAX_GHOSTS).map(async (o) => {
            const skin = skinOf(o.entry as unknown as Placed);
            if (!skin) return null;
            const gpu = await loader.modelFor(skin, Number(o.entry.variation) || 0).catch(() => null);
            return gpu ? { gpu, modelScale: skin.modelScale } : null;
          })).then((models) => {
            if (!pasting) return;
            pasteModels = models;
            if (pasteAt) showPaste(pasteAt);
          });
          return true;
        };
        const endPaste = () => {
          pasting = null;
          pasteModels = [];
          renderer.ghosts = [];
          drawArea(null);
          clearSelection();
        };
        /** This map's number for each of the ground's tiles, adding those it lacks. -1 where it's full. */
        const tileNumbers = (ids: readonly string[], used: ReadonlySet<number>) => ids.map((id, i) => (used.has(i) ? ensureTile(id) ?? -1 : 0));
        /** Stamps the ground of a paste, adding the tiles it needs. At once, with no wait in between: placePaste
         *  takes the tile lists before and puts them back if the edit is refused. */
        const placeGround = (f: Fragment, g: Vec3) => {
          const ground = f.ground;
          if (!ground) return null;
          const tiles = tileNumbers(ground.tiles, new Set(ground.corners.map((c) => c.texture)));
          const full = tiles.filter((n) => n < 0).length;
          if (full) void w3.window.showWarning(`This map can't take ${full} more ground tile${full === 1 ? "" : "s"}; its first tile stands in.`);
          const cliffs = ground.cliffs.map((id) => Math.max(0, terrain.cliffTiles.indexOf(id)));
          return stampGround(terrain, ground, groundOrigin(terrain, ground, g[0], g[1]), tiles.map((n) => Math.max(0, n)), cliffs);
        };
        const placePaste = async (g: Vec3) => {
          const f = pasting;
          if (!f) return;
          // What the pasted objects are made of, before anything is placed: the user may refuse.
          const root = w3.workspace.project()?.root;
          const renames = await bringTypes(f).catch((e) => { void w3.window.showError(String(e)); return null; });
          // Another project, or the paste ended, while the question was open: nothing is placed.
          if (!renames || pasting !== f || w3.workspace.project()?.root !== root || refuseLost()) return;
          // Tiles the ground needs are added to the map's lists as it is stamped; if the ground is refused they go again.
          // From here to the end there is no wait: the lists are taken right before the tiles are added, so putting them
          // back can't drop a tile another edit added in between.
          const tiles = tileSnapshot(terrain);
          const stamped = placeGround(f, g);
          // Ground and objects are one undo step, and objects stand on the new ground. Each click is its
          // own step: without clearing keyStep this click would join the one before.
          keyStep = null;
          keyPress = "first";
          const applied = stamped?.corners.length ? commitTerrain({ ...stamped, cliffs: true }) : true;
          if (!applied) {
            // Neither the ground nor the objects that stand on it.
            keyPress = null;
            const added = terrain.groundTiles.length !== tiles.ground.length;
            restoreTiles(terrain, tiles);
            // The side list's rows and counts for the tiles that went again.
            if (added) void syncTileList();
            return;
          }
          keyPress = "repeat";
          try { placeObjects(f, g, renames); } finally { keyPress = null; keyStep = null; }
        };
        const placeObjects = (f: Fragment, g: Vec3, renames: ReadonlyMap<string, string> = new Map()) => {
          const added: { entry: Placed; f: PlacedFile }[] = [];
          const skips: PasteSkips = { noFile: 0, offMap: 0, pastPlayable: 0, outsideBounds: 0 };
          for (const o of f.objects) {
            const file = o.list === "doodads" ? dooFile : unitsFile, spot = pasteSpot(o, g);
            if (!file) { skips.noFile++; continue; }
            if (!spot) { skips.offMap++; continue; }
            // Units and items can't stand past the playable map, trees and doodads can.
            if (o.list !== "doodads" && playableEdge && !inArea(spot[0], spot[1], playableEdge)) { skips.pastPlayable++; continue; }
            if (!insideBounds(heldTo(), spot[0], spot[1])) { skips.outsideBounds++; continue; }
            // A type given another id here: its skin, and the items and abilities the object has, follow.
            const made = pastedEntry(file, renames.size ? { ...o, entry: renamedEntry(o.entry, renames) } : o, spot);
            if (typeof (made as Placed & { flags?: number }).flags === "number") (made as Placed & { flags?: number }).flags = pastedFlags((made as Placed & { flags: number }).flags, preserveHeight());
            file.list.push(made);
            repositioned.add(made);
            added.push({ entry: made, f: file });
          }
          const skipped = pasteSkipText(f.objects.length, skips);
          if (skipped) void w3.window.showWarning(skipped);
          if (!added.length) return;
          const remove = () => { for (const a of added) a.f.list.splice(a.f.list.indexOf(a.entry), 1); };
          const put = () => { for (const a of added) a.f.list.push(a.entry); };
          pushEdit({ undo: remove, redo: put, terrain: false, objects: true });
          objectsTouched = true;
          void rebuildObjects();
        };
        /** Ctrl+C, X, V and A, and the keys while pasting. True when the key did something. */
        const clipboardKey = (e: KeyboardEvent) => {
          if (pasting && e.key === "Escape") { endPaste(); return true; }
          if (terrainArea && e.key === "Escape") { setArea(null); return true; }
          const turn = turnKey(e);
          if (turn && pasting) {
            if (!e.repeat) { pasting = turnFragment(pasting, turn); if (pasteAt) showPaste(pasteAt); }
            return true;
          }
          if (turn && editable && !activeGroup && selectedEntries().length) { if (!e.repeat) turnSelection(turn); return true; }
          if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
          const key = e.key.toLowerCase();
          if (key === "c" && terrainArea) { copyArea(terrainArea); return true; }
          if (key === "c") return copySelection();
          if (key === "x") {
            if (terrainArea || !editable || !copySelection()) return false;
            deleteEntries(copyable());
            return true;
          }
          if (key === "v") return editable && startPaste();
          if (key === "a" && !activeGroup) { selectEntries(allPlaced().filter((o) => o.id !== "sloc").map((o) => o.p)); return true; }
          return false;
        };

        /** Alt: the selection goes to the pointer, keeping its shape, and follows it while held. */
        const startMoveTo = (g: Vec3) => {
          const entries = selectedEntries();
          objDrag = { entries, before: entries.map(poseOf), anchor: [...entries[0].position] as Vec3, moved: true };
          dragObjects(g);
        };
        /** "Face point": the selection turns toward the pointer until a click (apply) or Esc. */
        let facing: { entries: Placed[]; before: Pose[] } | null = null;
        /** Facing with Ctrl and the button held: it ends when the button is let go. */
        let faceHeld = false;
        const startFacing = () => {
          const entries = selectedEntries();
          if (!editable || !entries.length) return;
          facing = { entries, before: entries.map(poseOf) };
          modeHint.textContent = "Facing the pointer: click to apply · Esc to cancel";
          keysToMap();
        };
        const faceToward = (g: Vec3) => {
          for (const p of facing!.entries) setPlacement(p, [...p.position], Math.atan2(g[1] - p.position[1], g[0] - p.position[0]));
          refreshGroupRings();
        };
        const endFacing = (apply: boolean) => {
          const f = facing;
          if (!f) return;
          facing = null;
          modeHint.textContent = "";
          if (apply) moveEdits(f.entries, f.before);
          else { f.entries.forEach((p, i) => setPlacement(p, [...f.before[i].position], f.before[i].angle)); refreshGroupRings(); }
        };
        const modeHint = h("span.terrain-place-hint");

        const rotateSelected = (deg: number) => {
          const entries = selectedEntries();
          if (!entries.length) return;
          const before = entries.map(poseOf);
          for (const e of entries) setPlacement(e, [...e.position], e.angle + (deg * Math.PI) / 180);
          moveEdits(entries, before);
        };
        /** Blocked ground and object footprints, built when placing needs it
         *  and dropped after any edit. */
        let occupancyPromise: Promise<Occupancy> | null = null;
        /** What stops a walking unit; dropped with the above. */
        let walkPromise: Promise<Uint8Array> | null = null;
        let destructablePromise: Promise<Uint8Array> | null = null;
        let standingPromise: Promise<Uint8Array> | null = null;
        let pathingData: Promise<PathingData> | null = null;
        const occupancy = () => {
          occupancyPromise ??= (async () => {
            pathingData ??= loadPathingData(w3, (p) => readFile(w3, doc, p), (id) => objCtx?.bases.get(id));
            const kindOf = (id: string) => (objCtx?.skins.get(id) ?? objCtx?.skins.get(objCtx.bases.get(id) ?? ""))?.kind ?? "w3u";
            const placed = [
              ...(dooFile?.list ?? []).map((entry) => ({ entry, kind: "w3d" })),
              ...(unitsFile?.list ?? []).map((entry) => ({ entry, kind: kindOf(entry.id) === "w3t" ? "w3t" : "w3u" })),
            ];
            return Occupancy.build(terrain, await pathingData, placed);
          })();
          return occupancyPromise;
        };

        // ---- selection --------------------------------------------------------------
        const selInfo = h("div.terrain-selection.muted", {}, "Click a unit, item, doodad or destructable.");
        const row = (label: string, value: string) => h("div.terrain-sel-row", {}, h("span.muted", {}, label), h("span", {}, value));
        const fmt = (v: number) => (Math.round(v * 10) / 10).toString();
        let selected: ObjectInstance | null = null;
        const selectObject = (inst: ObjectInstance) => {
          pendingSel = null;
          selected = inst;
          const p = inst.pick!, pl = p.placed;
          const iconEl = h("img.terrain-sel-icon", { alt: "", hidden: true });
          void w3.services.get<ObjectsService>(OBJECTS_SERVICE).then((s) => s.icon(p.kind, p.id))
            .then((src) => { if (src) { iconEl.src = src; iconEl.hidden = false; } }).catch(() => { /* no icon */ });
          const nameEl = h("div.terrain-sel-name", {}, p.id === "sloc" ? "Start location" : p.id);
          loadKind(w3, p.kind).then((k) => {
            const base = k.names.get(p.base ?? p.id);
            if (base) nameEl.textContent = p.base ? `${p.id} (custom, based on ${base})` : base;
          }).catch(() => { /* raw id stays */ });
          const skin = objCtx?.skins.get(p.id) ?? objCtx?.skins.get(p.base ?? "");
          const numVar = skin?.numVar ?? 1;
          // Editable fields commit on Enter/blur; each change is one undo step.
          const num = (value: number, step: string, commit: (v: number) => void) =>
            h("input.terrain-sel-num", { type: "number", step, value: fmt(value), onchange: (e: Event) => {
              const v = Number((e.target as HTMLInputElement).value);
              if (Number.isFinite(v)) commit(v);
            } });
          const triple = (values: number[], step: string, commit: (v: [number, number, number]) => void) =>
            h("span.terrain-sel-triple", {}, ...values.map((v, i) => num(v, step, (nv) => {
              const next = [...values] as [number, number, number];
              next[i] = nv;
              commit(next);
            })));
          const choice = (value: number, options: [number, string][], commit: (v: number) => void) => {
            if (!options.some(([v]) => v === value)) options.push([value, `#${value}`]);
            const sel = h("select", { onchange: () => commit(Number(sel.value)) },
              ...options.map(([v, label]) => h("option", { value: String(v), selected: v === value }, label)));
            return sel;
          };
          const field = (label: string, el: HTMLElement) => h("div.terrain-sel-row", {}, h("span.muted", {}, label), el);
          const ownerOptions = (): [number, string][] => Array.from({ length: 28 }, (_, i) => [i, ownerName(i)]);
          selInfo.className = "terrain-selection";
          selInfo.replaceChildren(
            h("div.terrain-sel-title", {}, iconEl, nameEl),
            row("Type", `${KIND_LABELS[p.kind] ?? p.kind} · ${p.id}${p.base ? ` ← ${p.base}` : ""}`),
            ...(editable ? [
              ...(pl.player !== undefined ? [field("Owner", choice(pl.player, ownerOptions(), (v) => editProps(pl, { player: v })))] : []),
              field("Position", triple(pl.position, "16", (v) => {
                if (!insideBounds(heldTo(), v[0], v[1])) {
                  void w3.window.showWarning("Not done: that is outside the camera bounds. Turn off Enforce Camera Bounds to allow it.");
                  // The boxes show where the object is again, not what was typed.
                  if (selected) selectObject(selected);
                  return;
                }
                editProps(pl, { position: v });
              })),
              field("Facing", num((pl.angle * 180) / Math.PI, "15", (v) => editProps(pl, { angle: (v * Math.PI) / 180 }))),
              field("Scale", triple(pl.scale, "0.1", (v) => editProps(pl, { scale: v }))),
              numVar > 1
                ? field("Variation", choice(pl.variation, Array.from({ length: numVar }, (_, i) => [i, String(i)]), (v) => editProps(pl, { variation: v })))
                : row("Variation", String(pl.variation)),
            ] : [
              ...(pl.player !== undefined ? [row("Owner", ownerName(pl.player))] : []),
              row("Position", pl.position.map(fmt).join(", ")),
              row("Facing", `${fmt((pl.angle * 180) / Math.PI)}°`),
              row("Scale", pl.scale.map(fmt).join(", ")),
              row("Variation", String(pl.variation)),
            ]),
            row("Model", p.model),
            propsSlot([pl]),
            h("div.terrain-sel-actions", {},
              h("button", { title: "Ctrl+F1", onclick: () => openObject(p.kind, p.id) }, "Open in Object Editor")),
            // The same order as for several objects below, with Delete last.
            h("div.terrain-sel-actions.wrap", {},
              h("button", { title: "Select every object of this type", onclick: selectSameTypes }, "Select all of this type"),
              h("button", { title: "Move the camera to the object (command: View Selection)", onclick: () => { void viewSelection(); keysToMap(); } }, "View"),
              ...(editable ? [
                h("button", { title: "Make this type the one the Objects tab places (command: Select In Tool Palette)", onclick: () => void selectInPalette().then((why) => { if (why) void w3.window.showInfo(why); keysToMap(); }) }, "Select in palette"),
                h("button", { title: "Turn toward the pointer (F); click to apply", onclick: startFacing }, "Face point"), ...turnButtons(), ...heightButtons(),
                h("button", { title: "Delete (Del)", onclick: deleteSelected }, "Delete"),
              ] : [])),
            ...(editable ? [h("div.muted", {}, "Drag it to move · [ ] to turn · F face point · Del to delete · Ctrl+C, then Ctrl+V to copy")] : []),
          );
          renderer.setSelection(ringOf(inst));
          redraw();
        };
        const openObject = (kind: string, id: string) => {
          w3.commands.execute("w3.objectEditor.open", kind, id).catch((e) => w3.window.showError(String(e)));
        };
        /** What was selected before the selection was cleared, for Space. */
        let lastSelected: Placed[] = [];
        const clearSelection = () => {
          pendingSel = null;
          const was = selectedEntries();
          if (was.length) lastSelected = was;
          selected = null;
          group = [];
          selInfo.className = "terrain-selection muted";
          selInfo.replaceChildren(areaMode ? "Drag over the ground to select an area." : "Click a unit, item, doodad or destructable, or drag a box around several. Hold A and drag for an area.");
          renderer.setSelection(null);
          redraw();
        };

        /** Several selected objects (box or Ctrl+click); `selected` is then null. */
        let group: Placed[] = [];
        /** Object kinds a selection box picks up. */
        const boxKinds = new Set(["w3u", "w3t", "w3b", "w3d"]);
        /** Selection ring radius per type: the collision size (units) or the
         *  pathing footprint (buildings, doodads, destructables), like the game. */
        const ringRadius = new Map<string, number>();
        const ringLoading = new Set<string>();
        const radiusOf = (kind: string, id: string): number | undefined => {
          const key = `${kind}:${id}`;
          if (ringRadius.has(key)) return ringRadius.get(key);
          if (!ringLoading.has(key)) {
            ringLoading.add(key);
            void (async () => {
              pathingData ??= loadPathingData(w3, (p) => readFile(w3, doc, p), (x) => objCtx?.bases.get(x));
              const data = await pathingData;
              const texRadius = async (path?: string) => { const t = path ? await data.texture(path) : null; return t ? Math.max(t.width, t.height) * 16 : undefined; };
              let r: number | undefined;
              if (kind === "w3t") r = 24;
              else if (kind === "w3u") { const sh = data.unitShape(id); r = (await texRadius(sh?.path)) ?? sh?.collision ?? 32; }
              else r = (await texRadius(data.placedTex(id)?.path)) ?? 32;
              ringRadius.set(key, Math.max(16, r));
              refreshRings();
            })().catch(() => { ringRadius.set(key, 32); });
          }
          return undefined;
        };
        const ringOf = (inst: ObjectInstance) => {
          const [, , , sr] = inst.sphere!, pl = inst.pick!.placed;
          // Until the size is known: a modest share of the model bounds.
          const r = radiusOf(inst.pick!.kind, inst.pick!.id) ?? Math.min(96, Math.max(24, sr * 0.4));
          // Centred on the object position (model bounds can be off-centre).
          // A ship's ring goes round it on the water, not on the sea bed.
          const onWater = goesOnWater(moveTypeOf(pl)) ? drawnZ(pl) : pl.position[2];
          const z = ((flagsOf(pl) ?? 0) & FIXED_HEIGHT) !== 0 ? pl.position[2] : onWater !== pl.position[2] ? onWater : undefined;
          return { x: pl.position[0], y: pl.position[1], z, r, rgb: (pl.player !== undefined && pl.player < 24 ? TEAM_COLORS[pl.player][1] : [120, 255, 120]) as Vec3 };
        };
        /** Click target per object: the same radius as its selection ring. */
        const pickRadius = (inst: ObjectInstance) =>
          radiusOf(inst.pick!.kind, inst.pick!.id) ?? Math.min(96, Math.max(24, (inst.sphere?.[3] ?? 64) * 0.4));
        /** Redraws the selection rings (after a size became known). */
        const refreshRings = () => {
          const insts = (group.length ? group : selected?.pick ? [selected.pick.placed] : []).map(findInstance).filter((i): i is ObjectInstance => !!i?.pick);
          renderer.setSelection(insts.map(ringOf));
          redraw();
        };
        /** Moves the view to entries (the first one) and selects those that have a model. */
        const showEntries = (entries: Placed[]) => {
          if (!entries.length) return;
          // Close enough to see one object (objects without a model are only markers).
          renderer.distance = Math.min(renderer.distance, 1600);
          look(entries[0].position[0], entries[0].position[1]);
          selectEntries(entries);
        };
        /** Selects these entries: none clears, one shows its details, more a summary. */
        const selectEntries = (entries: Placed[]) => {
          pendingSel = null;
          const insts = entries.map(findInstance).filter((i): i is ObjectInstance => !!i?.pick);
          if (!insts.length) { clearSelection(); return; }
          if (insts.length === 1) { group = []; selectObject(insts[0]); return; }
          selected = null;
          group = insts.map((i) => i.pick!.placed);
          renderer.setSelection(insts.map(ringOf));
          // Summary: counts per type, most common first.
          const counts = new Map<string, { kind: string; id: string; n: number }>();
          for (const i of insts) {
            const key = `${i.pick!.kind}:${i.pick!.id}`;
            const c = counts.get(key) ?? { kind: i.pick!.kind, id: i.pick!.id, n: 0 };
            c.n++;
            counts.set(key, c);
          }
          const rows = [...counts.values()].sort((a, b) => b.n - a.n);
          const list = h("div.terrain-sel-list");
          const shown = rows.slice(0, 12);
          list.append(...shown.map((c) => {
            const name = h("span", {}, c.id);
            loadKind(w3, c.kind).then((k) => { const n = k.names.get(c.id) ?? k.names.get(objCtx?.bases.get(c.id) ?? ""); if (n) name.textContent = n; }).catch(() => { /* id */ });
            return h("div.terrain-sel-row", {}, h("span.muted", {}, `${c.n} ×`), name,
              h("button.icon-button.terrain-sel-open", {
                title: `Open ${c.id} in the Object Editor`,
                onclick: () => openObject(c.kind, c.id),
              }, "↗"));
          }), ...(rows.length > shown.length ? [h("div.muted", {}, `… ${rows.length - shown.length} more types`)] : []));
          // Owner for all selected units at once.
          const units = group.filter((p) => p.player !== undefined && objCtx?.skins.get(p.id)?.kind !== "w3t");
          const ownerSel = units.length ? (() => {
            const first = units[0].player!, same = units.every((u) => u.player === first);
            const sel = h("select", { onchange: () => setGroupOwner(units, Number(sel.value)) },
              ...(same ? [] : [h("option", { value: "", selected: true }, "(mixed)")]),
              ...Array.from({ length: 28 }, (_, i) => h("option", { value: String(i), selected: same && i === first }, ownerName(i))));
            return sel;
          })() : null;
          // "Edit all": an expression per field, applied to every selected object.
          const vars = group.map(varsOf);
          const common = (k: MassField) => {
            const vs = vars.map((v) => v[k]);
            return vs.every((v) => Math.abs(v - vs[0]) < 1e-3) ? fmt(vs[0]) : "mixed";
          };
          const massField = (label: string, k: MassField, title: string) => {
            const input = h("input.terrain-sel-expr", {
              type: "text", placeholder: common(k), title,
              onkeydown: (e: KeyboardEvent) => {
                if (e.key !== "Enter" || !input.value.trim()) return;
                const err = massEdit(group, k, input.value.trim());
                input.classList.toggle("invalid", !!err);
                input.title = err ? `${err}\n\n${title}` : title;
                if (!err) input.value = "";
              },
            });
            return h("div.terrain-sel-row", {}, h("span.muted", {}, label), input);
          };
          const help = "Enter a number or an expression, applied to each object: v = current value, i = index, n = count, x y z facing scale of the object; random(1..1.2), randint(0,9), round(v, 32), min, max, abs, sin/cos (degrees). Examples: x+64 · random(0..360) · i*90 · v*1.1";
          const quick = (label: string, title: string, fn: () => void) => h("button", { title, onclick: fn }, label);
          selInfo.className = "terrain-selection";
          selInfo.replaceChildren(
            h("div.terrain-sel-name", {}, `${group.length} objects selected`),
            list,
            ...(editable ? [] : [h("div.terrain-sel-actions", {}, quick("Select all of these types", "Select every object of the selected types", selectSameTypes))]),
            ...(editable ? [
              ...(ownerSel ? [h("div.terrain-sel-row", {}, h("span.muted", {}, `Owner (${units.length})`), ownerSel)] : []),
              propsSlot(group),
              h("div.terrain-sel-sub.muted", { title: help }, "Edit all (Enter applies; hover for help)"),
              massField("X", "x", help), massField("Y", "y", help), massField("Z", "z", help),
              massField("Facing", "facing", help), massField("Scale", "scale", help), massField("Variation", "variation", help),
              h("div.terrain-sel-actions.wrap", {},
                quick("Select all of these types", "Select every object of the selected types", selectSameTypes),
                quick("Face point", "Turn every selected object toward the pointer (F); click to apply", startFacing),
                ...turnButtons(), ...heightButtons(),
                quick("Random facing", "A random facing for each object", () => void massEdit(group, "facing", "random(0..360)")),
                quick("Random variation", "A random model variation for each object", () => applyMass(group, (p) => {
                  const n = skinOf(p)?.numVar ?? 1;
                  return n > 1 ? { variation: Math.floor(Math.random() * n) } : null;
                })),
                quick("Random scale", "A random scale within each type's own range (game data)", () => applyMass(group, (p) => {
                  const sk = skinOf(p);
                  if (!sk || sk.maxScale <= sk.minScale) return null;
                  const k = sk.minScale + Math.random() * (sk.maxScale - sk.minScale);
                  return { scale: [k, k, k] };
                })),
                quick("Drop to ground", "Set every object's height to the ground under it", () => applyMass(group, (p) => ({ position: [p.position[0], p.position[1], heightAt(terrain, p.position[0], p.position[1])] }))),
                h("button", { title: "Delete all selected (Del)", onclick: deleteSelected }, `Delete ${group.length}`)),
              h("div.muted", {}, "Drag one to move all · [ ] turn each · F face point · Del delete · Ctrl+click adds/removes · Shift+box adds"),
            ] : []),
          );
          redraw();
        };
        const setGroupOwner = (units: Placed[], player: number) => {
          const before = units.map((u) => u.player);
          const apply = (v: (number | undefined)[]) => units.forEach((u, i) => { u.player = v[i]; });
          apply(units.map(() => player));
          pushEdit({ undo: () => apply(before), redo: () => apply(units.map(() => player)), terrain: false, objects: true });
          objectsTouched = true;
          void rebuildObjects();
        };
        /** Entries currently selected (one or many). */
        const selectedEntries = (): Placed[] => (group.length ? group : selected?.pick ? [selected.pick.placed] : []);
        /** What is selected, said so that it can be found again among entries loaded anew (see matchPlaced). */
        const selectionRefs = (): PlacedRef[] => selectedEntries().map((p) => ({ id: p.id, editorId: (p as Placed & { editorId?: number }).editorId, x: p.position[0], y: p.position[1] }));
        /** Selects what `refs` name among the placed objects as they are now; true when any was found. */
        const reselect = (refs: readonly PlacedRef[]): boolean => {
          if (!refs.length) return false;
          const placed = allPlaced().map((o) => o.p);
          const like = placed as unknown as PlacedLike[];
          const found = [...new Set(refs.map((ref) => matchPlaced(like, ref)).filter((i) => i >= 0))].map((i) => placed[i]);
          if (found.length) selectEntries(found);
          return found.length > 0;
        };

        /** Objects whose position projects into the canvas rectangle (CSS pixels). */
        const objectsInBox = (x0: number, y0: number, x1: number, y1: number): Placed[] =>
          objectsInRect(shownInstances(), (pos) => renderer.project(pos), renderer.hiddenGroups, boxKinds, x0, y0, x1, y1);

        const pickAt = (e: MouseEvent) => {
          const rect = canvas.getBoundingClientRect();
          const ray = renderer.ray(e.clientX - rect.left, e.clientY - rect.top);
          // Objects shown only as markers are clicked through their stand-ins, as a box selects them.
          const inst = renderer.pickObject(ray, pickRadius, strays);
          // Shift+click adds or removes an object, as in the World Editor; so does Ctrl+click with nothing
          // selected yet, when it has no point to face.
          if (e.shiftKey || e.ctrlKey || e.metaKey) {
            if (!inst?.pick) return;
            const cur = selectedEntries(), entry = inst.pick.placed;
            selectEntries(cur.includes(entry) ? cur.filter((p) => p !== entry) : [...cur, entry]);
            return;
          }
          // The ground isn't selectable; it's edited with brushes.
          if (inst) { group = []; selectObject(inst); } else clearSelection();
        };

        const tiles = `${terrain.width - 1} × ${terrain.height - 1}`;
        const side = h("div.model-side", {},
          h("h3", {}, TILESETS[terrain.tileset] ?? `Tileset ${terrain.tileset}`),
          h("div.model-facts", {},
            h("div", {}, `w3e v${terrain.version} · ${tiles} tiles`),
            groundFacts,
            cliffInfo, texInfo,
          ),
          texHeading, texList,
          h("h4", {}, "Selection"), selInfo,
          h("h4", {}, "Placed objects"), markerList, problems,
        );

        function selectBar() {
          const objectsOnly = h("button.chip", { title: "A drag selects objects. Hold A and drag to select a block of ground", onclick: () => setMode(false) }, "Objects");
          const ground = h("button.chip", { title: "A drag selects a block of ground, then Ctrl+C copies it. Esc clears it. Holding A and dragging does this in Objects too", onclick: () => setMode(true) }, "Area");
          const standing = h("input", { type: "checkbox", checked: withObjects, onchange: () => {
            withObjects = standing.checked;
            if (terrainArea) terrainArea = { ...terrainArea, objects: withObjects };
            keysToMap();
          } });
          const standingWrap = h("label.terrain-tool-opt", { title: "Copy the units, items and doodads standing on the area along with its ground" }, standing, " With objects");
          const kindsWrap = h("span.terrain-tool-opt", { title: "Kinds of objects a selection box picks up" }, "Box selects:",
              ...([["w3u", "Units"], ["w3t", "Items"], ["w3b", "Destructables"], ["w3d", "Doodads"]] as const).map(([k, label]) => {
                const cb = h("input", { type: "checkbox", checked: boxKinds.has(k), onchange: () => { if (cb.checked) boxKinds.add(k); else boxKinds.delete(k); keysToMap(); } });
                return h("label.terrain-place-opt", {}, cb, ` ${label}`);
              }));
          const filterRun = h("button", { title: "Select every object matching the filter", onclick: () => void runFilter() }, "Select matching");
          const setMode = (area: boolean) => {
            areaMode = area;
            objectsOnly.classList.toggle("on", !area);
            ground.classList.toggle("on", area);
            standingWrap.hidden = !area;
            kindsWrap.hidden = filterInput.hidden = filterRun.hidden = area;
            dragHint.textContent = area ? "Drag: select an area" : "Drag: select box · Hold A and drag: select an area";
            setArea(null);
            clearSelection();
            keysToMap();
          };
          objectsOnly.classList.add("on");
          standingWrap.hidden = true;
          return h("div.terrain-group-tools", {}, h("span.terrain-tool-opt", {}, objectsOnly, ground), standingWrap, kindsWrap, filterInput, filterRun, modeHint);
        }
        const filterHelp = "Select all objects matching every condition (and the Box selects kinds): field op value, op = != < > <= >= or : (contains). Fields: id, kind (unit, item, destructable, doodad), owner (Player 1 = 1), name, x, y, z, facing, scale, variation. Examples: kind=unit owner=1 · name:tree scale>1.1 · id=LTlt";
        const filterInput = h("input.terrain-filter", {
          type: "text", placeholder: "Filter, e.g. kind=unit owner=1 · name:tree", title: filterHelp,
          onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") void runFilter(); },
        });
        const runFilter = async () => {
          if (!filterInput.value.trim()) return;
          const err = await selectMatching(filterInput.value.trim());
          filterInput.classList.toggle("invalid", !!err);
          filterInput.title = err ? `${err}\n\n${filterHelp}` : filterHelp;
        };

        // ---- tool groups of other extensions ("w3.terrain") --------------------------
        /** wpm bytes (header + cells): applies every group's pathing filter. */
        const filterPathing = (wpm: Uint8Array) => {
          const v = new DataView(wpm.buffer, wpm.byteOffset);
          const w = v.getUint32(8, true), hgt = v.getUint32(12, true);
          for (const g of groupInsts.values()) g.filterPathing?.(wpm.subarray(16), w, hgt);
        };
        /** Latest ghost request (older model loads are dropped). */
        let ghostReq = 0;
        /** File each created entry goes to (set by objects.create). */
        const entryFile = new WeakMap<Placed, PlacedFile>();
        /** Rewrites a project JSON document of the format engine (or its raw file when the project keeps it raw). */
        /** Edits a JSON-backed map file in either project form; `change` returning false skips the write. */
        const editDoc = (name: string, change: (d: Record<string, unknown>) => void | boolean) => editMapDoc(w3, name, change);
        /** The minimap icons (war3map.mmp) of the placed units on a terrain; none when the map has no units file. */
        const updateMinimapIcons = async (t: Terrain, units: Placed[] | undefined = unitsFile?.list) => {
          if (unitsFile && units) await writeMinimapIcons(w3, t, units);
        };
        /** Map Size and Camera Bounds (see TerrainEditorHandle.resizeMap). */
        /** One resize, undo or redo at a time (see ResizeHistory.exclusive). */
        const resizeMap = (change: Sides, complements: Sides): Promise<{ removed: number }> => resizeHistory.exclusive(() => resizeLocked(change, complements));
        const resizeLocked = async (change: Sides, complements: Sides): Promise<{ removed: number }> => {
          if (!editable) throw new Error("This map is read-only.");
          const problem = resizeProblem(terrain, change, complements);
          if (problem) throw new Error(problem);
          // The messages already on screen: an undo withdraws only those the resize brought.
          const shownBefore = new Set<unknown>(document.querySelectorAll(".toast"));
          // Work still due from the last edit (pathing, shadows, minimap, script) is done first: it would land on the new files otherwise.
          await settleWithin(() => w3.commands.execute("w3.terrain.settle"), SETTLE_LIMIT);
          await w3.commands.execute("w3.script.settle").catch(() => {});
          // This editor's own unsaved changes are saved first: the files are rewritten below. A saved editor isn't saved
          // again: a save redoes pathing, shadows and the minimap, which takes minutes on a big map, and the resize
          // makes them anew below.
          if (mark.isDirty(at)) await editorApi.save?.();
          // Every file the resize rewrites is kept, for Undo Resize (Map Size); if it fails halfway they go back.
          const session = await beginResize(w3.workspace, doc.path, "Resize map", shownBefore);
          // The editor opens again on the new terrain (or, after a failure, on the old), still inside the lock: an undo
          // waiting for it finds the editor of the new files, not this one closing.
          const reopen = async () => {
            try {
              await w3.editors.close(doc.path);
              // A rebuild still planned is for the terrain this editor had.
              await w3.commands.execute("w3.terrain.dropRebuild").catch(() => {});
              await w3.editors.open(doc.path, "w3.terrainViewer");
            } catch (e) {
              void w3.window.showError(`The terrain editor couldn't be opened again: ${(e as Error).message ?? e}`);
            }
          };
          try {
            const r = await applyResize(change, complements);
            await session.finish();
            await reopen();
            return r;
          } catch (e) {
            await session.abort().catch((x) => w3.window.showError(`The map's files couldn't be put back after the failed resize: ${(x as Error).message ?? x}. Restore the checkpoint.`));
            await reopen();
            throw e;
          }
        };
        const applyResize = async (change: Sides, complements: Sides): Promise<{ removed: number }> => {
          const next = resizeTerrain(terrain, change);
          // Read and moved before anything is written; a bad file is left alone (see planPathingOverrides).
          const stored = await w3.workspace.readText(".w3proj/pathing.json").then((x) => JSON.parse(x) as unknown).catch(() => null);
          const plan = planPathingOverrides(stored, terrain, change);
          const rect = worldRect(next);
          const inside = (x: number, y: number) => x >= rect.left && x <= rect.right && y >= rect.bottom && y <= rect.top;
          // Start locations aren't removed but moved into the map (a player needs one).
          const pb = cameraBounds(next, complements);
          const clamp = (x: number, y: number): [number, number] => [Math.min(Math.max(x, pb[0]), pb[2]), Math.min(Math.max(y, pb[1]), pb[3])];
          let removed = 0;
          for (const f of [dooFile, unitsFile]) {
            if (!f) continue;
            for (const p of f.list) if (p.id === "sloc" && !inside(p.position[0], p.position[1])) [p.position[0], p.position[1]] = clamp(p.position[0], p.position[1]);
            const keep = f.list.filter((p) => inside(p.position[0], p.position[1]));
            removed += f.list.length - keep.length;
            f.list.splice(0, f.list.length, ...keep);
            // The border itself moved, so anything can be on the other side of it now.
            if (f === dooFile) {
              const edge = playableArea({ cameraComplements: complements }, next);
              for (const p of keep) {
                const flags = flagsOf(p);
                if (flags !== undefined) (p as Placed & { flags?: number }).flags = borderFlags(flags, !inArea(p.position[0], p.position[1], edge));
              }
            }
            await savePlacedFile(w3, f);
          }
          markMapEdge(next, complements);
          await writeTerrainBytes(doc.path, writeW3e(next), doc);
          await editDoc("war3map.w3i", (info) => {
            info.cameraComplements = [...complements];
            info.cameraBounds = cameraBounds(next, complements);
            [info.playableWidth, info.playableHeight] = playableSize(next, complements);
            for (const pl of (info.players as { start: number[] }[] | undefined) ?? []) if (!inside(pl.start[0], pl.start[1])) [pl.start[0], pl.start[1]] = clamp(pl.start[0], pl.start[1]);
          });
          void loadBorder();
          // Regions are clipped to the map (those left outside go).
          await editDoc("war3map.w3r", (d) => {
            type R = { left: number; right: number; bottom: number; top: number };
            const list = (d.regions as R[] | undefined) ?? [];
            for (const r of list) {
              r.left = Math.max(r.left, rect.left); r.right = Math.min(r.right, rect.right);
              r.bottom = Math.max(r.bottom, rect.bottom); r.top = Math.min(r.top, rect.top);
            }
            d.regions = list.filter((r) => r.right > r.left && r.top > r.bottom);
          });
          const shd = await w3.workspace.readBytes("map/war3map.shd").catch(() => null);
          if (shd) await w3.workspace.writeBytes("map/war3map.shd", resizeGrid(shd, terrain, change, 4));
          // Pathing and minimap from the new terrain. Pathing Editor overrides are by cell: they move
          // with the ground (cells that no longer exist go) and are applied to the new pathing here,
          // since the editor reopens on the new size only afterwards.
          const rf = (p: string) => readFile(w3, doc, p);
          const doodads = dooFile?.list ?? [];
          const { wpm } = await buildPathingMap(w3, next, doodads, rf, w3.settings.get<number>("terrain.pathing.deepWater"));
          // Same size: the tool groups' own filters, as everywhere else.
          if (change.every((c) => c === 0)) filterPathing(wpm);
          const pathingText = applyResizePathing(wpm, plan, next, change);
          await w3.workspace.writeBytes("map/war3map.wpm", wpm);
          if (pathingText !== null) await w3.workspace.writeText(".w3proj/pathing.json", pathingText);
          await w3.workspace.writeBytes("map/war3mapMap.blp", await buildMinimap(w3, next, doodads, rf, minimapSettings(w3), w3.settings.get<number>("terrain.minimap.jpegQuality")));
          await updateMinimapIcons(next);
          return { removed };
        };
        const handle: TerrainEditorHandle = {
          terrain, editable, redraw, host: el, resizeMap,
          terrainChanged: (cliffs) => { renderer.terrainChanged(); if (cliffs) void liveCliffs(); doc.setDirty(true); redraw(); },
          commitTerrain,
          tilesets: tilesetList,
          setTileset: (id) => {
            if (id === terrain.tileset) return;
            const set = (v: string, custom: number) => {
              terrain.tileset = v;
              terrain.customTilesetsRaw = custom;
              terrain.customTilesets = custom !== 0;
              loadTilesetArt();
              reloadLighting();
            };
            const before = terrain.tileset, customBefore = terrain.customTilesetsRaw;
            // The tile list is custom or not by the tileset's own list.
            const custom = customTilesFlag(terrain.groundTiles, ownTiles?.get(id));
            pushEdit({ undo: () => set(before, customBefore), redo: () => set(id, custom), terrain: true, objects: false });
            set(id, custom);
            redraw();
          },
          replaceGroundTiles: (tiles) => {
            if (!tiles.length) return;
            changeTileList(tiles.slice(0, MAX_GROUND_TILES), (old) => Math.min(old, Math.min(tiles.length, MAX_GROUND_TILES) - 1));
          },
          mapTileset: async () => {
            let id: string | null = null;
            await editDoc("war3map.w3i", (d) => { id = typeof d.tileset === "string" ? d.tileset : null; return false; }).catch(() => {});
            return id;
          },
          setMapTileset: (id) => editDoc("war3map.w3i", (d) => { if (d.tileset === id) return false; d.tileset = id; }),
          ensureGroundTile: async (id) => ensureTile(id),
          groundTileUsage: () => {
            const n = terrain.groundTiles.map(() => 0);
            for (const c of terrain.corners) if (c.texture < n.length) n[c.texture]++;
            return n;
          },
          moveGroundTile: (from, to) => {
            const t = terrain.groundTiles;
            if (from === to || from < 0 || to < 0 || from >= t.length || to >= t.length) return;
            const order = t.map((_, i) => i);
            order.splice(to, 0, order.splice(from, 1)[0]);
            const inverse = new Map(order.map((old, nw) => [old, nw]));
            changeTileList(order.map((i) => t[i]), (old) => inverse.get(old) ?? old);
          },
          removeGroundTile: (index, replacement) => {
            const t = terrain.groundTiles;
            if (index === replacement || index < 0 || index >= t.length || replacement < 0 || replacement >= t.length) return;
            const tiles = t.filter((_, i) => i !== index);
            const shift = (i: number) => (i > index ? i - 1 : i);
            changeTileList(tiles, (old) => shift(old === index ? replacement : old));
          },
          groundTileUse: () => (cliffData ? tileUse(terrain, cliffData.types) : null),
          removeGroundTiles: (remove, replace) => removeTiles(remove, replace),
          removeUnusedGroundTiles: removeUnusedTiles,
          groundTileThumb: async (id) => {
            try {
              const path = (await tilePaths(w3)).get(id);
              return path ? await tileThumb(path) : null;
            } catch (e) {
              // Every tile of every palette asks: without the game's data they'd all fail, unseen. Said once, as an error.
              reportOnce(w3, "The ground tile pictures couldn't be read", e);
              return null;
            }
          },
          objects: {
            type: (id) => {
              const skin = objCtx?.skins.get(id) ?? objCtx?.skins.get(objCtx.bases.get(id) ?? "");
              return skin ? { kind: skin.kind, numVar: skin.numVar, randScale: skin.randScale, minScale: skin.minScale, maxScale: skin.maxScale, fixedRot: skin.fixedRot } : null;
            },
            create: (kind, id, at) => {
              const f = kind === "w3u" || kind === "w3t" ? unitsFile : dooFile;
              if (!f) return `This project has no ${kind === "w3u" || kind === "w3t" ? "war3mapUnits.doo" : "war3map.doo"}.`;
              const entry = newEntry(f, id, [at.x, at.y, heightAt(terrain, at.x, at.y)], at.player, kind);
              entry.angle = at.angle;
              repositioned.add(entry);
              entryFile.set(entry, f);
              return entry;
            },
            list: () => [...(unitsFile?.list ?? []), ...(dooFile?.list ?? [])],
            buildingSpot: async (id, x, y) => { await loadCells(id).catch(() => { /* stays free */ }); return onGrid(id, x, y); },
            backdrop: (kind, x, y) => isBackdrop(kind, x, y, playableEdge, wholeMap(handle)),
            inBounds: (x, y) => insideBounds(heldTo(), x, y),
            update: () => {
              objectsTouched = true;
              void rebuildObjects();
            },
            insert: (entries) => {
              for (const e of entries) { const f = entryFile.get(e as Placed); if (f && !f.list.includes(e as Placed)) f.list.push(e as Placed); }
              objectsTouched = true;
              void rebuildObjects();
            },
            remove: (entries) => {
              for (const e of entries) { const f = entryFile.get(e as Placed) ?? fileOf(e as Placed); const i = f?.list.indexOf(e as Placed) ?? -1; if (i >= 0) f!.list.splice(i, 1); }
              objectsTouched = true;
              void rebuildObjects();
            },
            setGhost: (g) => {
              ghostReq++;
              if (!g) { renderer.ghost = null; redraw(); return; }
              const skin = objCtx?.skins.get(g.id) ?? objCtx?.skins.get(objCtx.bases.get(g.id) ?? "");
              if (!skin) { renderer.ghost = null; redraw(); return; }
              const req = ghostReq;
              const entry = { id: g.id, variation: g.variation ?? 0, position: [g.x, g.y, heightAt(terrain, g.x, g.y)] as [number, number, number], angle: g.angle, scale: [1, 1, 1] as [number, number, number], player: g.player };
              void loader.modelFor(skin, entry.variation).then((gpu) => {
                if (req !== ghostReq) return;
                renderer.ghost = { gpu, world: placement(entry, skin.modelScale, drawnZ(entry, skin.moveType)), team: g.player !== undefined && g.player < TEAM_COLORS.length ? g.player : NEUTRAL, ok: g.ok };
                redraw();
              }).catch(() => { renderer.ghost = null; redraw(); });
            },
            blockers: () => (walkPromise ??= (async () => {
              pathingData ??= loadPathingData(w3, (p) => readFile(w3, doc, p), (id) => objCtx?.bases.get(id));
              const data = await pathingData;
              // Units walk off and items are walked over: of those, only buildings stay in the way.
              const buildings = (unitsFile?.list ?? []).filter((e) => data.unitShape(e.id)?.path).map((entry) => ({ entry, kind: "w3u" }));
              const placed = [...(dooFile?.list ?? []).map((entry) => ({ entry, kind: "w3d" })), ...buildings];
              return (await Occupancy.build(terrain, data, placed)).blocked;
            })()),
            standing: () => (standingPromise ??= (async () => {
              pathingData ??= loadPathingData(w3, (p) => readFile(w3, doc, p), (id) => objCtx?.bases.get(id));
              const data = await pathingData;
              const isDestructable = (id: string) => (objCtx?.skins.get(id) ?? objCtx?.skins.get(objCtx.bases.get(id) ?? ""))?.kind === "w3b";
              const placed = [
                ...(dooFile?.list ?? []).filter((e) => !isDestructable(e.id)).map((entry) => ({ entry, kind: "w3d" })),
                ...(unitsFile?.list ?? []).filter((e) => data.unitShape(e.id)?.path).map((entry) => ({ entry, kind: "w3u" })),
              ];
              return Occupancy.mask(terrain, data, placed);
            })()),
            baseOf: (id) => objCtx?.bases.get(id),
            modelShape: async (id) => {
              const skin = objCtx?.skins.get(id) ?? objCtx?.skins.get(objCtx.bases.get(id) ?? "");
              if (!skin) return null;
              const gpu = await loader.modelFor(skin, 0).catch(() => null);
              if (!gpu) return null;
              const { min, max } = bounds(gpu.model);
              const x = max[0] - min[0], y = max[1] - min[1];
              return { length: Math.max(x, y) * skin.modelScale, alongX: x >= y };
            },
            destructables: () => (destructablePromise ??= (async () => {
              pathingData ??= loadPathingData(w3, (p) => readFile(w3, doc, p), (id) => objCtx?.bases.get(id));
              const isDestructable = (id: string) => (objCtx?.skins.get(id) ?? objCtx?.skins.get(objCtx.bases.get(id) ?? ""))?.kind === "w3b";
              const placed = (dooFile?.list ?? []).filter((e) => isDestructable(e.id)).map((entry) => ({ entry, kind: "w3b" }));
              return Occupancy.mask(terrain, await pathingData, placed);
            })()),
            occupancy: async () => {
              const wrap = (occ: Occupancy): TerrainOccupancy => ({
                blocked: occ.blocked,
                scratch: () => wrap(occ.copy()),
                footprint: async (kind, id) => { const fp = await occ.footprint(id, kind); return fp && { width: fp.width, height: fp.height }; },
                fits: async (kind, id, x, y, angle) => {
                  // Units and items can't stand on painted Boundary. Doodads can, as past the map's edge.
                  if ((kind === "w3u" || kind === "w3t") && id !== "sloc" && onBoundary(terrain, x, y)) return false;
                  const fp = await occ.footprint(id, kind);
                  return !fp || occ.fits(fp, x, y, angle);
                },
                mark: async (kind, id, x, y, angle) => { const fp = await occ.footprint(id, kind); if (fp) occ.mark(fp, x, y, angle); },
              });
              return wrap(await occupancy());
            },
          },
          pushEdit: (e) => pushEdit(e),
          cliffGroundTiles: () => cliffList(terrain, cliffData?.types ?? new Map()).map((c) => c.groundTile),
          setBrush: (r) => { renderer.setBrush(r); redraw(); },
          setGroundOverlay: (rgba, w, hgt) => { renderer.setGroundOverlay(rgba, w, hgt); redraw(); },
          setLabels: (list) => {
            labels = (list ?? []).map(({ x, y, text, rgb }) => ({ x, y, el: h("span.terrain-label", { style: rgb ? { color: `rgb(${rgb.join(",")})` } : {} }, text) }));
            labelLayer.replaceChildren(...labels.map((l) => l.el));
            redraw();
          },
          pathing: async (opts) => {
            const doodads = dooFile?.list ?? [];
            const { wpm } = await buildPathingMap(w3, terrain, doodads, (p) => readFile(w3, doc, p), w3.settings.get<number>("terrain.pathing.deepWater"));
            if (opts?.filtered !== false) filterPathing(wpm);
            const v = new DataView(wpm.buffer, wpm.byteOffset);
            return { cells: wpm.slice(16), width: v.getUint32(8, true), height: v.getUint32(12, true) };
          },
          focus: () => keysToMap(),
          lookAt: (x, y) => { renderer.target = [x, y, heightAt(terrain, x, y)]; redraw(); },
          view: () => ({ target: [...renderer.target], yaw: renderer.yaw, pitch: renderer.pitch, distance: renderer.distance, fov: renderer.fov }),
          setView: (v) => {
            if (v.target) renderer.target = [...v.target];
            Object.assign(renderer, Object.fromEntries((["yaw", "pitch", "distance", "fov"] as const).filter((k) => v[k] !== undefined).map((k) => [k, v[k]])));
            redraw();
          },
          frameCost: () => {
            const c = renderer.frameCost, out = { ...c };
            c.frames = c.frameMs = c.poseMs = c.particleMs = 0;
            return out;
          },
          sunShadows: () => ({ ...renderer.sunShadowState }),
        };
        const viewKey = `${w3.workspace.project()?.root}|${doc.path}`;
        const carried = lastView?.key === viewKey ? lastView : null;
        /** Set once the editor is closed: a load that ends afterwards selects nothing. */
        let disposed = false;
        if (carried) handle.setView(carried.view);
        // The objects selected when it last closed, once they are loaded, unless something was selected meanwhile.
        if (carried?.selection.length) {
          void firstLoad.then(() => {
            if (disposed || selected || group.length) return;
            if (reselect(carried.selection)) redraw();
          }, () => {});
        }
        const tabsEl = h("div.terrain-tabs");
        const dragHint = h("span", {}, "Drag: select box · Hold A and drag: select an area");
        const builtinBar = selectBar();
        const groupBar = h("div.model-toolbar.terrain-tools", {}, builtinBar);
        /** The active tab: null = the built-in tools. */
        let activeGroup: string | null = null;
        /** A drag taken by the active group's pointerDown. */
        let groupDrag = false;
        const activeInst = () => (activeGroup ? groupInsts.get(activeGroup) ?? null : null);
        const showTab = (id: string | null) => {
          if (id === activeGroup) return;
          setArea(null);
          activeInst()?.deactivate?.();
          activeGroup = id;
          const inst = activeInst();
          groupBar.replaceChildren(inst ? inst.toolbar : builtinBar);
          renderer.setBrush(null);
          inst?.activate?.();
          renderTabs();
          layersAfterTab();
          redraw();
        };
        const renderTabs = () => {
          const tab = (id: string | null, title: string) =>
            h(`button.terrain-tab${id === activeGroup ? ".on" : ""}`, { onclick: () => showTab(id) }, title);
          tabsEl.replaceChildren(tab(null, "Select"), ...toolGroups.all().filter((g) => groupInsts.has(g.id)).map((g) => tab(g.id, g.title)),
            h("span.terrain-tabs-gap"),
            h("button", { title: "Undo (Ctrl+Z)", onclick: undo }, "↶"),
            h("button", { title: "Redo (Ctrl+Y)", onclick: redo }, "↷"));
        };
        const syncGroups = () => {
          const wanted = new Set(toolGroups.all().map((g) => g.id));
          for (const [id, inst] of groupInsts) {
            if (wanted.has(id)) continue;
            if (activeGroup === id) showTab(null);
            inst.dispose?.();
            groupInsts.delete(id);
          }
          for (const g of toolGroups.all()) {
            if (groupInsts.has(g.id)) continue;
            try { groupInsts.set(g.id, g.create(handle)); } catch (e) { w3.window.showError(`${g.title}: ${(e as Error).message ?? e}`); }
          }
          renderTabs();
        };
        const stopGroups = toolGroups.onChange(syncGroups);
        // A point pick for another module (trigger parameters): banner, click on the ground, Esc cancels.
        const pickBanner = h("div.terrain-pick-banner", { hidden: true });
        el.append(pickBanner);
        const syncPick = () => {
          const p = toolGroups.picking;
          pickBanner.hidden = !p;
          if (p) pickBanner.replaceChildren(h("span", {}, p.prompt), h("span.muted", {}, " · Esc to cancel"),
            h("button", { onclick: () => toolGroups.picking?.finish(undefined) }, "Cancel"));
        };
        syncPick();
        const stopPick = toolGroups.onChange(syncPick);
        const live = () => ({ units: unitsFile?.list ?? [], doodads: dooFile?.list ?? [] });
        /** While picking objects: the accepted placement nearest to a ground point, if close enough. */
        const pickTarget = (g: [number, number, number] | null): Placed | null => {
          const o = toolGroups.picking?.objects;
          if (!o || !g) return null;
          const list = (o.file === "units" ? unitsFile?.list : dooFile?.list) ?? [];
          let best: Placed | null = null, bestD = o.radius ?? 128;
          for (const e of list) {
            const d = Math.hypot(e.position[0] - g[0], e.position[1] - g[1]);
            if (d <= bestD && o.accept(e)) { best = e; bestD = d; }
          }
          return best;
        };
        let pickRing = false;
        const showPickTarget = (t: Placed | null) => {
          if (!t && !pickRing) return;
          pickRing = !!t;
          renderer.setBrush(t ? { x: t.position[0], y: t.position[1], r: 64, rgb: [1, 0.85, 0.2] } : null);
          redraw();
        };
        // However the pick ends (click, Esc, Cancel, another pick), the ring goes.
        const stopPickRing = toolGroups.onChange(() => { if (!toolGroups.picking) showPickTarget(null); });
        toolGroups.livePlacements = live;
        const look = (x: number, y: number, ref?: PlacedRef) => {
          renderer.target = [x, y, heightAt(terrain, x, y)];
          // Normal selection (side panel, keys); no undo step, nothing dirty. Models may still be
          // loading: then it waits for the end of rebuildObjects.
          if (ref) { pendingSel = null; if (!trySelect(ref)) pendingSel = ref; }
          redraw();
        };
        function trySelect(ref: PlacedRef): boolean {
          const insts = allInstances().map((s) => s.inst).filter((i) => i.pick?.placed);
          const at = matchPlaced(insts.map((i) => i.pick!.placed as unknown as PlacedLike), ref);
          if (at < 0) return false;
          endFacing(false);
          group = [];
          selectObject(insts[at]);
          return true;
        }
        toolGroups.look.set(doc.path, look);
        const resetGround = () => {
          if (!editable) throw new Error("This terrain is read-only.");
          if (glDead) throw new Error(VIEW_LOST);
          const log = new CornerUndo();
          if (!resetVariations(terrain, log)) return false;
          commitTerrain(log.step(terrain));
          return true;
        };
        toolGroups.resetVariations.set(doc.path, resetGround);
        // ---- Replace Cliff Type, Tiles, Doodads, Units (commands; the dialog is in replace.ts) -------------------
        const replaceTypes: ReplaceTypes = {
          choices: async (kind) => {
            const names = await readTileNames();
            const tileLabel = (id: string) => `${names.get(id) ?? id} (${id})`;
            if (kind === "tiles") {
              const use = handle.groundTileUsage();
              const own = (await handle.tilesets().catch(() => [])).find((s) => s.id === terrain.tileset)?.tiles ?? [];
              const from = terrain.groundTiles.map((id, i) => ({ id, label: tileLabel(id), count: use[i] ?? 0 }));
              return { from, to: [...from, ...own.filter((id) => !terrain.groundTiles.includes(id)).map((id) => ({ id, label: tileLabel(id), count: 0 }))], selected: 0 };
            }
            if (kind === "cliffs") {
              const use = handle.groundTileUse();
              const from = handle.cliffGroundTiles().map((g) => ({ id: g, label: `${tileLabel(g)} cliff`, count: use?.cliffs[terrain.groundTiles.indexOf(g)] ?? 0 }));
              return { from, to: from, selected: 0 };
            }
            const { list, fits } = replacePool(kind);
            const counts = new Map<string, number>();
            for (const p of list) if (fits(p)) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
            const objects = await w3.services.get<ObjectsService>(OBJECTS_SERVICE).catch(() => null);
            const from = await Promise.all([...counts].map(async ([id, count]) => ({ id, label: `${(await objects?.name(id).catch(() => undefined)) ?? id} (${id})`, count })));
            from.sort((a, b) => a.label.localeCompare(b.label));
            return { from, to: from, selected: selectedEntries().filter((p) => list.includes(p) && fits(p)).length };
          },
          pickType: async (kind, from) => {
            const objects = await w3.services.get<ObjectsService>(OBJECTS_SERVICE);
            const fromKind = handle.objects.type(from)?.kind ?? (kind === "doodads" ? "w3d" : "w3u");
            const chosen = await objects.pick(el, { title: `Replace ${from} with…`, kinds: kind === "units" ? ["w3u"] : replaceableKinds([fromKind]) });
            keysToMap();
            return chosen ? { id: chosen.id, label: `${chosen.name} (${chosen.id})` } : null;
          },
          run: async (kind, req) => {
            if (!editable) throw new Error("This terrain is read-only.");
            if (glDead) throw new Error(VIEW_LOST);
            if (kind === "tiles" || kind === "cliffs") {
              let from: number, to: number;
              if (kind === "tiles") {
                from = terrain.groundTiles.indexOf(req.from);
                if (from < 0) throw new Error(`${req.from} isn't one of this map's ground tiles: ${terrain.groundTiles.join(", ")}.`);
                const slot = await handle.ensureGroundTile(req.to);
                if (slot === null) throw new Error("This map has 16 ground tiles, the most it can have: remove one first.");
                to = slot;
              } else {
                const grounds = handle.cliffGroundTiles();
                if (!grounds.length) throw new Error("The game's cliff types aren't read yet. Try again in a moment.");
                from = grounds.indexOf(req.from);
                to = grounds.indexOf(req.to);
                if (from < 0 || to < 0) throw new Error(`The map's cliff types are those of ${grounds.join(", ")}.`);
              }
              if (glDead) throw new Error(VIEW_LOST);
              const log = new CornerUndo();
              const changed = replaceCorners(terrain, kind === "tiles" ? "texture" : "cliffTexture", from, to, !!req.swap, log);
              if (!changed.length) return 0;
              commitTerrain({ ...log.step(terrain), cliffs: true });
              return changed.length;
            }
            const { list, fits } = replacePool(kind);
            const type = handle.objects.type(req.to), was = handle.objects.type(req.from);
            if (!type) throw new Error(`"${req.to}" isn't an object type here.`);
            if (!fits({ id: req.to } as Placed) || (was && !replaceableBy(was.kind, type.kind))) throw new Error(`${req.from} can't become ${req.to}: ${kind === "units" ? "units stay units" : "doodads and destructables stay among them"}.`);
            const pool = req.selectedOnly ? selectedEntries().filter((p) => list.includes(p)) : list;
            return replaceEntries(pool.filter(fits), swapsOf(req), kind === "doodads" && !!req.resetVariations);
          },
        };
        /** The placed objects a Replace command works on, and which of them it may change (units: not start locations or items). */
        const replacePool = (kind: "doodads" | "units") => kind === "doodads"
          ? { list: dooFile?.list ?? [], fits: (_p: Placed) => true }
          : { list: unitsFile?.list ?? [], fits: (p: Placed) => p.id !== "sloc" && (handle.objects.type(p.id)?.kind ?? "w3u") === "w3u" };
        toolGroups.replaceTypes.set(doc.path, replaceTypes);
        if (toolGroups.pendingLook) { const [px, py, pref] = toolGroups.pendingLook; toolGroups.pendingLook = null; requestAnimationFrame(() => look(px, py, pref)); }
        if (editable) queueMicrotask(syncGroups);

        // ---- View commands: View Selection, View Entire Map, Select In Tool Palette, grids and layers -----------
        /** The View items as chosen (the toolbar, the side panel's Doodads and Units, the commands and keys). Lighting,
         *  fog and weather are settings. Game view sets the choice aside without changing it: `shown` is what's drawn. */
        const viewState = {
          grid: "none" as GridSize, naval: false, heights: false, cameras: false, pathing: false, regions: false, lightRanges: false,
          terrain: "textured" as TerrainLook, doodads: true, units: true, water: true, blight: true, cliffs: true, effects: true,
        };
        const viewSet = (): ViewSet => ({ ...viewState, lighting: lightOn(),
          fog: w3.settings.get<boolean>("terrain.fog", true) !== false, weather: w3.settings.get<boolean>("terrain.weather", true) !== false });
        let shown = shownView(viewSet(), gameViewOn());
        /** Redraws the toolbar's boxes after a command changed what they show. */
        const viewSyncs: (() => void)[] = [];
        const GAME_VIEW_NOTE = "Game view is on (V): the view shows the map as the game does. Turn it off to change what the view shows.";
        viewSyncs.push(() => markerBoxes.forEach((box, name) => { box.checked = viewState[name]; box.disabled = gameViewOn(); }));
        const maxDistance = () => terrain.width * 300;
        const cornerHeights = (x0: number, y0: number, x1: number, y1: number) => {
          const zs: number[] = [];
          for (let y = Math.max(0, y0); y <= Math.min(terrain.height - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(terrain.width - 1, x1); x++) zs.push(terrain.corners[y * terrain.width + x].height);
          return zs.length ? [Math.min(...zs), Math.max(...zs)] : [0, 0];
        };
        const frameBox = (box: Box, opts: { margin?: number; minDistance?: number }) => {
          const v = viewOfBox(box, renderer, canvas.clientWidth / Math.max(1, canvas.clientHeight), { ...opts, maxDistance: maxDistance() });
          renderer.target = v.target;
          renderer.distance = v.distance;
          redraw();
        };
        const viewEntireMap = () => {
          const [lo, hi] = cornerHeights(0, 0, terrain.width, terrain.height);
          frameBox({ minX: terrain.offsetX, maxX: terrain.offsetX + (terrain.width - 1) * 128, minY: terrain.offsetY, maxY: terrain.offsetY + (terrain.height - 1) * 128, minZ: lo, maxZ: hi }, { margin: 1.05, minDistance: 200 });
        };
        /** The camera moves to what's selected: the selected objects, else the area drawn on the ground. */
        const viewSelection = (): string | null => {
          const entries = selectedEntries();
          if (entries.length) {
            const box = boxOf(entries.map((e) => e.position), 96);
            if (box) { frameBox(box, { margin: 1.3, minDistance: 700 }); return null; }
          }
          if (terrainArea) {
            const a = terrainArea, [lo, hi] = cornerHeights(a.x0, a.y0, a.x1, a.y1);
            frameBox({ minX: terrain.offsetX + a.x0 * 128, maxX: terrain.offsetX + a.x1 * 128, minY: terrain.offsetY + a.y0 * 128, maxY: terrain.offsetY + a.y1 * 128, minZ: lo, maxZ: hi }, { margin: 1.15, minDistance: 500 });
            return null;
          }
          return "Nothing is selected: click an object, or select an area, first.";
        };
        /** The object's kind by the file it's placed in: units and items, or doodads and destructables. Models don't come into it. */
        const kindOfPlaced = (p: Placed) => {
          const skin = (id: string) => objCtx?.skins.get(id) ?? objCtx?.skins.get(objCtx.bases.get(id) ?? "");
          if (unitsFile?.list.includes(p)) return skin(p.id)?.kind === "w3t" ? "w3t" : "w3u";
          if (dooFile?.list.includes(p)) return skin(p.id)?.kind === "w3b" ? "w3b" : "w3d";
          return undefined;
        };
        /** The selected object's type becomes what the Objects tab places, and that tab opens. */
        const selectInPalette = async (): Promise<string | null> => {
          const first = selectedEntries()[0];
          if (!first) return "Nothing is selected: click an object first.";
          if (!editable) return "This terrain is read-only: it has no tool palette.";
          const kind = kindOfPlaced(first);
          const palette = groupInsts.get("objects");
          if (!kind || !palette?.select) return "The Objects palette isn't available.";
          const ok = await palette.select({ kind, id: first.id, player: (first as { player?: number }).player });
          if (!ok) return "The Objects palette can't take this object.";
          showTab("objects");
          return null;
        };
        // The layers share one picture over the ground; it is made again after edits and saves, once they stop.
        let layerSeq = 0, layerTimer: ReturnType<typeof setTimeout> | undefined;
        /** Shown while a layer is being worked out (the pathing of a big map takes seconds). */
        const layerBusy = h("span.muted", { hidden: true }, "Working…");
        const refreshLayers = async () => {
          const seq = ++layerSeq;
          const latest = () => seq === layerSeq;
          // A layer that throws at once (not by rejecting) still ends with the label hidden and its error shown.
          const failed = await runLayerJobs(() => {
            const on = groundLayersOn();
            if (!anyGroundLayer(on)) { renderer.setViewLayer(null); redraw(); return []; }
            const W = (terrain.width - 1) * 4, H = (terrain.height - 1) * 4;
            // Heights are quick; the pathing of a big map and the files take a while, and are added when they arrive.
            // Bottom to top: regions, ground pathing, heights, naval pathing, cameras.
            const parts: (Uint8Array | null)[] = [null, null, on.heights ? heightColors(terrain).rgba : null, null, null];
            const show = () => {
              if (!latest()) return;
              const rgba = composeLayers(parts);
              if (rgba) renderer.setViewLayer(rgba, W, H); else renderer.setViewLayer(null);
              redraw();
            };
            show();
            const late: Promise<void>[] = [];
            if (on.regions) late.push(regionsNow().then((list) => { parts[0] = regionColors(list, W, H, terrain.offsetX, terrain.offsetY); show(); }));
            if (on.naval || on.pathing) {
              late.push(handle.pathing().then((p) => {
                const fits = p.width === W && p.height === H;
                parts[1] = fits && on.pathing ? groundPathingColors(p.cells) : null;
                parts[3] = fits && on.naval ? navalColors(p.cells) : null;
                show();
              }));
            }
            if (on.cameras) late.push(camerasNow().then((cams) => { parts[4] = cameraColors(cams, W, H, terrain.offsetX, terrain.offsetY); show(); }));
            return late;
          }, latest, (busy) => { layerBusy.hidden = !busy; });
          if (failed && latest()) w3.window.showError(`The view layers couldn't be drawn: ${(failed.error as Error)?.message ?? failed.error}`);
        };
        /** The cameras of the Camera Objects layer: the Camera Editor's, unsaved edits included, else the saved file. */
        const camerasNow = () => layerCameras(groupInsts.values(),
          async () => (await readMapDoc<{ cameras?: CameraObject[] }>(w3, "map/war3map.w3c.json"))?.cameras ?? []);
        /** The regions of the Regions layer: the Region Editor's, unsaved edits included, else the saved file. */
        const regionsNow = () => layerRegions(groupInsts.values(),
          async () => (await readMapDoc<{ regions?: RegionBox[] }>(w3, "map/war3map.w3r.json"))?.regions ?? []);
        /** The ground layers drawn: those shown, except the one the active tab draws itself (the Regions and Pathing
         *  tabs lay their own picture over the ground, which would show twice). */
        const groundLayersOn = () => ({
          naval: shown.naval, heights: shown.heights, cameras: shown.cameras,
          pathing: shown.pathing && activeGroup !== "pathing", regions: shown.regions && activeGroup !== "regions",
        });
        layersAfterTab = () => { if (shown.pathing || shown.regions) void refreshLayers(); };
        const refreshLayersSoon = () => {
          if (shown.lightRanges) showLightRanges();
          if (!anyGroundLayer(shown)) return;
          clearTimeout(layerTimer);
          layerTimer = setTimeout(() => void refreshLayers(), 400);
        };
        const applyGrid = () => {
          // The tile grid is the ground's own mesh, so it follows cliffs and ramps; the others are lines per pixel.
          renderer.wireframe = shown.grid === "medium";
          renderer.gridStep = shown.grid === "small" || shown.grid === "large" ? GRID_STEP[shown.grid] : 0;
          redraw();
        };
        /** Light Ranges: a ring round every light of the placed objects shown, as far as it reaches. Made again when
         *  the objects or their places change (lightsKey). */
        let lightsKey = "";
        const showLightRanges = () => {
          const rings: { x: number; y: number; r: number; rgb: [number, number, number] }[] = [];
          if (shown.lightRanges) {
            for (const b of renderer.batches) {
              const lights = b.gpu.model.lights;
              if (!lights?.length || (b.group !== "doodads" && b.group !== "units") || !renderer.batchShown(b)) continue;
              const pivots = b.gpu.model.pivots;
              for (const inst of b.instances) {
                for (const l of lights) {
                  const id = l.node.objectId;
                  rings.push(...lightRings(inst.world, [pivots[id * 3] ?? 0, pivots[id * 3 + 1] ?? 0, pivots[id * 3 + 2] ?? 0], l));
                }
              }
            }
          }
          const key = rings.map((r) => `${r.x.toFixed(1)},${r.y.toFixed(1)},${r.r.toFixed(1)}`).join(";");
          if (key === lightsKey) return;
          lightsKey = key;
          renderer.setRings("lights", rings);
          redraw();
        };
        /** Draws what `shown` says, after the choice or game view changed. */
        const applyView = () => {
          const was = shown;
          shown = shownView(viewSet(), gameViewOn());
          const hide = (g: string, hidden: boolean) => { if (hidden) renderer.hiddenGroups.add(g); else renderer.hiddenGroups.delete(g); };
          hide("doodads", !shown.doodads);
          hide("units", !shown.units);
          hide("cliffs", !shown.cliffs);
          // The shoreline foam goes with the water.
          hide("shoreline", !shown.water);
          renderer.showWater = shown.water;
          renderer.showEffects = shown.effects;
          renderer.showFog = shown.fog;
          renderer.showWeather = shown.weather;
          renderer.groundLook = shown.terrain;
          renderer.showEditorOnly = shown.starts;
          if (renderer.showBlight !== shown.blight) { renderer.showBlight = shown.blight; renderer.terrainChanged(); }
          gameBadge.hidden = !gameViewOn();
          applyLight();
          applyGrid();
          if (anyGroundLayer(was) || anyGroundLayer(shown)) void refreshLayers();
          showLightRanges();
          // A selected start location can't stay selected where it isn't shown.
          if (!shown.starts && selectedEntries().some((p) => p.id === "sloc")) clearSelection();
          viewSyncs.forEach((f) => f());
          redraw();
        };
        viewChanged = applyView;
        const refusedInGameView = () => (gameViewOn() ? GAME_VIEW_NOTE : null);
        const setGrid = (g: GridSize) => { viewState.grid = g; applyView(); };
        const toggleLayer = (layer: ToggleLayer | "water"): boolean | string => {
          const no = refusedInGameView();
          if (no) return no;
          viewState[layer] = !viewState[layer];
          applyView();
          return viewState[layer];
        };
        const toggleGameView = async () => {
          const on = !gameViewOn();
          await w3.settings.set("terrain.gameView", on);
          // The settings' listener draws it; once more in case the value was already there (another editor set it).
          // Closed meanwhile, there's nothing to draw.
          if (!disposed) applyView();
          return on;
        };
        const viewCommands: ViewCommands = {
          viewSelection, viewEntireMap, selectInPalette, toggleLayer, cycleRandomGroups, toggleGameView,
          toggleSetting: async (which) => {
            const no = refusedInGameView();
            if (no) return no;
            const key = which === "lighting" ? "terrain.lighting.enabled" : "terrain.weather";
            const on = w3.settings.get<boolean>(key, true) === false;
            await w3.settings.set(key, on);
            return on;
          },
          cycleTerrain: () => refusedInGameView() ?? (setTerrain(nextTerrainLook(viewState.terrain)), viewState.terrain),
          toggleGrid: (size) => refusedInGameView() ?? (setGrid(toggleGrid(viewState.grid, size)), viewState.grid),
          state: () => ({ ...viewState, gameView: gameViewOn(), shown: { ...shown }, camera: { target: [...renderer.target] as [number, number, number], distance: renderer.distance, yaw: renderer.yaw }, sunShadows: { ...renderer.sunShadowState } }),
        };
        const setTerrain = (t: TerrainLook) => { viewState.terrain = t; applyView(); };
        toolGroups.viewCommands.set(doc.path, viewCommands);
        /** "Label (key)" for a toolbar box's tooltip. */
        const withKey = (title: string, command: string) => (keyOf(command) ? `${title} (${keyOf(command)})` : title);
        /** A toolbar box for a View item: game view greys it out (the World Editor's View menu does so too). */
        const layerToggle = (label: string, title: string, layer: ToggleLayer | "water", command?: string) => {
          const box = h("input", { type: "checkbox", checked: viewState[layer], onchange: () => { if (viewState[layer] !== box.checked) toggleLayer(layer); keysToMap(); } });
          viewSyncs.push(() => { box.checked = viewState[layer]; box.disabled = gameViewOn(); });
          return h("label.model-toggle", { title: command ? withKey(title, command) : title }, box, ` ${label}`);
        };
        /** A box for one of the Advanced switches; the command and the box are the same setting. */
        const switchBox = (label: string, title: string, key: string, standard: boolean) => {
          const box = h("input", { type: "checkbox", checked: switchedOn(w3, key, standard), onchange: () => { void setSwitch(w3, key, box.checked); keysToMap(); } });
          viewSyncs.push(() => { box.checked = switchedOn(w3, key, standard); });
          return h("label.model-toggle", { title }, box, ` ${label}`);
        };
        const gridSelect = h("select", { title: "Grid: lines every 32 (small, the pathing cells), 128 (medium, the tiles) or 512 (large) units", onchange: () => { setGrid(gridSelect.value as GridSize); keysToMap(); } },
          ...(["none", "small", "medium", "large"] as const).map((g) => h("option", { value: g }, g === "none" ? "No grid" : `${g[0].toUpperCase()}${g.slice(1)} grid`)));
        viewSyncs.push(() => { gridSelect.value = viewState.grid; gridSelect.disabled = gameViewOn(); });
        const terrainSelect = h("select", { title: withKey("Terrain: textured, as a wireframe, or hidden", "w3.terrain.cycleTerrainDisplay"), onchange: () => { if (!gameViewOn()) setTerrain(terrainSelect.value as TerrainLook); keysToMap(); } },
          ...TERRAIN_LOOKS.map((t) => h("option", { value: t }, t === "textured" ? "Terrain" : t === "wireframe" ? "Wireframe" : "No terrain")));
        viewSyncs.push(() => { terrainSelect.value = viewState.terrain; terrainSelect.disabled = gameViewOn(); });
        const gameViewBox = h("input", { type: "checkbox", checked: gameViewOn(), onchange: () => { if (gameViewBox.checked !== gameViewOn()) void toggleGameView(); keysToMap(); } });
        viewSyncs.push(() => { gameViewBox.checked = gameViewOn(); });

        /** A box for a setting of the view's; game view greys it out when `forced`. */
        const toggle = (label: string, get: () => boolean, set: (v: boolean) => void, forced = false, title?: string) => {
          const box = h("input", { type: "checkbox", checked: get(), onchange: () => { set(box.checked); redraw(); keysToMap(); } });
          viewSyncs.push(() => { box.checked = get(); if (forced) box.disabled = gameViewOn(); });
          return h("label.model-toggle", title ? { title } : {}, box, ` ${label}`);
        };
        el.append(h("div.model-viewer", {},
          h("div.model-main", {},
            h("div.model-toolbar", {},
              h("label.model-toggle", { title: withKey("Game view: the map lit and fogged as the game shows it, without regions, cameras, start locations, pathing or grids", "w3.terrain.toggleGameView") }, gameViewBox, " Game view"),
              terrainSelect,
              layerToggle("Doodads", "Doodads and destructables", "doodads", "w3.terrain.toggleDoodads"),
              layerToggle("Units", "Units, items and start locations", "units", "w3.terrain.toggleUnits"),
              layerToggle("Water", "Water and the shoreline's waves", "water", "w3.terrain.toggleWater"),
              layerToggle("Blight", "Blighted ground (off: the ground's own tiles)", "blight", "w3.terrain.toggleBlight"),
              toggle("Effects", () => viewState.effects, (v) => { viewState.effects = v; applyView(); }, true),
              toggle("Animate", () => w3.settings.get<boolean>("terrain.animate", true) !== false, (v) => void w3.settings.set("terrain.animate", v)),
              h("label.model-toggle", { title: withKey("The map's day and night lighting; off: an even light", "w3.terrain.toggleLighting") }, lightBox, " Lighting"), lightSelect,
              gridSelect,
              layerToggle("Height map", "Colours the ground by height, with a line at every 32 units", "heights"),
              layerToggle("Ground pathing", "Pathing - Ground: magenta where nothing walks, blue where nothing can be built", "pathing", "w3.terrain.toggleGroundPathing"),
              layerToggle("Naval pathing", "Where ships can sail: deep water strong blue, shallow water light", "naval", "w3.terrain.toggleNavalPathing"),
              layerToggle("Regions", "The map's regions, in their colours", "regions", "w3.terrain.toggleRegions"),
              layerToggle("Camera objects", "The map's cameras: target, eye and field of view", "cameras", "w3.terrain.toggleCameraObjects"),
              layerToggle("Light ranges", "How far the lights of placed objects reach: a ring where each fades out, a fainter one where it starts to", "lightRanges", "w3.terrain.toggleLightRanges"),
              layerBusy,
              toggle("Boundary", showBoundary, (v) => void w3.settings.set("terrain.boundary", v)),
              ...(editable ? [
                switchBox("Keep pasted height", "Preserve Copied Object Height: pasted doodads with a fixed height keep their height over the ground; with it off they all sit on the ground", "terrain.preserveCopiedHeight", true),
                switchBox("Water limits", "Enforce Water Height Limits: an edit that would push water past the game's lowest or highest water height is refused, not cut off", "terrain.enforceWaterLimits", false),
                switchBox("Camera bounds", "Enforce Camera Bounds: objects can't be placed, pasted or moved outside the map's camera bounds", "terrain.enforceCameraBounds", false),
              ] : []),
              toggle("Fog", () => w3.settings.get<boolean>("terrain.fog", true) !== false, (v) => { void w3.settings.set("terrain.fog", v); }, true),
              toggle("Weather", () => w3.settings.get<boolean>("terrain.weather", true) !== false, (v) => { void w3.settings.set("terrain.weather", v); }, true, withKey("The map's weather", "w3.terrain.toggleWeather")),
              switchBox("Shadows", "View > Shadows: the map's shadow map (war3map.shd, with unsaved edits predicted), buildings' and trees' shadows, units' shadows", "terrain.shadows.visible", true),
              skySelect,
              toggle("Cliffs", () => viewState.cliffs, (v) => { viewState.cliffs = v; applyView(); }, true),
              h("button", { title: "Reset camera", onclick: () => { resetCamera(); keysToMap(); } }, "⟲"),
              h("button", { title: "View Entire Map", onclick: () => { viewEntireMap(); keysToMap(); } }, "⛶"),
              h("button", { title: "View Selection", onclick: () => { const why = viewSelection(); if (why) void w3.window.showInfo(why); keysToMap(); } }, "◎"),
              h("span.muted", {}, dragHint, " · Middle-drag or arrow keys (Shift: faster): pan · Right-drag or Ctrl+Left/Right: rotate · Wheel or Ctrl+Up/Down: zoom")),
            ...(editable ? [tabsEl, groupBar] : []),
            h("div.model-stage", {}, canvas, labelLayer, gameBadge, glLost)),
          side));
        // The View keys with Ctrl stay with the map while it has the keyboard (Ctrl+R: Regions, not Reload Window).
        canvas.dataset.ownKeys = OWN_CHORDS.join(" ");
        applyView();

        // ---- camera ------------------------------------------------------------------
        const initial = { yaw: renderer.yaw, pitch: renderer.pitch, distance: renderer.distance, fov: renderer.fov };
        const resetCamera = () => { Object.assign(renderer, initial, { target: [...renderer.center] }); redraw(); };
        /** Moves the target over the ground by screen pixels, in the camera's facing. */
        const pan = (dx: number, dy: number) => {
          const s = renderer.distance / Math.max(1, canvas.clientHeight) * 0.9;
          const cy = Math.cos(renderer.yaw), sy = Math.sin(renderer.yaw);
          // The ground follows the pointer: right = (-sin, cos), forward = (-cos, -sin).
          renderer.target[0] += (sy * dx - cy * dy) * s;
          renderer.target[1] += (-cy * dx - sy * dy) * s;
          redraw();
        };
        let drag: { x: number; y: number; button: number } | null = null;
        /** Selected objects being dragged: offsets follow the pointer from `anchor`. */
        let objDrag: { entries: Placed[]; before: Pose[]; anchor: Vec3; moved: boolean } | null = null;
        const dragObjects = (p: Vec3) => {
          if (!objDrag) return;
          // The group keeps its shape and stops at the map's edge (the playable part, for units), and at the camera bounds when enforced, together.
          const [dx, dy] = clampShift(objDrag.before.map((b) => [b.position[0], b.position[1]] as const),
            objDrag.entries.map(moveBounds), p[0] - objDrag.anchor[0], p[1] - objDrag.anchor[1]);
          objDrag.entries.forEach((entry, i) => {
            const [x, y] = objDrag!.before[i].position;
            setPlacement(entry, [x + dx, y + dy, ownHeight(entry) ?? heightAt(terrain, x + dx, y + dy)], entry.angle);
          });
          refreshGroupRings();
        };
        /** A selection box being dragged (canvas CSS pixels). */
        let box: { x0: number; y0: number; x1: number; y1: number; add: boolean; shown: boolean } | null = null;
        const boxEl = h("div.terrain-select-box", { hidden: true });
        el.append(boxEl);
        const showBox = () => {
          if (!box) { boxEl.hidden = true; return; }
          const rect = canvas.getBoundingClientRect();
          Object.assign(boxEl.style, {
            left: `${rect.left + Math.min(box.x0, box.x1)}px`, top: `${rect.top + Math.min(box.y0, box.y1)}px`,
            width: `${Math.abs(box.x1 - box.x0)}px`, height: `${Math.abs(box.y1 - box.y0)}px`,
          });
          boxEl.hidden = !box.shown;
        };
        canvas.tabIndex = 0;
        canvas.addEventListener("contextmenu", (e) => e.preventDefault());
        /** Where the left button went down; a release close by is a click (select). */
        let press: { x: number; y: number } | null = null;
        canvas.addEventListener("mousedown", (e) => {
          keysToMap();
          if (toolGroups.picking && e.button === 0) {
            e.preventDefault();
            const g = groundAt(e);
            const target = pickTarget(g);
            showPickTarget(null);
            if (g) toolGroups.picking.finish({ x: g[0], y: g[1], ...(target ? { object: target } : {}) });
            return;
          }
          if (pasting && e.button === 0) {
            e.preventDefault();
            const g = groundAt(e);
            if (g) void placePaste(g);
            return;
          }
          const gi = activeInst();
          if (gi && e.button === 0 && gi.pointerDown?.({ ground: groundAt(e), event: e, down: false })) {
            e.preventDefault();
            groupDrag = true;
            return;
          }
          if (facing) {
            e.preventDefault();
            endFacing(e.button === 0);
            return;
          }
          const ctrl = e.ctrlKey || e.metaKey;
          if (e.button === 0 && !activeGroup && !e.altKey && !ctrl && !e.shiftKey && (areaKey || areaMode)) {
            const g = groundAt(e);
            if (g) {
              e.preventDefault();
              areaPress = { from: tileOf(terrain, g[0], g[1]), x: e.clientX, y: e.clientY, moved: false };
              return;
            }
          }
          if (e.button === 0) setArea(null);
          if (e.button === 0 && editable && !activeGroup && selectedEntries().length && (ctrl || e.altKey)) {
            const g = groundAt(e);
            if (g) {
              e.preventDefault();
              if (e.altKey) startMoveTo(g);
              else { startFacing(); faceHeld = true; faceToward(g); }
              refreshGroupRings();
              return;
            }
          }
          if (e.button === 0) {
            const rect = canvas.getBoundingClientRect();
            const inst = editable && !e.ctrlKey && !e.shiftKey ? renderer.pickObject(renderer.ray(e.clientX - rect.left, e.clientY - rect.top), pickRadius, strays) : null;
            // Dragging a selected object moves the whole selection.
            const entries = selectedEntries();
            const anchor = inst?.pick && entries.includes(inst.pick.placed) ? groundAt(e) : null;
            if (anchor) {
              objDrag = { entries, before: entries.map(poseOf), anchor, moved: false };
              return;
            }
            // Otherwise a click selects, a drag draws a selection box (pan: middle button or arrow keys).
            const x = e.clientX - rect.left, y = e.clientY - rect.top;
            box = { x0: x, y0: y, x1: x, y1: y, add: e.shiftKey, shown: false };
            press = { x: e.clientX, y: e.clientY };
            return;
          }
          if (e.button === 1) e.preventDefault();
          drag = { x: e.clientX, y: e.clientY, button: e.button };
          press = null;
        });
        canvas.addEventListener("mousemove", (e) => {
          if (toolGroups.picking?.objects) { showPickTarget(pickTarget(groundAt(e))); return; }
          if (pasting) { const g = groundAt(e); if (g) showPaste(g); }
          if (areaPress) {
            if (Math.hypot(e.clientX - areaPress.x, e.clientY - areaPress.y) >= 4) areaPress.moved = true;
            const g = areaPress.moved ? groundAt(e) : null;
            if (g) setArea({ ...areaBetween(areaPress.from, tileOf(terrain, g[0], g[1])), objects: withObjects });
            return;
          }
          activeInst()?.pointerMove?.({ ground: groundAt(e), event: e, down: groupDrag });
          if (groupDrag) return;
          if (facing) { const g = groundAt(e); if (g) faceToward(g); return; }
          if (objDrag) {
            const p = groundAt(e);
            if (p) {
              objDrag.moved = true;
              dragObjects(p);
            }
            return;
          }
          if (drag) return;
        });
        canvas.addEventListener("mouseleave", () => { if (!groupDrag) activeInst()?.pointerLeave?.(); });
        canvas.addEventListener("mouseup", (e) => {
          if (e.button === 0 && press && !box?.shown) pickAt(e);
          press = null;
        });
        // Undo/redo anywhere in the editor (toolbars, panels), except while typing.
        el.addEventListener("keydown", (e) => {
          if (glDead) return;
          const t = e.target as HTMLElement;
          if (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && !["checkbox", "range", "button"].includes((t as HTMLInputElement).type))) return;
          if (!(e.ctrlKey || e.metaKey)) return;
          if (e.key === "z" || e.key === "Z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
          else if (e.key === "y" || e.key === "Y") { e.preventDefault(); redo(); }
        });
        // Arrow keys scroll like in the World Editor.
        canvas.addEventListener("keydown", (e) => {
          // No edits by key on a view that isn't drawn (the message over it takes the mouse). Ctrl+S still saves: it's a command.
          if (glDead) return;
          if (toolGroups.picking && e.key === "Escape") { e.preventDefault(); showPickTarget(null); toolGroups.picking.finish(undefined); return; }
          if (e.key.toLowerCase() === "a" && !e.ctrlKey && !e.metaKey && !e.altKey) areaKey = true;
          if (clipboardKey(e)) { e.preventDefault(); return; }
          if (activeInst()?.keyDown?.(e)) { e.preventDefault(); return; }
          if (e.key === "Escape") { if (facing) endFacing(false); else clearSelection(); return; }
          if (isRecallKey(e) && !activeGroup) {
            e.preventDefault();
            if (e.repeat || facing) return;
            if (selectedEntries().length) clearSelection(); else selectEntries(lastSelected);
            return;
          }
          if (isObjectEditorKey(e)) {
            e.preventDefault();
            const pick = selectedEntries().map(findInstance)[0]?.pick;
            if (pick) openObject(pick.kind, pick.id);
            return;
          }
          // The World Editor's View keys (V game view, Ctrl+T terrain, Ctrl+D doodads, …: viewmodes.ts). H and V mirror
          // what's selected or being pasted first (clipboardKey, above).
          const viewCommand = viewKeyCommand(e);
          if (viewCommand) {
            e.preventDefault();
            if (!e.repeat) void w3.commands.execute(viewCommand).catch((err) => w3.window.showError(String((err as Error)?.message ?? err)));
            return;
          }
          if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !activeGroup) { e.preventDefault(); startFacing(); return; }
          if (editable && selectedEntries().length && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); deleteSelected(); return; }
          if (editable && selectedEntries().length && (e.key === "[" || e.key === "]")) { e.preventDefault(); byKey(e, () => rotateSelected(e.key === "[" ? 15 : -15)); return; }
          const edit = editable && !activeGroup && selectedEntries().length ? selectionKey(e) : null;
          if (edit) { e.preventDefault(); byKey(e, () => keyEdit(edit)); return; }
          // The camera keys, as the World Editor's (viewmodes.ts cameraKey): arrows scroll, Shift faster, Ctrl+Up and
          // Down zoom, Ctrl+Left and Right turn. With a selection Ctrl and the arrows nudge it instead (above).
          const move = cameraKey(e);
          if (!move) return;
          e.preventDefault();
          if ("pan" in move) pan(-move.pan[0] * canvas.clientHeight, move.pan[1] * canvas.clientHeight);
          else if ("zoom" in move) { renderer.distance = Math.max(200, Math.min(maxDistance(), renderer.distance * move.zoom)); redraw(); }
          else { renderer.yaw += move.turn; redraw(); }
        });
        const onMove = (e: MouseEvent) => {
          if (box) {
            const rect = canvas.getBoundingClientRect();
            box.x1 = e.clientX - rect.left;
            box.y1 = e.clientY - rect.top;
            if (Math.hypot(box.x1 - box.x0, box.y1 - box.y0) >= 4) box.shown = true;
            showBox();
            return;
          }
          if (!drag) return;
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          drag.x = e.clientX; drag.y = e.clientY;
          if (drag.button === 0 || drag.button === 1) {
            pan(dx, dy);
          } else {
            renderer.yaw -= dx * 0.01;
            renderer.pitch = Math.max(0.15, Math.min(1.55, renderer.pitch + dy * 0.01));
          }
          redraw();
        };
        const onUp = (e: MouseEvent) => {
          if (faceHeld) { faceHeld = false; endFacing(true); return; }
          if (areaPress) {
            const { moved } = areaPress;
            areaPress = null;
            if (!moved) setArea(null);
            else if (terrainArea) { clearSelection(); void showAreaPanel(); }
            return;
          }
          if (groupDrag) {
            groupDrag = false;
            activeInst()?.pointerUp?.({ ground: groundAt(e), event: e, down: false });
            return;
          }
          drag = null;
          if (objDrag?.moved) moveEdits(objDrag.entries, objDrag.before);
          objDrag = null;
          if (box?.shown) {
            const found = objectsInBox(box.x0, box.y0, box.x1, box.y1);
            const base = box.add ? selectedEntries() : [];
            selectEntries([...base, ...found.filter((p) => !base.includes(p))]);
          }
          box = null;
          showBox();
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        // Wherever the key comes up, and if it never does here: Alt+Tab takes it along.
        const areaKeyUp = (e: KeyboardEvent) => { if (e.key.toLowerCase() === "a") areaKey = false; };
        const areaKeyLost = () => { areaKey = false; };
        window.addEventListener("keyup", areaKeyUp);
        window.addEventListener("blur", areaKeyLost);
        canvas.addEventListener("wheel", (e) => {
          e.preventDefault();
          renderer.distance = Math.max(200, Math.min(renderer.terrain.width * 300, renderer.distance * (e.deltaY > 0 ? 1.15 : 1 / 1.15)));
          redraw();
        }, { passive: false });

        /** Names over the map: HTML over the canvas, placed again whenever the view is drawn. */
        const placeLabels = () => {
          for (const { el, x, y } of labels) {
            const at = renderer.project([x, y, renderer.groundHeight(x, y)]);
            el.hidden = !at;
            if (at) el.style.transform = `translate(-50%, -50%) translate(${Math.round(at[0])}px, ${Math.round(at[1])}px)`;
          }
        };
        // Static scene: draw only when something changed (or the size did).
        let raf = 0, lastSize = "", lastFrame = 0;
        // While models and textures stream in, each one asks for a frame, and drawing thousands of
        // objects every frame took time the loading needed (GoldRush: about 2 s of 7). Frames asked
        // for by the load (loadRedraw) and by animation then come a few times a second; a change
        // someone makes (the camera, an edit, a panel, a command: redraw) is drawn at once.
        const tick = (now: number) => {
          const size = `${canvas.clientWidth}x${canvas.clientHeight}`;
          const loading = loader.busy || artLoads.size > 0;
          const byItself = loadDirty || renderer.animating;
          const due = dirty || size !== lastSize || (byItself && !(loading && now - lastFrame < LOADING_FRAME_MS));
          // Particle effects move by themselves: then every frame is drawn.
          if (canvas.clientWidth > 0 && due && !glDead) {
            renderer.render();
            placeLabels();
            dirty = loadDirty = false;
            lastSize = size;
            lastFrame = now;
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);

        /** Files derived from the terrain and doodads: pathing, shadows, minimap. `baseTerrain` and
         *  `baseDoodads` are the state the shadows were last updated for. */
        const updateDerived = async (doodads: Placed[], baseTerrain: Terrain, baseDoodads: Placed[], now: Terrain = terrain, units?: Placed[], staleAt: number = minimapStale.take()) => {
          const icons = units ?? unitsFile?.list;
          await writeDerived(w3, {
            now, doodads, baseTerrain, baseDoodads,
            units: unitsFile && icons ? icons : null,
            skins: objCtx?.skins ?? new Map(), baseOf: (id) => objCtx?.bases.get(id),
            read: (p) => readFile(w3, doc, p),
            filterPathing,
            minimapStale: minimapStale.isSet(),
            // Clean only for what the snapshot had: an edit made since keeps it set, and the next save redraws.
            minimapWritten: () => minimapStale.clear(staleAt),
          });
        };

        const ready = () => Promise.all([objectsPlaced.catch(() => {}), objectReload.settled()]).then(() => {});
        const takeScreenshot = async (size: number, area: Area | null, angle: ViewAngle, colors: { rgba: Uint8Array; width: number; height: number } | null, hide: ReturnType<typeof hiddenInPicture>) => {
          let timer = 0;
          const inTime = await Promise.race([
            (async () => { await ready(); await loader.settled(); await artSettled(); return true; })(),
            new Promise<false>((done) => { timer = window.setTimeout(() => done(false), PICTURE_WAIT_MS); }),
          ]);
          clearTimeout(timer);
          if (!inTime) void w3.window.showWarning(`Some models or textures were still loading after ${PICTURE_WAIT_MS / 1000} seconds: the terrain picture leaves them out.`);
          if (!canvas.clientWidth) throw new Error("The terrain editor isn't visible.");
          if (glDead) throw new Error("The terrain editor's 3D view stopped (the graphics device was reset): save, then open the editor again.");
          const before = handle.view();
          if (area) {
            const middle = heightAt(terrain, (area.left + area.right) / 2, (area.bottom + area.top) / 2);
            handle.setView(viewOfArea(area, middle, canvas.clientWidth / canvas.clientHeight, renderer.fov, angle));
          }
          const restore = renderer.showEverything(hide);
          if (colors) handle.setGroundOverlay(colors.rgba, colors.width, colors.height);
          try {
            // WebGL keeps a picture only until control returns to the browser: drawn and copied in one go.
            renderer.render();
            const scale = Math.min(1, size / Math.max(canvas.width, canvas.height));
            const copy = h("canvas", { width: Math.round(canvas.width * scale), height: Math.round(canvas.height * scale) });
            const g = copy.getContext("2d")!;
            g.drawImage(canvas, 0, 0, copy.width, copy.height);
            if (area) {
              const per = copy.width / canvas.clientWidth;
              const at = (x: number, y: number) => renderer.project([x, y, heightAt(terrain, x, y)])?.map((n) => n * per) ?? null;
              const corners = [[area.left, area.top], [area.right, area.top], [area.right, area.bottom], [area.left, area.bottom]];
              const points = corners.map(([x, y]) => at(x, y));
              g.strokeStyle = "#ffe14d";
              g.lineWidth = 2;
              g.beginPath();
              points.forEach((p) => { if (p) g.lineTo(p[0], p[1]); });
              g.closePath();
              g.stroke();
              g.font = "bold 13px sans-serif";
              g.fillStyle = "#ffe14d";
              g.shadowColor = "#000";
              g.shadowBlur = 3;
              points.forEach((p, i) => { if (p) g.fillText(`${corners[i][0]}, ${corners[i][1]}`, p[0] + 4, p[1] + (i < 2 ? -6 : 16)); });
            }
            return copy.toDataURL("image/png").split(",")[1];
          } finally {
            restore();
            handle.setView(before);
            redraw();
          }
        };
        const record: OpenedEditor = {
          root: w3.workspace.project()?.root ?? "",
          handle, ready, screenshot: takeScreenshot,
          // Tools change the files: what's open is the result already.
          derive: async (from) => {
            await ready();
            minimapStale.set();
            await updateDerived(dooFile?.list ?? [], from?.terrain ?? terrain, from?.doodads ?? dooFile?.list ?? []);
          },
          minimapSource: async () => {
            await ready();
            const rf = (p: string) => readFile(w3, doc, p);
            // Copies: the picture is of the moment it was asked for, whatever is edited while it is drawn.
            const doodads = [...(dooFile?.list ?? [])], units = [...(unitsFile?.list ?? [])];
            return {
              base: await minimapBase(w3, terrain, doodads, rf),
              terrain, units,
              pathing: () => handle.pathing({ filtered: true }),
              regions: async () => (await readMapDoc<{ regions?: { left: number; bottom: number; right: number; top: number; color?: { red: number; green: number; blue: number } }[] }>(w3, "map/war3map.w3r.json"))?.regions ?? [],
              iconKind: () => iconKinds(w3),
              iconImage: (type) => minimapIconImage(w3, type, rf),
              params: minimapSettings(w3),
            };
          },
        };
        // A read-only editor (a game map) never derives: it isn't the project's.
        if (editable) openedBy.set(doc.path, record);
        /** A change from outside, in place: nothing is torn down, so what's loaded stays. Only a
         *  new ground tile or another map size needs a real reopen. */
        const takeChange = async (path: string): Promise<boolean> => {
          const reopenInstead = () => { if (openedBy.get(doc.path) === record) openedBy.delete(doc.path); return false; };
          occupancyPromise = walkPromise = destructablePromise = standingPromise = null;
          minimapStale.set();
          // The editor's undo steps were for the map as it was.
          history.length = 0;
          at = 0;
          mark.reset();
          if (path === doc.path.toLowerCase()) {
            const bytes = await readTerrainBytes(doc.path, doc), fresh = parseW3e(bytes);
            // Another size or place needs everything built anew: the editor opens again (camera and selection stay).
            const sameGrid = fresh.width === terrain.width && fresh.height === terrain.height && fresh.offsetX === terrain.offsetX && fresh.offsetY === terrain.offsetY;
            if (!sameGrid) return reopenInstead();
            fresh.corners.forEach((c, i) => Object.assign(terrain.corners[i], c));
            // A new ground tile (an AI tool painting one the map didn't have), another list or tileset: taken in place too.
            const tilesChanged = fresh.groundTiles.join() !== terrain.groundTiles.join() || fresh.cliffTiles.join() !== terrain.cliffTiles.join()
              || fresh.customTilesetsRaw !== terrain.customTilesetsRaw;
            const tilesetChanged = fresh.tileset !== terrain.tileset;
            Object.assign(terrain, {
              version: fresh.version, trailer: fresh.trailer, groundTiles: fresh.groundTiles, cliffTiles: fresh.cliffTiles,
              customTilesets: fresh.customTilesets, customTilesetsRaw: fresh.customTilesetsRaw, tileset: fresh.tileset,
            });
            if (tilesetChanged) { loadTilesetArt(); reloadLighting(); }
            if (tilesChanged || tilesetChanged) void syncTileList();
            savedW3e = bytes;
            // The edits the shadows were predicted for are gone with the undo steps.
            void viewShadows.reloadBaked();
            notifyGroups({ terrain: true, objects: false } as Edit);
            void replanCliffs();
            renderer.terrainChanged();
            redraw();
            return true;
          }
          for (const [name, key] of [["war3map.doo", "doodads"], ["war3mapUnits.doo", "units"]] as const) {
            if (path !== `map/${name}.json`.toLowerCase()) continue;
            const f = await loadPlacedFile(w3, name, key);
            if (!f) return reopenInstead();
            // The selection is of the entries as they were: it goes to the same objects in the file's (a resize writes them too).
            const kept = selectionRefs();
            if (key === "doodads") { dooFile = f; savedDoodads = structuredClone(f.list); void viewShadows.reloadBaked(); } else { unitsFile = f; savedStarts = startLocations(f.list); }
            objectsTouched = false;
            if (selected || group.length) clearSelection();
            await rebuildObjects();
            reselect(kept);
            notifyGroups({ terrain: false, objects: true } as Edit);
            redraw();
            return true;
          }
          // A group that isn't open yet reads the file when it is.
          for (const g of groupInsts.values()) await g.reloadFile?.(path);
          // The Camera Objects layer draws what the Camera Editor now holds.
          refreshLayersSoon();
          return true;
        };
        let changes: Promise<boolean> = Promise.resolve(true);
        const reloadFile = (path: string) => {
          // One at a time, in order; tools wait for them through ready().
          changes = changes.catch(() => true).then(() => takeChange(path));
          objectsPlaced = Promise.all([objectsPlaced, changes]).then(() => {});
          return changes;
        };

        const editorApi = {
          undo,
          redo,
          reloadFile,
          // Saved by something else (an AI tool), they'd go stale here, and be written back so.
          watches: ["map/war3map.doo.json", "map/war3mapUnits.doo.json", "map/war3map.w3r.json", "map/war3map.w3c.json"],
          // One save at a time, each taking its own snapshot: a later write can't be overtaken by an older one.
          save: editable ? serial(async () => {
            // The dark border comes from the terrain. Real maps always agree with the w3i, ones made here before didn't.
            const edgeInfo = await readMapDoc<{ cameraComplements?: number[] }>(w3, "map/war3map.w3i.json").catch(() => null);
            if (edgeInfo?.cameraComplements) markMapEdge(terrain, edgeInfo.cameraComplements);
            // The game won't start a map with no players, so one always gets Player 1's start.
            const startAdded = !!edgeInfo && !!unitsFile && !unitsFile.list.some((p) => p.id === "sloc");
            if (startAdded && unitsFile) {
              const [x, y] = firstStart(playableArea(edgeInfo, terrain));
              unitsFile.list.push(newEntry(unitsFile, "sloc", [x, y, heightAt(terrain, x, y)], 0));
              objectsTouched = true;
              void w3.window.showInfo("This map had no start location, which the game can't start. Added Player 1's in the middle of the map.");
            }
            if (objectsTouched) await settleMoved();
            // Remove Unused Tiles on save (off unless chosen): an undo step of its own, so the save writes it and Undo
            // still takes it back. Not on a lost view, where nothing is edited.
            if (w3.settings.get<boolean>("terrain.removeUnusedTilesOnSave", false) === true && !lostViews.has(doc.path)) {
              const removed = removeUnusedTiles();
              if (removed?.length) void w3.window.showInfo(`Saving removed the ground tiles nothing uses: ${removed.join(", ")} (setting Remove Unused Tiles on Save). Undo takes it back.`);
            }
            // Below, everything the save writes is taken in one go with no await, so the files agree with
            // each other and with the undo position. An edit made while they are written is not in them,
            // and stays unsaved.
            const snap = await saveSnapshot(mark, {
              at: () => at,
              take: () => ({
                w3e: writeW3e(terrain),
                placed: objectsTouched ? [dooFile, unitsFile].filter((f): f is PlacedFile => !!f).map((f) => ({ f, text: placedText(f.doc) })) : [],
                starts: objectsTouched && unitsFile ? startLocations(unitsFile.list) : null,
                doodads: dooFile ? structuredClone(dooFile.list) : null,
                units: unitsFile ? structuredClone(unitsFile.list) : undefined,
                stale: minimapStale.take(),
              }),
              write: async (t) => {
                await writeTerrainBytes(doc.path, t.w3e, doc);
                for (const { f, text } of t.placed) await savePlacedFile(w3, f, text);
                // Placed, moved or deleted start locations add, move or remove the map's players.
                if (t.starts) {
                  const starts = t.starts;
                  let changes: string[] = [];
                  await editDoc("war3map.w3i", (info) => {
                    changes = syncPlayers(info as unknown as PlayerInfo, starts, savedStarts);
                    return changes.length > 0;
                  });
                  savedStarts = starts;
                  if (changes.length) void w3.window.showInfo(`Map players: ${changes.join(", ")}.`);
                }
              },
              saved: () => doc.setDirty(mark.isDirty(at)),
            });
            if (startAdded) void rebuildObjects();
            // The derived files follow what was written, not what an edit made meanwhile changed.
            const doodads = snap.doodads ?? (await loadPlacedFile(w3, "war3map.doo", "doodads").catch(() => null))?.list ?? [];
            await updateDerived(doodads, parseW3e(savedW3e), savedDoodads ?? doodads, parseW3e(snap.w3e), snap.units, snap.stale);
            savedW3e = snap.w3e;
            savedDoodads = snap.doodads ?? structuredClone(doodads);
            for (const g of groupInsts.values()) {
              await g.save?.().catch((e) => w3.window.showError(`Saving failed: ${(e as Error).message ?? e}`));
            }
          }) : undefined,
          focus: () => keysToMap(),
          dispose: () => {
            stopGroups();
            stopPick();
            stopPickRing();
            if (toolGroups.livePlacements === live) toolGroups.livePlacements = null;
            if (toolGroups.look.get(doc.path) === look) toolGroups.look.delete(doc.path);
            if (toolGroups.resetVariations.get(doc.path) === resetGround) toolGroups.resetVariations.delete(doc.path);
            if (toolGroups.viewCommands.get(doc.path) === viewCommands) toolGroups.viewCommands.delete(doc.path);
            if (toolGroups.heightCommands.get(doc.path) === heightCommands) toolGroups.heightCommands.delete(doc.path);
            if (toolGroups.replaceTypes.get(doc.path) === replaceTypes) toolGroups.replaceTypes.delete(doc.path);
            clearTimeout(layerTimer);
            layerSeq++;
            for (const g of groupInsts.values()) g.dispose?.();
            cancelAnimationFrame(raf);
            if (openedBy.get(doc.path) === record) openedBy.delete(doc.path);
            disposed = true;
            lastView = { key: viewKey, view: handle.view(), selection: selectionRefs() };
            stopLightWatch.dispose();
            stopObjectWatch.dispose();
            objectReload.cancel();
            stopLightSettings.dispose();
            stopWeatherWatch.dispose();
            stopWeatherSaves.dispose();
            stopShadows();
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            window.removeEventListener("keyup", areaKeyUp);
            window.removeEventListener("blur", areaKeyLost);
            glWatch.dispose();
            if (glDead) lostViews.delete(doc.path);
            renderer.dispose();
          },
        };
        return editorApi;
      },
    }),
  );
}
