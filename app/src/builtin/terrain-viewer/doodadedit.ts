// The World Editor's doodad rules (doodadgrid.ts: the grid and quarter turn; doodadrules.ts: the scale range) applied to
// a doodad or destructable as it is placed, pasted, moved, turned or scaled, as part of that edit, not only when a map
// opens. The same settings switch them: Snap Doodads on Load (terrain.doodads.snapOnLoad) the grid and the facing,
// Fix Doodads on Load (terrain.doodads.fixOnLoad) the scale (and on opening the flags, life and heights). What the editor does while editing (we-drive, 2026-11-13) is written in
// TESTING.md "Doodad rules while editing".

import { doodadOnGrid, doodadSnaps, openedUnitAngle, type PathSize } from "./doodadgrid";
import { doodadFixes, savedScale, type ScaleRule } from "./doodadrules";
import type { Placed } from "./objects";

/** What the rules know of the map: each switch, a type's pathing size (null: none; undefined: not read yet, so it
 *  stays where it is) and its scale rule (null: none, the scale stays). */
export interface DoodadRuleSource {
  snap: boolean;
  fix: boolean;
  size(id: string): PathSize | null | undefined;
  scaleRule(id: string): ScaleRule | null;
  /** A destructable type's fixed rotation in degrees (null: none; doodads have none here, doodadgrid.ts). */
  fixedRot?(id: string): number | null;
}

/** Where a doodad of type `id` asked to stand at (x, y) with `angle` goes: on its grid, turned to a quarter turn if its
 *  texture isn't square, a destructable to its type's fixed rotation, any other angle into 0..360 (doodadgrid.ts). As
 *  asked with snapping off; a type whose pathing size isn't known yet stays where it is asked, its facing ruled. */
export function doodadPose(rules: DoodadRuleSource, id: string, x: number, y: number, angle: number): { x: number; y: number; angle: number } {
  if (!rules.snap) return { x, y, angle };
  return doodadOnGrid(x, y, angle, rules.size(id) ?? null, rules.fixedRot?.(id) ?? null);
}

/** The scale a doodad of type `id` asked to have gets: within its type's range (doodadrules.ts; 0 a random one). As
 *  asked with fixing off or without a range. */
export function doodadScale(rules: DoodadRuleSource, id: string, scale: [number, number, number], random: () => number = Math.random): [number, number, number] {
  const rule = rules.fix ? rules.scaleRule(id) : null;
  return rule ? savedScale(scale, rule, random) : scale;
}

/** A doodad as these rules change it. Flag 4: a height of its own. */
export interface RuledEntry { id: string; position: number[]; angle: number; scale: [number, number, number]; flags?: number }

/** Applies the rules to a doodad in place: its place and facing (`place`) and its scale (`scale`). A doodad that moves and
 *  follows the ground (no flag 4) lands on it (`ground`). True when anything changed. */
export function settleDoodad(entry: RuledEntry, rules: DoodadRuleSource, ground: (x: number, y: number) => number,
  what: { place?: boolean; scale?: boolean }, random: () => number = Math.random): boolean {
  let changed = false;
  if (what.place) {
    const [x, y, z] = entry.position;
    const at = doodadPose(rules, entry.id, x, y, entry.angle);
    if (at.x !== x || at.y !== y) {
      entry.position = [at.x, at.y, (entry.flags ?? 0) & 4 ? z : ground(at.x, at.y)];
      changed = true;
    }
    if (at.angle !== entry.angle) { entry.angle = at.angle; changed = true; }
  }
  if (what.scale) {
    const scale = doodadScale(rules, entry.id, entry.scale, random);
    if (scale.some((v, i) => v !== entry.scale[i])) { entry.scale = scale; changed = true; }
  }
  return changed;
}

/** What opening a map goes by for its doodads: a type's pathing size (null: none) and fixed rotation (null: none), its
 *  scale rule (null: none, or the ranges can't be read), whether a place is outside the playable area (null: not
 *  known, flags stay), a type's object kind (w3d, w3b), and the ground's height. */
export interface OpenRuleSource {
  sizeOf(id: string): PathSize | null;
  fixedRot(id: string): number | null;
  scaleRule(id: string): ScaleRule | null;
  outside: ((x: number, y: number) => boolean) | null;
  kindOf(id: string): string | undefined;
  ground(x: number, y: number): number;
  /** Where a doodad of type `id` (drawn as `skinId` where the file names one) without a height of its own stands at
   *  (x, y): a floating one on the water (objheights.ts doodadGround). Absent: the types' data can't be read, and such
   *  doodads keep their heights; NaN for one whose ground isn't known, which keeps its height too. */
  restingZ?(id: string, x: number, y: number, skinId?: string): number;
}

/** How far a stored height may be from the one the World Editor works out and still be kept: the doodads without
 *  flag 4 of the maps of smoketest_maps fit Studio's ground (doodadGround) within 0.001 (2026-11-16, after the ramp and
 *  elevation radius rules of branch doodad-open-z-we: every one of the 26 maps), so a map the editor saved isn't
 *  rewritten for float noise. */
export const RESTING_Z_TOLERANCE = 0.01;

/** The skin a doodad of the file is drawn as (war3map.doo `skinId`, version 8 with skin ids and later), when it names one. */
const skinOf = (entry: Placed): string | undefined => {
  const s = (entry as Placed & { skinId?: unknown }).skinId;
  return typeof s === "string" && s ? s : undefined;
};

