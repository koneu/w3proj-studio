// The Object Editor's list of standard objects: the game's objects of a kind the map doesn't change,
// grouped as the object browser's first facet (race, category, class).

import type { KindData } from "../../lib/objects/metadata";

export interface StandardGroup { label: string; ids: string[] }

/** The standard objects not in `skip`, in groups ordered by label; ids stay in table order. */
export function standardGroups(kind: Pick<KindData, "baseIds" | "facetDefs" | "facets">, skip: ReadonlySet<string>): StandardGroup[] {
  const facet = kind.facetDefs[0]?.id;
  const groups = new Map<string, string[]>();
  for (const id of kind.baseIds) {
    if (skip.has(id)) continue;
    const label = (facet && kind.facets(id)[facet]) || "—";
    let ids = groups.get(label);
    if (!ids) groups.set(label, (ids = []));
    ids.push(id);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([label, ids]) => ({ label, ids }));
}
