// Placed units in war3map.j ("Unit Creation"): per player one function for
// buildings and one for units, then for the neutral players, and the wrappers
// CreatePlayerBuildings / CreatePlayerUnits / CreateAllUnits. Each unit is
// created where it was placed, followed by its changes from the defaults
// (resources, acquisition range, life and mana, colour, hero data, items,
// waygates, item drops).

import { dropFunctionOf, randomItem } from "./drops";

const EOL = "\r\n";
const SEP = "//===========================================================================";

/** A war3mapUnits.doo entry (format engine JSON). */
export interface UnitJson {
  id: string; variation: number; position: number[]; angle: number; skinId?: string; player: number;
  hp: number; mana: number; itemTable?: number; itemSets?: unknown[]; gold: number; targetAcquisition: number;
  level: number; strength?: number; agility?: number; intelligence?: number;
  inventory: { slot: number; id: string }[]; abilities: { id: string; autocast: number; level: number }[];
  color: number; waygate: number; editorId: number;
  /** Random units (ids uDNR, bDNR): 0 any by level, 1 from a random group, 2 from a list. */
  randomType?: number; randomLevel?: string; randomClass?: number; randomGroup?: number; randomPosition?: number; randomUnits?: { id: string; chance: number }[];
}

export interface UnitsInput {
  units: UnitJson[];
  /** The numbers of the map's item tables. */
  itemTables?: ReadonlySet<number>;
  /** What an object id is (custom ids by their base and the map's changes). */
  kindOf: (id: string) => "building" | "unit" | "item" | "sloc" | undefined;
  /** war3map.w3i editorVersion: newer editors write more (item colours). */
  editorVersion?: number;
  /** The game build of war3map.w3i's gameVersion (its last number): the item colour changed within editor 7003. */
  gameBuild?: number;
  /** Generated globals the triggers use (gg_unit_…). */
  referenced: Set<string>;
  /** Region global for a waygate target (region creation number). */
  regionName?: (index: number) => string | undefined;
  /** Whether a (custom) unit type is a gold mine, besides ngol, ugol and egol. */
  goldMine?: (id: string) => boolean;
  /** Whether a (custom) unit type is a waygate, besides nwgt. */
  waygate?: (id: string) => boolean;
  /** Whether a unit type allows a custom team colour (lib/script/objects customColorTypes); without it, waygates do. */
  customColor?: (id: string) => boolean;
  /** Team colour a unit type has in the map's object data (lib/script/objects). */
  teamColor?: (id: string) => number | undefined;
  /** The orders that turn an ability's autocast on and off, if it has one. */
  autocastOrders?: (ability: string) => { on: string; off?: string } | undefined;
  /** Whether an ability is a hero ability (lib/script/objects heroAbilities): unlearned ones get no autocast order. */
  heroAbility?: (ability: string) => boolean;
}

/** Fixed decimals of a 32-bit float, ties to even like C's printf (-3722.25 → -3722.2). */
export function fixed(v: number, digits: number): string {
  const x = Math.fround(v), f = 10 ** digits, scaled = x * f, floor = Math.floor(scaled);
  if (scaled - floor !== 0.5) return x.toFixed(digits);
  return ((floor % 2 === 0 ? floor : floor + 1) / f).toFixed(digits);
}
const r1 = (v: number) => fixed(v, 1);
/** Facing in degrees, worked out in 32-bit floats like the World Editor. */
const deg = (rad: number) => fixed(Math.fround(Math.fround(rad) * Math.fround(180 / Math.PI)), 3);
/** Neutral players (1.31+ numbering). */
const NEUTRAL_HOSTILE = 24, NEUTRAL_PASSIVE = 27;

/** The player field: the owner, and a flag for Ancients placed uprooted. */
const owner = (u: UnitJson) => u.player & 0xffff, uprooted = (u: UnitJson) => (u.player & 0x10000) !== 0;
/** Placeholders for a random unit and a random building: no such unit types exist. */
const RANDOM_BUILDING = "bDNR", RANDOM_UNIT = "uDNR";
const isRandom = (u: UnitJson) => u.id === RANDOM_UNIT || u.id === RANDOM_BUILDING;
/** A random item: no item type, whatever the object data's lookup says (it isn't an item there). */
export const RANDOM_ITEM = "iDNR";
const isItem = (i: UnitsInput, u: UnitJson) => u.id === RANDOM_ITEM || i.kindOf(u.id) === "item";
/** Item classes of a random item by level (randomClass 0 any, then as the World Editor lists them). */
const ITEM_TYPES = ["ANY", "PERMANENT", "CHARGED", "POWERUP", "ARTIFACT", "PURCHASABLE", "CAMPAIGN", "MISCELLANEOUS"];

