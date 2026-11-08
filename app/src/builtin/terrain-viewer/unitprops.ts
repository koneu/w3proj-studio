// Properties of a placed object, as the World Editor's Unit Properties and Destructable Properties
// have them: hit points, mana, gold, hero level, attributes and skills, inventory, target acquisition,
// waygate destination, colour and items dropped on death. Which apply depends on the object's type
// (TypeFacts, from the game's and the map's object data). The fields are those of war3mapUnits.doo
// and war3map.doo (crates/w3proj/formats/units.json, doodads.json); a field the file's version doesn't
// have is never added, and a value the World Editor writes as "default" (-1) stays it until changed.
// Each change is checked first and refused whole, so several objects are changed all or none.

import type { Placed } from "./objects";

/** "Default" in the file: the type's own value (hit points, mana), the owner's colour, no table. */
export const DEFAULT = -1;
/** Target acquisition: -1 the type's own range, -2 "camp" (the creeps' guard range; the script makes it 200). */
export const ACQUIRE_NORMAL = -1, ACQUIRE_CAMP = -2;
/** The range a "camp" gives in the game: the World Editor's script sets this (lib/script/units.ts). */
export const CAMP_RANGE = 200;
/** Limits of what is typed. The game stores these as 32-bit numbers; the tools (MCP place_objects) use the same. */
export const MAX_GOLD = 1000000, MAX_MANA = 1000000, MAX_ACQUIRE = 5000, MAX_ATTRIBUTE = 100000;
/** Player colours 0 to 23 (Red to Peanut). */
export const COLORS = 24;

export interface SkillInfo {
  id: string;
  /** Levels the skill has (AbilityData levels). */
  levels: number;
  /** Hero level its first level needs (reqLevel; 0 counts as 1). */
  req: number;
  /** Hero levels between its levels (levelSkip; 0: the gameplay constant HeroAbilityLevelSkip). */
  skip: number;
}

/** What a placed object's type is, as far as its properties go. */
export interface TypeFacts {
  /** Object kind: w3u (units, buildings, heroes), w3t (items), w3b (destructables), w3d (doodads). */
  kind: string;
  hero: boolean;
  building: boolean;
  /** Has the Invulnerable ability (gold mines, waygates): the World Editor shows no hit points for it. */
  invulnerable: boolean;
  /** Attacks (weapsOn): the World Editor offers a target acquisition range only then. */
  attacks: boolean;
  /** The type's own acquisition range (acquire), what "Normal" means; 0 unknown. */
  acquireRange: number;
  /** Hit points and mana of the type (0: none or unknown); heroes' grow with their attributes. */
  maxHp: number;
  maxMana: number;
  /** Heroes: attributes at level 1 and per level, and what a point of strength and intelligence gives (gameplay
   *  constants StrHitPointBonus, IntManaBonus). */
  attributes?: { str: number; agi: number; int: number; strPlus: number; agiPlus: number; intPlus: number; hpPerStr: number; manaPerInt: number };
  /** Heroes: the skills they can learn (heroAbilList). */
  skills: SkillInfo[];
  /** Inventory slots (an inventory ability's slot count), 0 for none. */
  slots: number;
  goldMine: boolean;
  waygate: boolean;
  /** The highest hero level (gameplay constant MaxHeroLevel). */
  maxLevel: number;
  /** HeroAbilityLevelSkip, for skills without their own. */
  levelSkip: number;
}

export interface DropItem { id: string; chance: number }
/** Items dropped on death: none, one of the map's item tables (by its number), or the object's own sets. */
export type Drops = { mode: "none" } | { mode: "table"; table: number } | { mode: "custom"; sets: DropItem[][] };

export type PropField = "hp" | "mana" | "gold" | "acquire" | "level" | "attributes" | "skills" | "inventory" | "drops" | "waygate" | "color" | "life";

/** One edit of the properties panel. */
export type PropChange =
  | { field: "hp"; value: number }
  | { field: "mana"; value: number }
  | { field: "gold"; value: number }
  | { field: "acquire"; value: number }
  | { field: "level"; value: number }
  | { field: "attributes"; value: [number, number, number] | null }
  | { field: "skill"; id: string; level: number }
  | { field: "slot"; slot: number; id: string | null }
  | { field: "drops"; value: Drops }
  | { field: "waygate"; value: number }
  | { field: "color"; value: number }
  | { field: "life"; value: number };

