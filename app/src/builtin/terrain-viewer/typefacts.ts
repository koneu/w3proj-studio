// What the properties panel needs to know of a placed object's type (unitprops.ts TypeFacts), from the
// game's tables with the map's object data on top: hero or not, hit points and mana, attributes,
// the skills a hero learns, inventory slots, gold mine, waygate, and the gameplay constants for hero
// levels (war3mapMisc.txt over the game's Units\MiscGame.txt).

import type { W3Api } from "../../extensions/api";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { loadKind } from "../../lib/objects/metadata";
import { ABILITY_FUNC_FILES, abilityOrders, specialUnits, type ObjectFile } from "../../lib/script/objects";
import { objectMods, readMapJson } from "./pathmap";
import type { SkillInfo, TypeFacts } from "./unitprops";

/** Field values of units and abilities, the map's first; "" when nothing says. Level is 1-based for fields
 *  with levels, else 0. */
export interface FactsData extends HeroConstants {
  unit(id: string, field: string): string;
  destructable(id: string, field: string): string;
  ability(id: string, field: string, level: number): string;
  /** The game ability an ability works as (AbilityData code: Apak is an AInv), through a custom one's base. */
  abilityCode(id: string): string;
  /** A map's own ability's base (A000 based on Ahea: Ahea), the id itself else. */
  abilityBase(id: string): string;
  goldMines: ReadonlySet<string>;
  /** Abilities that can be placed switched on: those the map script has an order for (lib/script/objects.ts
   *  abilityOrders: autocast with Orderon and Orderoff, toggles with Order and Unorder). */
  toggleable: ReadonlySet<string>;
  waygates: ReadonlySet<string>;
}

const GOLD_CODES = new Set(["Agld", "Abgm", "Aegm"]);
const WAYGATE_CODE = "Awrp", INVENTORY_CODE = "AInv", INVULNERABLE_CODE = "Avul";
/** The World Editor's Inventory tab has six slots for every unit with an inventory ability, a footman's two-slot
 *  one too (seen with we-drive, 2026-11-08). */
const INVENTORY_SLOTS = 6;
const num = (v: string, or = 0) => (v.trim() === "" || !Number.isFinite(Number(v)) ? or : Number(v));
const list = (v: string) => v.split(",").map((s) => s.trim()).filter((s) => s && s !== "_");

/** The facts of a type of `kind` (w3u, w3t, w3b, w3d). */
export function typeFacts(id: string, kind: string, d: FactsData): TypeFacts {
  const facts: TypeFacts = {
    kind, hero: false, building: false, invulnerable: false, attacks: false, acquireRange: 0, maxHp: 0, maxMana: 0, skills: [], toggles: [], slots: 0,
    goldMine: false, waygate: false, customColor: false, maxLevel: d.maxHeroLevel, levelSkip: d.levelSkip,
  };
  if (kind === "w3b") facts.maxHp = num(d.destructable(id, "bhps"));
  if (kind !== "w3u" || id === "sloc") return facts;
  // A hero's id starts with a capital letter, a custom hero's too (it keeps its base's first letter).
  facts.hero = /^[A-Z]/.test(id);
  facts.building = d.unit(id, "ubdg") === "1";
  facts.maxHp = num(d.unit(id, "uhpm"));
  facts.maxMana = num(d.unit(id, "umpm"));
  const codes = list(d.unit(id, "uabi")).map((a) => ({ id: a, code: d.abilityCode(a) }));
  facts.goldMine = d.goldMines.has(id) || codes.some((a) => GOLD_CODES.has(a.code));
  facts.waygate = d.waygates.has(id) || codes.some((a) => a.code === WAYGATE_CODE);
  facts.invulnerable = codes.some((a) => a.code === INVULNERABLE_CODE);
  facts.customColor = num(d.unit(id, "utcc")) === 1;
  // Attacks enabled (weapsOn): the World Editor offers the acquisition range only to units that attack.
  facts.attacks = num(d.unit(id, "uaen")) > 0;
  facts.acquireRange = num(d.unit(id, "uacq"));
  const level = d.unit(id, "ulev");
  if (level.trim() !== "" && Number.isFinite(Number(level))) facts.level = Number(level);
  if (codes.some((a) => a.code === INVENTORY_CODE)) facts.slots = INVENTORY_SLOTS;
  // By the ability's id, or a map's own ability's base (one based on Heal is placed with "healon" too, as the World
  // Editor writes it: we-drive 2026-11-10), as the map script looks up its orders (lib/script/objects.ts autocastOrdersOf).
  facts.toggles = [...new Set(codes.map((a) => a.id).filter((a) => d.toggleable.has(a) || d.toggleable.has(d.abilityBase(a))))];
  if (facts.hero) {
    facts.attributes = {
      str: num(d.unit(id, "ustr")), agi: num(d.unit(id, "uagi")), int: num(d.unit(id, "uint")),
      strPlus: num(d.unit(id, "ustp")), agiPlus: num(d.unit(id, "uagp")), intPlus: num(d.unit(id, "uinp")),
      hpPerStr: d.hpPerStr, manaPerInt: d.manaPerInt,
    };
    // In the World Editor's order: the ultimate (a later first level, 6 for the game's heroes) after the others, which
    // keep the list's order (a Paladin's heroAbilList has Resurrection third, the editor shows it last).
    facts.skills = list(d.unit(id, "uhab")).map((s): SkillInfo => ({
      id: s, levels: Math.max(1, num(d.ability(s, "alev", 0), 1)), req: num(d.ability(s, "arlv", 0)), skip: num(d.ability(s, "alsk", 0)),
    })).map((s, i) => ({ s, i })).sort((a, b) => Math.max(1, a.s.req) - Math.max(1, b.s.req) || a.i - b.i).map(({ s }) => s);
  }
  return facts;
}

