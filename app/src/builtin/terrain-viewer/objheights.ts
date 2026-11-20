// Heights of placed doodads, with no editor state: what a paste keeps of the height over the ground,
// Set Uniform Doodad Heights and Reset Selected Doodad Heights. A doodad with FIXED_HEIGHT (flag 4) has a
// height of its own; any other stands on the ground, and follows it when the ground is edited.

import { DEEP_WATER } from "../../lib/terrain/pathing";
import { floatingLevelAt, heightAt, type Terrain } from "../../lib/terrain/w3e";
import { FIXED_HEIGHT } from "./selectionkeys";

/** What of a placed object these functions read. */
export interface HeightHolder { position: readonly number[]; flags?: number }
/** What they change: the same two fields. */
export interface HeightChange { position: [number, number, number]; flags: number }

/** The flags a doodad has when none were read: placed, visible (as a new doodad). */
const PLAIN = 2;
const isFixed = (p: HeightHolder) => ((p.flags ?? 0) & FIXED_HEIGHT) !== 0;

/** A pasted doodad's height, as the World Editor's Preserve Copied Object Height has it (we-drive 2026-11-12, copies of
 *  an empty map with a raised part, saved and read back, the switch's check mark seen in the Advanced menu): on, every
 *  pasted doodad keeps the height it had where it was copied (`copied`, as stored), whatever the ground is where it
 *  lands (a fixed rock at 200 pasted onto ground 64 stayed at 200, one at 64 pasted onto ground 0 at 64, a plain one at
 *  0 sank into ground 64); off, every one stands on the ground (`ground`), fixed or not. */
export function pastedHeight(ground: number, copied: number, preserve: boolean): number {
  return preserve ? copied : ground;
}

/** A pasted doodad's flags, from the same runs: on, every pasted doodad has a fixed height (flags 2 became 6), so it
 *  holds the height it was given; off, none has (6 became 2), so the copy follows the ground like any doodad that was
 *  never given a height. The other flags stay. */
export function pastedFlags(flags: number, preserve: boolean): number {
  return preserve ? flags | FIXED_HEIGHT : flags & ~FIXED_HEIGHT;
}

/** Movement types (UnitData.slk `movetp`, object data `umvt`) whose units the game puts on the water surface:
 *  ships always, amphibious units where they are in water. */
const ON_WATER = new Set(["float", "amph"]);
export const goesOnWater = (moveType: string | undefined) => !!moveType && ON_WATER.has(moveType.toLowerCase());

/** The height the World Editor's save writes for an object of war3mapUnits.doo (a unit, building, item or start
 *  location) whose type moves by `moveType` (UnitData.slk `movetp`; undefined for items, start locations and types not
 *  known), over ground `ground` (heightAt) with the water's surface at `surface` (waterSurfaceAt; null without): the
 *  ground, whatever height the file had, except a ship (movetp "float") in water, at the surface. Verification round 3
 *  (2026-11-13, we-drive, the map saved and read back), on flat ground 0, a plateau at 256, a ramp, a lake with its bed
 *  at -128 and its surface at -89.6: footmen stored at 500 came out at 0, those stored at 0 on the plateau at 256, on the
 *  ramp at 64, in the lake at -128; gryphons (flying) stored at 0 and 500 at the ground too (256, -128): their flying
 *  height comes from their type; the transport ship in the lake at -89.6, the one on land stored at 300 at 0; naga
 *  (amphibious) stored at 0 and 300 in the lake at its bed, -128; an item stored at 500 in the lake at -128 and one on the
 *  plateau at 256; barracks at 256 and 0; the start location stored at 500 at 0. The same with Reset Fixed Object Heights
 *  off: that switch is about doodads. */
export function savedUnitZ(moveType: string | undefined, ground: number, surface: number | null): number {
  return moveType?.toLowerCase() === "float" && surface !== null && surface > ground ? surface : ground;
}

