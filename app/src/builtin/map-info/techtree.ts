// Map Properties › Techtree & tables: upgrade levels and unavailable objects per player, random
// unit groups and item tables (war3map.w3i), like the World Editor's Scenario › Upgrades,
// Techtree, Random Groups and Item Tables. The lists are edited as stored, so an untouched
// entry keeps its bytes.

import { addChance, scaleChances } from "../../lib/chances";
import { itemFilterSelects } from "../../lib/objects/itemfilterui";
import { ITEM_CLASSES, parseRandomId, randomChoices, randomIdLabel, withItemFilter } from "../../lib/objects/randomids";
import { h } from "../../workbench/dom";
import { techGrid, upgradeGrid } from "./techgrid";

export interface Upgrade { players: number; id: string; level: number; availability: number }
export interface Tech { players: number; id: string }
export interface UnitTable { number: number; name: string; positions: number[]; lines: { chance: number; ids: string[] }[] }
export interface ItemTable { number: number; name: string; sets: { chance: number; id: string }[][] }
export interface TechInfo { upgrades: Upgrade[]; techs: Tech[]; unitTables: UnitTable[]; itemTables?: ItemTable[] }

export interface TechContext {
  /** Players of the map (id, label), for the per-player columns. */
  players: { id: number; label: string }[];
  /** Object browser over `kinds`; resolves with the id, or undefined when cancelled. */
  pick(title: string, kinds: string[]): Promise<string | undefined>;
  /** Display name of an object id. */
  name(id: string): Promise<string | undefined>;
  /** After any change: marks the editor dirty. `rerender` redraws the section (lists changed). */
  changed(rerender?: boolean): void;
  /** A map flag's checkbox, and setting a flag (the game's maps set "Use custom techtree" and
   *  "Use custom upgrades" whenever they have such entries). */
  flag(mask: number, label: string): HTMLElement;
  /** Sets a map flag; true when it wasn't set before. */
  setFlag(mask: number): boolean | void;
}

const CUSTOM_TECHTREE = 0x80, CUSTOM_UPGRADES = 0x200;

const AVAILABILITY = [[0, "Unavailable"], [1, "Available"], [2, "Researched"]] as const;
const POSITION_TYPES = [[0, "Unit"], [1, "Building"], [2, "Item"]] as const;
const KINDS_OF_POSITION: Record<number, string[]> = { 0: ["w3u"], 1: ["w3u"], 2: ["w3t"] };
/** An empty slot of a random group. */
const NONE = "0x00000000";

/** A section: title, a line of explanation, then its content (each child on its own line). */
const section = (title: string, hint: string, ...children: Node[]) =>
  h("section.form-section.techtree-section", {}, h("h3", {}, title), h("p.muted.techtree-hint", {}, hint), ...children);
const removeButton = (title: string, onclick: () => void) => h("button.icon-button", { title, onclick }, "×");

/** The random objects by level a position of a type offers ("Random Level 3 Neutral Hostile Unit"), as a choice that
 *  gives the chosen one's id and goes back to its title; the items by class, with Choose Item's equipment type and tag
 *  beside them. Those two show the random item there is and change it; else they apply to the next one chosen.
 *  `show`: the id of the cell changed. */
function randomSelect(positionType: number, current: () => string, choose: (id: string) => void): { element: HTMLElement; show(id: string): void } {
  const choices = randomChoices(positionType);
  const byClass = positionType === 2
    ? ITEM_CLASSES.map((c, k) => h("optgroup", { label: c.label }, ...choices.filter((x) => { const r = parseRandomId(x.id); return r?.kind === "item" && r.itemClass === k; })
      .map((x) => h("option", { value: x.id }, x.label))))
    : choices.map((x) => h("option", { value: x.id }, x.label));
  const sel = h("select.form-input.techtree-random", { title: "A random object of a level, chosen when the game starts" },
    h("option", { value: "" }, "Random…"), ...byClass);
  const filter = positionType === 2 ? itemFilterSelects() : null;
  sel.addEventListener("change", () => {
    const id = sel.value;
    sel.value = "";
    if (id) choose(filter ? withItemFilter(id, filter.equipment(), filter.tag()) : id);
  });
  if (!filter) return { element: sel, show: () => {} };
  for (const f of filter.elements) {
    f.classList.add("form-input", "techtree-filter");
    f.addEventListener("change", () => {
      if (parseRandomId(current())?.kind === "item") choose(withItemFilter(current(), filter.equipment(), filter.tag()));
    });
  }
  return { element: h("span.techtree-random-item", {}, ...filter.elements, sel), show: (id) => filter.show(id) };
}

