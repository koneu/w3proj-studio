// What the World Editor writes of a doodad's or destructable's scale and flags, besides its place (doodadgrid.ts).
// Measured with we-drive (2026-11-13, a copy of empty_map_on_newest_world_editor.w3m with 200 doodads, opened and
// saved by the editor; doodadrules.test.ts has the measured cases) and borne out by all 50 513 doodads of the 14 maps
// of smoketest_maps, which already fit both rules:
// - the scale goes into its type's minScale..maxScale (DestructableSkin.txt / DoodadSkins.txt, a map's own object
//   data on top: w3d dmis/dmas, w3b bmis/bmas). A doodad's each axis on its own (2, 1, 1.3 of a 0.8 to 1.2 type is
//   saved as 1.2, 1, 1.2); a destructable's x for all three (1, 1.3, 2 of the barrel's 1.1 to 1.5 is 1.1, 1.1, 1.1).
//   Signed: -1 is below the least and becomes it. A type of one scale (ZZdt, 1 to 1) is always saved at it. A scale
//   of 0 is replaced by a random one within the range (a destructable's x, a doodad's each axis: three different);
// - the flags: bit 0 is set outside the playable area (the edge itself is inside: x 3328 of a playable -3328..3328
//   isn't outside, 3328.5 is), cleared inside; bit 1 is always set (0 and 1 are saved as 2, 4 and 5 as 6); bit 2
//   (a height of its own) stays. Higher bits weren't tried and are left as they are.
// Not tried: a type whose minScale is above its maxScale (the game's tree bridges LTt0 have both orders), so no
// range is taken from one (objects.ts scaleRange); only one axis 0.

/** A placed type's scale rule: its object data file (w3d doodads, w3b destructables) and its range. */
export interface ScaleRule { kind: string; min: number; max: number }

/** The flag the World Editor sets on a doodad outside the playable area. */
export const OUTSIDE_FLAG = 1;
/** The flag it always sets. */
export const SOLID_FLAG = 2;

/** The flags the World Editor writes for a doodad stored with `flags`, outside the playable area or not. */
export function savedFlags(flags: number, outside: boolean): number {
  return (flags & ~(OUTSIDE_FLAG | SOLID_FLAG)) | SOLID_FLAG | (outside ? OUTSIDE_FLAG : 0);
}

/** The scale the World Editor writes for one stored as `scale` of a type with rule `rule`. Values it keeps are
 *  returned as they were (compared in single precision, as the file stores them: the JSON's 1.1 is the file's 1.1). */
export function savedScale(scale: readonly [number, number, number], rule: ScaleRule, random: () => number = Math.random): [number, number, number] {
  const { min, max } = rule;
  const lo = Math.fround(min), hi = Math.fround(max);
  const one = (v: number): number => {
    if (Number.isNaN(v)) return min;
    if (v === 0) return min + random() * (max - min);
    const f = Math.fround(v);
    return f < lo ? min : f > hi ? max : v;
  };
  if (rule.kind === "w3b") {
    const s = one(scale[0]);
    const keep = (v: number) => (Math.fround(v) === Math.fround(s) ? v : s);
    return [keep(scale[0]), keep(scale[1]), keep(scale[2])];
  }
  return [one(scale[0]), one(scale[1]), one(scale[2])];
}

/** A doodad as the rules read it. */
export interface RuledDoodad { id: string; position: readonly number[]; scale: [number, number, number]; flags?: number }

/** The doodads of a list whose scale or flags the World Editor would write otherwise, with what it writes. `ruleOf`:
 *  an id's scale rule (null: the type has none, the scale stays); `outside`: whether a place is outside the playable
 *  area (null: not known, the flags stay). */
export function doodadFixes<T extends RuledDoodad>(list: readonly T[], ruleOf: (id: string) => ScaleRule | null,
  outside: ((x: number, y: number) => boolean) | null, random: () => number = Math.random): { entry: T; scale: [number, number, number]; flags: number | undefined }[] {
  const out: { entry: T; scale: [number, number, number]; flags: number | undefined }[] = [];
  for (const entry of list) {
    const rule = ruleOf(entry.id);
    const scale = rule ? savedScale(entry.scale, rule, random) : entry.scale;
    const flags = entry.flags !== undefined && outside ? savedFlags(entry.flags, outside(entry.position[0], entry.position[1])) : entry.flags;
    if (flags !== entry.flags || scale.some((v, i) => v !== entry.scale[i])) out.push({ entry, scale, flags });
  }
  return out;
}
