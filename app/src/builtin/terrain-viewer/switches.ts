// The World Editor's Advanced switches that are settings here: what each is until it is set. The same values stand in
// extension.json (switches.test.ts checks they agree), and they are the World Editor's own defaults (we-drive,
// 2026-11-11: Preserve Copied Object Height off, Enforce Camera Bounds on, Enforce Water Height Limits off).

export const SWITCH_DEFAULTS = {
  "terrain.preserveCopiedHeight": false,
  "terrain.enforceWaterLimits": false,
  "terrain.enforceCameraBounds": true,
} as const;

export type SwitchKey = keyof typeof SWITCH_DEFAULTS;
