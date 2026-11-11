// The Item Drops tab (w3:item-drops): every drop on the map in one place. On the left the placed units and
// destructables that drop items, grouped into camps (creeps standing together), by owner or by type, and the map's
// item tables with where each is used; on the right the drops of what is chosen there (one object, a camp, several),
// with room for long names. A click chooses, Ctrl+click adds, Shift+click takes a range; "Show" selects and frames
// them in the terrain editor. Every change is one undo step of the terrain editor that holds the objects, unsaved
// until it is saved, as in the Selection panel (the tab's Undo and Redo are that editor's).

import type { EditorInstance, W3Api } from "../../extensions/api";
import { MAP_INFO_SERVICE, OBJECTS_SERVICE, type MapInfoService, type ObjectsService } from "../../extensions/services";
import { addKeyContext, UNDO_CONTEXT, undoStepOf } from "../../lib/keybindings";
import { h } from "../../workbench/dom";
import { dropsEditor, tableView, type DropsUiHost, type ItemTableInfo } from "./dropsedit";
import {
  MIDDLE_CAMP, TOUGH_CAMP, bulkDrops, campLevelText, creepLevel, dropsAnything, dropsText, groupDroppers, tableUse, type DropGroup, type DropperRow, type GroupBy,
} from "./dropsview";
import type { Placed } from "./objects";
import type { TerrainToolRegistry } from "./toolhost";
import { dropsOf, type Drops, type TypeFacts } from "./unitprops";

/** The tab's virtual document. */
export const ITEM_DROPS_DOC = "w3:item-drops";

/** An object whose drops can be set: a unit or building, a destructable, a doodad that drops anyway. */
export interface DropperInfo { entry: Placed; facts: TypeFacts; kind: string }

/** What an open terrain editor gives the tab. */
export interface DropsSource {
  /** The project it belongs to. */
  root: string;
  /** Every placed object whose drops can be set, now (unsaved changes included). */
  droppers(): Promise<DropperInfo[]>;
  /** The map's item tables with their contents: `live` those of the open Map Properties editor (unsaved changes
   *  included), else as saved; `list` null when war3map.w3i couldn't be read. */
  tables(): Promise<{ list: ItemTableInfo[] | null; live: boolean }>;
  /** Saves the terrain editor (its tab's Save, as Ctrl+S there): the placed objects' drops changed here with the rest;
   *  and Map Properties when the tab shows its item tables with unsaved changes. */
  save(): Promise<void>;
  /** Each object its drops, in one undo step; the reason when it's refused (nothing changed then). */
  setDrops(changes: { entry: Placed; facts: TypeFacts; drops: Drops }[]): string | null;
  /** The terrain editor in front, with these objects selected and in view. */
  show(entries: readonly Placed[]): Promise<void>;
  /** What is selected in the terrain editor now. */
  selection(): Placed[];
  undo(): void;
  redo(): void;
  /** Makes a new map item table (Map Properties opens on it) and has these objects drop from it. */
  createItemTable(entries: readonly Placed[]): Promise<void>;
  /** A player's name (from 0). */
  ownerName(player: number): string;
}

/** How the overview groups, kept while the app runs. */
let groupBy: GroupBy = "camp";
let onlyDropping = true;

export interface ItemDropsDeps {
  registry: TerrainToolRegistry;
  /** The project's terrain file (its editor is the source). */
  terrainPath(): string | null;
  openTerrain(): Promise<void>;
}

const KIND_LABEL: Record<string, string> = { w3u: "unit", w3b: "destructable", w3d: "doodad" };

