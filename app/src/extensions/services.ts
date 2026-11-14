// Contracts of the services built-in extensions provide (w3.services). Only
// types live here: users depend on the contract, not on the provider's code.

/** "w3.mcpEdits", provided by the MCP Server: how AI tools change a project. An edit can be undone,
 *  is refused while anything is unsaved, and only reaches files under map/. */
export interface McpEditsService {
  /** `change` reads what it needs through `read` and gives the new texts of the files. Nothing
   *  else runs between the reads and the write. Resolves false if that changed nothing.
   *  `follow` runs after the edit and after its undo, for files derived from these. */
  edit(title: string, change: (read: (path: string) => Promise<string | null>) => Promise<{ path: string; text: string }[]>, follow?: (undoing: boolean) => Promise<void>): Promise<boolean>;
}

export const MCP_EDITS_SERVICE = "w3.mcpEdits";

/** "w3.objects", provided by the Object Editor. */
export interface ObjectsService {
  /** The object browser (search, facets, field filters) over one or more
   *  object kinds ("w3u", "w3t", "w3b", "w3d", …) with a tab per kind,
   *  including the map's custom objects. Shown over `host`. */
  pick(host: HTMLElement, opts: { title: string; kinds: string[] }): Promise<PickedObject | undefined>;
  /** Icon of an object (custom ids use the map's own art, else their base's) as a data URL, or null. */
  icon(kind: string, id: string): Promise<string | null>;
  /** Display name of an object id (custom objects: the map's name), searching `kinds` (default: all). */
  name(id: string, kinds?: string[]): Promise<string | undefined>;
  /** The file browser: a model or image from the map's imports or the game; null when cancelled. */
  pickFile(host: HTMLElement, opts: { title: string; kind: "model" | "image"; current: string }): Promise<string | null>;
  /** The game's sound labels to choose from; null when cancelled. */
  pickSoundLabel(host: HTMLElement, opts: { title: string; current: string }): Promise<string | null>;
  /** An image of the map's imports or the game as a data URL, or null. */
  image(path: string): Promise<string | null>;
  /** The object editor's control for a field holding object ids (one, or a comma list). */
  objectField(host: HTMLElement, opts: { kinds: string[]; list: boolean; current: string; onCommit: (value: string) => void }): HTMLElement;
  /** The map's own objects that placed objects of these types need: the custom ones among `ids` and whatever
   *  they refer to, abilities and the like, however far. Taken from the open map at copy time, to be handed to
   *  `bringTypes` in whichever map is open when the objects are pasted. */
  typesFor(ids: readonly string[], root?: string): Promise<CopiedObject[]>;
  /** Makes sure the open map has copied types: those it has the same are used, the rest are added, and when it
   *  has other content under an id the user decides (keep, overwrite, new ids). One edit, one undo. Resolves
   *  with the ids that changed (old to new), or null if the user cancelled. */
  bringTypes(types: readonly CopiedObject[], label: string): Promise<Map<string, string> | null>;
  /** The open Object Editors' object data as they hold it now (unsaved changes included), by kind ("w3u", …), as in
   *  war3map.<kind>.json, with the shown name of each custom object; a kind without an open editor isn't there (the
   *  saved file is what there is then). */
  liveObjects(): Map<string, LiveObjectData>;
  /** After every edit, undo and redo in an Object Editor, and when one closes: its kind. */
  onDidEdit(listener: (kind: string) => void): { dispose(): void };
}

/** One kind's object data as an open Object Editor holds it (see ObjectsService.liveObjects). */
export interface LiveObjectData {
  custom: readonly LiveObject[];
  original: readonly LiveObject[];
  /** Custom objects' names as the editor shows them (by id), where it knows one. */
  names: ReadonlyMap<string, string>;
}
export interface LiveObject { id?: string; base: string; mods?: { field?: string; value: unknown }[]; sets?: { mods: { field?: string; value: unknown }[] }[] }

/** An object of the object data with its kind ("w3u", …), as copied. */
export type CopiedObject = import("../lib/objects/copydeps").Copied;

export interface PickedObject {
  kind: string;
  id: string;
  /** Display name (the map's own name for custom objects). */
  name: string;
  /** Custom objects: the game object they're based on. */
  base?: string;
}

export const OBJECTS_SERVICE = "w3.objects";

/** "w3.terrain", provided by the Terrain Editor: tool groups from other
 *  extensions appear as tabs above the editor's toolbar. */
