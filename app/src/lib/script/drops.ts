// Item drop functions of war3map.j ("Map Item Tables", "Unit Item Tables",
// "Destructible Item Tables"): one function per item table of war3map.w3i
// (ItemTable000003_DropItems) and per placed unit or destructable with its own
// item sets, named after its position in the placement file
// (Unit000114_DropItems). Each item set picks one item by chance; random items
// ("YiI2") become ChooseRandomItemEx( type, level ).

import { EQUIPMENT_TYPES, ITEM_CLASSES, ITEM_TAGS, parseRandomId, type ItemFilter } from "../objects/randomids";

const EOL = "\r\n";

export interface DropItem { id: string; chance: number }

/** Random item classes by the second letter of "Y?I<level>". */
const RANDOM_TYPES: Record<string, string> = {
  Y: "ANY", i: "PERMANENT", j: "CHARGED", k: "POWERUP", l: "ARTIFACT", m: "PURCHASABLE", n: "CAMPAIGN", o: "MISCELLANEOUS",
};

/** A random item of a class (ITEM_TYPE_<type>) and level (-1 any) picked when the script runs. World Editor 2.0
 *  (7003) writes ChooseRandomItemExWithFilter with any equipment and tag for every class and level, any class too
 *  (we-drive saves, 2026-11-09; the 7003 maps in smoketest_maps the same); the game's maps up to 6127 have
 *  ChooseRandomItemEx, any class included. None of 7000 to 7002 has a random item: the plain ChooseRandomItem
 *  for any class there is an older guess, kept. `equipment` and `tag` (EQUIPMENT_TYPE_<name>, ITEMTAG_TYPE_<name>):
 *  a placed random item's (units.ts randomItemFilter); a drop's id holds none. */
export function randomItem(type: string, level: number | string, editorVersion: number, equipment = "ANY", tag = "ANY"): string {
  if (editorVersion >= 7003) return `ChooseRandomItemExWithFilter( ITEM_TYPE_${type}, ${level}, EQUIPMENT_TYPE_${equipment}, ITEMTAG_TYPE_${tag} )`;
  return type === "ANY" && editorVersion >= 7000 ? `ChooseRandomItem( ${level} )` : `ChooseRandomItemEx( ITEM_TYPE_${type}, ${level} )`;
}

/** A random item's call with the equipment type and tag a "Z" id holds (randomids.ts; ANY for the "Y" form). */
function filteredRandomItem(r: { level: number; itemClass: number } & ItemFilter, editorVersion: number): string {
  const name = (names: string[], n: number | undefined) => (n === undefined ? "ANY" : names[n] ?? "ANY");
  return randomItem(ITEM_CLASSES[r.itemClass].type, r.level, editorVersion, name(EQUIPMENT_TYPES, r.equipment), name(ITEM_TAGS, r.tag));
}

function itemExpr(id: string, editorVersion: number): string {
  // An empty slot drops nothing.
  if (!id || id === "0x00000000") return "-1";
  // An item set entry given an equipment type or tag ("Z" id; Head and Droppable: EQUIPMENT_TYPE_HEAD,
  // ITEMTAG_TYPE_DROPPABLE in the editor's script, branch we-batch-5).
  const r = parseRandomId(id);
  if (r?.kind === "item" && (r.equipment !== undefined || r.tag !== undefined)) return filteredRandomItem(r, editorVersion);
  const m = /^Y(.)I(.)$/.exec(id);
  if (!m || !RANDOM_TYPES[m[1]]) return `'${id}'`;
  return randomItem(RANDOM_TYPES[m[1]], m[2] === "/" ? -1 : m[2], editorVersion);
}

/** Name of the function that drops a map item table's items. */
export const itemTableFunction = (n: number) => `ItemTable${String(n).padStart(6, "0")}_DropItems`;

/** One drop function; `sets` as stored (a list of item sets, each a list of items). */
export function dropFunction(name: string, sets: DropItem[][], editorVersion = 0): string {
  const lines = [`function ${name} takes nothing returns nothing`,
    "    local widget  trigWidget = null", "    local unit    trigUnit   = null", "    local integer itemID     = 0", "    local boolean canDrop    = true", "",
    "    set trigWidget = bj_lastDyingWidget", "    if (trigWidget == null) then", "        set trigUnit = GetTriggerUnit()", "    endif", "",
    "    if (trigUnit != null) then", "        set canDrop = not IsUnitHidden(trigUnit)", "        if (canDrop and GetChangingUnit() != null) then",
    "            set canDrop = (GetChangingUnitPrevOwner() == Player(PLAYER_NEUTRAL_AGGRESSIVE))", "        endif", "    endif", "",
    "    if (canDrop) then"];
  sets.forEach((set, k) => {
    // The chance missing to 100% drops nothing.
    const rest = 100 - set.reduce((sum, it) => sum + it.chance, 0);
    lines.push(`        // Item set ${k}`, "        call RandomDistReset(  )",
      ...set.map((it) => `        call RandomDistAddItem( ${itemExpr(it.id, editorVersion)}, ${it.chance} )`),
      ...(rest > 0 ? [`        call RandomDistAddItem( -1, ${rest} )`] : []),
      "        set itemID = RandomDistChoose(  )", "        if (trigUnit != null) then", "            call UnitDropItem( trigUnit, itemID )",
      "        else", "            call WidgetDropItem( trigWidget, itemID )", "        endif", "");
  });
  lines.push("    endif", "", "    set bj_lastDyingWidget = null", "    call DestroyTrigger(GetTriggeringTrigger())", "endfunction", "");
  return lines.join(EOL);
}

