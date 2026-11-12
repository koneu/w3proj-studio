// Enforce Camera Bounds and Enforce Water Height Limits for the AI tools (MCP): the terrain editor's rules in
// limits.ts, with the switches as they stand when a tool runs. A switch that is off leaves a tool as it was.

import type { Settings } from "../../extensions/api";
import { cameraRect, waterLimitHits, waterLimitText, type Bounds, type WaterWord } from "./limits";
import { SWITCH_DEFAULTS, switchedOn } from "./switches";

type Host = { settings: Pick<Settings, "get"> };

/** The bounds a tool's objects are held to: the map's camera bounds (its w3i, as read) with Enforce Camera Bounds on;
 *  none with it off, or when the map has no camera bounds to go by (as the terrain editor). */
export function toolBounds(w3: Host, info: { cameraBounds?: readonly number[] } | null | undefined): Bounds | null {
  return switchedOn(w3, "terrain.enforceCameraBounds", SWITCH_DEFAULTS["terrain.enforceCameraBounds"]) ? cameraRect(info) : null;
}

/** A tool's ground edit under Enforce Water Height Limits: what it says when it refuses the edit (the terrain editor's
 *  words), or null when the switch is off or no water was pushed to the limit. `before` and `after` are the terrain
 *  before and after the edit, `touched` the corners it changed. */
export function toolWaterRefusal(w3: Host, before: { corners: readonly WaterWord[] }, after: { corners: readonly WaterWord[] }, touched: readonly number[]): string | null {
  if (!switchedOn(w3, "terrain.enforceWaterLimits", SWITCH_DEFAULTS["terrain.enforceWaterLimits"])) return null;
  const words = (t: { corners: readonly WaterWord[] }) => touched.map((i) => ({ hasWater: t.corners[i]?.hasWater ?? false, rawWater: t.corners[i]?.rawWater ?? 0 }));
  const hits = waterLimitHits(words(before), words(after));
  return hits.length ? waterLimitText(hits.length) : null;
}