/** The expression or lines that put a random item's type into itemID. No map of the game's places one; World Editor
 *  2.0 (7003) writes ChooseRandomItemExWithFilter as in its item drops (drops.ts randomItem), older editors are
 *  taken to write their drops' form. */
function pickRandomItem(it: UnitJson, editorVersion: number): string[] {
  if (it.randomType === 1) return [`    set itemID = gg_rg_${String(it.randomGroup ?? 0).padStart(3, "0")}[${it.randomPosition ?? 0}]`];
  if (it.randomType === 2) {
    return ["    call RandomDistReset(  )", ...(it.randomUnits ?? []).map((r) => `    call RandomDistAddItem( '${r.id}', ${r.chance} )`), "    set itemID = RandomDistChoose(  )"];
  }
  const raw = parseInt((it.randomLevel ?? "").slice(0, 2), 16);
  const level = Number.isNaN(raw) || raw === 255 ? -1 : raw;
  return [`    set itemID = ${randomItem(ITEM_TYPES[it.randomClass ?? 0] ?? "ANY", level, editorVersion)}`];
}

/** Lines that put a random unit's type into unitID. */
function pickRandom(u: UnitJson): string[] {
  if (u.randomType === 1) return [`    set unitID = gg_rg_${String(u.randomGroup ?? 0).padStart(3, "0")}[${u.randomPosition ?? 0}]`];
  if (u.randomType === 2) {
    return ["    call RandomDistReset(  )", ...(u.randomUnits ?? []).map((r) => `    call RandomDistAddItem( '${r.id}', ${r.chance} )`), "    set unitID = RandomDistChoose(  )"];
  }
  // Any by level: no map of the game's has one, so this form isn't compared with the World Editor.
  if (u.id === RANDOM_BUILDING) return ["    set unitID = ChooseRandomNPBuilding(  )"];
  const level = parseInt((u.randomLevel ?? "").slice(0, 2), 16);
  return [`    set unitID = ChooseRandomCreep( ${Number.isNaN(level) || level === 255 ? -1 : level} )`];
}

const GOLD_MINES = new Set(["ngol", "ugol", "egol"]);
const isGoldMine = (i: UnitsInput, id: string) => GOLD_MINES.has(id) || (i.goldMine?.(id) ?? false);
const isWaygate = (i: UnitsInput, id: string) => id === "nwgt" || (i.waygate?.(id) ?? false);

export const unitGlobal = (u: UnitJson) => `gg_unit_${u.id}_${String(u.editorId).padStart(4, "0")}`;

