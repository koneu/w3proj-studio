// Refused values: what a placed object may be given, typed in the Selection panel or the Edit all fields, or asked of
// the AI tools, checked before anything changes. A value past these is refused with a message and the map stays as it
// was: not clamped, wrapped or rounded to the nearest one that fits (decision 2026-11-15; TESTING.md "Refused values").

import type { Area } from "../../lib/terrain/area";
import { storableFloat32 } from "../../lib/formats/float32";

/** What is given to a placed object; anything left out isn't checked. */
export interface PlacedValues {
  x?: number; y?: number; z?: number;
  /** Degrees. Any finite angle is stored as it is (in radians): a whole turn more is the same facing. */
  facing?: number;
  scale?: readonly number[];
  variation?: number;
  /** How many variations the type has (1 when unknown). */
  numVar?: number;
  /** The owner, counted from 0 (player 1) to 27 (Neutral Passive). */
  player?: number;
}

/** The placement files store positions, facings and scales as 32-bit floats: past them a number is stored as infinity. */
const storable = storableFloat32;

/** A tool's number setting: `fallback` when it isn't given; else it has to be a number from `min` to `max` (whole with
 *  `whole`; `above`: past `min`, not on it), or the tool is refused with what it takes, not held to the nearest end. */
export function givenNumber(name: string, v: unknown, o: { min: number; max: number; fallback: number; whole?: boolean; above?: boolean }): number {
  if (v === undefined) return o.fallback;
  const ok = typeof v === "number" && Number.isFinite(v) && (o.above ? v > o.min : v >= o.min) && v <= o.max && (!o.whole || Number.isInteger(v));
  if (ok) return v as number;
  const low = o.above ? `above ${o.min}` : `from ${o.min}`;
  const high = o.max === Infinity ? (o.above ? "" : " up") : o.above ? `, up to ${o.max}` : ` to ${o.max}`;
  throw new Error(`${name} must be ${o.whole ? "a whole number" : "a number"} ${low}${high}.`);
}

/** What is said of a variation the type hasn't got. */
export const variationText = (numVar: number) =>
  numVar > 1 ? `variation goes from 0 to ${numVar - 1} for this type.` : "this type has one variation: 0.";

/** Why the values can't be given, or null. `map`: the whole map (its corners' extent); x and y past it are refused. */
export function placedValueProblem(v: PlacedValues, map: Area | null): string | null {
  for (const k of ["x", "y", "z", "facing"] as const) {
    const n = v[k];
    if (n !== undefined && !storable(n)) return `${k} must be a number.`;
  }
  if (map && v.x !== undefined && (v.x < map.left || v.x > map.right)) return `x ${v.x} is off the map (x goes from ${map.left} to ${map.right}).`;
  if (map && v.y !== undefined && (v.y < map.bottom || v.y > map.top)) return `y ${v.y} is off the map (y goes from ${map.bottom} to ${map.top}).`;
  // 0 is a size of its own: a doodad's random one in its type's range, as the World Editor saves it (doodadrules.ts).
  if (v.scale && v.scale.some((s) => !storable(s) || s < 0)) return "scale must be a number from 0 up.";
  if (v.variation !== undefined) {
    const n = v.numVar ?? 1;
    if (!(Number.isInteger(v.variation) && v.variation >= 0 && v.variation < n)) return variationText(n);
  }
  if (v.player !== undefined && !(Number.isInteger(v.player) && v.player >= 0 && v.player <= 27)) return "the owner is player 1 to 28.";
  return null;
}
