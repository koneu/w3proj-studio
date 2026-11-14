// Enforce Water Height Limits for the AI tools (MCP): the terrain editor's rule in limits.ts, with the switch as it
// stands when a tool runs. The AI tools place and move objects wherever the editor does: no camera bounds hold them.

import type { Settings } from "../../extensions/api";
import { waterLimitHits, waterLimitText, type WaterWord } from "./limits";
import { SWITCH_DEFAULTS, switchedOn } from "./switches";

type Host = { settings: Pick<Settings, "get"> };

/** A tool's ground edit under Enforce Water Height Limits: what it says when it refuses the edit (the terrain editor's
 *  words), or null when the switch is off or no water was pushed to the limit. `before` and `after` are the terrain
 *  before and after the edit, `touched` the corners it changed. */
export function toolWaterRefusal(w3: Host, before: { corners: readonly WaterWord[] }, after: { corners: readonly WaterWord[] }, touched: readonly number[]): string | null {
  if (!switchedOn(w3, "terrain.enforceWaterLimits", SWITCH_DEFAULTS["terrain.enforceWaterLimits"])) return null;
  const words = (t: { corners: readonly WaterWord[] }) => touched.map((i) => ({ hasWater: t.corners[i]?.hasWater ?? false, rawWater: t.corners[i]?.rawWater ?? 0 }));
  const hits = waterLimitHits(words(before), words(after));
  return hits.length ? waterLimitText(hits.length) : null;
}
