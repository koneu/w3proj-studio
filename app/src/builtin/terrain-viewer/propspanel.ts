// The "Properties" part of the terrain viewer's Selection panel: the fields of unitprops.ts for the
// selected placed objects, one control each. Every control hands one change to the host, which makes
// it one undo step (or refuses it whole) and shows the panel again. With several objects selected it
// shows the fields they all have; a value they don't share shows as "mixed" and stays as it is until
// something is chosen.

import { h } from "../../workbench/dom";
import {
  ACQUIRE_CAMP, ACQUIRE_NORMAL, CAMP_RANGE, COLORS, DEFAULT, activeOthers, attributesAt, commonFields, isActive, maxSkillLevel, pointsSpent,
  heroPools, randomItemLabel, sameValue, type PropChange, type TypeFacts,
} from "./unitprops";
import type { Placed } from "./objects";

export interface PropsPanelHost {
  items: { entry: Placed; facts: TypeFacts }[];
  /** Shown, nothing can be changed (a read-only document). */
  readOnly?: boolean;
  /** The map's regions (war3map.w3r): number and name. */
  regions: { index: number; name: string }[];
  /** Makes the change as one undo step and shows the panel again; the reason when it's refused. */
  change(c: PropChange): string | null;
  /** Display name of an object id. */
  name(id: string, kinds?: string[]): Promise<string | undefined>;
  /** The object browser over `kinds`; the id, or undefined when cancelled. */
  pick(title: string, kinds: string[]): Promise<string | undefined>;
  /** A player colour's name (0 Red …). */
  colorName(n: number): string;
  /** Tells the user why a change was refused. */
  warn(message: string): void;
}

type Entry = Placed & Record<string, unknown>;
const MIXED = "mixed";

const row = (label: string, ...els: (Node | string)[]) =>
  h("div.terrain-sel-row.terrain-prop-row", {}, h("span.muted", {}, label), h("span.terrain-prop-value", {}, ...els));

/** A drop-down; `value` undefined: the objects differ ("mixed", until something is chosen). */
function select(value: string | undefined, options: [string, string][], prop: string, commit: (v: string) => void): HTMLSelectElement {
  const opts = value === undefined ? [["", MIXED] as [string, string], ...options] : [...options];
  if (value !== undefined && !opts.some(([v]) => v === value)) opts.push([value, `#${value}`]);
  const sel = h("select.terrain-prop-select", { "data-prop": prop, onchange: () => { if (sel.value !== "") commit(sel.value); } },
    ...opts.map(([v, label]) => h("option", { value: v, selected: v === (value ?? "") }, label)));
  return sel;
}

/** An id shown with its name once known. */
function named(host: PropsPanelHost, id: string, kinds?: string[]): HTMLElement {
  const random = randomItemLabel(id);
  const el = h("span.terrain-prop-name", { title: id }, random ?? id);
  if (random) return el;
  void host.name(id, kinds).then((n) => { if (n) el.textContent = `${n} (${id})`; }).catch(() => { /* id stays */ });
  return el;
}

