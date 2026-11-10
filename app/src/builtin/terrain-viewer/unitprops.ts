// Properties of a placed object, as the World Editor's Unit Properties and Destructable Properties
// have them: hit points, mana, gold, hero level, attributes and skills, inventory, target acquisition,
// waygate destination, colour and items dropped on death. Which apply depends on the object's type
// (TypeFacts, from the game's and the map's object data). The fields are those of war3mapUnits.doo
// and war3map.doo (crates/w3proj/formats/units.json, doodads.json); a field the file's version doesn't
// have is never added, and a value the World Editor writes as "default" (-1) stays it until changed.
// Each change is checked first and refused whole, so several objects are changed all or none.

import type { Placed } from "./objects";
import { ITEM_CLASSES, MAX_RANDOM_LEVEL, applyRandom, positionsFor, randomWhatOf, type RandomChoice, type RandomGroup, type RandomUnit } from "../../lib/terrain/randomplace";

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
  /** The type's own abilities that can be placed switched on (autocast like Heal, toggles like Defend: the World
   *  Editor's Abilities tab has an Active box for them, N/A for the rest), in the type's order. */
  toggles: string[];
  /** Inventory slots (an inventory ability's slot count), 0 for none. */
  slots: number;
  goldMine: boolean;
  waygate: boolean;
  /** Allow Custom Team Color (field utcc, UnitUI.slk customTeamColor; of the game's types only the waygate): the World
   *  Editor's Custom Color, which it then draws and writes into the script. Not for other types, whatever their file
   *  stores (we-drive, 2026-11-10: a footman type given utcc drawn and created in its colour, a waygate type without
   *  it in its owner's, a plain footman's stored colour ignored). */
  customColor: boolean;
  /** The highest hero level (gameplay constant MaxHeroLevel). */
  maxLevel: number;
  /** HeroAbilityLevelSkip, for skills without their own. */
  levelSkip: number;
  /** Units: the type's level (ulev, the map's change first), what a creep camp's level adds up; absent when unknown. */
  level?: number;
}

export interface DropItem { id: string; chance: number }
/** Items dropped on death: none, one of the map's item tables (by its number), or the object's own sets. */
export type Drops = { mode: "none" } | { mode: "table"; table: number } | { mode: "custom"; sets: DropItem[][] };

export type PropField = "hp" | "mana" | "gold" | "acquire" | "level" | "attributes" | "skills" | "active" | "inventory" | "drops" | "waygate" | "color" | "life" | "skin" | "random";

/** One edit of the properties panel. */
export type PropChange =
  | { field: "hp"; value: number }
  | { field: "mana"; value: number }
  | { field: "gold"; value: number }
  | { field: "acquire"; value: number }
  | { field: "level"; value: number }
  | { field: "attributes"; value: [number, number, number] | null }
  | { field: "skill"; id: string; level: number }
  | { field: "active"; id: string; on: boolean }
  | { field: "slot"; slot: number; id: string | null }
  | { field: "drops"; value: Drops }
  | { field: "waygate"; value: number }
  | { field: "color"; value: number }
  | { field: "life"; value: number }
  /** Another type's look (the World Editor's Skin, BlzCreateUnitWithSkin); null: the type's own. */
  | { field: "skin"; value: string | null }
  /** How a Random Unit, Building or Item is chosen (the Random Unit tab). */
  | { field: "random"; value: RandomChoice };

/** What a change is checked against besides the object: the map's item tables, regions and random groups (unknown:
 *  not checked). */
export interface PropContext { tables?: readonly number[]; regions?: readonly number[]; groups?: readonly RandomGroup[] }

type Ability = { id: string; autocast: number; level: number };
type Entry = Placed & {
  hp?: number; mana?: number; gold?: number; targetAcquisition?: number; level?: number;
  strength?: number; agility?: number; intelligence?: number;
  inventory?: { slot: number; id: string }[]; abilities?: Ability[];
  itemTable?: number; itemSets?: DropItem[][]; waygate?: number; color?: number; life?: number; skinId?: string;
  randomType?: number; randomLevel?: string; randomClass?: number; randomGroup?: number; randomPosition?: number; randomUnits?: RandomUnit[];
};

