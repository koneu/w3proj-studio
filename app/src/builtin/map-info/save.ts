// war3map.w3i as Map Properties' save writes it: the editor's values, with what the World Editor's save adds to them.

import { applyAllyPriorities, type PlayerInfo } from "../../lib/terrain/startlocations";
import { resizedCameraZoom } from "../../lib/terrain/resize";

/** Changes `info` (a copy of the editor's map info, about to be written) as the World Editor's save does:
 *  - without "Modify ally priorities" the ally priorities are worked out from the start locations;
 *  - a camera zoom of 0 in all three fields becomes 1250 in each (we-drive 2026-11-25, docs/testing/
 *    numeric-limits-measured.md "camera zoom": with the three Force ... camera zoom boxes unticked the save wrote 1250
 *    into all three, the map held 0; as Map Size and set_map_text do, resizedCameraZoom). A zoom already set stays.
 *  Only Map Properties' save does this: pack and unpack keep a map's 0 as it is. */
export function infoAsSaved(info: object): void {
  applyAllyPriorities(info as PlayerInfo & { flags: number });
  const doc = info as { cameraZoom?: Parameters<typeof resizedCameraZoom>[0] };
  const zoom = resizedCameraZoom(doc.cameraZoom);
  if (zoom) doc.cameraZoom = zoom;
}