/** What a change is checked against besides the object: the map's item tables and regions. */
export interface PropContext { tables?: readonly number[]; regions?: readonly number[] }

type Ability = { id: string; autocast: number; level: number };
type Entry = Placed & {
  hp?: number; mana?: number; gold?: number; targetAcquisition?: number; level?: number;
  strength?: number; agility?: number; intelligence?: number;
  inventory?: { slot: number; id: string }[]; abilities?: Ability[];
  itemTable?: number; itemSets?: DropItem[][]; waygate?: number; color?: number; life?: number;
};

/** Every key of an entry the panel may change: a snapshot of these is an undo step. */
export const PROP_KEYS = ["hp", "mana", "gold", "targetAcquisition", "level", "strength", "agility", "intelligence",
  "inventory", "abilities", "itemTable", "itemSets", "waygate", "color", "life"] as const;

const has = (e: Entry, k: string) => k in e;

/** The fields that apply to a placed object, in the panel's order. Only those the entry's file has. As the World
 *  Editor's Unit Properties (seen with we-drive, 2026-11-08): no hit points for an invulnerable gold mine or waygate,
 *  no acquisition range for a barracks, a colour only for a waygate. A value that isn't the default is shown anyway,
 *  so it can be seen and set back. */
export function fieldsFor(entry: Placed, facts: TypeFacts): PropField[] {
  const e = entry as Entry;
  const out: PropField[] = [];
  if (e.id === "sloc") return out;
  if (facts.kind === "w3u") {
    if (has(e, "hp") && (!facts.invulnerable || e.hp !== DEFAULT)) out.push("hp");
    if (has(e, "mana") && (facts.maxMana > 0 || facts.hero || e.mana !== DEFAULT)) out.push("mana");
    if (has(e, "gold") && facts.goldMine) out.push("gold");
    if (has(e, "level") && facts.hero) out.push("level");
    if (has(e, "strength") && facts.hero) out.push("attributes");
    if (has(e, "abilities") && facts.hero && (facts.skills.length || (e.abilities?.length ?? 0) > 0)) out.push("skills");
    if (has(e, "inventory") && (facts.slots > 0 || (e.inventory?.length ?? 0) > 0)) out.push("inventory");
    if (has(e, "targetAcquisition") && (facts.attacks || e.targetAcquisition !== ACQUIRE_NORMAL)) out.push("acquire");
    if (has(e, "waygate") && facts.waygate) out.push("waygate");
    // Other units store a colour too (some campaign maps), but the World Editor doesn't show it for them.
    if (has(e, "color") && facts.waygate) out.push("color");
    if (has(e, "itemSets")) out.push("drops");
  } else if (facts.kind === "w3b") {
    if (has(e, "life")) out.push("life");
    if (has(e, "itemSets")) out.push("drops");
  } else if (facts.kind === "w3d" && has(e, "itemSets") && dropsOf(e).mode !== "none") {
    // A plain doodad can't die; drops it has anyway can be taken off.
    out.push("drops");
  }
  return out;
}

/** The fields every one of several objects has. Skills and inventory only for objects of one type, or
 *  with as many slots: they're lists of that type's. */
export function commonFields(items: readonly { entry: Placed; facts: TypeFacts }[]): PropField[] {
  if (!items.length) return [];
  let out = fieldsFor(items[0].entry, items[0].facts);
  for (const it of items.slice(1)) {
    const f = new Set(fieldsFor(it.entry, it.facts));
    out = out.filter((x) => f.has(x));
  }
  const oneType = items.every((it) => it.entry.id === items[0].entry.id);
  const sameSlots = items.every((it) => it.facts.slots === items[0].facts.slots);
  return out.filter((f) => (f === "skills" || f === "attributes" ? oneType : f === "inventory" ? sameSlots : true));
}

/** The value all entries share, or undefined when they differ. Compared as JSON (lists too). */
export function sameValue<T>(entries: readonly Placed[], get: (e: Placed) => T): T | undefined {
  if (!entries.length) return undefined;
  const first = JSON.stringify(get(entries[0]));
  return entries.every((e) => JSON.stringify(get(e)) === first) ? get(entries[0]) : undefined;
}

// ---- drops ------------------------------------------------------------------------------------

