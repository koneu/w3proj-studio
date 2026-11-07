import type { PlacedRef } from "./pickmatch";
// The "w3.terrain" service: tool groups other extensions add to the terrain
// editor (see extensions/services.ts). Open editors follow registrations.
// Also picks a point on the map for other modules (trigger parameters).

import type { TerrainService, TerrainToolGroup } from "../../extensions/services";

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
  look: ((x: number, y: number, ref?: PlacedRef) => void) | null = null;
  /** Set by each open terrain editor, by its file: Reset Texture Variations, as one undo step; false when nothing changed. */
  readonly resetVariations = new Map<string, () => boolean>();
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