/** An object id with its name (filled in when known) and a button to pick another; with `randomType` (the position's
 *  type: 0 unit, 1 building, 2 item) also the random objects by level, which show the World Editor's names. */
function objectCell(ctx: TechContext, kinds: string[], get: () => string, set: (id: string) => void, randomType?: number): HTMLElement {
  const label = h("span.muted.techtree-name");
  let random: ReturnType<typeof randomSelect> | null = null;
  const show = () => {
    const id = get();
    random?.show(id);
    label.textContent = label.title = randomIdLabel(id) ?? "";
    if (id && id !== NONE && !randomIdLabel(id)) void ctx.name(id).then((n) => { if (n && get() === id) label.textContent = label.title = n; });
  };
  const input = h("input.form-input.techtree-id", {
    value: get() === NONE ? "" : get(), placeholder: "none", maxLength: 10,
    onchange: () => { set(input.value.trim() || NONE); show(); ctx.changed(); },
  });
  const browse = h("button", {
    title: "Choose with the object browser",
    onclick: async () => {
      const id = await ctx.pick("Choose an object", kinds);
      if (id === undefined) return;
      input.value = id;
      set(id);
      show();
      ctx.changed();
    },
  }, "…");
  if (randomType !== undefined) random = randomSelect(randomType, get, (id) => {
    input.value = id;
    set(id);
    show();
    ctx.changed();
  });
  show();
  return h("span.techtree-object", {}, input, browse, ...(random ? [random.element] : []), label);
}

/** Checkboxes for the map's players over a player bit mask. */
function playersCell(ctx: TechContext, get: () => number, set: (mask: number) => void): HTMLElement {
  return h("span.techtree-players", {}, ...ctx.players.map((p) => {
    const bit = (1 << p.id) >>> 0;
    const box = h("input", { type: "checkbox", checked: (get() & bit) !== 0, title: p.label,
      onchange: () => { set((box.checked ? get() | bit : get() & ~bit) >>> 0); ctx.changed(); } });
    return h("label.techtree-player", { title: p.label }, box, String(p.id + 1));
  }));
}

const allPlayers = (ctx: TechContext) => ctx.players.reduce((m, p) => (m | (1 << p.id)) >>> 0, 0);
/** The limits of the numbers typed here: an upgrade's level is shown from 1 and stored from 0 in a u32, a chance is a
 *  percentage (stored in a u32); the World Editor's item box takes 1 at least (its group box 0). */
export const TECH_LIMITS = { level: { min: 1, max: 2 ** 32 }, chance: { min: 0, max: 100 }, itemChance: { min: 1, max: 100 } } as const;
/** A typed number within `limits`, else null (refused: the map stays as it was). */
export function techNumber(typed: string, limits: { min: number; max: number }): number | null {
  const n = Number(typed);
  return typed.trim() !== "" && Number.isInteger(n) && n >= limits.min && n <= limits.max ? n : null;
}
const numberInput = (get: () => number, set: (n: number) => void, ctx: TechContext, opts: { min: number; max: number }) => {
  const input = h("input.form-input.form-num.techtree-num", { type: "number", step: "1", min: String(opts.min), max: String(opts.max), value: String(get()),
    onchange: () => {
      const n = techNumber(input.value, opts);
      if (n === null) { input.classList.add("invalid"); input.title = `A whole number from ${opts.min} to ${opts.max}; this isn't saved.`; return; }
      input.title = "";
      input.classList.remove("invalid");
      set(n);
      ctx.changed();
    } });
  return input;
};
const select = <T extends number>(options: readonly (readonly [T, string])[], get: () => number, set: (v: T) => void, ctx: TechContext, rerender = false) => {
  const sel = h("select.form-input", {}, ...options.map(([v, label]) => h("option", { value: String(v), selected: v === get() }, label)));
  if (!options.some(([v]) => v === get())) sel.prepend(h("option", { value: String(get()), selected: true }, `${get()} (unknown)`));
  sel.addEventListener("change", () => { set(Number(sel.value) as T); ctx.changed(rerender); });
  return sel;
};

