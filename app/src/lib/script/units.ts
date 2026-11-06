// Placed units in war3map.j ("Unit Creation"): per player one function for
// buildings and one for units, then for the neutral players, and the wrappers
// CreatePlayerBuildings / CreatePlayerUnits / CreateAllUnits. Each unit is
// created where it was placed, followed by its changes from the defaults
// (resources, acquisition range, life and mana, colour, hero data, items,
// waygates, item drops).

import { dropFunctionOf } from "./drops";

const EOL = "\r\n";
const SEP = "//===========================================================================";

/** A war3mapUnits.doo entry (format engine JSON). */
export interface UnitJson {
  id: string; variation: number; position: number[]; angle: number; skinId?: string; player: number;
  hp: number; mana: number; itemTable?: number; itemSets?: unknown[]; gold: number; targetAcquisition: number;
  level: number; strength?: number; agility?: number; intelligence?: number;
  inventory: { slot: number; id: string }[]; abilities: { id: string; autocast: number; level: number }[];
  color: number; waygate: number; editorId: number;
}

export interface UnitsInput {
  units: UnitJson[];
  /** What an object id is (custom ids by their base and the map's changes). */
  kindOf: (id: string) => "building" | "unit" | "item" | "sloc" | undefined;
  /** war3map.w3i editorVersion: newer editors write more (item colours). */
  editorVersion?: number;
  /** Generated globals the triggers use (gg_unit_…). */
  referenced: Set<string>;
  /** Region global for a waygate target (region creation number). */
  regionName?: (index: number) => string | undefined;
  /** Whether a (custom) unit type is a gold mine; default: ngol, ugol, egol. */
  goldMine?: (id: string) => boolean;
  /** Team colour a unit type has in the map's object data (lib/script/objects). */
  teamColor?: (id: string) => number | undefined;
  /** The orders that turn an ability's autocast on and off, if it has one. */
  autocastOrders?: (ability: string) => { on: string; off?: string } | undefined;
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

const GOLD_MINES = new Set(["ngol", "ugol", "egol"]);
const isGoldMine = (i: UnitsInput, id: string) => i.goldMine?.(id) ?? GOLD_MINES.has(id);

export const unitGlobal = (u: UnitJson) => `gg_unit_${u.id}_${String(u.editorId).padStart(4, "0")}`;

function unitLines(i: UnitsInput, u: UnitJson): string[] {
  const g = unitGlobal(u);
  const v = i.referenced.has(g) ? g : "u";
  const pos = `${r1(u.position[0])}, ${r1(u.position[1])}, ${deg(u.angle)}`;
  // Blighted gold mines have their own constructor (it also blights the ground).
  const lines = [u.id === "ugol"
    ? `    set ${v} = CreateBlightedGoldmine( p, ${pos} )`
    : `    set ${v} = BlzCreateUnitWithSkin( p, '${u.id}', ${pos}, '${u.skinId ?? u.id}' )`];
  if (isGoldMine(i, u.id)) lines.push(`    call SetResourceAmount( ${v}, ${u.gold} )`);
  // -2: "camp" (guard position), written as an acquisition range of 200.
  if (u.targetAcquisition === -2) lines.push(`    call SetUnitAcquireRange( ${v}, 200.0 )`);
  else if (u.targetAcquisition > 0) lines.push(`    call SetUnitAcquireRange( ${v}, ${r1(u.targetAcquisition)} )`);
  if (u.level > 1) lines.push(`    call SetHeroLevel( ${v}, ${u.level}, false )`);
  if (u.hp !== -1) lines.push(`    set life = GetUnitState( ${v}, UNIT_STATE_LIFE )`, `    call SetUnitState( ${v}, UNIT_STATE_LIFE, ${(u.hp / 100).toFixed(2)} * life )`);
  if (u.mana !== -1) lines.push(`    call SetUnitState( ${v}, UNIT_STATE_MANA, ${u.mana} )`);
  for (const a of u.abilities) {
    for (let l = 0; l < a.level; l++) lines.push(`    call SelectHeroSkill( ${v}, '${a.id}' )`);
    // Autocast abilities are switched on or off as placed.
    const orders = i.autocastOrders?.(a.id), order = a.autocast ? orders?.on : orders?.off;
    if (order) lines.push(`    call IssueImmediateOrder( ${v}, "${order}" )`);
  }
  for (const it of u.inventory) lines.push(`    call UnitAddItemToSlotById( ${v}, '${it.id}', ${it.slot} )`);
  if (u.waygate >= 0) {
    const r = i.regionName?.(u.waygate);
    if (r) lines.push(`    call WaygateSetDestination( ${v}, GetRectCenterX(${r}), GetRectCenterY(${r}) )`, `    call WaygateActivate( ${v}, true )`);
  }
  const color = u.color !== -1 ? u.color : i.teamColor?.(u.id);
  if (color !== undefined) lines.push(`    call SetUnitColor( ${v}, ConvertPlayerColor(${color}) )`);
  // Items drop from a map item table or the unit's own sets.
  const drops = dropFunctionOf("Unit", u, i.units.indexOf(u));
  if (drops) {
    lines.push("    set t = CreateTrigger(  )", `    call TriggerRegisterUnitEvent( t, ${v}, EVENT_UNIT_DEATH )`,
      `    call TriggerRegisterUnitEvent( t, ${v}, EVENT_UNIT_CHANGE_OWNER )`, `    call TriggerAddAction( t, function ${drops} )`);
  }
  return lines;
}

/** The "Items" section body: items placed on the map (war3mapUnits.doo), or "". */
export function itemsSection(i: UnitsInput): string {
  // Items are created by type id (character codes), then by creation number (not exact for
  // every map).
  const items = i.units.filter((u) => i.kindOf(u.id) === "item")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.editorId - b.editorId));
  if (!items.length) return "";
  const global = (it: UnitJson) => `gg_item_${it.id}_${String(it.editorId).padStart(4, "0")}`;
  // Editors from 7000 on colour every item (unset: 0), from 7003 with BlzSetItemColor.
  const ev = i.editorVersion ?? 0;
  const colorFn = ev >= 7003 ? "BlzSetItemColor" : ev >= 7000 ? "SetItemColor" : null;
  const colorOf = (it: UnitJson) => (colorFn ? Math.max(0, it.color) : it.color);
  // An item needs a variable when a trigger refers to it or it gets a colour; else it's a plain call.
  const usesLocal = items.some((it) => !i.referenced.has(global(it)) && colorOf(it) !== -1);
  const lines = ["function CreateAllItems takes nothing returns nothing", "    local integer itemID", ...(usesLocal ? ["    local item i"] : []), ""];
  for (const it of items) {
    const g = global(it);
    const v = i.referenced.has(g) ? g : colorOf(it) !== -1 ? "i" : null;
    const create = `BlzCreateItemWithSkin( '${it.id}', ${r1(it.position[0])}, ${r1(it.position[1])}, '${it.skinId ?? it.id}' )`;
    lines.push(v ? `    set ${v} = ${create}` : `    call ${create}`);
    if (v && colorOf(it) !== -1) lines.push(`    call ${colorFn ?? "BlzSetItemColor"}( ${v}, ConvertPlayerColor(${colorOf(it)}) )`);
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
  const placed = i.units.filter((u) => { const k = i.kindOf(u.id); return k === "unit" || k === "building"; })
    .sort((a, b) => a.editorId - b.editorId);
  if (!placed.length) return "";
  const parts: string[] = [];
  const playerBuildings: string[] = [], playerUnits: string[] = [];
  const of = (player: number, building: boolean) =>
    placed.filter((u) => u.player === player && (i.kindOf(u.id) === "building") === building).flatMap((u) => unitLines(i, u));
  const players = [...new Set(placed.map((u) => u.player))].filter((p) => p !== NEUTRAL_HOSTILE && p !== NEUTRAL_PASSIVE).sort((a, b) => a - b);
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