export interface TerrainService {
  /** Adds a tool group to every terrain editor (open now or later). */
  registerToolGroup(group: TerrainToolGroup): { dispose(): void };
  /** Opens the terrain editor and resolves with the next point clicked on the ground
   *  (undefined on Esc or when another pick starts). `prompt` is shown meanwhile. With
   *  `objects`, the nearest accepted placement (war3mapUnits.doo or war3map.doo entry) within
   *  `radius` of the pointer is ringed, and a click returns it as `object`. */
  pickPoint(opts: { prompt: string; objects?: { file: "units" | "doodads"; accept(entry: unknown): boolean; radius?: number } }):
    Promise<{ x: number; y: number; object?: unknown } | undefined>;
  /** The open terrain editor's placements as they are now (unsaved ones included), as in
   *  war3mapUnits.doo / war3map.doo JSON; null when no terrain editor is open, a list null while it isn't loaded
   *  (or couldn't be read: then the saved file is what there is). */
  placedObjects(): { units: unknown[] | null; doodads: unknown[] | null } | null;
  /** The open terrain editor's regions and cameras as its Regions and Cameras tabs hold them now (unsaved ones
   *  included), as in war3map.w3r / war3map.w3c JSON; null when no terrain editor is open, a list null when its tab
   *  isn't there (then the saved file is what there is). */
  listedObjects(): Promise<{ regions: readonly unknown[] | null; cameras: readonly unknown[] | null } | null>;
  /** After every edit, undo and redo in the open terrain editor (what it changed: the ground, placed objects, or
   *  neither: a region, a camera, …), and when it closes (told as placed objects changed: the saved files count again). */
  onDidEdit(listener: (what: { terrain: boolean; objects: boolean }) => void): { dispose(): void };
}

export const TERRAIN_SERVICE = "w3.terrain";

export interface TerrainToolGroup {
  id: string;
  title: string;
  /** Tab order, lower first. */
  order?: number;
  /** Called once per open terrain editor. */
  create(editor: TerrainEditorHandle): TerrainToolGroupInstance;
  /** With no terrain editor open (a rebuild after a tool's edit): what the instance's filterPathing would do,
   *  from the group's saved files. */
  filterSavedPathing?(cells: Uint8Array, width: number, height: number): Promise<void>;
}

export interface TerrainToolGroupInstance {
  /** The toolbar row shown while the group's tab is active. */
  toolbar: HTMLElement;
  activate?(): void;
  deactivate?(): void;
  /** Select In Tool Palette: makes this placed object's type the one the group's palette has chosen, as if picked there. False when the group can't use it. */
  select?(what: { kind: string; id: string; player?: number }): Promise<boolean>;
  /** Left button pressed on the map; return true to take the drag (no selection box). */
  pointerDown?(p: TerrainPointer): boolean;
  /** Pointer moved over the map (`p.down` while a taken drag is in progress). */
  pointerMove?(p: TerrainPointer): void;
  pointerUp?(p: TerrainPointer): void;
  pointerLeave?(): void;
  /** Keys while the map has focus; return true when handled. */
  keyDown?(e: KeyboardEvent): boolean;
  /** Cancel (Escape by default) while the tab is open: ends the tab's own business (placing, a selected region);
   *  false when it has none, and the view cancels its own. */
  cancel?(): boolean;
  /** Delete (Delete, Backspace by default) while the tab is open: deletes the tab's own selection; false when it has
   *  none, and the view deletes the selected objects. */
  deleteSelection?(): boolean;
  /** The group's object list (regions, cameras: the World Editor's Edit > Select Next / Previous in List, Move Up / Down
   *  in List): null when done, else why not. */
  listCommand?(cmd: "next" | "previous" | "up" | "down"): string | null;
  /** One of the group's named objects (a region, a camera), for the Object Manager: selects and shows it, renames it to
   *  `to` or deletes it, as the group's own panel does (one undo step, unsaved). Null when done, else why not. */
  itemAction?(name: string, action: "select" | "rename" | "delete", to?: string): Promise<string | null>;
  /** After every edit, undo and redo, from any group. */
  changed?(what: { terrain: boolean; objects: boolean }): void;
  /** Adjusts the generated pathing map (flags per 32×32 cell, rows from the south) before it is shown or saved. */
  filterPathing?(cells: Uint8Array, width: number, height: number): void;
  /** A file the group keeps was saved elsewhere: takes it in place. Without this, the editor reopens. */
  reloadFile?(path: string): Promise<boolean>;
  /** The camera objects as the group holds them, unsaved edits included: the Camera Objects layer draws these, not the saved war3map.w3c. */
  cameraObjects?(): Promise<readonly import("../lib/terrain/cameras").CameraObject[]>;
  /** The regions as the group holds them, unsaved edits included: the Regions layer draws these, not the saved war3map.w3r. */
  regionObjects?(): Promise<readonly { left: number; bottom: number; right: number; top: number; color?: { red: number; green: number; blue: number } }[]>;
  /** Writes the group's own files; called on save after the map files. */
  save?(): Promise<void>;
  dispose?(): void;
}

export interface TerrainPointer {
  /** Ground point under the pointer (world units), or null off the map. */
  ground: [number, number, number] | null;
  event: MouseEvent;
  /** True while a drag taken by pointerDown is in progress. */
  down: boolean;
}

