// What the checks of one Problems run share, so that a run reads each thing once: the map's documents
// (several checks read the object data and the placement files), and one lookup of the map's files,
// whose game paths are resolved in batches. A scope lives for one run only: the next run, and another
// project, start with nothing cached, so nothing found in one project's files is used for another's.

import type { W3Api } from "../../extensions/api";
import { readMapDoc, readMapDocStrict } from "../../lib/formats/mapdoc";
import { FileLookup } from "./checks";

export class RunScope {
  private docs = new Map<string, Promise<unknown>>();
  private files: FileLookup | null = null;
  /** `share` false: every call reads again, as without a scope (the control of the read-count test). */
  constructor(private w3: W3Api, private share = true) {}

  /** A map document as readMapDoc reads it, read once per run. Callers must not change it. */
  doc<T>(path: string): Promise<T | null> {
    if (!this.share) return readMapDoc<T>(this.w3, path);
    let p = this.docs.get(path);
    if (!p) {
      p = readMapDoc<T>(this.w3, path);
      this.docs.set(path, p);
    }
    return p as Promise<T | null>;
  }

  /** As readMapDocStrict: a document that is there but can't be read throws, an absent one is null. */
  docStrict<T>(path: string): Promise<T | null> {
    return readMapDocStrict<T>(this.w3, path, (_, p) => this.doc(p));
  }

  /** Starts reading these documents at once, instead of one after another as the checks ask. */
  async prefetch(paths: string[]): Promise<void> {
    if (this.share) await Promise.all(paths.map((p) => this.doc(p)));
  }

  /** The run's lookup of the map's and the game's files (made at first use). */
  lookup(): FileLookup {
    if (!this.share) return new FileLookup(this.w3);
    return (this.files ??= new FileLookup(this.w3));
  }
}

/** `f` over `items` with at most `limit` running at once; the results in the order of `items`. */
export async function mapLimit<T, R>(items: T[], limit: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
