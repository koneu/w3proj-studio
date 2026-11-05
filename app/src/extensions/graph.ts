// Which extensions rest on which.

import type { ExtensionManifest } from "./api";

type Manifest = Pick<ExtensionManifest, "id" | "extensionDependencies">;

/** The extensions `id` needs directly. */
export const requires = (id: string, all: Manifest[]): string[] => all.find((m) => m.id === id)?.extensionDependencies ?? [];

/** The extensions that stop working without `id`: those that need it, and those that need them. */
export function neededBy(id: string, all: Manifest[]): string[] {
  const out = new Set<string>();
  const add = (of: string) => {
    for (const m of all) {
      if (m.id !== id && !out.has(m.id) && m.extensionDependencies?.includes(of)) { out.add(m.id); add(m.id); }
    }
  };
  add(id);
  return [...out];
}

/** What keeps `id` from working: extensions it needs, directly or not, that are missing or off. */
export function blockedBy(id: string, all: Manifest[], disabled: ReadonlySet<string>): string[] {
  const out = new Set<string>(), seen = new Set<string>([id]);
  const walk = (of: string) => {
    for (const dep of requires(of, all)) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      if (disabled.has(dep) || !all.some((m) => m.id === dep)) out.add(dep);
      walk(dep);
    }
  };
  walk(id);
  return [...out];
}