/** Every key of an entry the panel may change: a snapshot of these is an undo step. */
export const PROP_KEYS = ["hp", "mana", "gold", "targetAcquisition", "level", "strength", "agility", "intelligence",
  "inventory", "abilities", "itemTable", "itemSets", "waygate", "color", "life", "skinId",
  "randomType", "randomLevel", "randomClass", "randomGroup", "randomPosition", "randomUnits"] as const;

/** The most lines a random object's own table takes here. */
export const MAX_RANDOM_UNITS = 100;

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
    if (has(e, "abilities") && (facts.toggles.length || activeOthers(e, facts).length)) out.push("active");
    if (has(e, "inventory") && (facts.slots > 0 || (e.inventory?.length ?? 0) > 0)) out.push("inventory");
    if (has(e, "targetAcquisition") && (facts.attacks || e.targetAcquisition !== ACQUIRE_NORMAL)) out.push("acquire");
    if (has(e, "waygate") && facts.waygate) out.push("waygate");
    // Other units store a colour too (some campaign maps), but the World Editor doesn't show or use it for them.
    if (has(e, "color") && facts.customColor) out.push("color");
    if (has(e, "skinId")) out.push("skin");
    if (randomWhatOf(e.id) && has(e, "randomType")) out.push("random");
    if (has(e, "itemSets")) out.push("drops");
  } else if (facts.kind === "w3t") {
    // Placed items: the World Editor's Skin, and a Random Item's choice.
    if (has(e, "skinId")) out.push("skin");
    if (randomWhatOf(e.id) && has(e, "randomType")) out.push("random");
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
  const sameKind = items.every((it) => it.facts.kind === items[0].facts.kind);
  // A random choice only for objects of one id: the World Editor refuses a table for units, buildings and items at
  // once (WESTRING_UPROPS_RANDOMUNITS_CANTEDITMULTIPLE). A skin is a type of the same kind.
  return out.filter((f) => (f === "skills" || f === "attributes" || f === "active" || f === "random" ? oneType
    : f === "inventory" ? sameSlots : f === "skin" ? sameKind : true));
}

/** The skin a placed object is drawn and created with: its own when it names none (or an empty one). */
export const skinOfEntry = (entry: Placed): string => {
  const s = (entry as Entry).skinId;
  return typeof s === "string" && s !== "" ? s : entry.id;
};

/** Abilities an object has placed switched on that its type can't switch on (another type's, or the type was changed
 *  since): shown too, so they can be switched off. */
export function activeOthers(entry: Placed, facts: TypeFacts): string[] {
  return ((entry as Entry).abilities ?? []).filter((a) => a.autocast && a.level === 0 && !facts.toggles.includes(a.id)).map((a) => a.id);
}

/** Whether an object is placed with the ability switched on (the World Editor's Active box). */
export const isActive = (entry: Placed, id: string): boolean => !!((entry as Entry).abilities ?? []).find((a) => a.id === id)?.autocast;

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

/** What choosing "Map item table" does with the map's tables (null: war3map.w3i couldn't be read): the first table,
 *  an offer to make one when there are none, or why neither can be. */
export function tableChoice(tables: readonly { number: number }[] | null): { table: number } | { offer: true } | { error: string } {
  if (tables === null) return { error: "The map's item tables couldn't be read (war3map.w3i)." };
  return tables.length ? { table: tables[0].number } : { offer: true };
}

/** Why the drops offer only the objects' own sets: their file has the older layout (Reign of Chaos, units subversion 9)
 *  without a field for a map item table. Null when a map item table can be chosen. World Editor 7003 keeps that layout
 *  (we-drive saves, 2026-11-09): it saves a .w3x of subversion 9 as 9 and every .w3m as 9 (one of 11 loses its tables and
 *  attributes), and with "Use Item Table From Map" chosen in such a file it writes the table into war3map.j only, not
 *  into the unit file, so it's gone the next time the map is opened. Studio doesn't offer it there. */