/** Which of the two sections show the grid of objects × players instead of the list of entries (kept while the app runs). */
const perPlayer = { upgrades: false, techs: false };

/** The switch between a section's list and its grid: the section is made again in place (each view edits the lists
 *  without drawing the other, so it is drawn from them anew); nothing of the map changes. */
function viewSwitch(which: keyof typeof perPlayer, remake: () => HTMLElement): HTMLElement {
  const button = (grid: boolean, label: string) => h(`button.techtree-view-${grid ? "grid" : "list"}${perPlayer[which] === grid ? ".active" : ""}`, {
    "aria-pressed": String(perPlayer[which] === grid),
    onclick: (e: Event) => {
      if (perPlayer[which] === grid) return;
      perPlayer[which] = grid;
      (e.currentTarget as HTMLElement).closest(".techtree-section")?.replaceWith(remake());
    },
  }, label);
  return h("span.techtree-view", { "data-switch": which }, button(false, "List"), button(true, "Per player"));
}

function upgrades(info: TechInfo, ctx: TechContext): HTMLElement {
  return section(`Upgrades (${info.upgrades.length})`,
    "Per player and upgrade level: unavailable, available (the default) or already researched.",
    h("div", {}, ctx.flag(CUSTOM_UPGRADES, "Use custom upgrades"), viewSwitch("upgrades", () => upgrades(info, ctx))),
    perPlayer.upgrades ? upgradeGrid(info, ctx) : h("table.form-table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Players"), h("th", {}, "Upgrade"), h("th", {}, "Level"), h("th", {}, "State"), h("th", {}))),
      h("tbody", {}, ...info.upgrades.map((u) => h("tr", {},
        h("td", {}, playersCell(ctx, () => u.players, (m) => { u.players = m; })),
        h("td", {}, objectCell(ctx, ["w3q"], () => u.id, (id) => { u.id = id; })),
        h("td", { title: "Level, counted from 1" }, numberInput(() => u.level + 1, (n) => { u.level = n - 1; }, ctx, TECH_LIMITS.level)),
        h("td", {}, select(AVAILABILITY, () => u.availability, (v) => { u.availability = v; }, ctx)),
        h("td", {}, removeButton("Remove", () => { info.upgrades.splice(info.upgrades.indexOf(u), 1); ctx.changed(true); })))))),
    h("button", { onclick: async () => {
      const id = await ctx.pick("Add an upgrade", ["w3q"]);
      if (id === undefined) return;
      info.upgrades.push({ players: allPlayers(ctx), id, level: 0, availability: 0 });
      ctx.setFlag(CUSTOM_UPGRADES);
      ctx.changed(true);
    } }, "Add upgrade…"));
}

function techs(info: TechInfo, ctx: TechContext): HTMLElement {
  return section(`Techtree (${info.techs.length} unavailable)`,
    "Units, buildings, items and abilities the players can't use (everything else is available).",
    h("div", {}, ctx.flag(CUSTOM_TECHTREE, "Use custom techtree"), viewSwitch("techs", () => techs(info, ctx))),
    perPlayer.techs ? techGrid(info, ctx) : h("table.form-table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Players"), h("th", {}, "Object"), h("th", {}))),
      h("tbody", {}, ...info.techs.map((t) => h("tr", {},
        h("td", {}, playersCell(ctx, () => t.players, (m) => { t.players = m; })),
        h("td", {}, objectCell(ctx, ["w3u", "w3t", "w3a"], () => t.id, (id) => { t.id = id; })),
        h("td", {}, removeButton("Remove", () => { info.techs.splice(info.techs.indexOf(t), 1); ctx.changed(true); })))))),
    h("button", { onclick: async () => {
      const id = await ctx.pick("Make an object unavailable", ["w3u", "w3t", "w3a"]);
      if (id === undefined) return;
      info.techs.push({ players: allPlayers(ctx), id });
      ctx.setFlag(CUSTOM_TECHTREE);
      ctx.changed(true);
    } }, "Add object…"));
}

