// Work that needs the whole map of a split project while some subterrains are closed (Open Subterrains…): Map Size and
// its undo and redo change every subterrain on the map's edges and write the map's files at another size, which a
// partial load can neither hold nor save. They run with every subterrain opened for them; afterwards the ones that were
// open are opened again, as they were chosen (those the resize cut away entirely left out).

import type { W3Api } from "../../extensions/api";
import { loadOpenState } from "./openset";

/** The parts of the app this uses (a fake in the tests). */
export type OpenAllApi = {
  workspace: Pick<W3Api["workspace"], "project" | "files">;
  editors: Pick<W3Api["editors"], "unsavedPaths">;
  commands: Pick<W3Api["commands"], "execute">;
  backend: Pick<W3Api["backend"], "invoke">;
  window: Pick<W3Api["window"], "showWarning" | "showInfo">;
};

/** The command that opens subterrains (terrain-layout): `{ names }` or `{ all }`; `quiet` leaves the message of a
 *  failure to the caller. */
export const OPEN_SUBTERRAINS = "w3.terrainLayout.openSubterrains";

const isSplit = (w3: OpenAllApi) => w3.workspace.files().some((f) => f.path.toLowerCase() === "map/terrain/terrain.json");

/** Runs `task` with every subterrain open. A flat project, or a split one with all of them open, runs it as it is.
 *  Otherwise: refused while an editor has unsaved changes (the terrain editor opens again, and what it holds would be
 *  lost), every subterrain opened (the terrain editor reopens on the whole map), `task` run, and the subterrains that
 *  were open opened again, whether `task` succeeded or not (its error passes on). One the task removed is left out;
 *  when none of them is left, or opening them again fails, every subterrain stays open and the user is told. */
export async function withAllSubterrainsOpen<T>(w3: OpenAllApi, what: string, task: () => Promise<T>): Promise<T> {
  const root = w3.workspace.project()?.root;
  if (!root || !isSplit(w3)) return task();
  const invoke = <R>(cmd: string, args: Record<string, unknown>) => w3.backend.invoke<R>(cmd, args);
  const state = await loadOpenState(invoke, root);
  if (state?.error) throw new Error(`${what}: ${state.error} Nothing was changed.`);
  if (!state?.partial) return task();
  const open = state.subterrains.filter((s) => s.open).map((s) => s.name);
  const unsaved = w3.editors.unsavedPaths();
  if (unsaved.length) throw new Error(`${what} opens every subterrain for the change, and ${unsaved.join(", ")} ${unsaved.length === 1 ? "has" : "have"} unsaved changes: save or discard them first. Nothing was changed.`);
  await w3.commands.execute(OPEN_SUBTERRAINS, { all: true, quiet: true }).catch((e: unknown) => {
    throw new Error(`${what}: the closed subterrains couldn't be opened for it (${(e as Error)?.message ?? e}). Nothing was changed.`);
  });
  try {
    return await task();
  } finally {
    await reopenChosen(w3, what, root, open);
  }
}

/** Opens `names` again (those still in the layout). */
async function reopenChosen(w3: OpenAllApi, what: string, root: string, names: string[]) {
  if (w3.workspace.project()?.root !== root) return;
  const invoke = <R>(cmd: string, args: Record<string, unknown>) => w3.backend.invoke<R>(cmd, args);
  try {
    const now = await loadOpenState(invoke, root);
    // Merged meanwhile (no layout left): nothing to close.
    if (!now) return;
    const there = new Set(now.subterrains.map((s) => s.name));
    const keep = names.filter((n) => there.has(n));
    if (!keep.length) {
      void w3.window.showInfo(`${what}: the subterrains that were open (${names.join(", ")}) are no longer in the layout, so every subterrain stays open.`);
      return;
    }
    if (keep.length === there.size) return;
    await w3.commands.execute(OPEN_SUBTERRAINS, { names: keep, quiet: true });
  } catch (e) {
    void w3.window.showWarning(`${what}: every subterrain stays open; the ones that were open (${names.join(", ")}) couldn't be chosen again: ${(e as Error)?.message ?? e}. Open Subterrains… chooses them.`);
  }
}