export function itemDropsEditor(w3: W3Api, el: HTMLElement, deps: ItemDropsDeps): EditorInstance {
  const { registry } = deps;
  const source = () => registry.dropSources.get(deps.terrainPath() ?? "") ?? null;
  const root = h("div.drops-tab", { tabindex: "-1", onkeydown: (e: KeyboardEvent) => {
    // The boxes keep their own keys (Ctrl+Z there takes back what was typed).
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    const step = undoStepOf(w3.keybindings.commandsFor(e));
    if (step === "undo") { e.preventDefault(); source()?.undo(); }
    else if (step === "redo") { e.preventDefault(); source()?.redo(); }
  } });
  addKeyContext(root, UNDO_CONTEXT);
  el.append(root);
  /** What the right side edits. */
  let targets: Placed[] = [];
  /** The last row clicked, for Shift+click. */
  let anchor: Placed | null = null;
  let query = "";
  let copied: { drops: Drops; from: string } | null = null;
  let disposed = false, seq = 0, timer: ReturnType<typeof setTimeout> | undefined;
  /** The list scrolls to what is edited once, after the Selection panel asked for it. */
  let reveal = false;
  const typeNames = new Map<string, string>(), itemNames = new Map<string, string>();
  const objects = () => w3.services.get<ObjectsService>(OBJECTS_SERVICE);
  const typeName = (id: string) => typeNames.get(id) ?? id;

  /** A request from the Selection panel (Edit drops…): its objects are what the tab edits. */
  const take = (req: { path: string; entries: readonly unknown[] } | null) => {
    if (!req || req.path !== deps.terrainPath()) return false;
    targets = [...req.entries] as Placed[];
    anchor = targets[0] ?? null;
    reveal = true;
    return true;
  };
  if (take(registry.pendingDrops)) registry.pendingDrops = null;

  /** A hidden tab isn't drawn again for every edit: once it's in front. */
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (root.isConnected && root.offsetParent !== null) void render(); else stale = true; }, 30);
  };
  let stale = false;
  const subs = [
    // Placed objects changed (an edit, undo, redo, the editor closed); the ground and regions don't drop anything.
    registry.onDidEdit((what) => { if (what.objects) soon(); }),
    registry.dropSourcesChanged.add(soon),
    registry.dropsRequests.add((req) => { if (take(req)) { registry.pendingDrops = null; soon(); } }),
    w3.workspace.onDidSave((p) => { if (/(^|\/)war3map\.(w3i|wts)(\.json)?$/i.test(p)) soon(); }),
    w3.editors.onDidChangeActive((a) => { if (a?.path === ITEM_DROPS_DOC && stale) { stale = false; void render(); } }),
  ];
  // The item tables as Map Properties holds them: drawn again after each edit there (and when it closes).
  void w3.services.get<MapInfoService>(MAP_INFO_SERVICE).then((s) => { if (!disposed) subs.push(s.onDidEdit(soon)); }, () => {});

  const warn = (m: string) => { void w3.window.showWarning(m); soon(); };

  async function render() {
    const my = ++seq;
    const src = source();
    if (!src) {
      root.replaceChildren(h("div.drops-empty", {},
        h("h2", {}, "Item Drops"),
        h("p.muted", {}, "The drops are those of the placed objects in the terrain editor. Open it to see and edit them here."),
        h("button", { "data-prop": "open-terrain", onclick: () => void deps.openTerrain().catch((e) => w3.window.showError(String((e as Error).message ?? e))) }, "Open the terrain editor")));
      return;
    }
    let all: DropperInfo[], tables: ItemTableInfo[] | null, live: boolean;
    try {
      let t: { list: ItemTableInfo[] | null; live: boolean };
      [all, t] = await Promise.all([src.droppers(), src.tables()]);
      tables = t.list;
      live = t.live;
    } catch (e) {
      if (my === seq && !disposed) root.replaceChildren(h("div.drops-empty", {}, h("h2", {}, "Item Drops"), h("p", {}, `The drops couldn't be read: ${(e as Error).message ?? e}`)));
      return;
    }
    // Names of the types and the items, read once; then the overview can sort and filter by them.
    const svc = await objects().catch(() => null);
    const ids = [...new Set(all.map((d) => d.entry.id))].filter((id) => !typeNames.has(id));
    const itemIds = [...new Set([...all.flatMap((d) => { const x = dropsOf(d.entry); return x.mode === "custom" ? x.sets.flat().map((it) => it.id) : []; }),
      ...(tables ?? []).flatMap((t) => t.sets.flat().map((it) => it.id))])].filter((id) => !itemNames.has(id));
    if (svc) {
      await Promise.all([
        ...ids.map((id) => svc.name(id, ["w3u", "w3b", "w3d"]).then((n) => { if (n) typeNames.set(id, n); }, () => {})),
        ...itemIds.map((id) => svc.name(id, ["w3t"]).then((n) => { if (n) itemNames.set(id, n); }, () => {})),
      ]);
    }
    // Something newer started, the tab closed, or another editor took over meanwhile: that one shows.
    if (my !== seq || disposed || source() !== src) return;
    const info = new Map(all.map((d) => [d.entry, d]));
    targets = targets.filter((t) => info.has(t));
    if (anchor && !info.has(anchor)) anchor = null;
    tablesLive = live;
    draw(src, all, info, tables);
  }
  /** The tables drawn are Map Properties' unsaved ones. */
  let tablesLive = false;

  function draw(src: DropsSource, all: DropperInfo[], info: Map<Placed, DropperInfo>, tables: ItemTableInfo[] | null) {
    const tablesUnsaved = !tablesLive && w3.editors.isDirty("map/war3map.w3i.json");
    // The panes keep their scroll, and a box that had the keys gets them back.
    const scrolls = [...root.querySelectorAll<HTMLElement>("[data-scroll]")].map((x) => [x.dataset.scroll, x.scrollTop] as const);
    const focused = (document.activeElement as HTMLElement | null)?.closest?.(".drops-tab") === root ? (document.activeElement as HTMLElement).dataset.prop : undefined;
    const names = { table: (n: number) => tables?.find((t) => t.number === n)?.name ?? (tables === null ? `#${n}` : undefined), item: (id: string) => itemNames.get(id) };
    const textOf = (e: Placed) => dropsText(dropsOf(e), names);
    // Units can be given drops; destructables and doodads are many (every tree), so only those that drop are listed.
    const listed: DropperRow[] = all.filter((d) => d.kind === "w3u" || dropsAnything(dropsOf(d.entry)) || targets.includes(d.entry))
      .map((d) => ({ entry: d.entry, kind: d.kind, ...(d.kind === "w3u" ? { level: creepLevel(d.entry, d.facts) } : {}) }));
    const q = query.trim().toLowerCase();
    const matches = (r: DropperRow) => !q || typeName(r.entry.id).toLowerCase().includes(q) || r.entry.id.toLowerCase().includes(q) || textOf(r.entry).toLowerCase().includes(q);
    let groups = groupDroppers(listed, groupBy, { owner: (p) => src.ownerName(p), type: typeName });
    // Camps are shown whole: one where anything drops keeps its creeps that don't.
    // What is being edited stays in the list, dropping or not.
    const keep = (r: DropperRow) => !onlyDropping || dropsAnything(dropsOf(r.entry)) || targets.includes(r.entry);
    if (groupBy === "camp") groups = groups.map((g) => (g.key.startsWith("camp:") ? g : { ...g, rows: g.rows.filter(keep) })).filter((g) => g.rows.some(keep));
    else groups = groups.map((g) => ({ ...g, rows: g.rows.filter(keep) })).filter((g) => g.rows.length);
    if (q) groups = groups.map((g) => ({ ...g, rows: g.rows.filter(matches) })).filter((g) => g.rows.length);
    const order = groups.flatMap((g) => g.rows.map((r) => r.entry));
    const dropping = all.filter((d) => dropsAnything(dropsOf(d.entry))).length;

    const choose = (e: Placed, ev: MouseEvent) => {
      if (ev.shiftKey && anchor && order.includes(anchor)) {
        const [a, b] = [order.indexOf(anchor), order.indexOf(e)].sort((x, y) => x - y);
        targets = order.slice(a, b + 1);
      } else if (ev.ctrlKey || ev.metaKey) {
        targets = targets.includes(e) ? targets.filter((t) => t !== e) : [...targets, e];
        anchor = e;
      } else { targets = [e]; anchor = e; }
      draw(src, all, info, tables);
    };
    const showIn = (entries: readonly Placed[]) => void src.show(entries).catch((e) => w3.window.showError(String((e as Error).message ?? e)));
    const typeIcon = (r: { entry: Placed; kind: string }) => {
      const icon = h("span.drops-icon", { "aria-hidden": "true" }, "");
      void objects().then((s) => s.icon(r.kind, r.entry.id)).then((src2) => { if (src2) icon.replaceChildren(h("img", { src: src2, alt: "" })); }).catch(() => {});
      return icon;
    };
    /** The owner where the group doesn't say it (by type), else only what isn't a unit (a destructable in a camp). */
    const objectRow = (r: DropperRow, byType: boolean) => {
      const p = (r.entry as Placed & { player?: number }).player;
      const owner = p === undefined ? KIND_LABEL[r.kind] ?? "" : byType ? src.ownerName(p) : "";
      return h(`div.drops-obj${targets.includes(r.entry) ? ".on" : ""}`, {
        "data-entry": `${r.entry.id}@${Math.round(r.entry.position[0])},${Math.round(r.entry.position[1])}`, title: "Click: edit its drops · Ctrl+click: add it · Shift+click: a range · Double-click: show it in the terrain editor",
        onclick: (ev: MouseEvent) => choose(r.entry, ev), ondblclick: () => showIn([r.entry]),
      }, typeIcon(r), h("span.drops-obj-name", {}, typeName(r.entry.id)),
      h("span.drops-obj-owner.muted", {}, owner),
      h(`span.drops-obj-drops${dropsAnything(dropsOf(r.entry)) ? "" : ".muted"}`, {}, textOf(r.entry)),
      h("button.icon-button", { title: "Show it in the terrain editor (selected, in view)", "data-prop": "show-one", onclick: (ev: Event) => { ev.stopPropagation(); showIn([r.entry]); } }, "⌖"));
    };
    const groupEl = (g: DropGroup) => {
      const entries = g.rows.map((r) => r.entry);
      const all2 = entries.length > 0 && entries.every((e) => targets.includes(e));
      return h(`div.drops-group${all2 ? ".on" : ""}`, { "data-group": g.key },
        h("div.drops-group-head", {},
          h("strong", {}, g.title),
          ...(g.level ? [h(`span.drops-camp-level.${g.level.strength}`, {
            "data-prop": "camp-level",
            title: `The creeps' levels added up${g.level.unknown ? ` (${g.level.unknown} of unknown level left out)` : ""}; the strongest is level ${g.level.strongest}. `
              + `The game's minimap shows a camp below level ${MIDDLE_CAMP} green, from ${MIDDLE_CAMP} orange and from ${TOUGH_CAMP} red.`,
          }, campLevelText(g.level))] : []),
          h("span.muted", {}, g.detail), h("span.drops-spacer"),
          h("button", { "data-prop": "edit-group", title: "Edit the drops of all of these at once", onclick: () => { targets = entries; anchor = entries[0] ?? null; draw(src, all, info, tables); } }, "Edit together"),
          h("button", { "data-prop": "show-group", title: "Select all of these in the terrain editor and show them", onclick: () => showIn(entries) }, "Show")),
        ...g.rows.map((r) => objectRow(r, groupBy === "type")));
    };

    // ---- the map's item tables and where each is used ----
    const use = tableUse(listed, tables ?? []);
    const userList = (rows: DropperRow[]) => h("div.drops-users", {}, ...rows.slice(0, 12).map((r) => h("button.link-inline", {
      title: "Edit its drops", onclick: () => { targets = [r.entry]; anchor = r.entry; draw(src, all, info, tables); } }, typeName(r.entry.id))),
      ...(rows.length > 12 ? [h("span.muted", {}, `… ${rows.length - 12} more`)] : []));
    const uiBase = (entries: readonly Placed[]): DropsUiHost => ({
      tables, tablesUnsaved,
      itemName: (id) => objects().then((s) => s.name(id, ["w3t"])).then((n) => { if (n) itemNames.set(id, n); return n; }),
      nameNow: (id) => itemNames.get(id),
      whoOf: (list) => {
        const counts = new Map<string, number>();
        for (const e of list) counts.set(typeName(e.id), (counts.get(typeName(e.id)) ?? 0) + 1);
        const named = [...counts].map(([n, c]) => (c > 1 ? `${c} × ${n}` : n));
        return named.length > 3 ? `${named.slice(0, 3).join(", ")} …` : named.join(", ");
      },
      itemIcon: (id) => objects().then((s) => s.icon("w3t", id)),
      pickItem: (title) => objects().then((s) => s.pick(root, { title, kinds: ["w3t"] })).then((o) => o?.id),
      bulk: (edit) => {
        const r = bulkDrops(entries, edit);
        if ("error" in r) return r.error;
        const items = entries.map((entry, i) => ({ entry, facts: info.get(entry)!.facts, drops: r.drops[i] }));
        if (items.some((it) => !it.facts)) return "the objects changed meanwhile; choose them again.";
        return src.setDrops(items);
      },
      warn,
      openItemTables: (n) => void w3.commands.execute("w3.mapInfo.open", "techtree", n === undefined ? "item-tables" : `item-table-${n}`).catch((e) => w3.window.showError(String((e as Error).message ?? e))),
      createItemTable: () => src.createItemTable(entries),
    });
    const tablesEl = h("section.drops-tables", { "data-prop": "item-tables" },
      h("h3", {}, tables === null ? "Map item tables (war3map.w3i couldn't be read)" : `Map item tables (${tables.length})`),
      ...(tables && !tables.length ? [h("p.muted", {}, "None. A map item table is a list of sets any number of objects can drop from; choose Map item table in an object's drops to make one.")] : []),
      ...(tables ?? []).map((t) => {
        const users = use.used.get(t.number) ?? [];
        return h("div.drops-table-card", { "data-table-card": String(t.number) },
          h("div.drops-group-head", {}, h("strong", {}, t.name), h("span.muted", {}, `#${t.number} · ${users.length ? `used by ${users.length}` : "not used"}`), h("span.drops-spacer"),
            ...(users.length ? [h("button", { "data-prop": "edit-table-users", title: "Edit the drops of everything that uses this table", onclick: () => { targets = users.map((r) => r.entry); anchor = targets[0]; draw(src, all, info, tables); } }, "Edit its users"),
              h("button", { title: "Select everything that uses this table in the terrain editor", onclick: () => showIn(users.map((r) => r.entry)) }, "Show")] : []),
            h("button", { "data-prop": "edit-table", title: "Map Properties › Techtree & Tables › Item tables", onclick: () => uiBase([]).openItemTables(t.number) }, "Edit in Map Properties…")),
          ...(users.length ? [userList(users)] : []),
          tableView(uiBase([]), t, true));
      }),
      ...[...use.missing].map(([n, rows]) => h("div.drops-table-card.missing", {},
        h("div.drops-group-head", {}, h("strong.terrain-prop-over", {}, `Item table #${n} isn't in the map`), h("span.muted", {}, `used by ${rows.length}: the script leaves their drops out`)), userList(rows))),
      ...(tablesUnsaved ? [h("p.muted", {}, "Map Properties has unsaved changes: the tables show as last saved.")] : []),
      ...(tablesLive && w3.editors.isDirty("map/war3map.w3i.json") ? [h("p.muted", { "data-prop": "tables-unsaved" }, "As in Map Properties, with its unsaved changes (saved with it).")] : []));

    // ---- the right side: what is chosen ----
    const pane = h("div.drops-pane", { "data-scroll": "pane" });
    if (!targets.length) {
      pane.append(h("h3", {}, "Nothing chosen"),
        h("p.muted", {}, "Click an object or a camp's Edit together on the left to edit its drops, or select objects in the terrain editor and take them here."),
        h("div.drops-actions", {}, h("button", { "data-prop": "take-selection", onclick: () => { targets = src.selection().filter((e) => info.has(e)); anchor = targets[0] ?? null; if (!targets.length) void w3.window.showInfo("Nothing selected in the terrain editor can drop items."); draw(src, all, info, tables); } }, "Take the terrain selection")));
    } else {
      const one = targets.length === 1 ? targets[0] : null;
      const p = one ? (one as Placed & { player?: number }).player : undefined;
      const kinds = new Map<string, number>();
      for (const t of targets) kinds.set(typeName(t.id), (kinds.get(typeName(t.id)) ?? 0) + 1);
      pane.append(
        h("div.drops-pane-head", {},
          ...(one ? [typeIcon({ entry: one, kind: info.get(one)!.kind })] : []),
          h("div", {}, h("h3", { "data-prop": "pane-title" }, one ? typeName(one.id) : `${targets.length} objects`),
            h("div.muted", {}, one
              ? `${p === undefined ? KIND_LABEL[info.get(one)!.kind] ?? "" : src.ownerName(p)} · at ${Math.round(one.position[0])}, ${Math.round(one.position[1])}`
              : [...kinds].map(([n, c]) => `${c} × ${n}`).join(", ")))),
        h("div.drops-actions", {},
          h("button", { "data-prop": "show-targets", title: "Select them in the terrain editor and show them there", onclick: () => showIn(targets) }, "Show in terrain"),
          h("button", { "data-prop": "copy-drops", disabled: !one, title: one ? "Remember these drops, to give them to others with Paste drops" : "Choose one object to copy its drops",
            onclick: () => { if (one) { copied = { drops: dropsOf(one), from: typeName(one.id) }; draw(src, all, info, tables); } } }, "Copy drops"),
          h("button", { "data-prop": "paste-drops", disabled: !copied, title: copied ? `Give ${targets.length === 1 ? "it" : `all ${targets.length}`} the drops copied from ${copied.from} (one undo step)` : "Copy an object's drops first",
            onclick: () => { if (copied) { const why = uiBase(targets).bulk({ op: "same", drops: copied.drops }); if (why) warn(`Not changed: ${why}`); } } }, copied ? `Paste drops of ${copied.from}` : "Paste drops"),
          h("button", { "data-prop": "take-selection", title: "Edit what is selected in the terrain editor instead", onclick: () => { const sel = src.selection().filter((e) => info.has(e)); if (!sel.length) { void w3.window.showInfo("Nothing selected in the terrain editor can drop items."); return; } targets = sel; anchor = sel[0]; draw(src, all, info, tables); } }, "Take the terrain selection")),
        dropsEditor(uiBase(targets), targets));
    }

    const groupSel = h("select", { "data-prop": "group-by", title: "How the objects are grouped", onchange: () => { groupBy = groupSel.value as GroupBy; draw(src, all, info, tables); } },
      ...([["camp", "Camps"], ["owner", "Owner"], ["type", "Type"]] as const).map(([v, label]) => h("option", { value: v, selected: v === groupBy }, label)));
    const onlyBox = h("input", { type: "checkbox", checked: onlyDropping, "data-prop": "only-dropping", onchange: () => { onlyDropping = onlyBox.checked; draw(src, all, info, tables); } });
    const search = h("input.drops-search", { type: "search", placeholder: "Filter by name or drop", value: query, "data-prop": "filter",
      oninput: () => { query = search.value; draw(src, all, info, tables); } });
    const list = h("div.drops-list", { "data-scroll": "list" },
      ...(groups.length ? groups.map(groupEl) : [h("p.muted", {}, q ? "Nothing matches the filter." : onlyDropping ? "Nothing on the map drops items yet. Untick \"Only what drops\" to give units drops." : "No units or destructables on the map.")]),
      tablesEl);
    root.replaceChildren(
      h("div.drops-head", {},
        h("h2", {}, "Item Drops"),
        h("span.muted", { "data-prop": "drops-count" }, `${dropping} object${dropping === 1 ? "" : "s"} drop items · ${tables === null ? "item tables unknown" : `${tables.length} map item table${tables.length === 1 ? "" : "s"}`}`),
        h("span.drops-spacer"),
        h("label", {}, "Group by ", groupSel),
        h("label.terrain-prop-check", { title: "Leave out what drops nothing (a camp shows whole if anything in it drops)" }, onlyBox, " Only what drops"),
        search),
      h("div.drops-body", {}, list, pane),
      h("div.drops-foot.muted", {}, "Changes are steps of the terrain editor's undo history (Ctrl+Z here undoes them) and are saved with it; the map script's drop functions follow on save."));
    for (const [k, top] of scrolls) { const x = root.querySelector<HTMLElement>(`[data-scroll="${k}"]`); if (x) x.scrollTop = top; }
    if (reveal) {
      reveal = false;
      root.querySelector(".drops-obj.on")?.scrollIntoView({ block: "center" });
    }
    if (focused) {
      const again = root.querySelector<HTMLElement>(`[data-prop="${CSS.escape(focused)}"]`);
      if (again) again.focus({ preventScroll: true });
      if (again instanceof HTMLInputElement && again.type === "search") again.setSelectionRange(again.value.length, again.value.length);
    }
  }

  void render();
  return {
    focus: () => root.focus({ preventScroll: true }),
    // Ctrl+S here saves what is changed here: the terrain editor the drops are in, as its own Save does, and Map
    // Properties' unsaved item tables shown here.
    save: async () => { await source()?.save(); },
    undo: () => source()?.undo(),
    redo: () => source()?.redo(),
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
      for (const s of subs) s.dispose();
    },
  };
}
