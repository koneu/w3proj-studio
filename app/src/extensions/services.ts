// Contracts of the services built-in extensions provide (w3.services). Only
// types live here: users depend on the contract, not on the provider's code.

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
}

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
   *  war3mapUnits.doo / war3map.doo JSON; null when no terrain editor is open. */
  placedObjects(): { units: unknown[]; doodads: unknown[] } | null;
}

export const TERRAIN_SERVICE = "w3.terrain";

export interface TerrainToolGroup {
  id: string;
  title: string;
  /** Tab order, lower first. */
  order?: number;
  /** Called once per open terrain editor. */
  create(editor: TerrainEditorHandle): TerrainToolGroupInstance;
}

export interface TerrainToolGroupInstance {
  /** The toolbar row shown while the group's tab is active. */
  toolbar: HTMLElement;
  activate?(): void;
  deactivate?(): void;
  /** Left button pressed on the map; return true to take the drag (no selection box). */
  pointerDown?(p: TerrainPointer): boolean;
  /** Pointer moved over the map (`p.down` while a taken drag is in progress). */
  pointerMove?(p: TerrainPointer): void;
  pointerUp?(p: TerrainPointer): void;
  pointerLeave?(): void;
  /** Keys while the map has focus; return true when handled. */
  keyDown?(e: KeyboardEvent): boolean;
  /** After every edit, undo and redo, from any group. */
  changed?(what: { terrain: boolean; objects: boolean }): void;
  /** Adjusts the generated pathing map (flags per 32×32 cell, rows from the south) before it is shown or saved. */
  filterPathing?(cells: Uint8Array, width: number, height: number): void;
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
  setBrush(ring: { x: number; y: number; r: number; rgb: [number, number, number] } | null): void;
  /** RGBA texture over the whole map (rows from the south); null removes it. */
  setGroundOverlay(rgba: Uint8Array | null, width?: number, height?: number): void;
  /** The pathing map as generated from terrain and doodads; `filtered` applies the groups' filterPathing. */
  pathing(opts?: { filtered?: boolean }): Promise<{ cells: Uint8Array; width: number; height: number }>;
  focus(): void;
  /** Moves the camera to look at a world point. */
  lookAt(x: number, y: number): void;
  /** The view camera: it looks at `target` from `distance` away, `yaw` (radians)
   *  points from the target to the eye, `pitch` lifts the eye, `fov` is vertical. */
  view(): TerrainView;
  /** Changes the given parts of the view camera. */
  setView(v: Partial<TerrainView>): void;
  /** Redraws the ground after corners of `terrain` were changed in place (during a stroke). */
  terrainChanged(): void;
  /** Commits a finished terrain stroke as one undo step: `undo`/`redo` restore
   *  the corners; objects standing on the changed `corners` (indices) follow the
   *  ground; `cliffs` re-plans cliff and ramp models. */
  commitTerrain(stroke: { corners: number[]; undo(): void; redo(): void; cliffs?: boolean }): void;
  /** Index of a ground tile type in the map's list, adding it if needed (null when the list is full). */
  ensureGroundTile(id: string): Promise<number | null>;
  /** Corners using each ground tile (by index). */
  groundTileUsage(): number[];
  /** Moves a tile in the map's list (later tiles are drawn over earlier ones at transitions); one undo step. */
  moveGroundTile(from: number, to: number): void;
  /** Removes a tile; its corners get `replacement` (an index in the current list); one undo step. */
  removeGroundTile(index: number, replacement: number): void;
  /** Small thumbnail (data URL) of a ground tile type's texture. */
  groundTileThumb(id: string): Promise<string | null>;
  readonly objects: TerrainObjects;
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
}

export interface TerrainObjects {
  type(id: string): TerrainObjectType | null;
  /** A new entry of `kind`/`id` (not yet on the map), or an error message. */
  create(kind: string, id: string, at: { x: number; y: number; angle: number; player?: number }): PlacedEntry | string;
  /** Puts created entries on the map / takes them off (no undo step; pair them in pushEdit). */
  insert(entries: PlacedEntry[]): void;
  remove(entries: PlacedEntry[]): void;
  /** Footprints against blocked ground and placed objects (rebuilt after edits). */
  occupancy(): Promise<TerrainOccupancy>;
  /** A see-through preview of an object at a spot (red when `ok` is false); null hides it. */
  setGhost(ghost: { id: string; x: number; y: number; angle: number; variation?: number; player?: number; ok: boolean } | null): void;
}

export interface TerrainOccupancy {
  /** Footprint size in pathing cells, or null when the type takes no room. */
  footprint(kind: string, id: string): Promise<{ width: number; height: number } | null>;
  fits(kind: string, id: string, x: number, y: number, angle: number): Promise<boolean>;
  /** Marks the footprint as taken (for several placements in one go). */
  mark(kind: string, id: string, x: number, y: number, angle: number): Promise<void>;
}

/** "w3.triggers", provided by the Trigger Editor: kinds of triggers that
 *  other extensions show and edit (GUI events/conditions/actions, custom
 *  script, …). The host owns the tree, selection, undo and saving. */
export interface TriggersService {
  /** Adds a trigger kind to every trigger editor (open now or later). */
  registerKind(kind: TriggerKind): { dispose(): void };
}

export const TRIGGERS_SERVICE = "w3.triggers";

/** Code editors (CodeMirror with the app's languages and theme) for other extensions' views. */
export const CODE_EDITOR_SERVICE = "w3.codeEditor";
export interface CodeEditorService {
  create(parent: HTMLElement, opts: CodeEditorOptions): CodeEditorHandle;
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
  kind: "type" | "native" | "function" | "global" | "constant" | "local" | "param" | "keyword";
  /** How it is declared ("function F takes integer a returns nothing"). */
  detail: string;
  /** Declared in the edited text at this offset (go to definition). */
  at?: number;
  /** Declared elsewhere: "game:<path>" (opened in the text editor) or "trigger:<name>" (see openLocation). */
  location?: string;
  /** Visible only within this range (locals and parameters). */
  scope?: [number, number];
}
export interface CodeEditorHandle {
  value(): string;
  focus(): void;
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
    { dispose?(): void; /** Return true if the key was handled (before the host's shortcuts). */ keyDown?(e: KeyboardEvent): boolean } | void;
  /** Sets up a new trigger of this kind (flags, ECAs, custom text). Omitted: can't be created. */
  init?(trigger: TriggerItem, editor: TriggerEditorHandle): void;
}

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
}

export const TRIGGER_GUI_SERVICE = "w3.triggers.gui";

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