/** What of a unit type decides the ground the World Editor puts it on (Skin's fields of the same names). */
export interface ElevationType {
  /** Art - Elevation - Sample Points (UnitSkin.txt `elevPts`, field `uept`); absent for none. */
  elevPts?: number;
  /** Pathing - Collision Size (UnitBalance.slk `collision`, field `ucol`). */
  collision?: number;
  /** Stats - Is a Building (UnitBalance.slk `isbldg`, field `ubdg`). */
  building?: boolean;
  /** Art - Scaling Value in the graphics mode in use (UnitSkin.txt `modelScale`, `modelScale:hd`, field `usca`). */
  modelScale?: number;
}

/** A building's sample radius at a Scaling Value of 1. */
const BUILDING_SAMPLE = 16;

/** The ground the World Editor's save writes for an object of war3mapUnits.doo, before savedUnitZ's water rule, or
 *  null where that isn't known (Sample Points 3: no rule found). we-compare building-ground (branch we-compare-10,
 *  2026-11-18; make-building-ground.mjs: a plane rising 16 a tile east and 8 north, and a map of random corner heights
 *  with four of each type at random places and facings; and the 11 smoketest_maps the editor saved, 2152 objects):
 *  a type with Sample Points 2 or 4 is put on points round it, the first in its facing, the others evenly spread
 *  (Sample Points 2: in front and behind; 4: a cross turned with it); a building on the highest of them, at 16 times its
 *  Scaling Value from its centre (the goblin merchant 16, the farm 13.6, the mercenary camp 12.8 in SD and 16.8 in HD,
 *  a merchant with Scaling Value 2 at 32; neither the Sample Radius uerd, the collision size, the placed scale nor
 *  the model counts); any other unit on their mean, at its collision size (turtles 48 and 32, gryphons 8 with 2
 *  points, red dragons 48 with 2; a footman given 4 points 31; model scale and Sample Radius play no part). A type
 *  with none, 1 or 8 (foot units, the gold mine, items, start locations; custom footmen with 1 and 8) stands on the
 *  point under it (heightAt). A custom type goes by its own fields. `facing` is the placed angle in radians. */
export function unitGround(t: Terrain, x: number, y: number, facing: number, type: ElevationType | undefined): number | null {
  const n = type?.elevPts ?? 0;
  if (n === 3) return null;
  if (n !== 2 && n !== 4) return heightAt(t, x, y);
  const scale = Number.isFinite(type?.modelScale) ? type!.modelScale! : 1;
  const r = type?.building ? BUILDING_SAMPLE * scale : Number.isFinite(type?.collision) ? Math.max(0, type!.collision!) : 0;
  const angle = Number.isFinite(facing) ? facing : 0;
  const heights = Array.from({ length: n }, (_, k) => {
    const a = angle + (k * 2 * Math.PI) / n;
    return heightAt(t, x + r * Math.cos(a), y + r * Math.sin(a));
  });
  return type?.building ? Math.max(...heights) : heights.reduce((s, h) => s + h, 0) / n;
}

/** How far from savedUnitZ (over unitGround) a unit's stored height may be and still be left as it is by a save: 0.01
 *  (the editor counts in 32-bit numbers: its saves stand within 0.001 of the rule), 32 where unitGround doesn't know
 *  the editor's ground (Sample Points 3: more than the 7.6 seen off the point under it, less than a unit stored at 0
 *  on a plateau or a ship on the sea bed, which needs deeper water than DEEP_WATER). */
export function unitZTolerance(known: boolean): number {
  return known ? 0.01 : 32;
}

/** Whether a placed object's drawn height comes from its movement type rather than the height the placement file
 *  holds: any unit type with one (UnitData.slk `movetp`; buildings have "_"). */
export const heightByMoveType = (moveType: string | undefined) => !!moveType;

