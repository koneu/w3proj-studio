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
