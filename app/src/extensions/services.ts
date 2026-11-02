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
