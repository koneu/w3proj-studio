// Map Properties › Techtree & tables, per player: the upgrades and the unavailable objects as a grid of objects × players,
// as the World Editor's Scenario › Techtree Settings and Upgrade Settings show them a player at a time. It edits the
// same lists as the list view (war3map.w3i upgrades and techs, each entry an object with a player bit mask): a cell
// changed takes its player's bit out of the entries that had it and puts it where the new state is kept. Entries that
// no cell changed keep their bytes; one that has no player left goes.

import { h } from "../../workbench/dom";
import type { TechContext, TechInfo, Tech, Upgrade } from "./techtree";

const bit = (player: number) => (1 << player) >>> 0;
/** An upgrade's state for a player that no entry names: available. */
export const DEFAULT_AVAILABILITY = 1;

/** The objects of the unavailable list, once each, in the order they come. */
export const techRows = (techs: readonly Tech[]): string[] => [...new Set(techs.map((t) => t.id))];

/** Whether a player can use an object: no entry of it has the player. */
export const techAvailable = (techs: readonly Tech[], id: string, player: number) =>
  !techs.some((t) => t.id === id && (t.players & bit(player)) !== 0);

/** Makes an object available or unavailable to a player; false when it already was. Made unavailable, the player goes
 *  into the object's first entry (or a new one at the end); made available, out of every entry of it. */
export function setTechAvailable(techs: Tech[], id: string, player: number, available: boolean): boolean {
  if (techAvailable(techs, id, player) === available) return false;
  const b = bit(player);
  if (available) {
    for (const t of techs.filter((t) => t.id === id && (t.players & b) !== 0)) {
      t.players = (t.players & ~b) >>> 0;
      if (t.players === 0) techs.splice(techs.indexOf(t), 1);
    }
  } else {
    const t = techs.find((t) => t.id === id);
    if (t) t.players = (t.players | b) >>> 0;
    else techs.push({ players: b, id });
  }
  return true;
}

/** The upgrade levels of the list, once each, in the order they come. */
export function upgradeRows(upgrades: readonly Upgrade[]): { id: string; level: number }[] {
  const seen = new Map<string, { id: string; level: number }>();
  for (const u of upgrades) if (!seen.has(`${u.id}:${u.level}`)) seen.set(`${u.id}:${u.level}`, { id: u.id, level: u.level });
  return [...seen.values()];
}

/** A player's state of an upgrade level: the last entry that names the player (the script applies them in order), else
 *  available. */
export function upgradeState(upgrades: readonly Upgrade[], id: string, level: number, player: number): number {
  let state = DEFAULT_AVAILABILITY;
  for (const u of upgrades) if (u.id === id && u.level === level && (u.players & bit(player)) !== 0) state = u.availability;
  return state;
}

/** Sets a player's state of an upgrade level; false when it already was. The player leaves every entry of the level and
 *  joins the first one with that state (or a new one at the end), except for available, which needs no entry. */
export function setUpgradeState(upgrades: Upgrade[], id: string, level: number, player: number, state: number): boolean {
  if (upgradeState(upgrades, id, level, player) === state) return false;
  const b = bit(player);
  const same = (u: Upgrade) => u.id === id && u.level === level;
  for (const u of upgrades.filter((u) => same(u) && (u.players & b) !== 0)) {
    u.players = (u.players & ~b) >>> 0;
    if (u.players === 0) upgrades.splice(upgrades.indexOf(u), 1);
  }
  if (state !== DEFAULT_AVAILABILITY) {
    const u = upgrades.find((u) => same(u) && u.availability === state);
    if (u) u.players = (u.players | b) >>> 0;
    else upgrades.push({ players: b, id, level, availability: state });
  }
  return true;
}

const CUSTOM_TECHTREE = 0x80, CUSTOM_UPGRADES = 0x200;
const STATES = [[0, "–", "Unavailable"], [1, "✓", "Available"], [2, "R", "Researched"]] as const;

/** An object's id and, once known, its name. */
function objectLabel(ctx: TechContext, id: string, extra = ""): HTMLElement {
  const name = h("span.muted");
  void ctx.name(id).then((n) => { if (n) name.textContent = ` ${n}`; });
  return h("span.techtree-grid-object", {}, h("code", {}, id), extra, name);
}

const head = (ctx: TechContext, first: string) =>
  h("thead", {}, h("tr", {}, h("th", {}, first), ...ctx.players.map((p) => h("th.techtree-grid-player", { title: p.label }, String(p.id + 1)))));

/** The unavailable objects × players: a cell is ticked where the player can use the object. */
export function techGrid(info: TechInfo, ctx: TechContext): HTMLElement {
  return h("table.form-table.techtree-grid.techtree-grid-techs", {}, head(ctx, "Object"),
    h("tbody", {}, ...techRows(info.techs).map((id) => h("tr", { "data-object": id },
      h("td", {}, objectLabel(ctx, id)),
      ...ctx.players.map((p) => {
        const box = h("input", { type: "checkbox", checked: techAvailable(info.techs, id, p.id), title: `${p.label}: ${id} available`,
          onchange: () => {
            if (!setTechAvailable(info.techs, id, p.id, box.checked)) return;
            // The flag's box is drawn again when this set it.
            ctx.changed(!box.checked && ctx.setFlag(CUSTOM_TECHTREE) === true);
          } });
        return h("td.techtree-grid-cell", { "data-player": String(p.id) }, box);
      })))));
}

/** The upgrade levels × players: each cell the player's state of the level. */
export function upgradeGrid(info: TechInfo, ctx: TechContext): HTMLElement {
  return h("table.form-table.techtree-grid.techtree-grid-upgrades", {}, head(ctx, "Upgrade, level"),
    h("tbody", {}, ...upgradeRows(info.upgrades).map(({ id, level }) => h("tr", { "data-object": id, "data-level": String(level + 1) },
      h("td", {}, objectLabel(ctx, id, ` ${level + 1}`)),
      ...ctx.players.map((p) => {
        const current = upgradeState(info.upgrades, id, level, p.id);
        const sel = h("select.form-input.techtree-grid-state", { title: `${p.label}: ${id} level ${level + 1}` },
          ...STATES.map(([v, short, label]) => h("option", { value: String(v), selected: v === current, title: label }, short)));
        if (!STATES.some(([v]) => v === current)) sel.prepend(h("option", { value: String(current), selected: true }, `${current}?`));
        sel.addEventListener("change", () => {
          const state = Number(sel.value);
          if (!setUpgradeState(info.upgrades, id, level, p.id, state)) return;
          ctx.changed(state !== DEFAULT_AVAILABILITY && ctx.setFlag(CUSTOM_UPGRADES) === true);
        });
        return h("td.techtree-grid-cell", { "data-player": String(p.id) }, sel);
      })))));
}