export function ownSetsOnly(entries: readonly Placed[]): string | null {
  const without = entries.filter((e) => !("itemTable" in e)).length;
  if (!without) return null;
  const which = entries.length === 1 ? "This object is" : without === entries.length ? "These objects are" : `${without} of these objects ${without === 1 ? "is" : "are"}`;
  return `${which} in a file with the older layout (Reign of Chaos) that has no map item tables: only own item sets can be given.`;
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
/** "Random item, permanent, level 2" for a random item id ("YiI2"), else undefined. Level "/" is any level. */
export function randomItemLabel(id: string): string | undefined {
  const m = /^Y(.)I(.)$/.exec(id);
  if (!m || !RANDOM_CLASSES[m[1]]) return undefined;
  return `Random item, ${RANDOM_CLASSES[m[1]]}, ${m[2] === "/" ? "any level" : `level ${m[2]}`}`;
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
      // 0 isn't offered: the save writes it as the default, as the World Editor's does (lib/terrain/owner.ts savedUnitValues).
      return need("mana") ?? (c.value === DEFAULT || (whole(c.value) && c.value >= 1 && c.value <= MAX_MANA) ? null
        : `Mana is a whole number from 1 to ${MAX_MANA}, or the default (the World Editor saves 0 as the default).`);
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
    case "active": {
      const no = need("abilities");
      if (no) return no;
      return c.on && !facts.toggles.includes(c.id) ? `${c.id} isn't one of this unit's abilities that can be switched on as placed.` : null;
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
      if (!facts.customColor) return "Only a type that allows a custom team colour (a waygate) takes one: the World Editor's Custom Color, object data Allow Custom Team Color.";
      return need("color") ?? (c.value === DEFAULT || (whole(c.value) && c.value >= 0 && c.value < COLORS) ? null : "A player colour goes from 0 to 23.");
    case "life":
      return need("life") ?? (whole(c.value) && c.value >= 0 && c.value <= 100 ? null : "Life goes from 0 (dead) to 100 percent.");
    case "skin":
      if (e.id === "sloc") return "A start location has no skin.";
      return need("skinId") ?? (c.value === null || (ITEM_ID.test(c.value) && !c.value.startsWith("0x")) ? null : "A skin is an object id of four characters.");
    case "random":
      return checkRandom(e, c.value, ctx);
  }
}

/** Why a random choice can't be given to an object, or null. */
function checkRandom(e: Entry, v: RandomChoice, ctx: PropContext): string | null {
  const what = randomWhatOf(e.id);
  if (!what) return "Only a Random Unit, Building or Item is chosen at random.";
  if (!has(e, "randomType")) return "This object's file has no randomType.";
  if (v.by === "level") {
    if (what === "building") return v.level === -1 ? null : "A Random Building is any neutral passive building: it has no level.";
    if (!(v.level === -1 || (whole(v.level) && v.level >= 0 && v.level <= MAX_RANDOM_LEVEL))) return `A random level goes from 0 to ${MAX_RANDOM_LEVEL}, or any.`;
    if (v.itemClass !== undefined && v.itemClass !== 0 && what !== "item") return "Only a Random Item has a class.";
    if (v.itemClass !== undefined && !(whole(v.itemClass) && v.itemClass >= 0 && v.itemClass < ITEM_CLASSES.length)) return `An item class goes from 0 (any) to ${ITEM_CLASSES.length - 1}.`;
    return null;
  }
  if (v.by === "group") {
    if (!whole(v.group) || v.group < 0 || !whole(v.position) || v.position < 0) return "A random group and its position are whole numbers.";
    if (!ctx.groups) return null;
    const g = ctx.groups.find((x) => x.number === v.group);
    if (!g) return `The map has no random group #${v.group} (Map Properties › Random Groups).`;
    const kind = what === "item" ? "items" : `${what}s`;
    if (!positionsFor(g, what).includes(v.position)) return `Position ${v.position + 1} of ${g.name} isn't one for ${kind}.`;
    return null;
  }
  if (v.units.length > MAX_RANDOM_UNITS) return `A table holds up to ${MAX_RANDOM_UNITS} lines.`;
  for (const [i, u] of v.units.entries()) {
    if (!ITEM_ID.test(u.id) || u.id.startsWith("0x")) return `Line ${i + 1}: an object id has four characters.`;
    if (randomWhatOf(u.id)) return `Line ${i + 1}: a random object can't be one of a table's.`;
    // A total past 100 is let through, as the drops' (the panel shows it red).
    if (!whole(u.chance) || u.chance < 0 || u.chance > 100) return `Line ${i + 1}: a chance goes from 0 to 100.`;
  }
  return null;
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
    case "active": {
      // As the World Editor saves its Active box (we-drive, 2026-11-09): ticked, a level-0 entry with autocast 1 (a
      // priest's Heal: "healon" in the script); unticked again, the entry is gone. A hero skill keeps its level.
      const list = e.abilities ?? [];
      const at = list.findIndex((a) => a.id === c.id);
      if (c.on) {
        if (at < 0) list.push({ id: c.id, autocast: 1, level: 0 });
        else list[at] = { ...list[at], autocast: 1 };
      } else if (at >= 0) {
        if (list[at].level > 0) list[at] = { ...list[at], autocast: 0 };
        else list.splice(at, 1);
      }
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
    // As the World Editor stores the type's own look: its id (new placements and replaced types do the same).
    case "skin": e.skinId = c.value ?? e.id; break;
    case "random": applyRandom(e as unknown as Record<string, unknown>, { ...structuredClone(c.value), what: randomWhatOf(e.id)! }); break;
  }
  return JSON.stringify(PROP_KEYS.map((k) => e[k])) !== before;
}

/** A change to several objects: all of it or, with the first object's reason, none. The objects that changed. */
export function changeAll(items: readonly { entry: Placed; facts: TypeFacts }[], c: PropChange, ctx: PropContext = {}): { error: string } | { changed: Placed[] } {
  return changeEach(items.map((it) => ({ ...it, change: c })), ctx);
}

/** A change of its own to each object (drops copied, a set added to each one's own): all of them or, with the first
 *  object's reason, none. The objects that changed. */
export function changeEach(items: readonly { entry: Placed; facts: TypeFacts; change: PropChange }[], ctx: PropContext = {}): { error: string } | { changed: Placed[] } {
  for (const it of items) {
    const why = checkChange(it.entry, it.facts, it.change, ctx);
    if (why) return { error: items.length > 1 ? `${it.entry.id}: ${why}` : why };
  }
  return { changed: items.filter((it) => applyChange(it.entry, it.facts, it.change)).map((it) => it.entry) };
}

/** The panel's field a change is made in. */
export const fieldOfChange = (c: PropChange): PropField =>
  c.field === "skill" ? "skills" : c.field === "slot" ? "inventory" : c.field;

/** Why a change isn't one the panel would offer for one of the objects (a footman's "gold", a start location's hit
 *  points), or null. What the panel shows is what an AI tool may set. */
export function notOffered(items: readonly { entry: Placed; facts: TypeFacts }[], changes: readonly PropChange[]): string | null {
  for (const it of items) {
    const shown = fieldsFor(it.entry, it.facts);
    const missing = changes.map(fieldOfChange).find((f) => !shown.includes(f));
    if (missing) return `${it.entry.id} has no ${missing} in Unit Properties${shown.length ? ` (it has ${shown.join(", ")})` : ""}.`;
  }
  return null;
}

/** Several changes to several objects, in order (a hero's level before its skills): all of them, or with the first
 *  reason none, and then nothing is changed. The objects that changed. */
export function changeAllOf(items: readonly { entry: Placed; facts: TypeFacts }[], changes: readonly PropChange[], ctx: PropContext = {}): { error: string } | { changed: Placed[] } {
  const trial = items.map((it) => ({ entry: structuredClone(it.entry), facts: it.facts }));
  for (const c of changes) {
    const r = changeAll(trial, c, ctx);
    if ("error" in r) return { error: `${c.field}: ${r.error}` };
  }
  const changed: Placed[] = [];
  items.forEach((it, i) => {
    const before = JSON.stringify(propSnapshot(it.entry)), after = propSnapshot(trial[i].entry);
    if (JSON.stringify(after) === before) return;
    restoreProps(it.entry, after);
    changed.push(it.entry);
  });
  return { changed };
}

/** The properties an AI tool (MCP set_object_properties, place_objects) gives, as the panel's changes, in the order they
 *  are made. Names and numbers as the tool's description says: hit points in percent, slots and colours from 1, a
 *  waygate's region by name or number. Only the form is checked here; the ranges are the panel's (checkChange). */
export function propChangesOf(props: Record<string, unknown>, regions: readonly { index: number; name: string }[] = [],
  groups: readonly { number: number; name: string }[] = []): PropChange[] {
  const out: PropChange[] = [];
  const known = new Set(["hp", "mana", "gold", "acquireRange", "level", "attributes", "skills", "active", "inventory", "drops", "waygate", "color", "life", "skin", "random"]);
  const unknown = Object.keys(props).filter((k) => !known.has(k));
  if (unknown.length) throw new Error(`Unknown properties: ${unknown.join(", ")} (known: ${[...known].join(", ")}).`);
  const number = (k: string, v: unknown, ...words: [string, number][]): number => {
    for (const [w, n] of words) if (v === w) return n;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${k} must be a number${words.length ? ` or ${words.map(([w]) => `"${w}"`).join(", ")}` : ""}.`);
    return v;
  };
  const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const p = props;
  if (p.hp !== undefined) out.push({ field: "hp", value: number("hp", p.hp, ["default", DEFAULT]) });
  if (p.mana !== undefined) out.push({ field: "mana", value: number("mana", p.mana, ["default", DEFAULT]) });
  if (p.gold !== undefined) out.push({ field: "gold", value: number("gold", p.gold) });
  if (p.acquireRange !== undefined) out.push({ field: "acquire", value: number("acquireRange", p.acquireRange, ["normal", ACQUIRE_NORMAL], ["camp", ACQUIRE_CAMP]) });
  if (p.level !== undefined) out.push({ field: "level", value: number("level", p.level) });
  if (p.attributes !== undefined) {
    if (p.attributes === "default") out.push({ field: "attributes", value: null });
    else if (Array.isArray(p.attributes) && p.attributes.length === 3 && p.attributes.every((v) => typeof v === "number")) out.push({ field: "attributes", value: p.attributes as [number, number, number] });
    else throw new Error("attributes must be [strength, agility, intelligence] or 'default'.");
  }
  if (p.skills !== undefined) {
    if (!isRecord(p.skills)) throw new Error("skills must map skill ids to levels, like { AHhb: 2 }.");
    // Lower ones first: a skill taken down frees the points another one is raised with.
    const list = Object.entries(p.skills).map(([id, level]) => ({ id, level: number(`skills.${id}`, level) }));
    for (const s of list.sort((a, b) => a.level - b.level)) out.push({ field: "skill", id: s.id, level: s.level });
  }
  if (p.active !== undefined) {
    if (!isRecord(p.active) || !Object.values(p.active).every((v) => typeof v === "boolean")) throw new Error("active must map ability ids to true or false, like { Adef: true }.");
    for (const [id, on] of Object.entries(p.active)) out.push({ field: "active", id, on: on as boolean });
  }
  if (p.inventory !== undefined) {
    const form = "inventory must list { slot, item } (slot from 1; item null empties it).";
    if (!Array.isArray(p.inventory)) throw new Error(form);
    for (const it of p.inventory as unknown[]) {
      if (!isRecord(it) || !Number.isInteger(it.slot) || !(it.item === null || typeof it.item === "string")) throw new Error(form);
      out.push({ field: "slot", slot: (it.slot as number) - 1, id: it.item as string | null });
    }
  }
  if (p.drops !== undefined) {
    const d = p.drops;
    const item = (it: unknown) => isRecord(it) && typeof it.id === "string" && typeof it.chance === "number";
    if (d === "none") out.push({ field: "drops", value: { mode: "none" } });
    else if (isRecord(d) && typeof d.table === "number") out.push({ field: "drops", value: { mode: "table", table: d.table } });
    else if (isRecord(d) && Array.isArray(d.sets) && d.sets.every((s) => Array.isArray(s) && s.every(item))) {
      out.push({ field: "drops", value: { mode: "custom", sets: (d.sets as DropItem[][]).map((s) => s.map((it) => ({ id: it.id, chance: it.chance }))) } });
    } else throw new Error("drops must be 'none', { table: number } or { sets: [[{ id, chance }]] }.");
  }
  if (p.waygate !== undefined) {
    const w = p.waygate;
    let value: number;
    if (w === "none") value = DEFAULT;
    else if (typeof w === "number") value = w;
    else if (typeof w === "string") {
      const r = regions.find((x) => x.name === w);
      if (!r) throw new Error(`waygate: the map has no region called "${w}".`);
      value = r.index;
    } else throw new Error("waygate must be a region's name or number, or 'none'.");
    out.push({ field: "waygate", value });
  }
  // Player colours from 1 (Red), as players are counted; "default" is the owner's.
  if (p.color !== undefined) out.push({ field: "color", value: number("color", p.color, ["default", 0]) - 1 });
  if (p.life !== undefined) out.push({ field: "life", value: number("life", p.life) });
  if (p.skin !== undefined) {
    if (typeof p.skin !== "string") throw new Error("skin must be an object id, like \"hkni\", or \"default\" (the type's own).");
    out.push({ field: "skin", value: p.skin === "default" ? null : p.skin });
  }
  if (p.random !== undefined) out.push({ field: "random", value: randomChoiceOf(p.random, groups) });
  return out;
}

/** A random choice as the AI tools give it: { level, itemClass } (level "any" or a number, class from 0), { group,
 *  position } (a group by number or name, its position from 1) or { units: [{ id, chance }] }. */
function randomChoiceOf(v: unknown, groups: readonly { number: number; name: string }[]): RandomChoice {
  const form = "random must be { level, itemClass }, { group, position } (position from 1) or { units: [{ id, chance }] }.";
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(form);
  const r = v as Record<string, unknown>;
  const keys = ["level", "group", "units"].filter((k) => r[k] !== undefined);
  if (keys.length !== 1) throw new Error(form);
  if (r.level !== undefined) {
    const level = r.level === "any" ? -1 : r.level;
    if (typeof level !== "number" || (r.itemClass !== undefined && typeof r.itemClass !== "number")) throw new Error(form);
    return { by: "level", level, ...(r.itemClass !== undefined ? { itemClass: r.itemClass as number } : {}) };
  }
  if (r.group !== undefined) {
    let group: number;
    if (typeof r.group === "number") group = r.group;
    else if (typeof r.group === "string") {
      const g = groups.find((x) => x.name === r.group);
      if (!g) throw new Error(`random: the map has no random group called "${r.group}".`);
      group = g.number;
    } else throw new Error(form);
    if (typeof r.position !== "number") throw new Error(form);
    return { by: "group", group, position: r.position - 1 };
  }
  const units = r.units;
  if (!Array.isArray(units) || !units.every((u) => u && typeof u === "object" && typeof (u as RandomUnit).id === "string" && typeof (u as RandomUnit).chance === "number")) throw new Error(form);
  return { by: "table", units: (units as RandomUnit[]).map((u) => ({ id: u.id, chance: u.chance })) };
}

/** The panel's keys of an entry, copied: what an undo step puts back. Keys the entry doesn't have stay out. */
export function propSnapshot(entry: Placed): Record<string, unknown> {
  const e = entry as Entry, out: Record<string, unknown> = {};
  for (const k of PROP_KEYS) if (k in e) out[k] = structuredClone(e[k]);
  return out;
}

/** Puts a snapshot (propSnapshot) back: its keys as they were, and a panel key it lacks taken off again (a random
 *  object's group fields after its level was chosen once more), so undo leaves no field of another layout behind. */
export function restoreProps(entry: Placed, snap: Record<string, unknown>): void {
  const e = entry as unknown as Record<string, unknown>;
  for (const k of PROP_KEYS) {
    if (k in snap) e[k] = structuredClone(snap[k]);
    else delete e[k];
  }
}
