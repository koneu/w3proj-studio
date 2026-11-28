// A cache of what is read from the game's files, which differ by graphics mode (Classic, HD and DE share paths).

/** Values by graphics mode and key. One whose mode changed while it was made (its reads may be of both modes)
 *  isn't kept, nor is a make that failed (rejected): the next ask makes it again, so one flaky read doesn't stick
 *  for the session. A make that catches inside and resolves to a fallback keeps that fallback. */
export class ModeCache<T> {
  private entries = new Map<string, Promise<T>>();
  /** Every cache made, to empty them all when the game's files are read again (`clearAll`). */
  private static all = new Set<WeakRef<ModeCache<unknown>>>();

  constructor() { ModeCache.all.add(new WeakRef(this as ModeCache<unknown>)); }

  /** Empties every cache: the game's files were read again (w3.game.reload), so what was made from them is stale. */
  static clearAll(): void {
    for (const ref of ModeCache.all) {
      const c = ref.deref();
      if (c) c.clear(); else ModeCache.all.delete(ref);
    }
  }

  /** The value for `key` in the mode now, made by `make` the first time. `keep`: asked when `make` is done, false when
   *  the value mustn't be kept (it was made from a file the map imports, see `trackImports`): the caller gets it, the
   *  next ask makes it again. */
  get(mode: () => string, key: string, make: () => Promise<T>, keep?: () => boolean): Promise<T> {
    const m = mode(), k = `${m}|${key}`;
    let p = this.entries.get(k);
    if (!p) {
      const made = make();
      p = made;
      this.entries.set(k, made);
      const settle = () => { if ((mode() !== m || keep?.() === false) && this.entries.get(k) === made) this.entries.delete(k); };
      made.then(settle, () => { if (this.entries.get(k) === made) this.entries.delete(k); });
    }
    return p;
  }

  get size(): number { return this.entries.size; }

  /** Forgets every value (a reload of the files it was read from). */
  clear(): void { this.entries.clear(); }
}

/** Bytes read from a file the map imports (not the game's): what a cache made from them must not keep, as the next
 *  project, or the same one after the import changed, reads other files under that path. */
const importBytes = new WeakSet<Uint8Array>();

/** Notes `bytes` as read from a map's import (projectfiles.ts readImport); returns them. */
export function markImport(bytes: Uint8Array): Uint8Array { importBytes.add(bytes); return bytes; }

/** A reader that notes whether any file it read was a map's import: pass `read` to what makes the value and `() => !own()`
 *  as `keep` of ModeCache.get, so a value made from an import isn't served to another project or after the import changed.
 *  Values made from the game's files only stay cached. */
export function trackImports(read: (path: string) => Promise<Uint8Array>): { read: (path: string) => Promise<Uint8Array>; own: () => boolean } {
  let own = false;
  return { read: async (path) => { const b = await read(path); if (importBytes.has(b)) own = true; return b; }, own: () => own };
}