export interface TerrainView {
  target: [number, number, number];
  yaw: number;
  pitch: number;
  distance: number;
  fov: number;
}

export interface TerrainEditorHandle {
  /** The terrain being edited (live; see lib/terrain/w3e). */
  readonly terrain: import("../lib/terrain/w3e").Terrain;
  readonly editable: boolean;
  /** The editor element (for overlays such as pickers). */
  readonly host: HTMLElement;
  redraw(): void;
  /** Adds an undo step (and marks the document modified). */
  pushEdit(e: { undo(): void; redo(): void; terrain: boolean; objects: boolean }): void;
  /** Brush outline on the ground; null hides it. */
  setBrush(ring: { x: number; y: number; r: number; rgb: [number, number, number]; square?: boolean } | null): void;
  /** RGBA texture over the whole map (rows from the south); null removes it. */
  setGroundOverlay(rgba: Uint8Array | null, width?: number, height?: number): void;
  /** Solid marks in the view (the Cameras tab's camera models): triangles, 10 floats per corner (x, y, z, the face's
   *  normal, r, g, b, a: the colour before light), lit as placed models are; null removes them. */
  setShapes(triangles: readonly number[] | null): void;
  /** Rings in the view, drawn over everything (the selected cameras' circles): `z` keeps a ring at that height, else
   *  it follows the ground; null removes them. */
  setRings(rings: { x: number; y: number; r: number; z?: number; rgb: [number, number, number] }[] | null): void;
  /** Where a world point is on the screen (CSS pixels, as a mouse event's clientX and clientY), or null behind the
   *  camera. */
  project(p: [number, number, number]): [number, number] | null;
  /** Names drawn over the map at world points (regions, cameras); null removes them. */
  setLabels(labels: { x: number; y: number; text: string; rgb?: [number, number, number] }[] | null): void;
  /** The pathing map as generated from terrain and doodads; `filtered` applies the groups' filterPathing. */
  pathing(opts?: { filtered?: boolean }): Promise<{ cells: Uint8Array; width: number; height: number }>;
  focus(): void;
  /** Cycle Random Groups - Next (1) or Previous (-1) (the same as the commands): says what is shown now. */
  cycleRandomGroups(step: 1 | -1): Promise<string>;
  /** Moves the camera to look at a world point. */
  lookAt(x: number, y: number): void;
  /** The view camera: it looks at `target` from `distance` away, `yaw` (radians)
   *  points from the target to the eye, `pitch` lifts the eye, `fov` is vertical. */
  view(): TerrainView;
  /** The view's width / height as drawn now (4:3 while it has no size). */
  aspect(): number;
  /** Changes the given parts of the view camera. */
  setView(v: Partial<TerrainView>): void;
  /** CPU time of the frames drawn since the last call (ms, by performance.now): the whole frame, posing
   *  the placed models in it, the particles, and HD water's depth picture of the models in it. For measuring
   *  (app-drive's --frame-cost). */
  frameCost(): { frames: number; frameMs: number; poseMs: number; particleMs: number; waterMs: number };
  /** The last frame's real shadows (HD): whether they were cast, how big a texel of the sun's shadow map was on the
   *  ground (world units), and how many objects cast into it. For tests and measuring. */
  sunShadows(): { drawn: boolean; texel: number; casters: number };
  /** The last frame's depth picture of the models under HD water (they show through it): whether it was drawn, and
   *  how many models were in it. For tests and measuring. */
  waterDepth(): { drawn: boolean; models: number };
  /** Where the placed units' models are drawn now (a flyer at its flying height, a ship on the water), by their
   *  placement's id and position, with the team colour they're drawn in and their model ("" for a checkered cube).
   *  For tests and measuring. */
  /** The special doodads (cliff and cave models placed by tile) drawn now: type id, position and model. They can't be
   *  selected. For tests and measuring. */
  /** The see-through start buildings drawn now (one per start location), where they stand. For tests. */
  drawnStartBuildings(): { x: number; y: number }[];
  drawnSpecials(): { id: string; x: number; y: number; z: number; model: string }[];
  drawnUnits(group?: "units" | "doodads"): { id: string; x: number; y: number; z: number; team: number; model: string }[];
  /** Redraws the ground after corners of `terrain` were changed in place (during a stroke). */
  terrainChanged(cliffs?: boolean): void;
  /** Commits a finished terrain stroke as one undo step: `undo`/`redo` restore
   *  the corners; objects standing on the changed `corners` (indices) follow the
   *  ground; `cliffs` re-plans cliff and ramp models. */
  /** Puts a finished stroke on the undo stack. False when it was refused (Enforce Water Height Limits): the ground is as it was. */
  commitTerrain(stroke: { corners: number[]; undo(): void; redo(): void; cliffs?: boolean }): boolean;
  /** The ground tile of each cliff type number a corner can have (empty until the game's cliff types are read). */
  cliffGroundTiles(): string[];
  /** The cliff type number the World Editor's cliff palette starts on, for new cliffs and water (-1: none known). */
  defaultCliffType(): number;
  /** The game's tilesets with their own ground tiles (the tile list New Map gives them). */
  tilesets(): Promise<{ id: string; name: string; tiles: string[] }[]>;
  /** Changes the terrain's tileset (water, lighting, blight follow); one undo step. */
  setTileset(id: string): void;
  /** Replaces the ground tile list slot by slot (corners keep their slot; slots beyond the new
   *  list take its last tile); cliffs follow; one undo step. */
  replaceGroundTiles(tiles: string[]): void;
  /** The tileset Map Properties (war3map.w3i) names (null without map info), and setting it there. */
  mapTileset(): Promise<string | null>;
  setMapTileset(id: string): Promise<void>;
  /** Index of a ground tile type in the map's list, adding it if needed (null when the list is full). */
  ensureGroundTile(id: string): Promise<number | null>;
  /** Corners using each ground tile (by index). */
  groundTileUsage(): number[];
  /** Moves a tile in the map's list (later tiles are drawn over earlier ones at transitions); one undo step. */
  moveGroundTile(from: number, to: number): void;
  /** Removes a tile; its corners get `replacement` (an index in the current list); one undo step. */
  removeGroundTile(index: number, replacement: number): void;
  /** Per ground tile (by index): corners painted with it, and cliff tiles drawn with its cliff type. Null until the
   *  game's cliff types are read. */
  groundTileUse(): { ground: number[]; cliffs: number[] } | null;
  /** Removes the tiles `remove` (indices) in one undo step; a tile in use needs a replacement in `replace` (its
   *  index → a tile that stays), which its corners and cliffs get. The removed ids; throws with the reason when refused
   *  (nothing changes then). */
  removeGroundTiles(remove: readonly number[], replace: ReadonlyMap<number, number>): string[];
  /** Removes the tiles nothing uses (corners or cliffs), one undo step: their ids (none: no step), or null while
   *  the cliff types aren't read. */
  removeUnusedGroundTiles(): string[] | null;
  /** Small thumbnail (data URL) of a ground tile type's texture. */
  groundTileThumb(id: string): Promise<string | null>;
  readonly objects: TerrainObjects;
  /** Changes the map's size and its unplayable border, both per side (left, right, bottom, top;
   *  `change` in tiles added + or removed −, `complements` the border widths in tiles). Saves the
   *  map first, rewrites terrain, placements (see resizeRemovals for what is removed), map info,
   *  regions (clipped), pathing, shadows and minimap, then reopens the terrain editor. */
  resizeMap(change: [number, number, number, number], complements: [number, number, number, number]): Promise<{ removed: number }>;
  /** How many placed objects (special doodads included) `resizeMap` with these arguments would remove; changes
   *  nothing. */
  resizeRemovals(change: [number, number, number, number], complements: [number, number, number, number]): Promise<number>;
}