/** The gameplay constants the panel uses: the map's own over the game's. */
export function heroConstants(gameMisc: string, mapMisc: string | null): HeroConstants {
  const game = parseIni(gameMisc).get("Misc"), map = mapMisc ? parseIni(mapMisc).get("Misc") : undefined;
  const get = (k: string, or: number) => {
    const v = Number(map?.get(k) ?? game?.get(k));
    return Number.isFinite(v) && v > 0 ? v : or;
  };
  return { maxHeroLevel: Math.floor(get("maxherolevel", 10)), levelSkip: Math.floor(get("heroabilitylevelskip", 2)), hpPerStr: get("strhitpointbonus", 25), manaPerInt: get("intmanabonus", 15) };
}
export interface HeroConstants { maxHeroLevel: number; levelSkip: number; hpPerStr: number; manaPerInt: number }

/** Reads what typeFacts needs from the game and the open project. Read anew after the map's object data or
 *  gameplay constants are saved (see the terrain viewer). */
export async function loadFactsData(w3: W3Api): Promise<FactsData> {
  const [units, abilities, destructables, unitMods, skinMods, abilityMods, destructableMods, unitFile, skinFile, abilityRows, gameMisc] = await Promise.all([
    loadKind(w3, "w3u"), loadKind(w3, "w3a"), loadKind(w3, "w3b"),
    objectMods(w3, "war3map.w3u"), objectMods(w3, "war3mapSkin.w3u"), objectMods(w3, "war3map.w3a"), objectMods(w3, "war3map.w3b"),
    readMapJson<ObjectFile>(w3, "war3map.w3u").catch(() => null), readMapJson<ObjectFile>(w3, "war3mapSkin.w3u").catch(() => null),
    w3.game.readText("Units\\AbilityData.slk").then(parseSlk).catch(() => []),
    w3.game.readText("Units\\MiscGame.txt").catch(() => ""),
  ]);
  // A table that can't be read only leaves its abilities without an Active box.
  const orders = abilityOrders(await Promise.all(ABILITY_FUNC_FILES.map((f) => w3.game.readText(f).then(parseIni).catch(() => new Map()))));
  const files = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
  const mapMisc = files.has("map/war3mapmisc.txt") ? await w3.workspace.readText("map/war3mapMisc.txt").catch(() => null) : null;
  const codes = new Map(abilityRows.map((r) => [r.alias, r.code || r.alias]));
  const mods = new Map([...unitMods, ...skinMods]);
  const value = (kind: typeof units, own: typeof mods, id: string, field: string, level: number) => {
    const v = own.get(id)?.mods.get(field);
    if (v !== undefined) return String(v);
    const f = kind.fieldById.get(field);
    return (f && kind.defaultValue(own.get(id)?.base ?? id, f, level)) ?? "";
  };
  const special = specialUnits([unitFile, skinFile]);
  return {
    unit: (id, field) => value(units, mods, id, field, 0),
    destructable: (id, field) => value(destructables, destructableMods, id, field, 0),
    ability: (id, field, level) => value(abilities, abilityMods, id, field, level),
    abilityCode: (id) => { const base = abilityMods.get(id)?.base ?? id; return codes.get(base) ?? base; },
    abilityBase: (id) => abilityMods.get(id)?.base ?? id,
    goldMines: special.goldMines, waygates: special.waygates, toggleable: new Set(orders.keys()),
    ...heroConstants(gameMisc, mapMisc),
  };
}