/** Snap Doodads on Load on a list as stored, in place (doodadgrid.ts doodadSnaps): each doodad on its grid and facing;
 *  one that moves and follows the ground (no flag 4) lands on it. `moved` hears of each one that moved. The number
 *  changed. Applied to its own result it changes nothing, so an AI tool's file and the save after it agree. */
export function snapAsOpened(list: Placed[], src: OpenRuleSource, moved?: (entry: Placed) => void): number {
  // A whole-number angle is degrees, -1 is 135°, for doodads and destructables alike (doodadgrid.ts openedAngle).
  const snaps = doodadSnaps(list, (id) => src.sizeOf(id), (id) => src.fixedRot(id));
  for (const { entry, x, y, angle } of snaps) {
    if (x !== entry.position[0] || y !== entry.position[1]) {
      const flags = (entry as Placed & { flags?: number }).flags ?? 0;
      const resting = flags & 4 ? entry.position[2] : src.restingZ?.(entry.id, x, y, skinOf(entry));
      entry.position = [x, y, resting !== undefined && Number.isFinite(resting) ? resting : src.ground(x, y)];
      moved?.(entry);
    }
    entry.angle = angle;
  }
  return snaps.length;
}

/** The facings the World Editor gives the entries of war3mapUnits.doo when it opens a map, in place (doodadgrid.ts
 *  openedUnitAngle: a whole number as degrees, -1 as 135°, then into 0..360). The number changed. Applied to its own
 *  result it changes nothing. */
export function unitAnglesAsOpened(list: Placed[]): number {
  let n = 0;
  for (const entry of list) {
    const angle = openedUnitAngle(entry.angle);
    if (angle === entry.angle || (Number.isNaN(angle) && Number.isNaN(entry.angle))) continue;
    entry.angle = angle;
    n++;
  }
  return n;
}

/** The heights the World Editor works out again for the doodads of a list when it opens a map, in place: each one
 *  without a height of its own (no flag 4) goes where `src.restingZ` puts it (a floating one on the water), unless
 *  it is within RESTING_Z_TOLERANCE of it already. The entries changed; none without `restingZ`. */
export function restAsOpened(list: Placed[], src: OpenRuleSource): Placed[] {
  const changed: Placed[] = [];
  if (!src.restingZ) return changed;
  for (const entry of list) {
    if (((entry as Placed & { flags?: number }).flags ?? 0) & 4) continue;
    const [x, y, z] = entry.position;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const want = src.restingZ(entry.id, x, y, skinOf(entry));
    if (!Number.isFinite(want) || Math.abs(want - z) <= RESTING_Z_TOLERANCE) continue;
    entry.position = [x, y, want];
    changed.push(entry);
  }
  return changed;
}

/** Fix Doodads on Load on a list as stored, in place (doodadrules.ts doodadFixes): the scale within the type's range,
 *  the outside and solid flags, the life the World Editor writes for the type's kind, and the height of each one that
 *  follows the ground (restAsOpened). The number changed. Applied to its own result it changes nothing. */
export function fixAsOpened(list: Placed[], src: OpenRuleSource, random: () => number = Math.random): number {
  type Ruled = Placed & { flags?: number; life?: number };
  const fixes = doodadFixes(list as Ruled[], (id) => src.scaleRule(id), src.outside, random, (id) => src.kindOf(id));
  for (const { entry, scale, flags, life } of fixes) {
    entry.scale = scale;
    if (life !== undefined) entry.life = life;
    if (flags !== undefined) entry.flags = flags;
  }
  return new Set<Placed>([...fixes.map((f) => f.entry), ...restAsOpened(list, src)]).size;
}

/** The facing a turn key gives a doodad of type `id` facing `angle`, turned by `by` (radians): one whose texture isn't
 *  square, or a square one of more than one colour (`mixed`), turns a whole quarter that way, as in the World Editor
 *  (three presses turned its log from 0° to 270°; one press of a 4×4 ring picture 270° to 0°, two of a 2×2 diagonal
 *  270° to 90°, doodad-turn-we spec), where a smaller turn would round back; anything else by `by`. */
export function doodadTurn(rules: DoodadRuleSource, id: string, angle: number, by: number): number {
  const size = rules.snap ? rules.size(id) : null;
  const square = !size || !(size.width >= 1) || !(size.height >= 1) || (size.width === size.height && !size.mixed);
  return square || by === 0 ? angle + by : angle + Math.sign(by) * (Math.PI / 2);
}

/** How many nudges (selectionkeys.ts: 8) long a nudge is for something on a 64 grid: a building, and a doodad with a
 *  pathing texture (we-drive 2026-11-13: tree and farm 64, footman and a doodad without pathing 8). */
export const GRID_NUDGE_STEPS = 8;

/** How many nudges long a nudge of a doodad of type `id` is: its grid's step (64) when it snaps, so that a smaller
 *  one doesn't round back where it was. */
export function doodadNudgeSteps(rules: DoodadRuleSource, id: string): number {
  const size = rules.snap ? rules.size(id) : null;
  return size && size.width >= 1 && size.height >= 1 ? GRID_NUDGE_STEPS : 1;
}

/** How many nudges long a nudge of any placed object is: a building's (`building`) and a start location's a whole 64
 *  (verification round 3, 2026-11-13: three presses of the number pad's 6 moved a start location from -2176 to -1984),
 *  a doodad's what doodadNudgeSteps gives (`doodad`, null for anything that isn't a doodad), anything else one. */
export function placedNudgeSteps(id: string, building: boolean, doodad: number | null): number {
  if (building || id === "sloc") return GRID_NUDGE_STEPS;
  return doodad ?? 1;
}