/** A placed unit, item, doodad or destructable (the placement files' JSON entry). */
export interface PlacedEntry {
  id: string;
  variation: number;
  position: [number, number, number];
  /** Radians. */
  angle: number;
  scale: [number, number, number];
  player?: number;
}

export interface TerrainObjectType {
  /** w3u, w3t, w3b or w3d. */
  kind: string;
  numVar: number;
  /** Random scale range for new placements. */
  randScale: boolean;
  minScale: number;
  maxScale: number;
  /** Fixed facing in degrees, or null. */
  fixedRot: number | null;
  /** A unit type's movement type (UnitData.slk `movetp`: "foot", "fly", "float", …); absent for other kinds. */
  moveType?: string;
}

export interface TerrainObjects {
  type(id: string): TerrainObjectType | null;
  /** A new entry of `kind`/`id` (not yet on the map), or an error message. */
  create(kind: string, id: string, at: { x: number; y: number; angle: number; player?: number }): PlacedEntry | string;
  /** Units and items, then doodads and destructables, as placed now. */
  list(): PlacedEntry[];
  /** Redraws and marks for saving entries whose fields (position, …) were changed in place. */
  update(entries: PlacedEntry[]): void;
  /** Puts created entries on the map / takes them off (no undo step; pair them in pushEdit). */
  insert(entries: PlacedEntry[]): void;
  remove(entries: PlacedEntry[]): void;
  /** Footprints against blocked ground and placed objects (rebuilt after edits). */
  occupancy(): Promise<TerrainOccupancy>;
  /** Where a unit type lands near a point: buildings go on the building grid, others stay. */
  buildingSpot(id: string, x: number, y: number): Promise<[number, number]>;
  /** Reads what `type(id)` needs of a doodad or destructable type's pathing texture (a destructable without one has no
   *  fixed rotation to place at); resolves when it's read or can't be. Others: at once. */
  ready(id: string): Promise<void>;
  /** Where an object of `kind`/`id` placed at (x, y) facing `angle` (radians) lands, and its facing then: a building
   *  on the building grid, a doodad or destructable on its own grid and, with a texture that isn't square, at a
   *  quarter turn (Snap Doodads on Load); anything else as asked. */
  placedSpot(kind: string, id: string, x: number, y: number, angle: number): Promise<{ x: number; y: number; angle: number }>;
  /** Gives doodads and destructables among `entries` (placed, moved or scaled by a tool) the place and facing
   *  (`place`) and the scale (`scale`) the World Editor gives them, in place: on their grid (Snap Doodads on Load),
   *  the scale within their type's range (Fix Doodads on Load). Part of the caller's edit; units are left alone. */
  settleDoodads(entries: PlacedEntry[], what: { place?: boolean; scale?: boolean }): Promise<void>;
  /** Whether an object here is the map's backdrop: doodads past the playable map stand on what counts as blocked. */
  backdrop(kind: string, x: number, y: number): boolean;
  /** Per pathing cell (rows from the south), 1 where cliffs, doodads, trees or buildings stop a
   *  walking unit. Unlike occupancy(), units and items don't count. */
  blockers(): Promise<Uint8Array>;
  /** How long a type's model is, in world units, and whether that's along x at facing 0, so which
   *  way it has to turn to run along a line. Null without a model. */
  modelShape(id: string): Promise<{ length: number; alongX: boolean } | null>;
  /** The game's type a type of this map is based on. */
  baseOf(id: string): string | undefined;
  /** Per pathing cell (rows from the south), 1 where doodads or buildings stand: what's there
   *  apart from the ground, and from destructables, which can go. */
  standing(): Promise<Uint8Array>;
  /** Per pathing cell (rows from the south), 1 where a destructable stands. The game's pathing file
   *  leaves these out: it blocks them at runtime, and frees the ground when they're destroyed. */
  destructables(): Promise<Uint8Array>;
  /** A see-through preview of an object at a spot (red when `ok` is false); null hides it. */
  setGhost(ghost: { id: string; x: number; y: number; angle: number; variation?: number; player?: number; ok: boolean } | null): void;
}