/** How an object drops items. An item table wins over sets, as in the script (lib/script/drops.ts). */
export function dropsOf(entry: Placed): Drops {
  const e = entry as Entry;
  if ((e.itemTable ?? DEFAULT) >= 0) return { mode: "table", table: e.itemTable! };
  if ((e.itemSets ?? []).length) return { mode: "custom", sets: structuredClone(e.itemSets!) };
  return { mode: "none" };
}

/** Chances of a set spread evenly to 100, the first items taking what doesn't divide (three items: 34,
 *  33, 33, as the World Editor's Redistribute Chances leaves them in the game's maps). */
export function redistribute(set: readonly DropItem[]): DropItem[] {
  const n = set.length;
  if (!n) return [];
  const base = Math.floor(100 / n), rest = 100 - base * n;
  return set.map((it, i) => ({ ...it, chance: base + (i < rest ? 1 : 0) }));
}

/** Random item classes by the second letter of "Y?I<level>" (lib/script/drops.ts writes them as ITEM_TYPE_…). */
const RANDOM_CLASSES: Record<string, string> = {
  Y: "any class", i: "permanent", j: "charged", k: "power-up", l: "artifact", m: "purchasable", n: "campaign", o: "miscellaneous",
};
/** "Random item (permanent, level 2)" for a random item id ("YiI2"), else undefined. Level "/" is any level. */
export function randomItemLabel(id: string): string | undefined {
  const m = /^Y(.)I(.)$/.exec(id);
  if (!m || !RANDOM_CLASSES[m[1]]) return undefined;
  return `Random item (${RANDOM_CLASSES[m[1]]}, ${m[2] === "/" ? "any level" : `level ${m[2]}`})`;
}

/** The chances of a set added up. */
export const setTotal = (set: readonly DropItem[]) => set.reduce((s, it) => s + it.chance, 0);

// ---- heroes -----------------------------------------------------------------------------------

/** The highest level a skill can have at a hero level: its first level needs `req`, each further one `skip` more. */
export function maxSkillLevel(skill: SkillInfo, heroLevel: number, defaultSkip = 2): number {
  const req = Math.max(1, skill.req), skip = skill.skip > 0 ? skill.skip : Math.max(1, defaultSkip);
  if (heroLevel < req) return 0;
  return Math.min(skill.levels, 1 + Math.floor((heroLevel - req) / skip));
}

/** Skill points spent: a hero gets one per level. */
export const pointsSpent = (abilities: readonly Ability[]) => abilities.reduce((s, a) => s + Math.max(0, a.level), 0);

/** The skills of a hero as they can be at `level`: each at most what the level allows, and no more points than
 *  levels, the last skills giving way first. Entries that are left at level 0 with nothing else to say go. */
export function fitSkills(abilities: readonly Ability[], facts: TypeFacts, level: number): Ability[] {
  const out = abilities.map((a) => ({ ...a }));
  const skillOf = new Map(facts.skills.map((s) => [s.id, s]));
  const touched = new Set<Ability>();
  for (const a of out) {
    const s = skillOf.get(a.id);
    if (!s) continue;
    const max = maxSkillLevel(s, level, facts.levelSkip);
    if (a.level > max) { a.level = max; touched.add(a); }
  }
  for (let i = out.length - 1; i >= 0 && pointsSpent(out) > level; i--) {
    const a = out[i];
    const cut = Math.min(a.level, pointsSpent(out) - level);
    if (cut > 0) { a.level -= cut; touched.add(a); }
  }
  return out.filter((a) => !(touched.has(a) && a.level === 0 && !a.autocast));
}

/** A hero's attributes at a level, as the World Editor shows them for "Use Default Attributes" (base plus growth). */
export function attributesAt(facts: TypeFacts, level: number): [number, number, number] | null {
  const a = facts.attributes;
  if (!a) return null;
  const at = (base: number, plus: number) => Math.max(1, Math.floor(base + plus * (level - 1)));
  return [at(a.str, a.strPlus), at(a.agi, a.agiPlus), at(a.int, a.intPlus)];
}

/** A placed hero's hit points and mana, the "of …" the World Editor shows: the type's plus what its attributes give
 *  (its own, else the default ones at its level). A level 5 Paladin with strength 30 and intelligence 25: 850 and 375. */
