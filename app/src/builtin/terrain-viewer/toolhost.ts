// The "w3.terrain" service: tool groups other extensions add to the terrain
// editor (see extensions/services.ts). Open editors follow registrations.

import type { TerrainService, TerrainToolGroup } from "../../extensions/services";

export class TerrainToolRegistry implements TerrainService {
  private groups: TerrainToolGroup[] = [];
  private listeners = new Set<() => void>();

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

  /** Registered groups in tab order. */
  all(): TerrainToolGroup[] {
    return [...this.groups].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }

  /** Calls `l` whenever groups are added or removed; returns the unsubscribe. */
  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