export interface TerrainOccupancy {
  /** Per pathing cell (rows from the south), 1 where cliffs or placed objects stand. */
  readonly blocked: Uint8Array;
  /** Footprint size in pathing cells, or null when the type takes no room. */
  footprint(kind: string, id: string): Promise<{ width: number; height: number } | null>;
  fits(kind: string, id: string, x: number, y: number, angle: number): Promise<boolean>;
  /** Marks the footprint as taken (for several placements in one go). */
  mark(kind: string, id: string, x: number, y: number, angle: number): Promise<void>;
  /** A copy as it is now: marks on it stay in it (a dry run that must see its own objects). */
  scratch(): TerrainOccupancy;
}

/** "w3.triggers", provided by the Trigger Editor: kinds of triggers that
 *  other extensions show and edit (GUI events/conditions/actions, custom
 *  script, …). The host owns the tree, selection, undo and saving. */
export interface TriggersService {
  /** Adds a trigger kind to every trigger editor (open now or later). */
  registerKind(kind: TriggerKind): { dispose(): void };
  /** The open Trigger Editor's triggers and variables as it holds them now (unsaved changes included); null when
   *  none is open (the saved file is what there is then). The editor's own object: read it, don't change it. */
  liveTriggers(): import("../lib/triggers/wtg").TriggerFile | null;
  /** After every edit, undo and redo in the open Trigger Editor, and when it closes. */
  onDidEdit(listener: () => void): { dispose(): void };
  /** Objects renamed in another editor (`kind` "rct", "cam", …; `pairs` [old name, new name]) in the open Trigger
   *  Editor's GUI parameters at once, as an unsaved undo step there (`label`); script text waits for the objects'
   *  save (w3.triggers.renameGlobals asks about it then). The handle's undo and redo go with the other editor's:
   *  they take the step back or do it again, as a new step when the Trigger Editor was edited since. null when no
   *  changeable Trigger Editor is open or no GUI parameter names the old names. */
  followRenames(kind: string, pairs: [string, string][], label: string): FollowedRenames | null;
}

/** See TriggersService.followRenames. Does nothing once that Trigger Editor has closed. */
export interface FollowedRenames {
  undo(): void;
  redo(): void;
}

export const TRIGGERS_SERVICE = "w3.triggers";

/** "w3.sounds", provided by the Sound Editor: the map's sounds as the open editor holds them. */
export interface SoundsService {
  /** The open Sound Editor's sounds now (unsaved changes included), as in war3map.w3s JSON; null when none is open
   *  (the saved file is what there is then). The editor's own objects: read them, don't change them. */
  liveSounds(): readonly { name: string; file: string; flags: number }[] | null;
  /** After every edit, undo and redo in the open Sound Editor, and when it closes. */
  onDidEdit(listener: () => void): { dispose(): void };
}

