// What the Object Editor's model preview shows besides the model: the type's replaceable texture, the player colour,
// and an ability's art (its models are in the Profile "art" fields, not in a field of its own).

import { skinTextures } from "../../lib/model/replaceable";

/** An ability's model fields: caster, target, special, effect, area effect and missile art. */
export const ABILITY_ART: readonly { id: string; label: string }[] = [
  { id: "acat", label: "Caster art" }, { id: "atat", label: "Target art" }, { id: "asat", label: "Special art" },
  { id: "aeat", label: "Effect art" }, { id: "aaea", label: "Area effect art" }, { id: "amat", label: "Missile art" },
];

/** The model a (comma-separated) art value names: its first entry, none for an empty or "_" one. */
export function firstModel(value: string): string | null {
  const path = value.split(",")[0]?.trim();
  return !path || path === "_" ? null : path;
}

/** Which of an ability's art fields have a model, given a reader of a field's value. The chosen one, if it has one,
 *  else the first that has; null when none does. */
export function abilityArt(has: (id: string) => string, chosen?: string): { id: string; path: string } | null {
  const order = chosen ? [chosen, ...ABILITY_ART.map((a) => a.id)] : ABILITY_ART.map((a) => a.id);
  for (const id of order) {
    const path = firstModel(has(id));
    if (path) return { id, path };
  }
  return null;
}

/** The replaceable textures of an object type: its own (btxi / btxf), unless the user picked a file for id `id`. */
export function previewTextures(own: { texId: number; texFile: string }, pick?: { id: number; path: string }): Record<number, string> {
  return { ...skinTextures(own), ...(pick && pick.id > 0 && pick.path ? { [pick.id]: pick.path } : {}) };
}

/** The player colour to show: the user's choice, else the type's own (UnitSkin teamColor, a number from 0), else red. */
export function previewTeam(chosen: number | null, own: number | null | undefined): number {
  const ok = (n: number | null | undefined): n is number => n !== null && n !== undefined && Number.isInteger(n) && n >= 0 && n < 24;
  return ok(chosen) ? chosen : ok(own) ? own : 0;
}
