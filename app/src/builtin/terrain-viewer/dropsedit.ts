// The drops of placed objects on the page: the Selection panel's compact Drops block (what drops, readable at a
// glance, with "Edit drops…") and the wide editor of the Item Drops tab (each set as a whole: item icons, full names,
// chances as bars and shares of the set, the set's total and what drops nothing). Both hand changes to their host,
// which makes each one undo step or refuses it whole (unitprops.ts checks, dropsview.ts works out bulk edits).

import { h } from "../../workbench/dom";
import { dropsText, dropsVariants, isEmptyItem, itemLabel, setHeading, setShares, type BulkDrops } from "./dropsview";
import type { Placed } from "./objects";
import { dropsOf, ownSetsOnly, redistribute, sameValue, setTotal, tableChoice, type DropItem } from "./unitprops";

/** A map item table (war3map.w3i) with what it drops. */
export interface ItemTableInfo { number: number; name: string; sets: DropItem[][] }

export interface DropsUiHost {
  /** Shown, nothing can be changed (a read-only document). */
  readOnly?: boolean;
  /** The map's item tables; null when war3map.w3i couldn't be read. */
  tables: ItemTableInfo[] | null;
  /** Map Properties has unsaved changes: the tables are shown as last saved. */
  tablesUnsaved?: boolean;
  /** An item's name (the map's own for custom items). */
  itemName(id: string): Promise<string | undefined>;
  /** An item's name if it is known already (one-line summaries can't wait). */
  nameNow?(id: string): string | undefined;
  /** Which objects these are, in a few words ("2 × Forest Troll"), for drops that differ among them. */
  whoOf?(entries: readonly Placed[]): string;
  /** An item's icon as a data URL, or null. */
  itemIcon(id: string): Promise<string | null>;
  /** The item browser; the id, or undefined when cancelled. */
  pickItem(title: string): Promise<string | undefined>;
  /** The objects' drops changed in one undo step (bulkDrops); the reason when refused (nothing changed then). */
  bulk(edit: BulkDrops): string | null;
  /** Tells why a change was refused. */
  warn(message: string): void;
  /** Map Properties at its item tables (at one of them, by number). */
  openItemTables(table?: number): void;
  /** Makes a new map item table (Map Properties opens on it) and has the objects drop from it. */
  createItemTable(): Promise<void>;
}

const MIXED = "mixed";

/** An item: its icon (a "?" for random items and what has none) and its full name, the id in the tooltip. */
export function itemView(host: Pick<DropsUiHost, "itemName" | "itemIcon">, id: string): HTMLElement {
  const random = itemLabel(id) !== id && !isEmptyItem(id);
  const icon = h("span.drops-icon", { "aria-hidden": "true" }, "?");
  const name = h("span.drops-name", { title: id }, itemLabel(id));
  if (!random && !isEmptyItem(id)) {
    void host.itemName(id).then((n) => { if (n) name.textContent = n; }).catch(() => { /* the id stays */ });
    void host.itemIcon(id).then((src) => {
      if (src) icon.replaceChildren(h("img", { src, alt: "" }));
    }).catch(() => { /* the "?" stays */ });
  }
  return h("span.drops-item", { "data-item": id }, icon, name);
}

/** A share of a set as a bar. */
const bar = (share: number, nothing = false) =>
  h(`span.drops-bar${nothing ? ".nothing" : ""}`, {}, h("span", { style: { width: `${Math.max(0, Math.min(1, share)) * 100}%` } }));

const tableName = (host: DropsUiHost, n: number) => host.tables?.find((t) => t.number === n)?.name;
const namesOf = (host: DropsUiHost) => ({ table: (n: number) => tableName(host, n) ?? (host.tables === null ? `#${n}` : undefined), item: (id: string) => host.nameNow?.(id) });

