// Which skills the AI Editor offers for a hero: the hero's own Hero Abilities list where the map changes it,
// else its base unit's from the game (a custom hero made from the Paladin learns the Paladin's skills).

interface Mod { field?: string; value: unknown }
interface UnitEntry { id?: string; base: string; mods?: Mod[]; sets?: { mods: Mod[] }[] }
export interface UnitData { custom?: readonly unknown[]; original?: readonly unknown[] }

/** The unit field holding a hero's skills (UnitMetaData: heroAbilList). */
const HERO_ABILITIES = "uhab";

/** A hero's skills. `game`: unit id → skills from Units\UnitAbilities.slk; `units`: the map's unit data
 *  (war3map.w3u as JSON), or null. Empty for an id nothing knows. */
export function heroSkillsOf(hero: string, game: ReadonlyMap<string, string[]>, units: UnitData | null): string[] {
  const entries = (list: readonly unknown[] | undefined) => (list ?? []) as readonly UnitEntry[];
  const custom = entries(units?.custom).find((o) => o.id === hero);
  const entry = custom ?? entries(units?.original).find((o) => (o.id ?? o.base) === hero && !custom);
  const mods = entry ? [...(entry.mods ?? []), ...(entry.sets ?? []).flatMap((s) => s.mods ?? [])] : [];
  const own = mods.find((m) => m.field === HERO_ABILITIES);
  if (own) return String(own.value).split(",").map((s) => s.trim()).filter((s) => s && s !== "_");
  return game.get(custom ? custom.base : hero) ?? [];
}