/** Where a unit is drawn in height. The World Editor places a unit by its type, not by the height the placement file
 *  holds (we-drive, 2026-11-09, on copies of 03_Water_Ford_Lake_Boats): at its flying height (UnitData.slk
 *  `moveHeight`, object data `umvh`: `lift.height`) over the ground under it (`lift.ground`, heightAt: the bed under
 *  water, the cliff as it's drawn), whatever its movement type: footmen stored at 0, 256 and 600 on ground 256 stood on
 *  the ground alike, as did gryphons (flying height 240) stored at those heights 240 over it; a footman and a banshee
 *  given 300 in the map's object data and a gryphon given 600 were drawn that high; a gryphon over the lake is 240 over
 *  its bed, its shadow close under it on the water. A floating or amphibious unit over water (`surface`, from
 *  waterSurfaceAt; null without) sits on the surface where that is higher (map 03's ships hold the sea bed's height).
 *  Without `lift` (an object whose type isn't known as a unit) the stored height counts. */
export function unitDrawHeight(moveType: string | undefined, stored: number, surface: number | null,
  lift?: { ground: number; height: number }): number {
  const base = lift && heightByMoveType(moveType) ? lift.ground + (Number.isFinite(lift.height) ? lift.height : 0) : stored;
  return goesOnWater(moveType) && surface !== null && surface > base ? surface : base;
}

/** Whether a unit is drawn swimming (the "swim" look of its model: Stand Swim, with the body under the surface and,
 *  in the classic models, a ripple ring): an amphibious unit where the water is deeper than units can walk
 *  (`ground`, `surface`: heights under it; DEEP_WATER, the pathing's). The World Editor (we-drive, 2026-11-08, map 03
 *  with naga at depths 24, 45, 62, 66 and 102) shows those at 62 and more swimming, the others standing. */
export function unitSwims(moveType: string | undefined, ground: number, surface: number | null): boolean {
  return moveType?.toLowerCase() === "amph" && surface !== null && surface - ground > DEEP_WATER;
}

/** The looks a placed unit stands in besides its type's Animprops: an Ancient placed uprooted in its model's
 *  Alternate animations (Stand Alternate: on its legs, roots out of the ground, as the World Editor shows it), a
 *  swimming unit in its Swim ones. */
export function unitLooks(uprooted: boolean, swimming: boolean): string[] {
  return [...(uprooted ? ["alternate"] : []), ...(swimming ? ["swim"] : [])];
}