/** A placed object with its own item sets, or a map item table (`itemTable` ≥ 0). */
export interface Dropper { itemSets?: unknown[]; itemTable?: number }

/** Whether an object drops from a map item table. A table that's gone counts as none: its function
 *  doesn't exist, and a script calling it wouldn't compile. `tables` are the map's own. */
const usesTable = (p: Dropper, tables?: ReadonlySet<number>) => (p.itemTable ?? -1) >= 0 && (!tables || tables.has(p.itemTable!));

/** The functions for every dropper with its own sets (`prefix` "Unit" or "Doodad"), named by file position. */
export function dropSection(prefix: string, placed: Dropper[], editorVersion = 0, tables?: ReadonlySet<number>): string {
  const parts: string[] = [];
  placed.forEach((p, index) => {
    const sets = (p.itemSets ?? []) as DropItem[][];
    if (usesTable(p, tables) || !sets.some((s) => s.length)) return;
    parts.push(dropFunction(`${prefix}${String(index).padStart(6, "0")}_DropItems`, sets, editorVersion));
  });
  return parts.join(EOL);
}

/** The functions for the map's item tables (war3map.w3i), used or not. */
export function itemTablesSection(tables: { number: number; sets: DropItem[][] }[], editorVersion = 0): string {
  return tables.map((t) => dropFunction(itemTableFunction(t.number), t.sets, editorVersion)).join(EOL);
}

/** The drop function a placed object's death triggers, if it drops anything. */
export function dropFunctionOf(prefix: string, p: Dropper, index: number, tables?: ReadonlySet<number>): string | undefined {
  if (usesTable(p, tables)) return itemTableFunction(p.itemTable!);
  if ((p.itemSets ?? []).some((s) => (s as unknown[]).length > 0)) return `${prefix}${String(index).padStart(6, "0")}_DropItems`;
  return undefined;
}

export interface RandomGroupJson { number: number; name: string; positions: number[]; lines: { chance: number; ids: string[] }[] }

/** A random group's entry: -1 for an empty slot, the object's id, or the pick of a random object by level ("YYU3"
 *  ChooseRandomCreep( 3 ), "YYB/" ChooseRandomNPBuilding(  ), "YiI2" a random item; World Editor 2.0, we-drive
 *  2026-11-12: lib/objects/randomids.ts). */
function groupEntry(id: string | undefined, editorVersion: number): string {
  if (!id || id === "0x00000000") return "-1";
  const r = parseRandomId(id);
  if (r?.kind === "creep") return `ChooseRandomCreep( ${r.level} )`;
  if (r?.kind === "building") return "ChooseRandomNPBuilding(  )";
  if (r?.kind === "item") return filteredRandomItem(r, editorVersion);
  return `'${id}'`;
}

/** The global array of the random group at `index` in the map's list: the editor's script names the groups by their
 *  place in the list (0, 1, …), not by the number the file stores (we-drive 2026-11-17, groups numbered 2 and 7:
 *  gg_rg_000 and gg_rg_001, "// Group 0 - Mixed"). */
export const randomGroupGlobal = (index: number) => `gg_rg_${String(index).padStart(3, "0")}`;

/** What a placed random object's group number stands for in the script: the group's global array element, or -1
 *  when the map has no such group (the editor writes `set unitID = -1`). `numbers`: the group numbers in file order;
 *  not given, the number itself names the global. */
export function randomGroupSlot(numbers: readonly number[] | undefined, group: number, position: number): string {
  if (!numbers) return `${randomGroupGlobal(group)}[${position}]`;
  const index = numbers.indexOf(group);
  return index < 0 ? "-1" : `${randomGroupGlobal(index)}[${position}]`;
}

/** "Random Groups": InitRandomGroups picks one line per group into gg_rg_<place in the list>[position]. */
export function randomGroupsSection(groups: RandomGroupJson[], editorVersion = 0): string {
  if (!groups.length) return "";
  const lines = ["function InitRandomGroups takes nothing returns nothing", "    local integer curset", ""];
  for (const [place, g] of groups.entries()) {
    const arr = randomGroupGlobal(place);
    const set = (ids: (string | undefined)[]) => g.positions.map((_, k) => `        set ${arr}[${k}] = ${groupEntry(ids[k], editorVersion)}`);
    lines.push(`    // Group ${place} - ${g.name}`, "    call RandomDistReset(  )",
      ...g.lines.map((l, k) => `    call RandomDistAddItem( ${k}, ${l.chance} )`), "    set curset = RandomDistChoose(  )", "");
    g.lines.forEach((l, k) => lines.push(`    ${k ? "elseif" : "if"} (curset == ${k}) then`, ...set(l.ids)));
    // No line chosen: nothing is created.
    lines.push("    else", ...set([]), "    endif", "");
  }
  lines.push("endfunction", "");
  return lines.join(EOL);
}