export const SOUNDS_SERVICE = "w3.sounds";

/** "w3.mapInfo", provided by Map Properties: the map's properties as the open editor holds them. */
export interface MapInfoService {
  /** The map item tables of the project at `root` as its open Map Properties editor holds them now (unsaved changes
   *  included), names as shown there (string table references resolved); null when no editor of that project is open
   *  (the saved war3map.w3i is what there is then). A copy: changing it changes nothing. */
  liveItemTables(root: string): LiveItemTable[] | null;
  /** After every edit, undo and redo in an open Map Properties editor, and when one closes. */
  onDidEdit(listener: () => void): { dispose(): void };
}
export interface LiveItemTable { number: number; name: string; sets: { id: string; chance: number }[][] }

export const MAP_INFO_SERVICE = "w3.mapInfo";

/** Code editors (CodeMirror with the app's languages and theme) for other extensions' views. */
export const CODE_EDITOR_SERVICE = "w3.codeEditor";
export interface CodeEditorService {
  create(parent: HTMLElement, opts: CodeEditorOptions): CodeEditorHandle;
  /** Adds completion items to code editors of the given languages (all open and future ones):
   *  e.g. file paths in strings, rawcodes, a language's keywords. */
  registerCompletion(provider: CompletionProvider): { dispose(): void };
  /** Claims files for a language in the text editor: by file extension (".vj") or by content
   *  (a .j file written in vJASS). Applies to files opened afterwards; the first claim wins. */
  registerFileLanguage(language: FileLanguage): { dispose(): void };
}
export interface FileLanguage {
  id: string;
  /** Shown in the status bar ("vJASS"). */
  title: string;
  /** Highlighting and completion it builds on ("jass": JASS symbols and other extensions' JASS items). */
  base: "jass" | "lua" | "text";
  /** The base for one file when it depends on more than the file (war3map.wct.txt: the map's script language);
   *  asked as the file opens, `base` when omitted or when it fails. */
  baseOf?(path: string): Promise<"jass" | "lua" | "text">;
  /** File extensions with the dot (".vj", ".zn"); the files also need an editor contribution
   *  for "w3.textEditor" with these patterns to open in it. */
  extensions?: string[];
  /** Content check for other files (e.g. a .j file using vJASS). */
  detect?(path: string, text: string): boolean;
  /** The text's own declarations (outline, go to definition); omitted: the base language's. */
  symbols?(text: string): CodeSymbol[];
  /** Problems shown for the text; omitted: not checked (the plain JASS checker isn't used). */
  check?(text: string): Promise<import("../lib/jass/check").Diagnostic[]> | import("../lib/jass/check").Diagnostic[];
}
export interface CompletionProvider {
  /** "jass" (also used for vJASS trigger texts), "lua", … */
  languages: string[];
  provide(request: CompletionRequest): Promise<CompletionItem[]> | CompletionItem[];
}
export interface CompletionRequest {
  language: string;
  text: string;
  pos: number;
  /** Inside a string ("…") or a rawcode ('…'), with what is typed there (string escapes resolved). */
  inString: boolean;
  inRawcode: boolean;
  prefix: string;
  /** The innermost call the cursor is an argument of, and that parameter when known. */
  call?: { name: string; argIndex: number; param?: { name: string; type: string } };
}
export interface CompletionItem {
  /** Shown, and inserted unless `insert` is given (in strings: escaped by the editor). */
  label: string;
  insert?: string;
  detail?: string;
  info?: string;
  kind?: "file" | "constant" | "text" | "keyword" | "variable" | "function" | "type" | "class";
  boost?: number;
}
export interface CodeEditorOptions {
  value: string;
  language: "jass" | "lua" | "json" | "text";
  readOnly?: boolean;
  /** After the text changed and typing paused (and when the editor loses focus with changes). */
  onChange?(value: string): void;
  /** Pause in ms before onChange (default 600). */
  debounce?: number;
  /** Names for completion, hover and go to definition (F12, Ctrl+click), for the current text. */
  symbols?(text: string): Promise<CodeSymbol[]>;
  /** Go to definition of a symbol declared elsewhere that the editor can't open itself ("trigger:<name>"). */
  openLocation?(location: string, name: string): void;
  /** Problems in the text (lib/jass/check), shown as underlines and a list below the editor. */
  check?(text: string): Promise<import("../lib/jass/check").Diagnostic[]> | import("../lib/jass/check").Diagnostic[];
}
export interface CodeSymbol {
  name: string;
  /** library: also scopes; struct: also modules and interfaces; field: a struct member. */
  kind: "type" | "native" | "function" | "global" | "constant" | "local" | "param" | "keyword"
    | "library" | "struct" | "method" | "field" | "macro";
  /** How it is declared ("function F takes integer a returns nothing"). */
  detail: string;
  /** Declared in the edited text at this offset (go to definition). */
  at?: number;
  /** Declared elsewhere: "game:<path>" (opened in the text editor) or "trigger:<name>" (see openLocation). */
  location?: string;
  /** Visible only within this range (locals and parameters). */
  scope?: [number, number];
  /** The library or struct it is declared in (shown in the outline). */
  container?: string;
}
export interface CodeEditorHandle {
  value(): string;
  focus(): void;
  /** Hands a change still waiting for the pause (see `debounce`) to onChange now; nothing when there is none.
   *  Called before anything reads what the editor's owner holds for a save. */
  flush(): void;
  dispose(): void;
}