function unitLines(i: UnitsInput, u: UnitJson): string[] {
  const g = unitGlobal(u);
  const v = i.referenced.has(g) ? g : "u";
  const pos = `${r1(u.position[0])}, ${r1(u.position[1])}, ${deg(u.angle)}`;
  const random = isRandom(u);
  // Blighted gold mines have their own constructor (it also blights the ground).
  const lines = [random ? `    set ${v} = BlzCreateUnitWithSkin( p, unitID, ${pos}, unitID )`
    : u.id === "ugol" ? `    set ${v} = CreateBlightedGoldmine( p, ${pos} )`
    : `    set ${v} = BlzCreateUnitWithSkin( p, '${u.id}', ${pos}, '${u.skinId ?? u.id}' )`];
  if (uprooted(u)) lines.push(`    call IssueImmediateOrder( ${v}, "unroot" )`);
  if (isGoldMine(i, u.id)) lines.push(`    call SetResourceAmount( ${v}, ${u.gold} )`);
  if (u.level > 1) lines.push(`    call SetHeroLevel( ${v}, ${u.level}, false )`);
  // A hero's own attributes (0: its default ones), as the World Editor writes them (seen in the game's campaign map
  // WC2Orc12 and in a map it saved with a Paladin of 30/20/25).
  if ((u.strength ?? 0) > 0) {
    lines.push(`    call SetHeroStr( ${v}, ${u.strength}, true )`, `    call SetHeroAgi( ${v}, ${u.agility ?? 0}, true )`, `    call SetHeroInt( ${v}, ${u.intelligence ?? 0}, true )`);
  }
  if (u.hp !== -1) lines.push(`    set life = GetUnitState( ${v}, UNIT_STATE_LIFE )`, `    call SetUnitState( ${v}, UNIT_STATE_LIFE, ${(u.hp / 100).toFixed(2)} * life )`);
  if (u.mana !== -1) lines.push(`    call SetUnitState( ${v}, UNIT_STATE_MANA, ${u.mana} )`);
  // -1 is the type's default. -2: "camp" (guard position), written as an acquisition range of 200. A stored 0 is
  // written as it is (World Editor 2.0, we-drive 2026-11-09: 0.0, 0.5 and 500 each with their own call). After the
  // hero level and the mana (the game's maps: 308 times after the mana, 10 after the level, never before either).
  if (u.targetAcquisition === -2) lines.push(`    call SetUnitAcquireRange( ${v}, 200.0 )`);
  else if (u.targetAcquisition >= 0) lines.push(`    call SetUnitAcquireRange( ${v}, ${r1(u.targetAcquisition)} )`);
  for (const a of u.abilities) {
    for (let l = 0; l < a.level; l++) lines.push(`    call SelectHeroSkill( ${v}, '${a.id}' )`);
    // Autocast abilities are switched on or off as placed; a hero ability not learned (level 0) isn't.
    if (a.level === 0 && i.heroAbility?.(a.id)) continue;
    const orders = i.autocastOrders?.(a.id), order = a.autocast ? orders?.on : orders?.off;
    if (order) lines.push(`    call IssueImmediateOrder( ${v}, "${order}" )`);
  }
  for (const it of u.inventory) lines.push(`    call UnitAddItemToSlotById( ${v}, '${it.id}', ${it.slot} )`);
  // Other units store 0 here, and in the colour field: only waygates mean them.
  const waygate = isWaygate(i, u.id);
  if (waygate && u.waygate >= 0) {
    const r = i.regionName?.(u.waygate);
    if (r) lines.push(`    call WaygateSetDestination( ${v}, GetRectCenterX(${r}), GetRectCenterY(${r}) )`, `    call WaygateActivate( ${v}, true )`);
  }
  const custom = i.customColor ? i.customColor(u.id) : waygate;
  const color = custom && u.color !== -1 ? u.color : i.teamColor?.(u.id);
  if (color !== undefined) lines.push(`    call SetUnitColor( ${v}, ConvertPlayerColor(${color}) )`);
  // Items drop from a map item table or the unit's own sets.
  const drops = dropFunctionOf("Unit", u, i.units.indexOf(u), i.itemTables);
  if (drops) {
    lines.push("    set t = CreateTrigger(  )", `    call TriggerRegisterUnitEvent( t, ${v}, EVENT_UNIT_DEATH )`,
      `    call TriggerRegisterUnitEvent( t, ${v}, EVENT_UNIT_CHANGE_OWNER )`, `    call TriggerAddAction( t, function ${drops} )`);
  }
  // A group's line can leave a slot empty: then nothing is placed there.
  return random ? [...pickRandom(u), "    if (unitID != -1) then", ...lines.map((l) => `    ${l}`), "    endif"] : lines;
}

/** The "Items" section body: items placed on the map (war3mapUnits.doo), or "". */
export function itemsSection(i: UnitsInput): string {
  // Items are created by type id (character codes), then in the order war3mapUnits.doo lists them, which isn't
  // always by creation number (OrcX01_05: shwd 2, 1, 6, …, 13, 9 in both). The sort is stable.
  const items = i.units.filter((u) => isItem(i, u))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!items.length) return "";
  const global = (it: UnitJson) => `gg_item_${it.id}_${String(it.editorId).padStart(4, "0")}`;
  // Editors from 7000 on colour every placed item, from 7003 with BlzSetItemColor, whatever colour and owner the
  // placement stores: the game's maps (7000 and 7003 up to build 24356) with 0, World Editor 2.0 of build 24371 with
  // 24 (we-drive saves, 2026-11-09: stored colours -1, 0, 3, 5, 7, 12 and 24, owners 0, 3, 5, 24 and 27, all 24).
  // Random items get none from it, but are still created into the local.
  const ev = i.editorVersion ?? 0;
  const colorFn = ev >= 7003 ? "BlzSetItemColor" : ev >= 7000 ? "SetItemColor" : null;
  const colorOf = (it: UnitJson) => (it.id === RANDOM_ITEM && colorFn ? -1 : !colorFn ? it.color : (i.gameBuild ?? 0) >= 24371 ? 24 : 0);
  const local = (it: UnitJson) => (colorFn || colorOf(it) !== -1 ? "i" : null);
  // An item needs a variable when a trigger refers to it or it gets a colour; else it's a plain call. Editors from
  // 7000 on declare the local even when every item has its global (OrcX01_05 of editor 7003).
  const usesLocal = !!colorFn || items.some((it) => !i.referenced.has(global(it)) && local(it));
  const lines = ["function CreateAllItems takes nothing returns nothing", "    local integer itemID", ...(usesLocal ? ["    local item i"] : []), ""];
  for (const it of items) {
    const g = global(it);
    const v = i.referenced.has(g) ? g : local(it);
    const random = it.id === RANDOM_ITEM;
    const create = random ? `BlzCreateItemWithSkin( itemID, ${r1(it.position[0])}, ${r1(it.position[1])}, itemID )`
      : `BlzCreateItemWithSkin( '${it.id}', ${r1(it.position[0])}, ${r1(it.position[1])}, '${it.skinId ?? it.id}' )`;
    const made = [v ? `    set ${v} = ${create}` : `    call ${create}`];
    if (v && colorOf(it) !== -1) made.push(`    call ${colorFn ?? "BlzSetItemColor"}( ${v}, ConvertPlayerColor(${colorOf(it)}) )`);
    // A group's line can leave a slot empty: then nothing is placed there.
    lines.push(...(random ? [...pickRandomItem(it, ev), "    if (itemID != -1) then", ...made.map((l) => `    ${l}`), "    endif"] : made));
  }
  lines.push("endfunction", "");
  return lines.join(EOL);
}

