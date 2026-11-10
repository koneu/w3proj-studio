// Open tabs are remembered per project in the webview's storage, under the project's root.

import { isWindowsPath } from "../lib/paths";

export const TABS_PREFIX = "w3.openEditors:";

/** Case only counts where the file system tells it apart: a Windows path is compared in lower case, a Linux
 *  one as it is (two folders differing only in case are two projects there). */
const folded = (path: string) => (isWindowsPath(path) ? path.toLowerCase() : path);

/** The storage key for a project root (as the backend spells it: one spelling per folder). */
export const tabsKey = (root: string) => `${TABS_PREFIX}${folded(root.length > 1 ? root.replace(/[\\/]+$/, "") : root)}`;

const leaf = (path: string) => {
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!;
  return isWindowsPath(path) ? name.toLowerCase() : name;
};

/** Whether an old key's path could be another spelling of `root`: the same last folder name, or a
 *  short (8.3) name, which has a `~`. Others aren't asked about: resolving the path of an unrelated
 *  project on an offline share would hold the project open up. */
export const mayBeSameFolder = (oldPath: string, root: string) => leaf(oldPath) === leaf(root) || leaf(oldPath).includes("~");

/** An editor's view state is kept only up to this many characters of JSON: the tabs of every project share the
 *  webview's storage (a few MB). */
export const VIEW_STATE_LIMIT = 4096;

/** A view state as it is kept: a copy through JSON, or undefined for none, one that isn't JSON or one too big. */
export function keptView(view: unknown): unknown {
  if (view === undefined) return undefined;
  let json: string | undefined;
  try { json = JSON.stringify(view); } catch { return undefined; }
  return json === undefined || json.length > VIEW_STATE_LIMIT ? undefined : JSON.parse(json);
}

/** Whether a tab opens again when the graphics mode changes (EditorContribution.graphicsMode): an editor of the
 *  mode's art does, one that follows by itself doesn't, others for game files only (read in the mode). */
export function graphicsModeReopens(contribution: { graphicsMode?: "reopen" | "self" } | undefined, path: string): boolean {
  if (contribution?.graphicsMode === "self") return false;
  return contribution?.graphicsMode === "reopen" || path.startsWith("game:");
}

export interface KeyValueStore { readonly length: number; key(i: number): string | null; getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/** Tab state saved before the root was normalised sits under another spelling of the same folder
 *  (the 8.3 short name, a symlink, `..`). Moves it to `root`'s key when `normalise` says the old key
 *  names the same folder, unless the key already has state. Returns how many keys were moved. */
export async function adoptOldTabKeys(store: KeyValueStore, root: string, normalise: (path: string) => Promise<string>): Promise<number> {
  const current = tabsKey(root);
  const old: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k && k.startsWith(TABS_PREFIX) && k !== current && mayBeSameFolder(k.slice(TABS_PREFIX.length), root)) old.push(k);
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
