// Base object browser: free-text search, facet chips (race, type, …) and
// field filters on any field ("gold>100", "hp>=500", "ubdg=1"), shown as an
// overlay inside the object editor.

import { h } from "../../workbench/dom";
import type { FieldMeta, KindData } from "./metadata";

const MAX_ROWS = 300;
const OPS = [">=", "<=", "!=", ">", "<", "=", ":"] as const;
type Op = (typeof OPS)[number];
const OP_LABEL: Record<Op, string> = { ">=": "≥", "<=": "≤", "!=": "≠", ">": ">", "<": "<", "=": "=", ":": "contains" };
const TOKEN = /^([^\s<>=!:]+)(>=|<=|!=|>|<|=|:)(.*)$/;

interface Entry {
  id: string;
  name: string;
  facets: Record<string, string>;
  haystack: string;
}

interface FieldFilter {
  token: string;
  field: FieldMeta | null;
  key: string;
  op: Op;
  value: string;
}

/** Field for a filter key: exact id, then the game's column name ("HP",
 *  "goldcost"), then label without spaces, then the shortest label containing
 *  the key as whole word(s) ("range" → "Attack 1 - Range"), then label
 *  prefix, then label substring. */
export function resolveField(fields: FieldMeta[], key: string): FieldMeta | null {
  const k = key.toLowerCase().replace(/_/g, " ");
  const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const word = new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const byWord = fields.filter((f) => word.test(f.label)).sort((a, b) => a.label.length - b.label.length)[0];
  return (
    fields.find((f) => f.id.toLowerCase() === k) ??
    fields.find((f) => f.field.toLowerCase() === k) ??
    fields.find((f) => compact(f.label) === compact(k)) ??
    byWord ??
    fields.find((f) => f.label.toLowerCase().startsWith(k)) ??
    fields.find((f) => f.label.toLowerCase().includes(k)) ??
    null
  );
}

function compare(actual: string | undefined, op: Op, expected: string): boolean {
  if (actual === undefined) return op === "!=";
  const a = Number(actual), e = Number(expected);
  const numeric = actual.trim() !== "" && expected.trim() !== "" && Number.isFinite(a) && Number.isFinite(e);
  const as = actual.toLowerCase(), es = expected.toLowerCase();
  switch (op) {
    case ">": return numeric && a > e;
    case ">=": return numeric && a >= e;
    case "<": return numeric && a < e;
    case "<=": return numeric && a <= e;
    case "=": return numeric ? a === e : as === es;
    case "!=": return numeric ? a !== e : as !== es;
    case ":": return as.includes(es);
  }
}