/** The properties of the selected objects, or null when none apply. */
export function propsPanel(host: PropsPanelHost): HTMLElement | null {
  const items = host.items, entries = items.map((it) => it.entry as Entry);
  const fields = commonFields(items);
  if (!fields.length) return null;
  const same = <T,>(get: (e: Entry) => T) => sameValue(entries, (e) => get(e as Entry));
  const send = (c: PropChange) => { const why = host.change(c); if (why) host.warn(`Not changed: ${why}`); };
  const facts = items[0].facts;

  /** A number box; empty with a placeholder for "default" (when allowed) or mixed values. */
  const numberBox = (value: number | undefined, opts: { min?: number; max?: number; step?: number; empty?: number; placeholder?: string; title?: string; prop: string }, commit: (v: number) => void) => {
    const shown = value === undefined || value === opts.empty ? "" : String(value);
    const input = h("input.terrain-sel-num", {
      type: "number", value: shown, min: opts.min, max: opts.max, step: opts.step ?? 1, title: opts.title ?? "",
      placeholder: value === undefined ? MIXED : (opts.placeholder ?? ""), "data-prop": opts.prop,
      onchange: () => {
        const text = input.value.trim();
        if (text === "") { if (opts.empty !== undefined) commit(opts.empty); else input.value = shown; return; }
        const v = Number(text);
        if (Number.isFinite(v)) commit(v); else input.value = shown;
      },
    });
    return input;
  };
  const rows: HTMLElement[] = [];
  const ofMax = (n: number) => (n > 0 ? h("span.muted", {}, ` of ${n}`) : "");
  const maxShared = (get: (f: TypeFacts) => number) => { const v = items.map((it) => get(it.facts)); return v.every((x) => x === v[0]) ? v[0] : 0; };
  /** Hit points (0) or mana (1) the objects have in full, if they all have the same: a hero's grow with its attributes. */
  const pool = (k: 0 | 1) => {
    const v = items.map((it) => (it.facts.hero ? heroPools(it.facts, it.entry)?.[k] ?? 0 : k === 0 ? it.facts.maxHp : it.facts.maxMana));
    return v.every((x) => x === v[0]) ? Math.floor(v[0]) : 0;
  };

  for (const field of fields) {
    switch (field) {
      case "hp":
        rows.push(row("Hit points %", numberBox(same((e) => e.hp as number), { min: 1, max: 100, empty: DEFAULT, placeholder: "100 (default)", prop: "hp",
          title: "Percent of the type's hit points. Empty: the default (full)." }, (v) => send({ field: "hp", value: v })),
        ofMax(pool(0))));
        break;
      case "mana":
        rows.push(row("Mana", numberBox(same((e) => e.mana as number), { min: 1, empty: DEFAULT, placeholder: "default", prop: "mana",
          title: "Mana points the unit starts with. Empty: the default." }, (v) => send({ field: "mana", value: v })),
        ofMax(pool(1))));
        break;
      case "gold":
        rows.push(row("Gold", numberBox(same((e) => e.gold as number), { min: 0, step: 100, prop: "gold", title: "Gold in the mine" }, (v) => send({ field: "gold", value: v }))));
        break;
      case "level":
        rows.push(row("Hero level", numberBox(same((e) => e.level as number), { min: 1, max: facts.maxLevel, prop: "level",
          title: "Lowering it takes back skill points it no longer has" }, (v) => send({ field: "level", value: v })), ofMax(facts.maxLevel)));
        break;
      case "attributes": {
        const stats = same((e) => [e.strength, e.agility, e.intelligence] as number[]);
        const isDefault = stats !== undefined && stats.every((v) => v === 0);
        const level = same((e) => e.level as number) ?? 1;
        const shownStats = isDefault ? attributesAt(facts, level) ?? [0, 0, 0] : stats;
        const boxes = ["Strength", "Agility", "Intelligence"].map((label, i) => numberBox(shownStats?.[i], { min: 1, prop: `attr-${i}`, title: label }, (v) => {
          const next = [...(shownStats ?? [1, 1, 1])] as [number, number, number];
          next[i] = v;
          send({ field: "attributes", value: next });
        }));
        // Mixed attributes: one box would set the other two as well, so only Default can be chosen for all.
        if (isDefault || stats === undefined) for (const b of boxes) b.disabled = true;
        const def = h("input", { type: "checkbox", checked: isDefault, indeterminate: stats === undefined, "data-prop": "attr-default", onchange: () => {
          send({ field: "attributes", value: def.checked ? null : (attributesAt(facts, level) ?? [1, 1, 1]) });
        } });
        rows.push(row("Attributes", h("label.terrain-prop-check", { title: "The hero's own attributes for its level" }, def, " Default")),
          row("Str/Agi/Int", h("span.terrain-sel-triple", {}, ...boxes)));
        break;
      }
      case "skills": {
        // Several heroes (of one type): a skill they don't all have at one level shows as mixed.
        const e = entries[0];
        type Abilities = { id: string; level: number; autocast: number }[];
        const abilities = (e.abilities as Abilities) ?? [];
        const level = (e.level as number) ?? 1;
        const spent = pointsSpent(abilities);
        rows.push(h("div.terrain-sel-sub.muted", {}, entries.length > 1 ? "Skills" : `Skills: ${spent} of ${level} point${level === 1 ? "" : "s"} spent`));
        for (const s of facts.skills) {
          const now = same((x) => ((x.abilities as Abilities) ?? []).find((a) => a.id === s.id)?.level ?? 0);
          const max = maxSkillLevel(s, level, facts.levelSkip);
          rows.push(row("", named(host, s.id, ["w3a"]), numberBox(now, { min: 0, max: s.levels, prop: `skill-${s.id}`,
            title: `Up to level ${max} at hero level ${level} (the skill has ${s.levels})` }, (v) => send({ field: "skill", id: s.id, level: v })), ofMax(s.levels)));
        }
        // Skills the hero has learned that its type no longer lists: shown, and can be taken off.
        for (const a of abilities.filter((x) => x.level > 0 && !facts.skills.some((s) => s.id === x.id))) {
          rows.push(row("", named(host, a.id, ["w3a"]), ` level ${a.level} `,
            h("button.icon-button", { title: "Not one of this hero's skills: take it off", onclick: () => send({ field: "skill", id: a.id, level: 0 }) }, "×")));
        }
        break;
      }
      case "active": {
        // The World Editor's Abilities tab, its Active boxes: abilities placed switched on (autocast, or a toggle
        // like Defend). Objects of one type; one that differs shows as mixed until clicked.
        rows.push(h("div.terrain-sel-sub.muted", {}, "Abilities placed switched on"));
        const ids = [...new Set([...facts.toggles, ...entries.flatMap((e) => activeOthers(e, facts))])];
        for (const id of ids) {
          const now = same((e) => isActive(e, id));
          const own = facts.toggles.includes(id);
          const box = h("input", { type: "checkbox", "data-prop": `active-${id}`, checked: now === true,
            title: own ? "Active: the unit starts with it switched on" : "Not one of this unit type's: it can only be switched off",
            onchange: () => send({ field: "active", id, on: box.checked }) });
          box.indeterminate = now === undefined;
          if (!own && now === false) continue;
          rows.push(row("", h("label.terrain-prop-check", {}, box, " ", named(host, id, ["w3a"]))));
        }
        break;
      }
      case "inventory": {
        const slots = Math.max(facts.slots, ...entries.flatMap((e) => ((e.inventory as { slot: number }[]) ?? []).map((it) => it.slot + 1)));
        rows.push(h("div.terrain-sel-sub.muted", {}, "Inventory"));
        for (let slot = 0; slot < slots; slot++) {
          const id = same((e) => ((e.inventory as { slot: number; id: string }[]) ?? []).find((it) => it.slot === slot)?.id ?? null);
          const choose = h("button", { "data-prop": `slot-${slot}`, title: "Choose an item for this slot", onclick: async () => {
            const picked = await host.pick(`Item for slot ${slot + 1}`, ["w3t"]);
            if (picked !== undefined) send({ field: "slot", slot, id: picked });
          } }, "Choose…");
          rows.push(row(`Slot ${slot + 1}`, id === undefined ? MIXED : id === null ? h("span.muted", {}, "empty") : named(host, id, ["w3t"]), " ", choose,
            ...(id !== null ? [h("button.icon-button", { title: "Empty this slot", onclick: () => send({ field: "slot", slot, id: null }) }, "×")] : [])));
        }
        break;
      }
      case "acquire": {
        const ta = same((e) => e.targetAcquisition as number);
        const mode = ta === undefined ? undefined : ta === ACQUIRE_NORMAL ? "normal" : ta === ACQUIRE_CAMP ? "camp" : "custom";
        // The World Editor offers Normal and Camp; a range of its own (MCP place_objects can give one) is shown and kept.
        const normal = maxShared((f) => f.acquireRange);
        const options: [string, string][] = [["normal", normal > 0 ? `Normal (${normal})` : "Normal"], ["camp", `Camp (${CAMP_RANGE})`],
          ...(mode === "custom" ? [["custom", "Own range"] as [string, string]] : [])];
        const sel = select(mode, options, "acquire", (v) => {
          if (v === "normal") send({ field: "acquire", value: ACQUIRE_NORMAL });
          else if (v === "camp") send({ field: "acquire", value: ACQUIRE_CAMP });
        });
        rows.push(row("Acquire range", sel, ...(mode === "custom" ? [numberBox(ta, { min: 1, max: 5000, step: 50, prop: "acquire-range" }, (v) => send({ field: "acquire", value: v }))] : [])));
        break;
      }
      case "waygate": {
        const wg = same((e) => e.waygate as number);
        rows.push(row("Destination", select(wg === undefined ? undefined : String(wg), [[String(DEFAULT), "None (inactive)"], ...host.regions.map((r) => [String(r.index), r.name] as [string, string])],
          "waygate", (v) => send({ field: "waygate", value: Number(v) }))));
        break;
      }
      case "color": {
        const c = same((e) => e.color as number);
        rows.push(row("Custom colour", select(c === undefined ? undefined : String(c), [[String(DEFAULT), "None (the owner's)"], ...Array.from({ length: COLORS }, (_, i) => [String(i), host.colorName(i)] as [string, string])],
          "color", (v) => send({ field: "color", value: Number(v) }))));
        break;
      }
      case "life":
        rows.push(row("Life %", numberBox(same((e) => e.life as number), { min: 0, max: 100, prop: "life", title: "Percent of its hit points; 0 places it dead" }, (v) => send({ field: "life", value: v })),
          ofMax(maxShared((f) => f.maxHp))));
        break;
      case "drops":
        // A block of its own higher up in the panel (dropsedit.ts dropsBlock).
        break;
    }
  }
  if (!rows.length) return null;
  // A fieldset: read-only, every control in it is off at once.
  return h("fieldset.terrain-props", { disabled: !!host.readOnly },
    h("legend.terrain-sel-sub.muted", {}, items.length > 1 ? `Properties (${items.length} objects)` : "Properties"), ...rows);
}
