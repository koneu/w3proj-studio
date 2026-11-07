import type { PlacedRef } from "./pickmatch";
// The "w3.terrain" service: tool groups other extensions add to the terrain
// editor (see extensions/services.ts). Open editors follow registrations.
// Also picks a point on the map for other modules (trigger parameters).

import type { TerrainService, TerrainToolGroup } from "../../extensions/services";

/** The View commands of one open terrain editor. Each returns what to tell the person when it can't run, else null. */
export interface ViewCommands {
  viewSelection(): string | null;
  viewEntireMap(): void;
  selectInPalette(): Promise<string | null>;
  /** Pathing - Naval, Height Map, Camera Objects: flips the layer and returns whether it's shown now. */
  toggleLayer(layer: "naval" | "heights" | "cameras"): boolean;
  /** Small, Medium or Large Grid Display: the same size again switches the grid off. Returns the grid shown now. */
  toggleGrid(size: "small" | "medium" | "large"): "none" | "small" | "medium" | "large";
  /** What is shown, for the status line and tests. */
  state(): { grid: "none" | "small" | "medium" | "large"; naval: boolean; heights: boolean; cameras: boolean; camera: { target: [number, number, number]; distance: number } };
}

type Point = { x: number; y: number; object?: unknown };
type PickObjects = { file: "units" | "doodads"; accept(entry: unknown): boolean; radius?: number };

export class TerrainToolRegistry implements TerrainService {
  private groups: TerrainToolGroup[] = [];
  private listeners = new Set<() => void>();
  /** The pick in progress: its prompt and how it ends. */
  picking: { prompt: string; objects?: PickObjects; finish(p: Point | undefined): void } | null = null;

  /** Set by the open terrain editor: its live placements. */
  livePlacements: (() => { units: unknown[]; doodads: unknown[] }) | null = null;

  placedObjects() { return this.livePlacements?.() ?? null; }

  /** Set by the open terrain editor: moves its camera to a point. */
  readonly look = new Map<string, (x: number, y: number, ref?: PlacedRef) => void>();
  /** Set by each open terrain editor, by its file: Reset Texture Variations, as one undo step; false when nothing changed. */
  readonly resetVariations = new Map<string, () => boolean>();
  /** Set by each open terrain editor, by its file: the View commands (command palette) on that editor. */
  readonly viewCommands = new Map<string, ViewCommands>();
  /** A point to show once the terrain editor has opened. */
  pendingLook: [number, number, PlacedRef?] | null = null;

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