function creator(name: string, player: string, lines: string[]): string {
  return [SEP, `function ${name} takes nothing returns nothing`, `    local player p = ${player}`, "    local unit u", "    local integer unitID",
    "    local trigger t", "    local real life", "", ...lines, "endfunction", ""].join(EOL);
}

/** The "Unit Creation" section (without its banner), or "" without placed units. */
export function unitsSection(i: UnitsInput): string {
  // Units are created in the order they were placed (creation number).
  const placed = i.units.filter((u) => { const k = i.kindOf(u.id); return u.id !== RANDOM_ITEM && (k === "unit" || k === "building"); })
    .sort((a, b) => a.editorId - b.editorId);
  if (!placed.length) return "";
  const parts: string[] = [];
  const playerBuildings: string[] = [], playerUnits: string[] = [];
  const isBuilding = (u: UnitJson) => u.id === RANDOM_BUILDING || i.kindOf(u.id) === "building";
  const of = (player: number, building: boolean) =>
    placed.filter((u) => owner(u) === player && isBuilding(u) === building).flatMap((u) => unitLines(i, u));
  const players = [...new Set(placed.map(owner))].filter((p) => p !== NEUTRAL_HOSTILE && p !== NEUTRAL_PASSIVE).sort((a, b) => a - b);
  for (const p of players) {
    const b = of(p, true), u = of(p, false);
    if (b.length) { parts.push(creator(`CreateBuildingsForPlayer${p}`, `Player(${p})`, b)); playerBuildings.push(`CreateBuildingsForPlayer${p}`); }
    if (u.length) { parts.push(creator(`CreateUnitsForPlayer${p}`, `Player(${p})`, u)); playerUnits.push(`CreateUnitsForPlayer${p}`); }
  }
  const all: string[] = [];
  const neutral = (player: number, title: string, constant: string) => {
    const b = of(player, true), u = of(player, false);
    if (b.length) { parts.push(creator(`Create${title}Buildings`, `Player(${constant})`, b)); all.push(`Create${title}Buildings`); }
    if (u.length) { parts.push(creator(`Create${title}`, `Player(${constant})`, u)); all.push(`Create${title}`); }
  };
  neutral(NEUTRAL_HOSTILE, "NeutralHostile", "PLAYER_NEUTRAL_AGGRESSIVE");
  neutral(NEUTRAL_PASSIVE, "NeutralPassive", "PLAYER_NEUTRAL_PASSIVE");
  const wrapper = (name: string, calls: string[]) => [SEP, `function ${name} takes nothing returns nothing`, ...calls.map((c) => `    call ${c}(  )`), "endfunction", ""].join(EOL);
  parts.push(wrapper("CreatePlayerBuildings", playerBuildings), wrapper("CreatePlayerUnits", playerUnits));
  // Order of creation: neutral buildings, player buildings, neutral hostile, neutral passive, player units.
  const order = ["CreateNeutralHostileBuildings", "CreateNeutralPassiveBuildings", "CreatePlayerBuildings", "CreateNeutralHostile", "CreateNeutralPassive", "CreatePlayerUnits"]
    .filter((n) => n === "CreatePlayerBuildings" || n === "CreatePlayerUnits" || all.includes(n));
  parts.push(wrapper("CreateAllUnits", order));
  return parts.join(EOL);
}