export function pickBaseObject(
  host: HTMLElement,
  kd: KindData,
  opts: { title: string; pinned?: string },
): Promise<string | undefined> {
  const strip = (s: string) => s.replace(/\|c[0-9a-f]{8}|\|r/gi, "");
  const entries: Entry[] = kd.baseIds.map((id) => {
    const name = strip(kd.names.get(id) ?? id);
    const facets = kd.facets(id);
    return { id, name, facets, haystack: `${name} ${id} ${Object.values(facets).join(" ")}`.toLowerCase() };
  });
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

  const chosen = new Map<string, Set<string>>(kd.facetDefs.map((f) => [f.id, new Set()]));
  let words: string[] = [];
  let filters: FieldFilter[] = [];
  let shown: Entry[] = [];
  let active = 0;

  return new Promise((resolve) => {
    const finish = (id: string | undefined) => {
      overlay.remove();
      resolve(id);
    };

    const parseQuery = () => {
      words = [];
      filters = [];
      for (const token of search.value.trim().split(/\s+/).filter(Boolean)) {
        const m = TOKEN.exec(token);
        if (m) filters.push({ token, key: m[1], op: m[2] as Op, value: m[3], field: resolveField(kd.fields, m[1]) });
        else words.push(token.toLowerCase());
      }
    };

    const matches = (e: Entry, skipFacet?: string) => {
      if (!words.every((t) => e.haystack.includes(t))) return false;
      for (const [fid, values] of chosen) {
        if (fid === skipFacet || !values.size) continue;
        if (!values.has(e.facets[fid])) return false;
      }
      for (const f of filters) {
        if (!f.field) continue; // unknown field: shown as an error chip, ignored
        if (!compare(fieldValue(f.field, e.id), f.op, f.value)) return false;
      }
      return true;
    };

    const search = h("input.picker-search", {
      placeholder: "Search by name, id, race … or filter fields: gold>100  hp>=500  ubdg=1",
      oninput: () => { active = 0; render(); },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "ArrowDown") { active = Math.min(active + 1, shown.length - 1); renderRows(); e.preventDefault(); }
        else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); renderRows(); e.preventDefault(); }
        else if (e.key === "Enter") { if (shown[active]) finish(shown[active].id); e.preventDefault(); }
        else if (e.key === "Escape") { finish(undefined); e.preventDefault(); }
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
    valueInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { addFilter(); e.preventDefault(); } });
    const builder = h("div.picker-builder", { hidden: true },
      fieldInput, fieldList, opSelect, valueInput,
      h("button.primary-inline", { onclick: addFilter }, "Add"),
      h("button", { onclick: () => { builder.hidden = true; search.focus(); } }, "Cancel"));
    const addButton = h("button.chip", { title: "Filter by any field's value", onclick: () => { builder.hidden = !builder.hidden; if (!builder.hidden) fieldInput.focus(); } }, "+ Field filter");

    const renderFilterChips = () => {
      filterChips.replaceChildren(
        ...filters.map((f) =>
          h(`span.filter-chip${f.field ? "" : ".error"}`, { title: f.field ? `${f.field.id} · ${f.field.type}` : "No field matches this name" },
            f.field ? `${f.field.label} ${OP_LABEL[f.op]} ${f.value.replace(/_/g, " ")}` : `unknown field "${f.key}"`,
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

    const renderRows = () => {
      const shownFields = filters.filter((f) => f.field).map((f) => f.field!);
      rowsEl.replaceChildren(...shown.slice(0, MAX_ROWS).map((e, i) =>
        h(`div.picker-row${i === active ? ".active" : ""}`, {
          // Keep focus in the search box, but choose on the completed click:
          // choosing on mousedown let that same event close the id prompt
          // that "+ New" opens next.
          onmousedown: (ev: MouseEvent) => ev.preventDefault(),
          onclick: () => finish(e.id),
          onmouseenter: () => { active = i; for (const [j, r] of [...rowsEl.children].entries()) r.classList.toggle("active", j === i); },
        },
          h("span.picker-name", {}, e.name),
          h("code", {}, e.id),
          e.id === opts.pinned ? h("span.badge", {}, "base of selected") : null,
          ...shownFields.map((f) => h("span.picker-value", { title: f.label }, `${f.label}: ${strip(fieldValue(f, e.id) ?? "—")}`)),
          h("span.picker-tags", {}, Object.values(e.facets).join(" · ")),
        )));
      rowsEl.children[active]?.scrollIntoView({ block: "nearest" });
    };

    const render = () => {
      parseQuery();
      shown = entries.filter((e) => matches(e));
      countEl.textContent = shown.length > MAX_ROWS ? `${shown.length} matches — showing ${MAX_ROWS}, refine to see more` : `${shown.length} matches`;
      renderFilterChips();
      renderFacets();
      renderRows();
    };

    const overlay = h("div.picker-overlay", { onmousedown: (e: MouseEvent) => { if (e.target === overlay) finish(undefined); } },
      h("div.picker", {},
        h("div.picker-header", {}, h("strong", {}, opts.title), countEl, h("button.icon-button", { title: "Cancel (Esc)", onclick: () => finish(undefined) }, "×")),
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