/** A set read-only: its head line, then each item with its chance and bar, then what drops nothing. */
function setReadOnly(host: DropsUiHost, set: readonly DropItem[], k: number, compact: boolean): HTMLElement {
  const s = setShares(set);
  return h(`div.drops-set${compact ? ".compact" : ""}`, { "data-set": String(k) },
    h(`div.drops-sethead${s.over ? ".over" : ""}`, {}, setHeading(set, k)),
    ...s.items.map((it) => h("div.drops-row", {}, itemView(host, it.id), h("span.drops-chance", {}, `${it.chance}%`), bar(it.share))),
    ...(set.length && s.nothing ? [h("div.drops-row.nothing", {}, h("span.drops-item", {}, h("span.drops-icon", {}, ""), h("span.drops-name", {}, "Nothing")),
      h("span.drops-chance", {}, `${s.nothing}%`), bar(s.nothing / 100, true))] : []));
}

/** A map item table's contents, read-only. */
export function tableView(host: DropsUiHost, table: ItemTableInfo, compact: boolean): HTMLElement {
  return h("div.drops-table", { "data-table": String(table.number) },
    ...(table.sets.length ? table.sets.map((set, k) => setReadOnly(host, set, k, compact)) : [h("div.muted", {}, "No sets: drops nothing.")]));
}

/** The mode drop-down: nothing, a map item table (not for the older layout), own sets. */
function modeSelect(host: DropsUiHost, entries: readonly Placed[], mode: string | undefined, onTable: () => void, onCustom: () => void): HTMLSelectElement {
  const onlyOwn = ownSetsOnly(entries);
  const modes: [string, string][] = [["none", "Nothing"], ...(onlyOwn ? [] : [["table", "Map item table"] as [string, string]]), ["custom", "Own item sets"]];
  const opts = mode === undefined ? [["", MIXED] as [string, string], ...modes] : modes;
  const sel = h("select.drops-mode", { "data-prop": "drops-mode", title: "What these objects drop when they die",
    onchange: () => {
      if (sel.value === "none") send(host, { op: "same", drops: { mode: "none" } });
      else if (sel.value === "table") onTable();
      else if (sel.value === "custom") onCustom();
    } }, ...opts.map(([v, label]) => h("option", { value: v, selected: v === (mode ?? "") }, label)));
  return sel;
}

const send = (host: DropsUiHost, edit: BulkDrops) => {
  const why = host.bulk(edit);
  if (why) host.warn(`Not changed: ${why}`);
};

/** The parts both views share: the mode, the hint for the older layout, the offer to make a table, the table chosen. */
function common(host: DropsUiHost, entries: readonly Placed[], wide: boolean) {
  const drops = sameValue(entries, (e) => dropsOf(e));
  const onlyOwn = ownSetsOnly(entries);
  const tables = host.tables ?? [];
  const create = h("button", { "data-prop": "create-table", title: "A new item table in Map Properties (saved with it), opened there to fill in; these objects drop from it",
    onclick: async () => {
      create.disabled = true;
      try { await host.createItemTable(); } finally { create.disabled = false; }
    } }, "Create an item table");
  const offer = h("div.drops-offer", { "data-prop": "table-offer", hidden: true }, h("span.muted", {}, "The map has no item tables yet."), create);
  const mode = modeSelect(host, entries, drops?.mode, () => {
    const choice = tableChoice(host.tables);
    if ("error" in choice) { host.warn(choice.error); mode.value = drops?.mode ?? ""; }
    else if ("offer" in choice) { mode.value = drops?.mode ?? ""; offer.hidden = false; create.focus(); }
    else send(host, { op: "same", drops: { mode: "table", table: choice.table } });
  }, () => send(host, { op: "same", drops: { mode: "custom", sets: drops?.mode === "custom" ? drops.sets : [[]] } }));
  // The narrow block's legend says "Drops" already.
  const parts: HTMLElement[] = [wide ? h("div.drops-line", {}, h("span.muted.drops-label", {}, "Drops"), mode) : h("div.drops-line.single", {}, mode), offer];
  if (onlyOwn) parts.push(h("div.muted.drops-hint", { "data-prop": "drops-hint" }, onlyOwn));
  const editTables = (n?: number) => h("button", { "data-prop": "edit-tables", title: "Map Properties › Techtree & Tables › Item tables", onclick: () => host.openItemTables(n) }, "Edit item tables…");
  if (drops?.mode === "table") {
    // Tables that couldn't be read (null) aren't taken for missing ones.
    const table = tables.find((t) => t.number === drops.table);
    const known = host.tables === null || !!table;
    const options: [string, string][] = [...tables.map((t) => [String(t.number), `${t.name} (#${t.number})`] as [string, string]),
      ...(known && table ? [] : [[String(drops.table), known ? `#${drops.table}` : `#${drops.table} (not in the map)`] as [string, string]])];
    const sel = h("select.drops-table-select", { "data-prop": "drops-table", title: "The map item table these objects drop from",
      onchange: () => send(host, { op: "same", drops: { mode: "table", table: Number(sel.value) } }) },
    ...options.map(([v, label]) => h("option", { value: v, selected: v === String(drops.table) }, label)));
    parts.push(h("div.drops-line", {}, h("span.muted.drops-label", {}, "Item table"), sel));
    if (table) parts.push(h("div.drops-table-head.muted", {}, `${table.name} drops, from each set, one item by its chance${host.tablesUnsaved ? " (as last saved: Map Properties has unsaved changes)" : ""}:`), tableView(host, table, !wide));
    else if (!known) parts.push(h("div.drops-hint.terrain-prop-over", {}, `The map has no item table #${drops.table}: the script leaves these drops out.`));
    parts.push(h("div.drops-actions", {}, editTables(drops.table)));
  }
  return { drops, onlyOwn, parts };
}

