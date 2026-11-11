import type { PlacedRef } from "./pickmatch";
import type { ReplaceTypes } from "./replace";
import type { Shown, TerrainLook, ToggleLayer, ViewSet } from "./viewmodes";
import type { MinimapPanel } from "./minimappanel";
// The "w3.terrain" service: tool groups other extensions add to the terrain
// editor (see extensions/services.ts). Open editors follow registrations.
// Also picks a point on the map for other modules (trigger parameters).

import type { TerrainService, TerrainToolGroup } from "../../extensions/services";
import { Listeners } from "../../lib/listeners";
import type { DropsSource } from "./dropstab";

/** The View commands of one open terrain editor. Each returns what to tell the person when it can't run, else null. */
export interface ViewCommands {
  viewSelection(): string | null;
  viewEntireMap(): void;
  selectInPalette(): Promise<string | null>;
  /** A View item (Pathing - Naval and Ground, Height Map, Camera Objects, Camera Bounds, Regions, Light Ranges,
   *  Doodads, Units, Water, Blight): flips it and returns whether it's on now. In game view nothing changes, and the answer is why. */
  toggleLayer(layer: ToggleLayer | "water"): boolean | string;
  /** Lighting, Weather and Fog Effects, which are settings: as toggleLayer. */
  toggleSetting(which: "lighting" | "weather" | "fog"): Promise<boolean | string>;
  /** View > Terrain: textured, wireframe, hidden, and round again. Returns what it is now, or why not (game view). */
  cycleTerrain(): TerrainLook | string;
  /** Lock to Game View Settings (V): returns whether game view is on now. */
  toggleGameView(): Promise<boolean>;
  /** Small, Medium or Large Grid Display: the same size again switches the grid off. Returns the grid shown now, or why not (game view). */
  toggleGrid(size: "small" | "medium" | "large"): "none" | "small" | "medium" | "large" | string;
  /** View > Grid's key (G): none, large, medium, small and round again (viewcmds.ts nextGrid). Answers as toggleGrid. */
  cycleGrid(): "none" | "small" | "medium" | "large" | string;
  /** Cycle Random Groups - Next (1) or Previous (-1): objects placed from a random group show the unit, building or item
   *  the group's next line puts there, then the question mark again. Says what is shown now. */
  cycleRandomGroups(step: 1 | -1): Promise<string>;
  /** Edit > Select Next / Previous in List, Move Up / Down in List: on the open tab's object list (Regions, Cameras).
   *  Null when done, else why not. */
  listCommand(cmd: "next" | "previous" | "up" | "down"): string | null;
  /** A named object of a tab's list (the Regions or Cameras tab, by its group id): the tab comes to the front and does
   *  the action (TerrainToolGroupInstance.itemAction); no name: only the tab. Null when done, else why not. */
  groupItemAction(group: string, name: string | null, action: "select" | "rename" | "delete", to?: string): Promise<string | null>;
  /** One of the view's key commands (camera, selection, clipboard: index.ts KEY_COMMANDS) as its key would do it,
   *  once; true when it did something. */
  keyCommand(id: string): boolean;
  /** What is chosen and what is shown (game view sets the choice aside), for the status line and tests; `sunShadows`
   *  the last frame's real shadows (HD: cast or not, the shadow map's texel on the ground, how many objects cast). */
  state(): Omit<ViewSet, "lighting" | "fog" | "weather"> & { gameView: boolean; shown: Shown; camera: { target: [number, number, number]; distance: number; yaw: number; pitch: number; fov: number; aspect: number }; sunShadows: { drawn: boolean; texel: number; casters: number }; shadowImages: number;
    /** The minimap panel: shown, its picture in, the view's outline on it (picture pixels). */
    minimap: ReturnType<MinimapPanel["state"]> };
}

/** The object height commands of one open terrain editor, on what is selected there. Each returns what to tell the person, or null when it was done. */
export interface HeightCommands {
  /** Set Uniform Doodad Heights: the selected doodads to one height (world units; their mean height when none is given, as the World Editor does). */
  setUniformHeights(height?: number): Promise<string | null>;
  /** Reset Fixed Object Heights: the selected objects with a height of their own back onto the ground. */
  resetFixedHeights(): string | null;
  /** The selected doodads' mean height (uniformDefaultHeight), for a prompt's start value; null with none selected. */
  uniformDefaultHeight(): number | null;
}

/** Reset Height Field and Adjust Cliff Levels on one open terrain editor's whole map, each one undo step: how many
 *  corners changed (0: nothing to do), or why it was refused (nothing changed then). */
