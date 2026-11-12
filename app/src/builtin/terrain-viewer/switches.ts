// The World Editor's Advanced switches that are settings here: what each is until it is set. The same values stand in
// extension.json (switches.test.ts checks they agree), and they are the World Editor's own defaults (we-drive,
// 2026-11-11: Preserve Copied Object Height off, Enforce Camera Bounds on, Enforce Water Height Limits off;
// 2026-11-12: Reset Fixed Object Heights off, an unchecked item of the Advanced menu, see objheights.ts movedHeight).

import type { Settings } from "../../extensions/api";

export const SWITCH_DEFAULTS = {
  "terrain.preserveCopiedHeight": false,
  "terrain.enforceWaterLimits": false,
  "terrain.enforceCameraBounds": true,
  "terrain.resetFixedHeights": false,
} as const;

export type SwitchKey = keyof typeof SWITCH_DEFAULTS;

/** One of the Advanced switches: a boolean setting that is `standard` until it is set. */
export const switchedOn = (w3: { settings: Pick<Settings, "get"> }, key: string, standard: boolean) =>
  (standard ? w3.settings.get<boolean>(key, true) !== false : w3.settings.get<boolean>(key, false) === true);