type TriggerItem = import("../lib/triggers/wtg").TriggerItem;

export interface TriggerKind {
  id: string;
  /** Shown in "New …" ("GUI Trigger", "Custom Script"). */
  title: string;
  /** Several kinds may match a trigger; the highest priority shows it. */
  priority?: number;
  matches(trigger: TriggerItem, editor: TriggerEditorHandle): boolean;
  /** Fills `el` with the trigger's body (below the host's name, flags and comment). */
  render(el: HTMLElement, trigger: TriggerItem, editor: TriggerEditorHandle):
    { dispose?(): void; /** Return true if the key was handled (before the host's shortcuts). */ keyDown?(e: KeyboardEvent): boolean;
      /** The editor's commands on the body's lines (Select All, Clear, Toggle Function Enabled); false when the body has no
       *  line for it. */
      run?(action: "selectAll" | "clear" | "toggleFunction"): boolean;
      /** Applies text still waiting to be committed (a code editor's pause): the host calls it before a save, an
       *  undo or any other edit, so the save has it and its undo step comes first. */
      flush?(): void } | void;
  /** Sets up a new trigger of this kind (flags, ECAs, custom text). Omitted: can't be created. */
  init?(trigger: TriggerItem, editor: TriggerEditorHandle): void;
  /** What a new one is: 8 a trigger (default), 32 a script item (Reforged files: code in the
   *  "Custom Script Code" section, no trigger object; older files get a custom text trigger). */
  itemType?: 8 | 32;
  /** Whether "New …" offers it in this editor (e.g. only for JASS maps). Default: yes. */
  available?(editor: TriggerEditorHandle): boolean;
  /** Called before the trigger is shown for a found problem (Problems): select the line at `path`
   *  (indices through children) and mark the parameter at `param` (indices through nested calls, -1 an
   *  array index). */
  reveal?(trigger: TriggerItem, at: TriggerLocation): void;
  /** The lines selected in the trigger's body (Copy As Text / Copy As Script take them instead of the
   *  whole trigger), or none. */
  selectedLines?(trigger: TriggerItem): import("../lib/triggers/wtg").Eca[];
}

/** A place in a GUI trigger: a line, and in it a parameter. */
export interface TriggerLocation { path: number[]; param?: number[] }

export interface TriggerEditorHandle {
  readonly file: import("../lib/triggers/wtg").TriggerFile;
  readonly data: import("../lib/triggers/triggerdata").TriggerData;
  readonly display: import("../lib/triggers/display").DisplayContext;
  readonly editable: boolean;
  /** The map's script language (war3map.w3i scriptType). */
  readonly language: "jass" | "lua";
  /** The trigger's custom script text (war3map.wct), or null. */
  customText(trigger: TriggerItem): string | null;
  setCustomText(trigger: TriggerItem, text: string | null): void;
  /** All custom texts as the editor holds them now (unsaved changes included): the map header and one text per
   *  trigger and script item, in the order of war3map.wct. A copy. */
  customFile(): import("../lib/triggers/wtg").CustomTextFile;
  /** Runs `change` on the trigger data as one undo step (snapshot before and after) and redraws;
   *  `keepView` leaves the trigger's own view as it is (an editor committing while typing). */
  edit(label: string, change: () => void, opts?: { keepView?: boolean }): void;
  /** Icon of a trigger category path (ReplaceableTextures\WorldEditUI\…) as a data URL. */
  icon(path: string): Promise<string | null>;
  /** Selects the trigger a gg_trg_<name> global stands for; false if there's none. */
  openTrigger(global: string): boolean;
}

/** "w3.triggers.gui", provided by the GUI trigger kind (a sub-extension of the
 *  Trigger Editor): editors for parameter values of given TriggerData types,
 *  offered next to Preset / Variable / Function / Value when a parameter is edited. */
