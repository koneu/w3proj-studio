// Contracts of the services built-in extensions provide (w3.services). Only
// types live here: users depend on the contract, not on the provider's code.

/** "w3.mcpEdits", provided by the MCP Server: how AI tools change a project. An edit can be undone,
 *  is refused while anything is unsaved, and only reaches files under map/. */
export interface McpEditsService {
  /** `change` reads what it needs through `read` and gives the new texts of the files. Nothing
   *  else runs between the reads and the write. Resolves false if that changed nothing. */
  edit(title: string, change: (read: (path: string) => Promise<string | null>) => Promise<{ path: string; text: string }[]>): Promise<boolean>;
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
  setBrush(ring: { x: number; y: number; r: number; rgb: [number, number, number]; square?: boolean } | null): void;
  /** RGBA texture over the whole map (rows from the south); null removes it. */
  setGroundOverlay(rgba: Uint8Array | null, width?: number, height?: number): void;
  /** Names drawn over the map at world points (regions, cameras); null removes them. */
  setLabels(labels: { x: number; y: number; text: string; rgb?: [number, number, number] }[] | null): void;
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
  /** The ground tile of each cliff type number a corner can have (empty until the game's cliff types are read). */
  cliffGroundTiles(): string[];
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
  /** Small thumbnail (data URL) of a ground tile type's texture. */
  groundTileThumb(id: string): Promise<string | null>;
  readonly objects: TerrainObjects;
  /** Changes the map's size and its unplayable border, both per side (left, right, bottom, top;
   *  `change` in tiles added + or removed −, `complements` the border widths in tiles). Saves the
   *  map first, rewrites terrain, placements (objects outside the new map are removed), map info,
   *  regions (clipped), pathing, shadows and minimap, then reopens the terrain editor. */
  resizeMap(change: [number, number, number, number], complements: [number, number, number, number]): Promise<{ removed: number }>;
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
  /** Units and items, then doodads and destructables, as placed now. */
  list(): PlacedEntry[];
  /** Redraws and marks for saving entries whose fields (position, …) were changed in place. */
  update(entries: PlacedEntry[]): void;
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
  /** What a new one is: 8 a trigger (default), 32 a script item (Reforged files: code in the
   *  "Custom Script Code" section, no trigger object; older files get a custom text trigger). */
  itemType?: 8 | 32;
  /** Whether "New …" offers it in this editor (e.g. only for JASS maps). Default: yes. */
  available?(editor: TriggerEditorHandle): boolean;
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
  /** The parameter dialog on its own, for other function trees (AI conditions): presets,
   *  functions and values of `data`, and the registered editors; no variables. */
  editParam(opts: {
    data: import("../lib/triggers/triggerdata").TriggerData; display: import("../lib/triggers/display").DisplayContext;
    type: string; current: import("../lib/triggers/wtg").Param; limits?: [number | null, number | null];
  }): Promise<import("../lib/triggers/wtg").Param | undefined>;
}

export const TRIGGER_GUI_SERVICE = "w3.triggers.gui";

/** "w3.problems", provided by the Problems view: checks of the open project (like compiler
 *  errors), shown in a list and run before packing. Extensions add their own checks. */
export interface ProblemsService {
  registerCheck(check: ProblemCheck): { dispose(): void };
  /** Runs every check; the view shows the result. Resolves with all problems found. */
  run(): Promise<Problem[]>;
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