export interface WholeMapGround {
  resetHeightField(): number | string;
  adjustCliffLevels(by: number): number | string;
  /** How far the cliff levels can move (lib/terrain/wholemap.ts cliffShiftRange). */
  range(): { min: number; max: number };
}

type Point = { x: number; y: number; object?: unknown };
type PickObjects = { file: "units" | "doodads"; accept(entry: unknown): boolean; radius?: number };

export class TerrainToolRegistry implements TerrainService {
  private groups: TerrainToolGroup[] = [];
  private listeners = new Set<() => void>();
  /** The pick in progress: its prompt and how it ends. */
  picking: { prompt: string; objects?: PickObjects; finish(p: Point | undefined): void } | null = null;

  /** Set by the open terrain editor: its live placements. */
  livePlacements: (() => { units: unknown[] | null; doodads: unknown[] | null }) | null = null;

  placedObjects() { return this.livePlacements?.() ?? null; }

  /** Set by the open terrain editor: its regions and cameras as its tabs hold them. */
  liveLists: (() => Promise<{ regions: readonly unknown[] | null; cameras: readonly unknown[] | null }>) | null = null;

  listedObjects() { return this.liveLists?.() ?? Promise.resolve(null); }

  private editListeners = new Set<(what: { terrain: boolean; objects: boolean }) => void>();

  onDidEdit(listener: (what: { terrain: boolean; objects: boolean }) => void) {
    this.editListeners.add(listener);
    return { dispose: () => { this.editListeners.delete(listener); } };
  }

  /** Called by the open terrain editor after each edit, undo and redo: tells the onDidEdit listeners (one that throws
   *  doesn't stop the others or the edit). */
  edited(what: { terrain: boolean; objects: boolean }) {
    for (const l of [...this.editListeners]) {
      try { l(what); } catch (e) { console.error(e); }
    }
  }

  /** Set by the open terrain editor: moves its camera to a point. */
  readonly look = new Map<string, (x: number, y: number, ref?: PlacedRef) => void>();
  /** Set by each open terrain editor, by its file: Reset Texture Variations, as one undo step; false when nothing changed. */
  readonly resetVariations = new Map<string, () => boolean>();
  /** Set by each open terrain editor, by its file: Reset Height Field and Adjust Cliff Levels. */
  readonly wholeMapGround = new Map<string, WholeMapGround>();
  /** Set by each open terrain editor, by its file: the View commands (command palette) on that editor. */
  readonly viewCommands = new Map<string, ViewCommands>();
  /** Set by each open terrain editor, by its file: Set Uniform Doodad Heights and Reset Fixed Object Heights. */
  readonly heightCommands = new Map<string, HeightCommands>();
  /** Set by each open terrain editor, by its file: Replace Cliff Type, Tiles, Doodads and Units. */
  readonly replaceTypes = new Map<string, ReplaceTypes>();
  /** A point to show once the terrain editor has opened. */
  pendingLook: [number, number, PlacedRef?] | null = null;
  /** Set by each open terrain editor that can be edited, by its file: its placed objects' drops, for the Item Drops tab. */
  readonly dropSources = new Map<string, DropsSource>();
  /** A drops source came or went (an editor opened, closed or reopened). */
  readonly dropSourcesChanged = new Listeners<void>();
  /** What the Item Drops tab is asked to edit (the Selection panel's Edit drops…): the objects, in the editor of `path`. */
  readonly dropsRequests = new Listeners<{ path: string; entries: readonly unknown[] }>();
  /** The last request, for a tab that opens because of it (taken by it). */
  pendingDrops: { path: string; entries: readonly unknown[] } | null = null;

  /** `open` brings up the terrain editor (for pickPoint). */
  constructor(private open: () => Promise<void>) {}

  registerToolGroup(group: TerrainToolGroup) {
    this.groups.push(group);
    this.listeners.forEach((l) => l());
    return {
      dispose: () => {
        this.groups = this.groups.filter((g) => g !== group);
        this.listeners.forEach((l) => l());
      },
    };
  }

  async pickPoint(opts: { prompt: string; objects?: PickObjects }): Promise<Point | undefined> {
    this.picking?.finish(undefined);
    const result = new Promise<Point | undefined>((resolve) => {
      this.picking = {
        prompt: opts.prompt, objects: opts.objects,
        finish: (p) => { this.picking = null; this.listeners.forEach((l) => l()); resolve(p); },
      };
    });
    this.listeners.forEach((l) => l());
    try {
      await this.open();
    } catch (e) {
      this.picking?.finish(undefined);
      throw e;
    }
    return result;
  }

  /** Registered groups in tab order. */
  all(): TerrainToolGroup[] {
    return [...this.groups].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }

  /** Calls `l` whenever groups are added or removed, or a pick starts or ends; returns the unsubscribe. */
  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
