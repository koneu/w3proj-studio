// Map Properties › Techtree & tables: upgrade levels and unavailable objects per player, random
// unit groups and item tables (war3map.w3i), like the World Editor's Scenario › Upgrades,
// Techtree, Random Groups and Item Tables. The lists are edited as stored, so an untouched
// entry keeps its bytes.

import { h } from "../../workbench/dom";

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
  setFlag(mask: number): void;
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

/** An object id with its name (filled in when known) and a button to pick another. */
function objectCell(ctx: TechContext, kinds: string[], get: () => string, set: (id: string) => void): HTMLElement {
  const label = h("span.muted");
  const show = () => {
    const id = get();
    label.textContent = "";
    if (id && id !== NONE) void ctx.name(id).then((n) => { if (n && get() === id) label.textContent = n; });
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
  show();
  return h("span.techtree-object", {}, input, browse, label);
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
const numberInput = (get: () => number, set: (n: number) => void, ctx: TechContext, opts: { min?: number; max?: number } = {}) => {
  const input = h("input.form-input.form-num.techtree-num", { type: "number", step: "1", min: String(opts.min ?? 0), max: opts.max !== undefined ? String(opts.max) : undefined, value: String(get()),
    onchange: () => {
      const n = Number(input.value);
      if (!Number.isInteger(n) || n < (opts.min ?? 0) || (opts.max !== undefined && n > opts.max)) { input.classList.add("invalid"); return; }
      input.classList.remove("invalid");
      set(n);
      ctx.changed();
    } });
  return input;
};
const select = <T extends number>(options: readonly (readonly [T, string])[], get: () => number, set: (v: T) => void, ctx: TechContext) => {
  const sel = h("select.form-input", {}, ...options.map(([v, label]) => h("option", { value: String(v), selected: v === get() }, label)));
  if (!options.some(([v]) => v === get())) sel.prepend(h("option", { value: String(get()), selected: true }, `${get()} (unknown)`));
  sel.addEventListener("change", () => { set(Number(sel.value) as T); ctx.changed(); });
  return sel;
};

function upgrades(info: TechInfo, ctx: TechContext): HTMLElement {
  return section(`Upgrades (${info.upgrades.length})`,
    "Per player and upgrade level: unavailable, available (the default) or already researched.",
    h("div", {}, ctx.flag(CUSTOM_UPGRADES, "Use custom upgrades")),
    h("table.form-table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Players"), h("th", {}, "Upgrade"), h("th", {}, "Level"), h("th", {}, "State"), h("th", {}))),
      h("tbody", {}, ...info.upgrades.map((u) => h("tr", {},
        h("td", {}, playersCell(ctx, () => u.players, (m) => { u.players = m; })),
        h("td", {}, objectCell(ctx, ["w3q"], () => u.id, (id) => { u.id = id; })),
        h("td", { title: "Level, counted from 1" }, numberInput(() => u.level + 1, (n) => { u.level = n - 1; }, ctx, { min: 1 })),
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
    h("div", {}, ctx.flag(CUSTOM_TECHTREE, "Use custom techtree")),
    h("table.form-table", {},
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
const chanceTotal = (chances: number[]) => {
  const sum = chances.reduce((a, b) => a + b, 0);
  return h(`span${sum === 100 ? ".muted" : ".techtree-warn"}`, { title: "Chances should add up to 100%" }, `total ${sum}%`);
};

function unitTables(info: TechInfo, ctx: TechContext): HTMLElement {
  return section(`Random groups (${info.unitTables.length})`,
    "Each line is chosen with its chance; its objects go to the group's positions (random units, buildings or items placed on the map).",
    ...info.unitTables.map((g) => h("div.techtree-table", {},
      h("div.techtree-table-head", {},
        h("input.form-input", { value: g.name, onchange: (e: Event) => { g.name = (e.target as HTMLInputElement).value; ctx.changed(); } }),
        h("span.muted", {}, `#${g.number}`), chanceTotal(g.lines.map((l) => l.chance)),
        removeButton("Remove the group", () => { info.unitTables.splice(info.unitTables.indexOf(g), 1); ctx.changed(true); })),
      h("table.form-table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Chance %"),
          ...g.positions.map((_, k) => h("th.techtree-position", {},
            select(POSITION_TYPES, () => g.positions[k], (v) => { g.positions[k] = v; }, ctx),
            removeButton("Remove this position", () => { g.positions.splice(k, 1); for (const l of g.lines) l.ids.splice(k, 1); ctx.changed(true); }))),
          h("th", {}, h("button", { title: "Add a position", onclick: () => { g.positions.push(0); for (const l of g.lines) l.ids.push(NONE); ctx.changed(true); } }, "+")))),
        h("tbody", {}, ...g.lines.map((l) => h("tr", {},
          h("td", {}, numberInput(() => l.chance, (n) => { l.chance = n; }, ctx, { max: 100 })),
          ...l.ids.map((_, k) => h("td", {}, objectCell(ctx, KINDS_OF_POSITION[g.positions[k]] ?? ["w3u"], () => l.ids[k], (id) => { l.ids[k] = id; }))),
          h("td", {}, removeButton("Remove this line", () => { g.lines.splice(g.lines.indexOf(l), 1); ctx.changed(true); })))))),
      h("button", { onclick: () => { g.lines.push({ chance: 0, ids: g.positions.map(() => NONE) }); ctx.changed(true); } }, "Add line"))),
    h("button", { onclick: () => {
      info.unitTables.push({ number: nextNumber(info.unitTables), name: "Random Group", positions: [0], lines: [{ chance: 100, ids: [NONE] }] });
      ctx.changed(true);
    } }, "Add random group"));
}

function itemTables(info: Required<TechInfo>, ctx: TechContext): HTMLElement {
  return section(`Item tables (${info.itemTables.length})`,
    "Items dropped by units that use the table: one item is chosen from each set by its chance.",
    ...info.itemTables.map((t) => h("div.techtree-table", {},
      h("div.techtree-table-head", {},
        h("input.form-input", { value: t.name, onchange: (e: Event) => { t.name = (e.target as HTMLInputElement).value; ctx.changed(); } }),
        h("span.muted", {}, `#${t.number}`),
        removeButton("Remove the table", () => { info.itemTables.splice(info.itemTables.indexOf(t), 1); ctx.changed(true); })),
      ...t.sets.map((set, k) => h("div.techtree-set", {},
        h("div.techtree-table-head", {}, h("strong", {}, `Set ${k + 1}`), chanceTotal(set.map((x) => x.chance)),
          removeButton("Remove the set", () => { t.sets.splice(k, 1); ctx.changed(true); })),
        ...set.map((x) => h("div.techtree-row", {},
          numberInput(() => x.chance, (n) => { x.chance = n; }, ctx, { max: 100 }), "% ",
          objectCell(ctx, ["w3t"], () => x.id, (id) => { x.id = id; }),
          removeButton("Remove the item", () => { set.splice(set.indexOf(x), 1); ctx.changed(true); }))),
        h("button", { onclick: async () => {
          const id = await ctx.pick("Add an item", ["w3t"]);
          if (id === undefined) return;
          set.push({ chance: set.length ? 0 : 100, id });
          ctx.changed(true);
        } }, "Add item…"))),
      h("button", { onclick: () => { t.sets.push([]); ctx.changed(true); } }, "Add set"))),
    h("button", { onclick: () => { info.itemTables.push({ number: nextNumber(info.itemTables), name: "Item Table", sets: [[]] }); ctx.changed(true); } }, "Add item table"));
}

export function renderTechtree(info: TechInfo, ctx: TechContext): Node[] {
  // Reign of Chaos maps have no item tables.
  return [upgrades(info, ctx), techs(info, ctx), unitTables(info, ctx), ...(info.itemTables ? [itemTables(info as Required<TechInfo>, ctx)] : [])];
}