const nextNumber = (list: { number: number }[]) => 1 + Math.max(-1, ...list.map((x) => x.number));

/** Where Map Properties scrolls to: the item tables, or one of them. */
export const ITEM_TABLES_ANCHOR = "item-tables";
export const itemTableAnchor = (number: number) => `item-table-${number}`;

/** The item tables as other modules see them (MapInfoService.liveItemTables): names through `text` (the string
 *  table), copies, a table without a list of sets has none. A map without item tables (Reign of Chaos) has none. */
export function itemTablesShown(info: TechInfo, text: (value: string) => string): ItemTable[] {
  return (info.itemTables ?? []).map((t) => ({ number: t.number, name: text(t.name), sets: Array.isArray(t.sets) ? structuredClone(t.sets) : [] }));
}

/** Adds a new item table (one empty set, named as the World Editor names it) after the others and gives it;
 *  throws for a map whose format has no item tables (Reign of Chaos). */
export function addItemTable(info: TechInfo): ItemTable {
  if (!Array.isArray(info.itemTables)) throw new Error("This map's format has no item tables (Reign of Chaos).");
  const table: ItemTable = { number: nextNumber(info.itemTables), name: "Item Table", sets: [[]] };
  info.itemTables.push(table);
  return table;
}
/** The chance boxes of a random group's lines or an item set's items, and the total they show: a chance that takes
 *  the total past 100 scales the others down as the World Editor does (lib/chances.ts), a lower one leaves them; the
 *  other boxes and the total follow in place, and the whole change is one undo step. */
function chanceBoxes(lines: { chance: number }[], ctx: TechContext, limits: { min: number; max: number }) {
  const total = h("span.techtree-total", { title: "Chances should add up to 100%" });
  const showTotal = () => {
    const sum = lines.reduce((a, l) => a + l.chance, 0);
    total.className = `techtree-total ${sum === 100 ? "muted" : "techtree-warn"}`;
    total.textContent = `total ${sum}%`;
  };
  const inputs: HTMLInputElement[] = lines.map((line, k) => numberInput(() => line.chance, (n) => {
    const out = scaleChances(lines.map((l) => l.chance), k, n, "cap");
    lines.forEach((l, i) => {
      l.chance = out[i];
      if (i === k) return;
      inputs[i].value = String(l.chance);
      inputs[i].classList.remove("invalid");
      inputs[i].title = "";
    });
    showTotal();
  }, ctx, limits));
  showTotal();
  return { inputs, total };
}

