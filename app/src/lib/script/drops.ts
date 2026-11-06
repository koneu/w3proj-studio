// Item drop functions of war3map.j ("Map Item Tables", "Unit Item Tables",
// "Destructible Item Tables"): one function per item table of war3map.w3i
// (ItemTable000003_DropItems) and per placed unit or destructable with its own
// item sets, named after its position in the placement file
// (Unit000114_DropItems). Each item set picks one item by chance; random items
// ("YiI2") become ChooseRandomItemEx( type, level ).

const EOL = "\r\n";

export interface DropItem { id: string; chance: number }

/** Random item classes by the second letter of "Y?I<level>". */
const RANDOM_TYPES: Record<string, string> = {
  Y: "ANY", i: "PERMANENT", j: "CHARGED", k: "POWERUP", l: "ARTIFACT", m: "PURCHASABLE", n: "CAMPAIGN", o: "MISCELLANEOUS",
};

function itemExpr(id: string, editorVersion: number): string {
  // An empty slot drops nothing.
  if (!id || id === "0x00000000") return "-1";
  const m = /^Y(.)I(.)$/.exec(id);
  if (!m || !RANDOM_TYPES[m[1]]) return `'${id}'`;
  const level = m[2] === "/" ? -1 : m[2];
  // Any class: editors from 7000 on write the plain ChooseRandomItem.
  return m[1] === "Y" && editorVersion >= 7000 ? `ChooseRandomItem( ${level} )` : `ChooseRandomItemEx( ITEM_TYPE_${RANDOM_TYPES[m[1]]}, ${level} )`;
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

/** "Random Groups": InitRandomGroups picks one line per group into gg_rg_<number>[position]. */
export function randomGroupsSection(groups: RandomGroupJson[]): string {
  if (!groups.length) return "";
  const lines = ["function InitRandomGroups takes nothing returns nothing", "    local integer curset", ""];
  for (const g of groups) {
    const arr = `gg_rg_${String(g.number).padStart(3, "0")}`;
    const set = (ids: (string | undefined)[]) => g.positions.map((_, k) => `        set ${arr}[${k}] = ${!ids[k] || ids[k] === "0x00000000" ? "-1" : `'${ids[k]}'`}`);
    lines.push(`    // Group ${g.number} - ${g.name}`, "    call RandomDistReset(  )",
      ...g.lines.map((l, k) => `    call RandomDistAddItem( ${k}, ${l.chance} )`), "    set curset = RandomDistChoose(  )", "");
    g.lines.forEach((l, k) => lines.push(`    ${k ? "elseif" : "if"} (curset == ${k}) then`, ...set(l.ids)));
    // No line chosen: nothing is created.
    lines.push("    else", ...set([]), "    endif", "");
  }
  lines.push("endfunction", "");
  return lines.join(EOL);
}