/** The Selection panel's Drops block: what the objects drop, readable in the narrow panel, and "Edit drops…" for the
 *  wide editor. The mode and the table can be chosen here. */
export function dropsBlock(host: DropsUiHost, entries: readonly Placed[], editDrops: () => void): HTMLElement {
  const { drops, onlyOwn, parts } = common(host, entries, false);
  const edit = h("button.drops-edit", { "data-prop": "edit-drops", title: "The Item Drops tab: these objects' drops with room for long names, the map's drops and item tables" ,
    onclick: editDrops }, "Edit drops…");
  if (drops === undefined) {
    const variants = dropsVariants(entries);
    parts.push(h("div.muted", { "data-prop": "drops-mixed" }, `${variants.length} different drops among these ${entries.length} objects:`),
      ...variants.slice(0, 4).map((v) => h("div.drops-variant", {}, h("span.drops-count", {}, `${v.entries.length} ×`), dropsText(v.drops, namesOf(host)))),
      ...(variants.length > 4 ? [h("div.muted", {}, `… ${variants.length - 4} more`)] : []));
  } else if (drops.mode === "custom") {
    parts.push(...(drops.sets.length ? drops.sets.map((set, k) => setReadOnly(host, set, k, true)) : [h("div.muted", {}, "No sets: drops nothing.")]));
  }
  const actions = h("div.drops-actions", {}, edit, ...(drops?.mode === "custom" && !onlyOwn
    ? [h("button", { "data-prop": "use-map-table", title: "Map Properties › Techtree & Tables › Item tables: tables any object can drop from (choose Map item table above to use one)",
      onclick: () => host.openItemTables() }, "Map item tables…")] : []));
  return h("fieldset.terrain-props.terrain-drops", { disabled: !!host.readOnly, "data-prop": "drops-block" },
    h("legend.terrain-sel-sub.muted", {}, entries.length > 1 ? `Drops (${entries.length} objects)` : "Drops"), ...parts, actions);
}

/** The Item Drops tab's editor for the objects being edited: own sets as wide cards (items with icons, full names,
 *  chances as numbers and bars, the set's total and what drops nothing), a chosen map item table with its contents,
 *  and for objects that drop differently their variants, each one a click away from being everyone's. */