/** A number typed for a height, or null: it has to be finite. A comma may be the decimal mark. */
export function parseHeight(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The height Set Uniform Doodad Heights gives a selection when none is typed: the mean of the doodads' heights, as
 *  the World Editor does (we-drive, 2026-11-11: three doodads went to 140.3125, their mean). Null for none. */
export function uniformDefaultHeight(doodads: readonly HeightHolder[]): number | null {
  if (!doodads.length) return null;
  let sum = 0;
  for (const p of doodads) sum += p.position[2];
  return sum / doodads.length;
}

/** Set Uniform Doodad Heights for one doodad: it stands at `z` with a height of its own. Null when it
 *  does so already. */
export function uniformHeight(p: HeightHolder, z: number): HeightChange | null {
  if (isFixed(p) && p.position[2] === z) return null;
  return { position: [p.position[0], p.position[1], z], flags: (p.flags ?? PLAIN) | FIXED_HEIGHT };
}

/** Reset Selected Doodad Heights for one object: if it has a height of its own, it goes onto the ground
 *  there (`ground` is the ground's height under it) and follows it again. Null for any other object. */
export function resetFixedHeight(p: HeightHolder, ground: number): HeightChange | null {
  if (!isFixed(p)) return null;
  return { position: [p.position[0], p.position[1], ground], flags: (p.flags ?? PLAIN) & ~FIXED_HEIGHT };
}

/** Multi-select "Drop to ground" for one object: puts it at `ground` and, for a doodad with a fixed height, clears
 *  FIXED_HEIGHT so it follows the ground again. Null when already there (and unfixed). */
export function dropToGround(p: HeightHolder, ground: number, isDoodad: boolean): Partial<HeightChange> | null {
  if (isDoodad && isFixed(p)) return resetFixedHeight(p, ground);
  if (p.position[2] === ground) return null;
  return { position: [p.position[0], p.position[1], ground] };
}

/** The height a doodad without a height of its own stands at, x, y: the ground there (heightAt), or for a floating type
 *  (Skin.floats) the water's level where floatingLevelAt finds water over its nearest corner; a destructable with an
 *  Elevation Sample Radius (`sampleRadius` > 0) the mean of the ground round it (ELEVATION_SAMPLE_OFFSET). The World
 *  Editor works it out again when it opens a map (we-compare doodad-water-z-open: lily pads and a ZPsh stored at 37.5
 *  came out at it; doodad-open-z: smoketest_maps' stored heights are all its own, copies raised by 37.5 went back), and
 *  Studio when a doodad moves (doodad-water-z-nudge). */
export function doodadGround(t: Terrain, x: number, y: number, floats: boolean, sampleRadius = 0): number {
  const water = floats ? floatingLevelAt(t, x, y) : null;
  if (water !== null) return water;
  if (sampleRadius > 0) {
    const d = ELEVATION_SAMPLE_OFFSET;
    return (heightAt(t, x - d, y - d) + heightAt(t, x + d, y - d) + heightAt(t, x - d, y + d) + heightAt(t, x + d, y + d)) / 4;
  }
  return heightAt(t, x, y);
}

/** Where the World Editor samples the ground for a destructable whose type has an Elevation Sample Radius
 *  (DestructableData `radius`, field `brad`; Skin.elevRadius): the mean of the ground at the four points this far
 *  off along both axes (doodadGround). we-compare doodad-open-z (2026-11-16, SD): every stone wall, gate and icy rock
 *  (radius 50) of smoketest_maps' SnowareBay, Hammerfall and Firebrand (75) and of make-doodad-open-z.mjs sits there,
 *  and so do types the map's original table gives a radius of 1, 25, 64 or 100 and the bridge YT00 (100); radius 0
 *  is the point itself, and so is any custom type, whatever its radius. */
export const ELEVATION_SAMPLE_OFFSET = 64;

/** The smallest Elevation Sample Radius whose ground isn't known: 128, 150 and the bridge YT04's 200 sample wider than
 *  ELEVATION_SAMPLE_OFFSET in a way not worked out (doodad-open-z, 2026-11-16). Opening a map keeps such a
 *  destructable's height; a move puts it at the radius-64 mean. */
export const ELEVATION_RADIUS_UNKNOWN = 128;

/** Where a doodad stands, and with what flags, after it was moved from `p` to a new x/y over ground of height `ground`.
 *  The World Editor's Advanced switch Reset Fixed Object Heights (Ctrl+Shift+H, on by default) decides, as we-drive
 *  showed on 2026-11-12 (a rock with flags 6 at 300 over ground 256, moved one step by Edit > Nudge Selection > Move
 *  Right, the map saved and read back): on, it came out at 256 (the ground) with flags 2, so a moved doodad follows
 *  the ground again; off, it came out at 300 with flags 6, keeping its own height. A doodad without a fixed height
 *  stands on the ground either way, and a fixed one that was not moved (`moved` false) stays as it is.
 *  Settled again the same day, as two runs had disagreed about the default: in a Wine prefix of its own (we-drive with
 *  W3PROJ_WE_DIR; the editor keeps the switch as "Reset Fixed Z When Moving Objects" in WorldEditPreferences.txt, so the
 *  shared prefix shows what the last run left) the item is checked, the file then says 1. A map with doodads of flags 6
 *  at 300 and 150 over flat ground 0 and at 400 and 350 over a slope rising 32 per 128 to the east, all selected and
 *  moved 64 by Edit > Nudge Selection > Move Right: on (the default), each landed on the ground where it stopped (0, 80
 *  and 144) with flags 2; switched off by a click on the item, each kept its height and flags 6. A plain doodad (flags
 *  2) on the slope went to the ground there (144) both ways. Turning in place (Rotate Right) changes neither. */
export function movedHeight(p: HeightHolder, ground: number, moved: boolean, resetFixed: boolean): { z: number; flags: number | undefined } {
  if (!isFixed(p)) return { z: ground, flags: p.flags };
  if (moved && resetFixed) return { z: ground, flags: (p.flags ?? PLAIN) & ~FIXED_HEIGHT };
  return { z: p.position[2], flags: p.flags };
}
