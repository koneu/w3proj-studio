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
}
