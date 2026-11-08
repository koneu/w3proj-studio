// Limits on object fields that come from Gameplay Constants, not from the field's own range. A unit's
// Movement Speed may be typed up to 522 (UnitMetaData), but the game clamps a moving unit's speed between
// MinUnitSpeed and MaxUnitSpeed (Units\MiscGame.txt, [Misc]; 150 and 400), or the building ones for a building.
// The unit's own Speed Minimum / Speed Maximum (umis, umas) replace the constant when they aren't 0
// (WorldEditStrings: "A value of zero means to use the default value (from Gameplay Constants)"). The game's
// Alchemist shows it: Speed Base 405 with Speed Maximum 522.
//
// Like the field ranges (limits.ts) these only warn: a value is always saved as typed.

import { parseIni } from "../formats/text";

/** The Gameplay Constants that limit a field. */
export const LIMIT_CONSTANTS = ["MaxUnitSpeed", "MinUnitSpeed", "MaxBldgSpeed", "MinBldgSpeed"] as const;
export type LimitConstant = (typeof LIMIT_CONSTANTS)[number];

/** A constant's value and where it comes from: the map's war3mapMisc.txt, or the game's files. */
export interface ConstantValue { value: number; from: "map" | "game" }
/** The constants as the map has them. A constant missing here isn't known (the map's value isn't a number, or
 *  the game's files couldn't be read): nothing is said about it then. */
export type GameplayLimits = Partial<Record<LimitConstant, ConstantValue>>;

/** The Gameplay Constants' labels (WESTRING_MISCVAL_MXUS & co.). */
const LABELS: Record<LimitConstant, string> = {
  MaxUnitSpeed: "Movement - Unit Speed - Maximum", MinUnitSpeed: "Movement - Unit Speed - Minimum",
  MaxBldgSpeed: "Movement - Building Speed - Maximum", MinBldgSpeed: "Movement - Building Speed - Minimum",
};

const misc = (text: string | null) => {
  if (text === null) return undefined;
  for (const [name, section] of parseIni(text)) if (name.toLowerCase() === "misc") return section;
  return undefined;
};
/** "400", "400 // comment"; anything else isn't a number. */
const numberOf = (raw: string) => {
  const t = raw.replace(/\s*\/\/.*$/, "").trim();
  const n = t === "" ? NaN : Number(t);
  return Number.isFinite(n) ? n : undefined;
};

/** The effective constants: the map's war3mapMisc.txt first (`map`, null when the map has none), then the game's
 *  files in the order given (the first that has a value wins, as for the Gameplay Constants editor: MiscGame.txt,
 *  then MiscData.txt). A value the map sets but that isn't a number leaves the constant unknown: what the game
 *  makes of it isn't known, and the game's default would be a guess. */
export function readGameplayLimits(map: string | null, game: readonly string[]): GameplayLimits {
  const own = misc(map), defaults = game.map(misc);
  const out: GameplayLimits = {};
  for (const name of LIMIT_CONSTANTS) {
    const key = name.toLowerCase();
    const mine = own?.get(key);
    if (mine !== undefined) {
      const value = numberOf(mine);
      if (value !== undefined) out[name] = { value, from: "map" };
      continue;
    }
    for (const d of defaults) {
      const raw = d?.get(key);
      if (raw === undefined) continue;
      const value = numberOf(raw);
      if (value !== undefined) out[name] = { value, from: "game" };
      break;
    }
  }
  return out;
}

/** What a value runs into. `setByMap` says the map made it so (it set the value, the unit's own
 *  minimum or maximum, or the constant): a value the game's data and defaults give alone isn't the map's to fix. */
export interface ConstantWarning { text: string; setByMap: boolean }

/** The object's other fields a limit depends on, as they are in effect for it (inherited or set), and
 *  whether the map sets them. */
export type FieldLookup = (id: string) => { value: number | string; set: boolean } | undefined;

/** A field value past a Gameplay Constant (or the unit's own clamp), or null. `set` says whether the map sets
 *  this value. Only Movement Speed (umvs) of units and buildings: 0 means the unit doesn't move and isn't
 *  clamped. */
export function constantWarning(field: string, value: number | string, set: boolean, limits: GameplayLimits, other: FieldLookup): ConstantWarning | null {
  if (field !== "umvs") return null;
  const speed = Number(value);
  if (!Number.isFinite(speed) || speed <= 0 || value === "") return null;
  const building = Number(other("ubdg")?.value) === 1;
  const side = (own: "umas" | "umis", constant: LimitConstant) => {
    const o = other(own), n = Number(o?.value);
    if (o && Number.isFinite(n) && n > 0) return { value: n, setByMap: o.set, says: `the unit's Speed ${own === "umas" ? "Maximum" : "Minimum"} (${own})` };
    const c = limits[constant];
    if (!c) return null;
    return { value: c.value, setByMap: c.from === "map", says: `Gameplay Constants: ${LABELS[constant]}, ${c.from === "map" ? "set by this map" : "the game's default"}` };
  };
  const max = side("umas", building ? "MaxBldgSpeed" : "MaxUnitSpeed");
  if (max && speed > max.value) {
    return { text: `The game moves it at ${max.value} at most (${max.says}).`, setByMap: set || max.setByMap };
  }
  const min = side("umis", building ? "MinBldgSpeed" : "MinUnitSpeed");
  if (min && speed < min.value) {
    return { text: `The game moves it at ${min.value} at least (${min.says}).`, setByMap: set || min.setByMap };
  }
  return null;
}

/** The game's files that hold the constants' defaults, in the order they count. */
export const GAME_CONSTANT_FILES = ["Units\\MiscGame.txt", "Units\\MiscData.txt"] as const;
/** The map's Gameplay Constants. */
export const MAP_CONSTANTS = "map/war3mapMisc.txt";