export function heroPools(facts: TypeFacts, entry: Placed): [number, number] | null {
  const e = entry as Entry, a = facts.attributes;
  if (!a) return null;
  const own = (e.strength ?? 0) > 0 ? [e.strength!, e.agility ?? 0, e.intelligence ?? 0] : null;
  const [str, , int] = own ?? attributesAt(facts, e.level ?? 1)!;
  return [facts.maxHp + str * a.hpPerStr, facts.maxMana + int * a.manaPerInt];
}

// ---- checking and applying ----------------------------------------------------------------------

const whole = (v: number) => Number.isInteger(v);
/** Four characters, or an id the files write as a number ("0x00000000": an empty slot, which drops nothing). */
const ITEM_ID = /^(?:[\x21-\x7e]{4}|0x[0-9a-fA-F]{8})$/;

/** Why a change can't be made to an object, or null when it can. Nothing is changed. */
export function checkChange(entry: Placed, facts: TypeFacts, c: PropChange, ctx: PropContext = {}): string | null {
  const e = entry as Entry;
  const need = (k: string) => (has(e, k) ? null : `This object's file has no ${k}.`);
  switch (c.field) {
    case "hp":
      return need("hp") ?? (c.value === DEFAULT || (whole(c.value) && c.value >= 1 && c.value <= 100) ? null : "Hit points go from 1 to 100 percent.");
    case "mana":
      return need("mana") ?? (c.value === DEFAULT || (whole(c.value) && c.value >= 0 && c.value <= MAX_MANA) ? null : `Mana is a whole number from 0 to ${MAX_MANA}.`);
    case "gold":
      return need("gold") ?? (whole(c.value) && c.value >= 0 && c.value <= MAX_GOLD ? null : `Gold is a whole number from 0 to ${MAX_GOLD}.`);
    case "acquire":
      return need("targetAcquisition") ?? (c.value === ACQUIRE_NORMAL || c.value === ACQUIRE_CAMP || (Number.isFinite(c.value) && c.value > 0 && c.value <= MAX_ACQUIRE)
        ? null : `The acquisition range is a distance above 0, up to ${MAX_ACQUIRE}.`);
    case "level":
      if (!facts.hero) return "Only heroes have a level.";
      return need("level") ?? (whole(c.value) && c.value >= 1 && c.value <= facts.maxLevel ? null : `A hero's level goes from 1 to ${facts.maxLevel}.`);
    case "attributes":
      if (!facts.hero) return "Only heroes have attributes.";
      if (!has(e, "strength")) return "This map's unit file has no hero attributes (an older layout).";
      return c.value === null || c.value.every((v) => whole(v) && v >= 1 && v <= MAX_ATTRIBUTE) ? null : `Attributes are whole numbers from 1 to ${MAX_ATTRIBUTE}.`;
    case "skill": {
      if (!facts.hero) return "Only heroes learn skills.";
      const no = need("abilities");
      if (no) return no;
      if (!whole(c.level) || c.level < 0) return "A skill's level is a whole number.";
      const skill = facts.skills.find((s) => s.id === c.id);
      if (!skill && c.level > 0) return `${c.id} isn't one of this hero's skills.`;
      const level = e.level ?? 1;
      if (skill && c.level > maxSkillLevel(skill, level, facts.levelSkip)) {
        return `At hero level ${level} ${c.id} goes up to level ${maxSkillLevel(skill, level, facts.levelSkip)}.`;
      }
      const others = pointsSpent((e.abilities ?? []).filter((a) => a.id !== c.id));
      return others + c.level > level ? `A level ${level} hero has ${level} skill point${level === 1 ? "" : "s"}; ${others} are spent on other skills.` : null;
    }
    case "slot":
      if (!has(e, "inventory")) return need("inventory");
      if (!whole(c.slot) || c.slot < 0 || c.slot >= Math.max(facts.slots, 1)) return `This unit has ${facts.slots} inventory slot${facts.slots === 1 ? "" : "s"}.`;
      return c.id === null || ITEM_ID.test(c.id) ? null : "An item id has four characters.";
    case "drops": {
      if (!has(e, "itemSets")) return need("itemSets");
      const d = c.value;
      if (d.mode === "table") {
        if (!has(e, "itemTable")) return "This map's file has no item tables for placed objects (an older layout); give it its own sets.";
        return ctx.tables && !ctx.tables.includes(d.table) ? `The map has no item table #${d.table}.` : null;
      }
      if (d.mode === "custom") {
        for (const [k, set] of d.sets.entries()) {
          if (set.some((it) => !ITEM_ID.test(it.id))) return `Set ${k + 1}: an item id has four characters.`;
          // A total past 100 is let through (the panel shows it red): the game then picks by the chances' shares,
          // and refusing it would make raising one item's chance before lowering another's impossible.
          if (set.some((it) => !whole(it.chance) || it.chance < 0 || it.chance > 100)) return `Set ${k + 1}: a chance goes from 0 to 100.`;
        }
      }
      return null;
    }
    case "waygate":
      if (!facts.waygate) return "Only waygates have a destination.";
      return need("waygate") ?? (c.value === DEFAULT || !ctx.regions || ctx.regions.includes(c.value) ? null : "That region isn't on the map.");
    case "color":
      if (!facts.waygate) return "Only a waygate's colour is set here (the World Editor's Custom Color).";
      return need("color") ?? (c.value === DEFAULT || (whole(c.value) && c.value >= 0 && c.value < COLORS) ? null : "A player colour goes from 0 to 23.");
    case "life":
      return need("life") ?? (whole(c.value) && c.value >= 0 && c.value <= 100 ? null : "Life goes from 0 (dead) to 100 percent.");
  }
}

