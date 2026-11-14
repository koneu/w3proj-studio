// The World Editor's Advanced switches that are settings here: what each is until it is set. The same values stand in
// extension.json (switches.test.ts checks they agree), and they are the World Editor's own defaults, read from its
// Advanced menu and its WorldEditPreferences.txt after the first start in a new, empty Wine prefix (we-drive with
// W3PROJ_WE_DIR, 2026-11-12): Preserve Copied Object Height off ("Preserve Z When Copying Objects=0"), Enforce Water
// Height Limits on ("Enforce Water Limits=1"), Enforce Camera Bounds on ("Enforce Camera Boundaries=1"), Reset Fixed
// Object Heights on ("Reset Fixed Z When Moving Objects=1"). The editor keeps these in WorldEditPreferences.txt, so a
// prefix shared by many runs shows what the last run left, not these (that is how Enforce Water Height Limits was
// once taken as off). Snap Doodads on Load and Fix Doodads on Load are no switches of the editor's: it always does
// them (doodadgrid.ts, doodadrules.ts).

import type { Settings } from "../../extensions/api";

export const SWITCH_DEFAULTS = {
  "terrain.preserveCopiedHeight": false,
  "terrain.enforceWaterLimits": true,
  "terrain.enforceCameraBounds": true,
  "terrain.resetFixedHeights": true,
  "terrain.doodads.snapOnLoad": true,
  "terrain.doodads.fixOnLoad": true,
  "terrain.units.groundOnSave": true,
} as const;

export type SwitchKey = keyof typeof SWITCH_DEFAULTS;

/** One of the Advanced switches: a boolean setting that is `standard` until it is set. */
export const switchedOn = (w3: { settings: Pick<Settings, "get"> }, key: string, standard: boolean) =>
  (standard ? w3.settings.get<boolean>(key, true) !== false : w3.settings.get<boolean>(key, false) === true);