export function dropsEditor(host: DropsUiHost, entries: readonly Placed[]): HTMLElement {
  const { drops, parts } = common(host, entries, true);
  if (drops === undefined) {
    const variants = dropsVariants(entries);
    parts.push(h("div.drops-hint", { "data-prop": "drops-mixed" }, `These ${entries.length} objects drop ${variants.length} different ways. Give them all one of these, or add a set to each:`),
      ...variants.map((v, i) => h("div.drops-variant", {},
        h("span.drops-count", {}, `${v.entries.length} ×`),
        h("span.drops-variant-text", {}, dropsText(v.drops, namesOf(host)), ...(host.whoOf ? [h("span.muted", {}, ` · ${host.whoOf(v.entries)}`)] : [])),
        h("button", { "data-prop": `use-variant-${i}`, title: "All of them drop this (one undo step)", onclick: () => send(host, { op: "same", drops: v.drops }) }, "Give this to all"))),
      h("div.drops-actions", {}, h("button", { "data-prop": "add-set-each", title: "Each keeps what it drops and gets one more set with this item (100%); not for those that drop from a map item table",
        onclick: async () => {
          const id = await host.pickItem("A set for each of them: its item");
          if (id !== undefined) send(host, { op: "addSet", set: [{ id, chance: 100 }] });
        } }, "Add a set to each…")));
  } else if (drops.mode === "custom") {
    const sets = drops.sets;
    const withSets = (change: (s: DropItem[][]) => void) => { const next = structuredClone(sets); change(next); send(host, { op: "same", drops: { mode: "custom", sets: next } }); };
    parts.push(...sets.map((set, k) => {
      const s = setShares(set), total = setTotal(set);
      return h("div.drops-set.wide", { "data-set": String(k) },
        h("div.drops-sethead", {},
          h("strong", {}, `Set ${k + 1}`),
          h("span.muted", {}, set.length ? (set.length === 1 ? "drops this" : "drops one of these") : "empty: drops nothing"),
          h(`span.drops-total${s.over ? ".over" : ""}`, { "data-prop": `total-${k}`, title: s.over ? "Over 100%: the game picks by the chances' shares" : "The chances added up" },
            `${total}%${s.nothing && set.length ? ` · ${s.nothing}% nothing` : ""}`),
          h("span.drops-spacer"),
          h("button", { title: "Spread 100% evenly over the set's items", "data-prop": `redistribute-${k}`, disabled: !set.length, onclick: () => withSets((x) => { x[k] = redistribute(x[k]); }) }, "Redistribute"),
          h("button.icon-button", { title: "Remove the set", "data-prop": `remove-set-${k}`, onclick: () => withSets((x) => { x.splice(k, 1); }) }, "×")),
        ...s.items.map((it, j) => h("div.drops-row", {},
          itemView(host, it.id),
          h("input.drops-chance-input", { type: "number", min: 0, max: 100, step: 1, value: String(it.chance), "data-prop": `chance-${k}-${j}`, title: "Chance in percent",
            onchange: (ev: Event) => {
              const input = ev.target as HTMLInputElement, v = Number(input.value);
              if (input.value.trim() !== "" && Number.isFinite(v)) withSets((x) => { x[k][j] = { ...x[k][j], chance: v }; });
              else input.value = String(it.chance);
            } }), h("span.muted", {}, "%"),
          bar(it.share),
          h("button.icon-button", { title: "Remove the item", "data-prop": `remove-item-${k}-${j}`, onclick: () => withSets((x) => { x[k].splice(j, 1); }) }, "×"))),
        ...(set.length && s.nothing ? [h("div.drops-row.nothing", {}, h("span.drops-item", {}, h("span.drops-icon", {}, ""), h("span.drops-name", {}, "Nothing")),
          h("span.drops-chance", {}, `${s.nothing}`), h("span.muted", {}, "%"), bar(s.nothing / 100, true), h("span"))] : []),
        h("div.drops-actions", {}, h("button", { "data-prop": `add-item-${k}`, onclick: async () => {
          const id = await host.pickItem(`Add an item to set ${k + 1}`);
          if (id !== undefined) withSets((x) => { x[k].push({ id, chance: x[k].length ? Math.max(0, 100 - setTotal(x[k])) : 100 }); });
        } }, "Add item…")));
    }), h("div.drops-actions", {}, h("button", { "data-prop": "add-set", title: "Each set drops one of its items by chance", onclick: () => withSets((x) => { x.push([]); }) }, "Add set")));
  }
  return h("fieldset.drops-editor", { disabled: !!host.readOnly }, ...parts);
}
