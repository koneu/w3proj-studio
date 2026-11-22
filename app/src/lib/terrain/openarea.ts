// Where objects may be placed, moved or removed while only some subterrains are open (Open Subterrains…), for the
// tools that edit the placement files without the terrain editor's own mask (the AI tools, the Region tools): the
// backend refuses a write outside the open subterrains at the save, these say so before anything is changed.

import type { W3Api } from "../../extensions/api";
import { terrainFacts } from "../formats/mapdoc";
import { loadIdLayout } from "./creationids";
import { editableAt, loadOpenState, partialMask } from "./openset";

/** Whether world (x, y) lies in an open subterrain, or null when there is nothing to hold to (a flat project, or every
 *  subterrain open). A choice that can't be used (a damaged open-subterrains.json) is an error, never "all open". */
export async function openAreaTest(w3: W3Api): Promise<((x: number, y: number) => boolean) | null> {
  const root = w3.workspace.project()?.root;
  if (!root || !w3.workspace.files().some((f) => f.path.replace(/\\/g, "/").toLowerCase() === "map/terrain/terrain.json")) return null;
  const state = await loadOpenState((cmd, args) => w3.backend.invoke(cmd, args), root);
  if (state?.error) throw new Error(state.error);
  if (!state?.partial) return null;
  const [width, height] = state.corners;
  const mask = partialMask(state, width, height);
  // The canvas's origin: terrain.json's, else (an offset kept as bits) the assembled terrain's.
  const layout = await loadIdLayout(w3);
  let [ox, oy] = layout?.offset ?? [NaN, NaN];
  if (!Number.isFinite(ox) || !Number.isFinite(oy)) {
    const facts = await terrainFacts(w3);
    if (!facts) throw new Error("The terrain can't be read, so where the open subterrains lie can't be told.");
    [ox, oy] = [facts.offsetX, facts.offsetY];
  }
  if (w3.workspace.project()?.root !== root) throw new Error("The project changed meanwhile; nothing was changed.");
  return (x, y) => editableAt(mask, ox, oy, x, y);
}
