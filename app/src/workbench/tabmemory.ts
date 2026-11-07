// Open tabs are remembered per project in the webview's storage, under the project's root.

export const TABS_PREFIX = "w3.openEditors:";

/** The storage key for a project root (as the backend spells it: one spelling per folder). */
export const tabsKey = (root: string) => `${TABS_PREFIX}${root.replace(/[\\/]+$/, "").toLowerCase()}`;

export interface KeyValueStore { readonly length: number; key(i: number): string | null; getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/** Tab state saved before the root was normalised sits under another spelling of the same folder
 *  (the 8.3 short name, a symlink, `..`). Moves it to `root`'s key when `normalise` says the old key
 *  names the same folder, unless the key already has state. Returns how many keys were moved. */
export async function adoptOldTabKeys(store: KeyValueStore, root: string, normalise: (path: string) => Promise<string>): Promise<number> {
  const current = tabsKey(root);
  const old: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && k.startsWith(TABS_PREFIX) && k !== current) old.push(k);
  }
  let moved = 0;
  for (const k of old) {
    const same = await normalise(k.slice(TABS_PREFIX.length)).then((n) => tabsKey(n) === current, () => false);
    if (!same) continue;
    const value = store.getItem(k);
    // Only a key that moved goes: one the new key already outranks stays as it was.
    if (value !== null && store.getItem(current) === null) { store.setItem(current, value); store.removeItem(k); moved++; }
  }
  return moved;
}