/** Makes a checked change. True when anything is different afterwards. */
export function applyChange(entry: Placed, facts: TypeFacts, c: PropChange): boolean {
  const e = entry as Entry;
  const before = JSON.stringify(PROP_KEYS.map((k) => e[k]));
  switch (c.field) {
    case "hp": e.hp = c.value; break;
    case "mana": e.mana = c.value; break;
    case "gold": e.gold = c.value; break;
    case "acquire": e.targetAcquisition = c.value; break;
    case "level":
      e.level = c.value;
      if (e.abilities) e.abilities = fitSkills(e.abilities, facts, c.value);
      break;
    case "attributes": {
      const [s, a, i] = c.value ?? [0, 0, 0];
      e.strength = s; e.agility = a; e.intelligence = i;
      break;
    }
    case "skill": {
      const list = e.abilities ?? [];
      const at = list.findIndex((a) => a.id === c.id);
      if (at < 0) { if (c.level > 0) list.push({ id: c.id, autocast: 0, level: c.level }); }
      else if (c.level === 0 && !list[at].autocast) list.splice(at, 1);
      else list[at] = { ...list[at], level: c.level };
      e.abilities = list;
      break;
    }
    case "slot": {
      const list = (e.inventory ?? []).filter((it) => it.slot !== c.slot);
      if (c.id !== null) {
        const at = list.findIndex((it) => it.slot > c.slot);
        list.splice(at < 0 ? list.length : at, 0, { slot: c.slot, id: c.id });
      }
      e.inventory = list;
      break;
    }
    case "drops": {
      const d = c.value;
      if (has(e, "itemTable")) e.itemTable = d.mode === "table" ? d.table : DEFAULT;
      e.itemSets = d.mode === "custom" ? structuredClone(d.sets) : [];
      break;
    }
    case "waygate": e.waygate = c.value; break;
    case "color": e.color = c.value; break;
    case "life": e.life = c.value; break;
  }
  return JSON.stringify(PROP_KEYS.map((k) => e[k])) !== before;
}

/** A change to several objects: all of it or, with the first object's reason, none. The objects that changed. */
export function changeAll(items: readonly { entry: Placed; facts: TypeFacts }[], c: PropChange, ctx: PropContext = {}): { error: string } | { changed: Placed[] } {
  for (const it of items) {
    const why = checkChange(it.entry, it.facts, c, ctx);
    if (why) return { error: items.length > 1 ? `${it.entry.id}: ${why}` : why };
  }
  return { changed: items.filter((it) => applyChange(it.entry, it.facts, c)).map((it) => it.entry) };
}

/** The panel's keys of an entry, copied: what an undo step puts back. Keys the entry doesn't have stay out. */
export function propSnapshot(entry: Placed): Record<string, unknown> {
  const e = entry as Entry, out: Record<string, unknown> = {};
  for (const k of PROP_KEYS) if (k in e) out[k] = structuredClone(e[k]);
  return out;
}