function unitTables(info: TechInfo, ctx: TechContext): HTMLElement {
  return section(`Random groups (${info.unitTables.length})`,
    "Each line is chosen with its chance; its objects go to the group's positions (random units, buildings or items placed on the map).",
    ...info.unitTables.map((g) => { const chances = chanceBoxes(g.lines, ctx, TECH_LIMITS.chance); return h("div.techtree-table", { "data-group": String(g.number) },
      h("div.techtree-table-head", {},
        h("input.form-input", { value: g.name, onchange: (e: Event) => { g.name = (e.target as HTMLInputElement).value; ctx.changed(); } }),
        h("span.muted", {}, `#${g.number}`), chances.total,
        removeButton("Remove the group", () => { info.unitTables.splice(info.unitTables.indexOf(g), 1); ctx.changed(true); })),
      h("table.form-table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Chance %"),
          ...g.positions.map((_, k) => h("th.techtree-position", {},
            // Drawn again: the position's random choices follow its type.
            select(POSITION_TYPES, () => g.positions[k], (v) => { g.positions[k] = v; }, ctx, true),
            removeButton("Remove this position", () => { g.positions.splice(k, 1); for (const l of g.lines) l.ids.splice(k, 1); ctx.changed(true); }))),
          h("th", {}, h("button", { title: "Add a position", onclick: () => { g.positions.push(0); for (const l of g.lines) l.ids.push(NONE); ctx.changed(true); } }, "+")))),
        h("tbody", {}, ...g.lines.map((l, row) => h("tr", {},
          h("td", {}, chances.inputs[row]),
          ...l.ids.map((_, k) => h("td", {}, objectCell(ctx, KINDS_OF_POSITION[g.positions[k]] ?? ["w3u"], () => l.ids[k], (id) => { l.ids[k] = id; }, g.positions[k]))),
          h("td", {}, removeButton("Remove this line", () => { g.lines.splice(g.lines.indexOf(l), 1); ctx.changed(true); })))))),
      h("button", { onclick: () => { g.lines.push({ chance: 0, ids: g.positions.map(() => NONE) }); ctx.changed(true); } }, "Add line")); }),
    h("button", { onclick: () => {
      info.unitTables.push({ number: nextNumber(info.unitTables), name: "Random Group", positions: [0], lines: [{ chance: 100, ids: [NONE] }] });
      ctx.changed(true);
    } }, "Add random group"));
}

function itemTables(info: Required<TechInfo>, ctx: TechContext): HTMLElement {
  const el = section(`Item tables (${info.itemTables.length})`,
    "Items dropped by units that use the table: one item is chosen from each set by its chance. A placed unit, building or item "
      + "uses one in the terrain editor (Selection › Drops › Map item table) or in Scenario › Item Drops, which also shows where each table is used.",
    ...info.itemTables.map((t) => h("div.techtree-table", { "data-anchor": itemTableAnchor(t.number) },
      h("div.techtree-table-head", {},
        h("input.form-input", { value: t.name, onchange: (e: Event) => { t.name = (e.target as HTMLInputElement).value; ctx.changed(); } }),
        h("span.muted", {}, `#${t.number}`),
        removeButton("Remove the table", () => { info.itemTables.splice(info.itemTables.indexOf(t), 1); ctx.changed(true); })),
      ...t.sets.map((set, k) => { const chances = chanceBoxes(set, ctx, TECH_LIMITS.itemChance); return h("div.techtree-set", {},
        h("div.techtree-table-head", {}, h("strong", {}, `Set ${k + 1}`), chances.total,
          removeButton("Remove the set", () => { t.sets.splice(k, 1); ctx.changed(true); })),
        ...set.map((x, row) => h("div.techtree-row", {},
          chances.inputs[row], "% ",
          objectCell(ctx, ["w3t"], () => x.id, (id) => { x.id = id; }, 2),
          removeButton("Remove the item", () => { set.splice(set.indexOf(x), 1); ctx.changed(true); }))),
        h("button", { onclick: async () => {
          const id = await ctx.pick("Add an item", ["w3t"]);
          if (id === undefined) return;
          // The editor's New Item box starts at 100 and the set's other items scale down to the rest.
          const out = addChance(set.map((x) => x.chance));
          set.forEach((x, i) => { x.chance = out[i]; });
          set.push({ chance: out[set.length], id });
          ctx.changed(true);
        } }, "Add item…")); }),
      h("button", { onclick: () => { t.sets.push([]); ctx.changed(true); } }, "Add set"))),
    h("button", { onclick: () => { addItemTable(info); ctx.changed(true); } }, "Add item table"));
  el.dataset.anchor = ITEM_TABLES_ANCHOR;
  return el;
}

export function renderTechtree(info: TechInfo, ctx: TechContext): Node[] {
  // Reign of Chaos maps have no item tables.
  return [upgrades(info, ctx), techs(info, ctx), unitTables(info, ctx), ...(info.itemTables ? [itemTables(info as Required<TechInfo>, ctx)] : [])];
}