export interface TriggerGuiService {
  registerParamEditor(editor: TriggerParamEditor): { dispose(): void };
  /** The parameter dialog on its own, for other function trees (AI conditions): presets,
   *  functions and values of `data`, and the registered editors; no variables. */
  editParam(opts: {
    data: import("../lib/triggers/triggerdata").TriggerData; display: import("../lib/triggers/display").DisplayContext;
    type: string; current: import("../lib/triggers/wtg").Param; limits?: [number | null, number | null];
  }): Promise<import("../lib/triggers/wtg").Param | undefined>;
}

export const TRIGGER_GUI_SERVICE = "w3.triggers.gui";

/** One check's part of a Problems run: what it reported (without the ignored), how many the ignore file left out,
 *  and why it failed if it did. */
export interface CheckedGroup { id: string; title: string; problems: Problem[]; ignored: number; error?: string }

/** "w3.problems", provided by the Problems view: checks of the open project (like compiler
 *  errors), shown in a list and run before packing. Extensions add their own checks. */
export interface ProblemsService {
  registerCheck(check: ProblemCheck): { dispose(): void };
  /** Runs every check; the view shows the result. Resolves with all problems found. */
  run(): Promise<Problem[]>;
  /** Like `run`, and says how many reports the project's ignore file (.w3proj/problems-ignore.json) left out of
   *  the result, and why it was not applied if that file is there but can't be read (then nothing is left out).
   *  `checks`: the same by check, with the reason of a check that failed (it found nothing, which isn't "no
   *  problems"); `w3proj check` prints them. Empty when the run's results weren't the open project's. */
  runChecked(): Promise<{ problems: Problem[]; ignored: number; ignoreError: string | null; checks: CheckedGroup[] }>;
  /** The result of the last run. */
  problems(): Problem[];
}

export const PROBLEMS_SERVICE = "w3.problems";

/** "w3.scriptLanguages", provided by Map Script: languages written in trigger texts that compile
 *  to the JASS the game runs (vJASS, Zinc, cJass, Wurst, …), each one an extension. When the map
 *  script is generated, the first language that detects itself compiles it. */
export interface ScriptLanguagesService {
  register(language: ScriptLanguage): { dispose(): void };
  /** The registered languages (in registration order). */
  languages(): ScriptLanguage[];
  /** The open JASS map's script as it is generated before any language compiles it (what a language's `compile`
   *  gets), made from the project's saved files but with these triggers and custom texts in place of the saved
   *  ones (a trigger editor's, unsaved changes included). Nothing is written. Throws for a Lua map, without a
   *  project, or when the script can't be generated. */
  source(held: { triggers: import("../lib/triggers/wtg").TriggerFile; custom: import("../lib/triggers/wtg").CustomTextFile | null }): Promise<string>;
}

export const SCRIPT_LANGUAGES_SERVICE = "w3.scriptLanguages";

export interface ScriptLanguage {
  id: string;
  /** Shown in messages ("vJASS (JassHelper)"). */
  title: string;
  /** Whether the map uses the language: the trigger texts (map header first) and the current
   *  map script (e.g. a compiler's output markers). */
  detect(opts: { texts: string[]; script: string }): boolean;
  /** The generated script (trigger texts as written) turned into plain JASS. Throws with the
   *  compiler's messages when it fails. */
  compile(opts: { script: string; commonJ: string; blizzardJ: string }): Promise<string>;
}

export interface ProblemCheck {
  id: string;
  /** Group title in the list ("Map script", "Object data paths"). */
  title: string;
  run(): Promise<Problem[]>;
}

export interface Problem {
  severity: "error" | "warning";
  message: string;
  /** Where (file, object), shown next to the message. */
  location?: string;
  /** What the report is about, stable across edits (a trigger's name): the Problems ignore names a report by its
   *  check and this. Without it, the location and message stand in. */
  about?: string;
  /** What a click does: a command with its arguments. */
  reveal?: { command: string; args?: unknown[] };
  /** Ways to fix it, shown as buttons; the checks run again afterwards. */
  fixes?: ProblemFix[];
}

export interface ProblemFix {
  label: string;
  /** What it does, in a tooltip. */
  title?: string;
  run(): Promise<void>;
}

export interface TriggerParamEditor {
  id: string;
  /** Button label in the parameter dialog ("Pick unit…"). */
  title: string;
  /** TriggerData types this editor handles ("unitcode", "abilcode", …). */
  types: string[];
  /** Asks for a value in its own dialog; resolves with the new parameter, or undefined when cancelled. */
  edit?(opts: { type: string; current: import("../lib/triggers/wtg").Param; editor: TriggerEditorHandle }):
    Promise<import("../lib/triggers/wtg").Param | undefined>;
  /** Or: choices shown as a tab of the parameter dialog (searchable list; `group` adds filter chips). */
  list?(opts: { type: string; editor: TriggerEditorHandle }): Promise<TriggerParamChoice[]>;
}

export interface TriggerParamChoice {
  label: string;
  detail?: string;
  group?: string;
  param: import("../lib/triggers/wtg").Param;
}
