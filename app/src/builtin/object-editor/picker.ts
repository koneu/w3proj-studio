// Base object browser: free-text search, facet chips (race, type, …) and
// field filters on any field ("gold>100", "hp>=500", "ubdg=1"), shown as an
// overlay inside the object editor.

import { focusAfterClick, h } from "../../workbench/dom";
import { keyOf } from "../../lib/keys";
import type { FieldMeta, KindData } from "../../lib/objects/metadata";
import { shownValue, type EditorType } from "./fields";
import { compare, filterValue, OP_LABEL, OPS, parseQuery as parseFilters, resolveField, type FieldFilter } from "./filters";

const MAX_ROWS = 300;

interface Entry {
  id: string;
  /** Custom objects: the game object field values come from. */
  base?: string;
  /** A custom object of the map's campaign (a chapter map's), not of the map itself. */
  campaign?: boolean;
  name: string;
  facets: Record<string, string>;
  haystack: string;
}

export function pickBaseObject(
  host: HTMLElement,
  kd: KindData,
  opts: { title: string; pinned?: string; iconOf?: PickOptions["iconOf"]; editorTypes?: PickOptions["editorTypes"] },
): Promise<string | undefined> {
  return pickObject(host, kd, opts).then((r) => (r && "id" in r ? r.id : undefined));
}

export interface PickOptions {
  title: string;
  /** Listed first, marked "base of selected". */
  pinned?: string;
  /** The map's custom objects, listed with the game objects (`campaign`: its campaign's, for a chapter map). */
  custom?: { id: string; base: string; name: string; campaign?: boolean }[];
  /** Kind tabs (e.g. Unit / Item / …): choosing another one closes the
   *  picker with `{ tab, query }` so the caller can reopen it for that kind. */
  tabs?: { labels: string[]; active: number };
  /** Initial search text. */
  query?: string;
  /** Icon (data URL) of an entry, loaded as rows are shown. */
  iconOf?: (id: string, base?: string) => Promise<string | null>;
  /** UnitEditorData's value types: a field filter on a choice/list/flags field matches its labels too, and
   *  a row shows them. A promise (types still loading): raw values until it settles, then the labels. */
  editorTypes?: Map<string, EditorType> | null | Promise<Map<string, EditorType> | null>;
}

export type PickResult = { id: string } | { tab: number; query: string } | undefined;

const strip = (s: string) => s.replace(/\|c[0-9a-f]{8}|\|r/gi, "");

/** The browser's entries and what matches, without the DOM. `onTypes` runs when editor types given
 *  as a promise arrive (not when it fails), so the shown list can be filtered and drawn again. */
export function pickerList(kd: KindData, opts: Pick<PickOptions, "custom" | "pinned" | "editorTypes">, onTypes?: () => void) {
  let types = opts.editorTypes instanceof Promise ? null : (opts.editorTypes ?? null);
  if (opts.editorTypes instanceof Promise) {
    opts.editorTypes.then((t) => { if (!t) return; types = t; onTypes?.(); }, () => {});
  }
  const entry = (id: string, name: string, base?: string, campaign?: boolean): Entry => {
    const facets = kd.facets(base ?? id);
    return { id, base, campaign, name, facets, haystack: `${name} ${id} ${base ?? ""} ${Object.values(facets).join(" ")} ${kd.searchText(base ?? id)}`.toLowerCase() };
  };
  const entries: Entry[] = [
    ...(opts.custom ?? []).map((c) => entry(c.id, strip(c.name), c.base, c.campaign)),
    ...kd.baseIds.map((id) => entry(id, strip(kd.names.get(id) ?? id))),
  ];
  entries.sort((a, b) => (a.id === opts.pinned ? -1 : b.id === opts.pinned ? 1 : a.name.localeCompare(b.name)));

  // Field values are looked up lazily and cached (level 1 for per-level fields).
  const valueCache = new Map<string, Map<string, string | undefined>>();
  const fieldValue = (f: FieldMeta, id: string) => {
    let m = valueCache.get(f.id);
    if (!m) valueCache.set(f.id, (m = new Map()));
    if (!m.has(id)) {
      const applies = kd.fieldsFor(id).includes(f);
      m.set(id, applies ? kd.defaultValue(id, f, f.repeat > 0 ? 1 : 0) : undefined);
    }
    return m.get(id);
  };

  const list = {
    entries,
    /** Facet id → the chosen values (none: all). */
    chosen: new Map<string, Set<string>>(kd.facetDefs.map((f) => [f.id, new Set()])),
    words: [] as string[],
    filters: [] as FieldFilter[],
    setQuery(text: string) { ({ words: list.words, filters: list.filters } = parseFilters(text, kd.fields)); },
    matches(e: Entry, skipFacet?: string) {
      if (!list.words.every((t) => e.haystack.includes(t))) return false;
      for (const [fid, values] of list.chosen) {
        if (fid === skipFacet || !values.size) continue;
        if (!values.has(e.facets[fid])) return false;
      }
      for (const f of list.filters) {
        if (!f.field) continue; // unknown field: shown as an error chip, ignored
        const value = fieldValue(f.field, e.base ?? e.id);
        if (!compare(value, f.op, f.value, shownValue(types?.get(f.field.type), value))) return false;
      }
      return true;
    },
    /** A row's value of a filtered field, as its label when the field's type has one ("Race: Night Elf"). */
    valueText(f: FieldMeta, e: Entry) {
      const value = fieldValue(f, e.base ?? e.id);
      return `${f.label}: ${strip(shownValue(types?.get(f.type), value) ?? value ?? "—")}`;
    },
  };
  return list;
}

