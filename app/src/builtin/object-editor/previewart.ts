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

/** The models a (comma-separated) value lists, in order; empty entries and "_" are left out. */
export function modelList(value: string): string[] {
  return value.split(",").map((p) => p.trim()).filter((p) => p && p !== "_");
}

/** The model at `index` of the value's list; the first when the index is out of range (the list changed). */
export function modelAt(value: string, index = 0): string | null {
  const list = modelList(value);
  return list[index] ?? list[0] ?? null;
}

/** Which of an ability's art fields have a model, given a reader of a field's value. The chosen one, if it has one,
 *  else the first that has; null when none does. `index` picks among the models of a comma list in the field found. */
export function abilityArt(has: (id: string) => string, chosen?: string, index = 0): { id: string; path: string } | null {
  const order = chosen ? [chosen, ...ABILITY_ART.map((a) => a.id)] : ABILITY_ART.map((a) => a.id);
  for (const id of order) {
    const path = modelAt(has(id), index);
    if (path) return { id, path };
  }
  return null;
}

/** The choices of a preview, and what resets them: they belong to one object, a different one starts at its defaults. */
export interface PreviewPicks { key: string | null; team: number | null; texture: number | null; art: string | undefined; model: number }
export function freshPicks(): PreviewPicks { return { key: null, team: null, texture: null, art: undefined, model: 0 }; }
/** Resets `picks` (in place) when `key` isn't the object they were made for; returns whether it did. */
export function syncPicks(picks: PreviewPicks, key: string): boolean {
  if (picks.key === key) return false;
  Object.assign(picks, freshPicks(), { key });
  return true;
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