/** The object browser: resolves with the chosen id, a tab switch, or
 *  undefined when cancelled. */
export function pickObject(host: HTMLElement, kd: KindData, opts: PickOptions): Promise<PickResult> {
  let shown: Entry[] = [];
  let active = 0;

  return new Promise((resolve) => {
    // Types that arrive while the browser is open filter and label it from then on.
    const list = pickerList(kd, opts, () => {
      if (overlay.isConnected) render();
    });
    const { entries, chosen } = list;
    const finish = (id: string | undefined) => {
      overlay.remove();
      resolve(id === undefined ? undefined : { id });
    };

    const parseQuery = () => list.setQuery(search.value);
    const matches = list.matches;

    const search = h("input.picker-search", {
      value: opts.query ?? "",
      placeholder: "Search by name, id, race … or filter fields: gold>100  hp>=500  ubdg=1",
      oninput: () => { active = 0; render(); },
      onkeydown: (e: KeyboardEvent) => {
        const key = keyOf(e);
        if (key === "ArrowDown") { active = Math.min(active + 1, shown.length - 1); renderRows(); e.preventDefault(); }
        else if (key === "ArrowUp") { active = Math.max(active - 1, 0); renderRows(); e.preventDefault(); }
        else if (key === "Enter") { if (shown[active]) finish(shown[active].id); e.preventDefault(); }
        else if (key === "Escape") { finish(undefined); e.preventDefault(); }
      },
    });
    const filterChips = h("div.picker-filter-chips");
    const facetsEl = h("div.picker-facets");
    const rowsEl = h("div.picker-rows");
    const countEl = h("span.muted");

    // "+ Field filter": builds a token and appends it to the search text.
    const fieldList = h("datalist", { id: `picker-fields-${Math.random().toString(36).slice(2)}` },
      ...kd.fields.map((f) => h("option", { value: `${f.label} (${f.id})` })));
    const fieldInput = h("input.picker-field-input", { placeholder: "Field, e.g. Gold Cost", list: fieldList.id });
    const opSelect = h("select", {}, ...OPS.map((op) => h("option", { value: op }, OP_LABEL[op])));
    const valueInput = h("input.picker-value-input", { placeholder: "value" });
    const addFilter = () => {
      // Accepts the suggestion format "Label (id)", a bare label or id, or "Label id".
      const text = fieldInput.value.trim();
      const m = /\(([^()]+)\)\s*$/.exec(text);
      const lastWord = text.split(/\s+/).pop() ?? "";
      const field = (m && kd.fieldById.get(m[1])) || kd.fieldById.get(lastWord) || resolveField(kd.fields, text);
      if (!field || !valueInput.value.trim()) {
        fieldInput.classList.toggle("invalid", !field);
        valueInput.classList.toggle("invalid", !valueInput.value.trim());
        return;
      }
      search.value = `${search.value.trim()} ${field.id}${opSelect.value}${valueInput.value.trim().replace(/\s+/g, "_")}`.trim();
      fieldInput.value = valueInput.value = "";
      fieldInput.classList.remove("invalid");
      valueInput.classList.remove("invalid");
      builder.hidden = true;
      active = 0;
      render();
      search.focus();
    };
    valueInput.addEventListener("keydown", (e) => { if (keyOf(e) === "Enter") { addFilter(); e.preventDefault(); } });
    const builder = h("div.picker-builder", { hidden: true },
      fieldInput, fieldList, opSelect, valueInput,
      h("button.primary-inline", { onclick: addFilter }, "Add"),
      h("button", { onclick: () => { builder.hidden = true; focusAfterClick(search); } }, "Cancel"));
    const addButton = h("button.chip", { title: "Filter by any field's value", onclick: () => { builder.hidden = !builder.hidden; if (!builder.hidden) focusAfterClick(fieldInput); } }, "+ Field filter");

    const renderFilterChips = () => {
      filterChips.replaceChildren(
        ...list.filters.map((f) =>
          h(`span.filter-chip${f.field ? "" : ".error"}`, { title: f.field ? `${f.field.id} · ${f.field.type}` : "No field matches this name" },
            f.field ? `${f.field.label} ${OP_LABEL[f.op]} ${filterValue(f.value)}` : `unknown field "${f.key}"`,
            h("button.icon-button", {
              title: "Remove filter",
              onclick: () => {
                search.value = search.value.split(/\s+/).filter((t) => t !== f.token).join(" ");
                render();
                search.focus();
              },
            }, "×"))),
        addButton,
      );
    };

    const renderFacets = () => {
      facetsEl.replaceChildren(...kd.facetDefs.map((f) => {
        // Counts respect the search and every *other* facet, so they show
        // what clicking a chip would leave.
        const counts = new Map<string, number>();
        for (const e of entries) if (matches(e, f.id)) counts.set(e.facets[f.id], (counts.get(e.facets[f.id]) ?? 0) + 1);
        const all = [...new Set(entries.map((e) => e.facets[f.id]))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        const sel = chosen.get(f.id)!;
        const chip = (value: string | null) =>
          h(`button.chip${(value === null ? !sel.size : sel.has(value)) ? ".on" : ""}`, {
            onclick: (e: MouseEvent) => {
              if (value === null) sel.clear();
              else if (e.ctrlKey || e.shiftKey) { if (sel.has(value)) sel.delete(value); else sel.add(value); }
              else if (sel.size === 1 && sel.has(value)) sel.clear();
              else { sel.clear(); sel.add(value); }
              active = 0;
              render();
              search.focus();
            },
          }, value ?? "All", value !== null ? h("small", {}, String(counts.get(value) ?? 0)) : null);
        return h("div.picker-facet", {}, h("span.picker-facet-label", {}, f.label), chip(null), ...all.map(chip));
      }));
    };

    const icon = (e: Entry) => {
      const img = h("img.picker-icon", { alt: "" });
      void opts.iconOf!(e.id, e.base).then((src) => { if (src) img.src = src; else img.classList.add("none"); });
      return img;
    };

    const renderRows = () => {
      const shownFields = list.filters.filter((f) => f.field).map((f) => f.field!);
      rowsEl.replaceChildren(...shown.slice(0, MAX_ROWS).map((e, i) =>
        h(`div.picker-row${i === active ? ".active" : ""}`, {
          // Keep focus in the search box, but choose on the completed click:
          // choosing on mousedown let that same event close the id prompt
          // that "+ New" opens next.
          onmousedown: (ev: MouseEvent) => ev.preventDefault(),
          onclick: () => finish(e.id),
          onmouseenter: () => { active = i; for (const [j, r] of [...rowsEl.children].entries()) r.classList.toggle("active", j === i); },
        },
          opts.iconOf ? icon(e) : null,
          h("span.picker-name", {}, e.name),
          h("code", {}, e.id),
          e.id === opts.pinned ? h("span.badge", {}, "base of selected") : null,
          e.base ? (e.campaign ? h("span.badge.picker-campaign", { title: "Custom object of the campaign (war3campaign.*): edited in the campaign" }, `campaign · ${e.base}`)
            : h("span.badge", { title: "Custom object of this map" }, `custom · ${e.base}`)) : null,
          ...shownFields.map((f) => h("span.picker-value", { title: f.label }, list.valueText(f, e))),
          h("span.picker-tags", {}, Object.values(e.facets).join(" · ")),
        )));
      rowsEl.children[active]?.scrollIntoView({ block: "nearest" });
    };

    const render = () => {
      parseQuery();
      shown = entries.filter((e) => matches(e));
      active = Math.max(0, Math.min(active, shown.length - 1));
      countEl.textContent = shown.length > MAX_ROWS ? `${shown.length} matches — showing ${MAX_ROWS}, refine to see more` : `${shown.length} matches`;
      renderFilterChips();
      renderFacets();
      renderRows();
    };

    const overlay = h("div.picker-overlay", { onmousedown: (e: MouseEvent) => { if (e.target === overlay) finish(undefined); } },
      h("div.picker", {},
        h("div.picker-header", {}, h("strong", {}, opts.title), countEl, h("button.icon-button", { title: "Cancel (Esc)", onclick: () => finish(undefined) }, "×")),
        opts.tabs ? h("div.picker-tabs", {}, ...opts.tabs.labels.map((label, i) =>
          h(`button.chip${i === opts.tabs!.active ? ".on" : ""}`, {
            onclick: () => { if (i === opts.tabs!.active) return; overlay.remove(); resolve({ tab: i, query: search.value }); },
          }, label))) : null,
        search,
        filterChips,
        builder,
        facetsEl,
        rowsEl,
        h("div.picker-hint.muted", {}, "↑↓ move · Enter choose · Ctrl+click chips to combine · field filters: name>value, name>=value, name:text (field by id or label) · Esc cancel"),
      ));
    host.append(overlay);
    render();
    search.focus();
  });
}
