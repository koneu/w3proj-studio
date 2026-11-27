// Dialogs of the GUI trigger kind: choosing a function (event, condition,
// action or call) and editing one parameter (preset, variable, function,
// value, or an editor another extension registered for the type).

import type { TriggerEditorHandle, TriggerParamEditor } from "../../extensions/services";
import { withColorTools } from "../../extensions/colortools";
import { keyOf } from "../../lib/keys";
import { paramText } from "../../lib/triggers/display";
import { filterTriggerTyping, isTypedCode, limitTriggerNumber, typedTriggerNumber } from "../../lib/triggers/literals";
import type { TriggerFunction } from "../../lib/triggers/triggerdata";
import type { Param } from "../../lib/triggers/wtg";
import { focusAfterClick, h } from "../../workbench/dom";
import { callParam, FUNCTION, functionsFor, isMessageType, PRESET, presetsFor, takesValue, VALUE, VARIABLE, variablesFor } from "./params";

/** A modal over the whole window; resolves with what `body` passes to `done`. */
function modal<T>(title: string, body: (done: (v: T | undefined) => void, hide: (hidden: boolean) => void) => HTMLElement[], cls = ""): Promise<T | undefined> {
  return new Promise((resolve) => {
    const close = (v: T | undefined) => { overlay.remove(); resolve(v); };
    const overlay = h("div.picker-overlay.newmap-overlay", {
      tabindex: -1,
      onmousedown: (e: MouseEvent) => { if (e.target === overlay) close(undefined); },
      onkeydown: (e: KeyboardEvent) => { if (keyOf(e) === "Escape") { e.stopPropagation(); close(undefined); } },
    }, h(`div.picker.trig-dialog${cls}`, {},
      h("div.picker-header", {}, h("strong", {}, title), h("button.icon-button", { title: "Close (Esc)", onclick: () => close(undefined) }, "×")),
      ...body(close, (hidden) => { overlay.hidden = hidden; })));
    document.body.append(overlay);
    // The search/value field, not the header's close button (a typed space would press it).
    ((overlay.querySelector("input, textarea") ?? overlay.querySelector(".picker-tabs button, .picker-row")) as HTMLElement | null)?.focus();
  });
}

/** A filterable list; Enter or double-click takes the highlighted row. */
interface ListItem<T> { label: string; detail?: string; value: T; category?: string }

/** A filterable list; Enter or double-click takes the highlighted row. With
 *  categories, chips above the list narrow it to one; `preview` describes the
 *  highlighted row below the list. */
function listPicker<T>(items: ListItem<T>[], done: (v: T) => void, opts: {
  placeholder?: string; categoryName?: (c: string) => string; preview?: (v: T) => (HTMLElement | string)[];
} = {}): HTMLElement[] {
  let shown = items, active = 0, category: string | null = null;
  const rows = h("div.picker-rows");
  const preview = h("div.trig-preview");
  const chips = h("div.game-chips.trig-chips");
  const search = h("input.picker-search", { type: "text", placeholder: opts.placeholder ?? "Search" });
  const filter = () => {
    const q = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = items.filter((it) => q.every((w) => `${it.label} ${it.detail ?? ""}`.toLowerCase().includes(w)));
    shown = category === null ? matching : matching.filter((it) => it.category === category);
    active = 0;
    renderChips(matching);
    render();
  };
  const renderChips = (matching: ListItem<T>[]) => {
    if (!opts.categoryName) return;
    const counts = new Map<string, number>();
    for (const it of matching) if (it.category) counts.set(it.category, (counts.get(it.category) ?? 0) + 1);
    const chip = (c: string | null, label: string, n: number) => h(`button.chip${category === c ? ".on" : ""}`, {
      onclick: () => { category = c; filter(); focusAfterClick(search); },
    }, label, h("small", {}, String(n)));
    chips.replaceChildren(chip(null, "All", matching.length),
      ...[...counts].map(([c, n]) => [c, opts.categoryName!(c), n] as const).sort((a, b) => a[1].localeCompare(b[1])).map(([c, l, n]) => chip(c, l, n)));
  };
  const render = () => {
    rows.replaceChildren(...shown.slice(0, 500).map((it, i) => h(`div.picker-row${i === active ? ".active" : ""}`, {
      onclick: () => { active = i; render(); }, ondblclick: () => done(it.value),
    }, h("span.picker-name", {}, it.label), it.detail ? h("span.picker-tags", {}, it.detail) : null)));
    rows.children[active]?.scrollIntoView({ block: "nearest" });
    if (opts.preview) preview.replaceChildren(...(shown[active] ? opts.preview(shown[active].value) : []));
  };
  search.addEventListener("input", filter);
  search.addEventListener("keydown", (e) => {
    const key = keyOf(e);
    if (key === "ArrowDown") { active = Math.min(shown.length - 1, active + 1); render(); e.preventDefault(); }
    else if (key === "ArrowUp") { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (key === "Enter" && shown[active]) done(shown[active].value);
  });
  filter();
  return [search, ...(opts.categoryName ? [chips] : []), rows, ...(opts.preview ? [preview] : [])];
}

/** The function's sentence with its arguments as placeholders, and its hint. */
function functionPreview(ed: TriggerEditorHandle, f: TriggerFunction): (HTMLElement | string)[] {
  const parts = f.pattern.length
    ? f.pattern.map((p) => (typeof p === "string" ? p : h("span.trig-param.unset", {}, p.arg)))
    : [f.displayName, ...(f.args.length ? [`(${f.args.map((a) => ed.data.types.get(a)?.name ?? a).join(", ")})`] : [])];
  return [h("div.trig-preview-text", {}, ...parts), ...(f.hint ? [h("div.muted.trig-preview-hint", {}, f.hint)] : [])];
}

/** Function choices as list items, with their category for the chips. */
function functionItems(ed: TriggerEditorHandle, functions: TriggerFunction[]): ListItem<TriggerFunction>[] {
  return functions.map((f) => ({ ...functionLabel(ed, f), value: f, category: f.category || "" })).sort((a, b) => a.label.localeCompare(b.label));
}
const categoryName = (ed: TriggerEditorHandle) => (c: string) => ed.data.categories.get(c)?.name ?? (c || "Other");

/** "Unit - Kill" style label of a function. */
export function functionLabel(ed: TriggerEditorHandle, f: TriggerFunction): { label: string; detail: string } {
  const cat = ed.data.categories.get(f.category);
  return { label: cat && !cat.hideName ? `${cat.name} - ${f.displayName}` : f.displayName, detail: f.name };
}

export function pickFunction(ed: TriggerEditorHandle, title: string, functions: TriggerFunction[]): Promise<TriggerFunction | undefined> {
  return modal<TriggerFunction>(title, (done) => listPicker(functionItems(ed, functions), done, {
    placeholder: "Search by name or category", categoryName: categoryName(ed), preview: (f) => functionPreview(ed, f),
  }), ".trig-dialog-wide");
}

/** Edits one parameter of argument type `type`. */
export function editParam(ed: TriggerEditorHandle, type: string, current: Param, extra: TriggerParamEditor[],
  limits?: [number | null, number | null], opts: { variables?: boolean } = {}): Promise<Param | undefined> {
  const data = ed.data, file = ed.file;
  const typeName = data.types.get(type)?.name ?? type;
  return modal<Param>(`${typeName}`, (done, hide) => {
    const tabs: { label: string; build: () => HTMLElement[] }[] = [];
    const presets = presetsFor(data, type);
    if (presets.length) tabs.push({ label: "Preset", build: () => listPicker(presets.map(([k, n]) => ({ label: n, detail: k, value: k })), (v) => done({ type: PRESET, value: v })) });
    const vars = variablesFor(data, file, type);
    if (opts.variables !== false) tabs.push({ label: "Variable", build: () => {
      const items = vars.map((v) => ({ label: v.name + (v.isArray ? "[]" : ""), detail: data.types.get(v.type)?.name ?? v.type, value: v }));
      return items.length
        ? listPicker(items, (v) => done({ type: VARIABLE, value: v.name, ...(v.isArray ? { index: { type: VALUE, value: "0" } } : {}) }))
        : [h("p.muted", {}, `No ${typeName} variables in this map.`)];
    } });
    const fns = functionsFor(data, type);
    if (fns.length) tabs.push({ label: "Function", build: () => listPicker(functionItems(ed, fns), (f) => done(callParam(data, f, file)), {
      categoryName: categoryName(ed), preview: (f) => functionPreview(ed, f),
    }) });
    if (takesValue(data, type)) tabs.push({ label: "Value", build: () => {
      // Numbers must be numbers the script can hold (literals.ts: a 32-bit integer, a 32-bit float); one past the
      // function's limits (_Limits) is pulled to the nearer one, as the World Editor's dialog does.
      const base = data.types.get(type)?.base ?? type;
      const problem = (v: string): string | null => {
        if (isTypedCode(type, v)) return null;
        if (base !== "integer" && base !== "real") return null;
        const t = typedTriggerNumber(base, v);
        if ("refused" in t || t.value === null) return /code$/.test(type) ? "Enter an object code of 4 characters, like hfoo." : "refused" in t ? t.refused : "Enter a number.";
        return null;
      };
      const note = h("div.trig-value-note", {}, limits && (limits[0] !== null || limits[1] !== null)
        ? `Allowed: ${limits[0] ?? "…"} to ${limits[1] ?? "…"}` : "");
      // An empty number box is 0 to the World Editor's dialog (measured: Wait typed empty is 0.00); a code isn't a number.
      const typed = () => (base === "integer" || base === "real") && !/code$/.test(type) && input.value.trim() === "" ? "0" : input.value;
      const allowed = note.textContent;
      // A doubt about a typed code (no such object): shown while typing, and always before the value is taken, so a
      // quick Enter can't pass it by. Taken all the same on the next OK.
      let seen: string | null = null;
      const warning = async (v: string) => {
        if (!isTypedCode(type, v)) return undefined;
        for (const x of extra) {
          const w = await x.warn?.({ type, value: v.trim() }).catch(() => undefined);
          if (w) return w;
        }
        return undefined;
      };
      const showWarning = async () => {
        const v = input.value;
        const w = await warning(v);
        if (input.value !== v || note.classList.contains("error")) return;
        note.textContent = w ?? allowed;
        note.classList.toggle("warning", !!w);
        if (w) seen = v;
      };
      let taking = false;
      const take = async () => {
        const v = typed();
        const err = problem(v);
        note.classList.remove("warning");
        if (err) { note.textContent = err; note.classList.add("error"); input.focus(); return; }
        if (isTypedCode(type, v) && seen !== v) {
          if (taking) return;
          taking = true;
          const w = await warning(v);
          taking = false;
          // Closed or typed on meanwhile.
          if (!input.isConnected || input.value !== v) return;
          if (w) { note.textContent = w; note.classList.remove("error"); note.classList.add("warning"); seen = v; input.focus(); return; }
        }
        // A typed number is kept as the World Editor keeps it (literals.ts typedTriggerNumber); a code as typed.
        const n = base === "integer" || base === "real" ? typedTriggerNumber(base, v) : null;
        const kept = n && "value" in n && n.value !== null && !isTypedCode(type, v) ? limitTriggerNumber(base as "integer" | "real", n.value, limits ?? [null, null]) : null;
        if (kept === null && base !== "integer" && base !== "real" && ed.text) {
          // A text as the map's text encoding stores it (lib/formats/codepage.ts): its bytes where it wasn't changed.
          try {
            done({ type: VALUE, value: ed.text.store(v, wasValue) });
          } catch (e) {
            note.textContent = (e as Error).message;
            note.classList.add("error");
            input.focus();
          }
          return;
        }
        done({ type: VALUE, value: kept ?? (base === "integer" || base === "real" ? v.trim() : v) });
      };
      const wasValue = current.type === VALUE ? current.value : "";
      const input = h("input.picker-search", { type: "text", value: ed.text && base !== "integer" && base !== "real" ? ed.text.show(wasValue) : wasValue,
        onkeydown: (e: KeyboardEvent) => { if (keyOf(e) === "Enter") void take(); },
        oninput: () => {
          note.classList.remove("error", "warning");
          note.textContent = allowed;
          const f = /code$/.test(type) ? input.value : filterTriggerTyping(base, input.value);
          if (f !== input.value) input.value = f;
          void showWarning();
        } });
      // A value already there that is doubtful says so when the tab opens.
      void showWarning();
      // A message the game shows gets the colour tools (the preview starts white, as the game's message text).
      return [isMessageType(data, type) ? withColorTools(input, { defaultColor: "FFFFFF" }) : input, note, h("div.newmap-buttons", {}, h("button.primary", { onclick: () => void take() }, "OK"))];
    } });
    const body = h("div.trig-dialog-body");
    const bar = h("div.picker-tabs");
    const show = (i: number) => {
      bar.querySelectorAll("button.trig-tab").forEach((b, j) => b.classList.toggle("active", i === j));
      body.replaceChildren(...tabs[i].build());
      (body.querySelector("input") as HTMLElement | null)?.focus();
    };
    tabs.forEach((t, i) => bar.append(h("button.trig-tab", { onclick: () => show(i) }, t.label)));
    // Editors with a list are tabs of their own (filled when first shown).
    for (const x of extra) {
      if (!x.list) continue;
      const list = x.list({ type, editor: ed }).catch(() => []);
      tabs.push({ label: x.title, build: () => {
        const box = h("div.trig-dialog-list", {}, h("p.muted", {}, "Loading…"));
        void list.then((choices) => {
          box.replaceChildren(...(choices.length
            ? listPicker(choices.map((c) => ({ label: c.label, detail: c.detail, category: c.group, value: c.param })), (p) => done(p),
              { categoryName: choices.some((c) => c.group) ? (g) => g : undefined })
            : [h("p.muted", {}, `Nothing in this map for ${typeName}.`)]));
          (box.querySelector("input") as HTMLElement | null)?.focus();
        });
        return [box];
      } });
    }
    for (const x of extra) {
      if (!x.edit) continue;
      const edit = x.edit.bind(x);
      bar.append(h("button.trig-tab-extra", { onclick: async () => {
        // Hidden meanwhile, so the extension's own dialog is on top.
        hide(true);
        const p = await edit({ type, current, editor: ed }).catch(() => undefined);
        hide(false);
        if (p) done(p);
      } }, x.title));
    }
    // The tab of the current kind of value; an unset parameter starts at Value, else Preset.
    const tabOf = (label: string) => tabs.findIndex((t) => t.label === label);
    // A generated global (gg_rct_…) is on its map list, if one shows the type.
    const mapTab = current.type === VARIABLE && current.value.startsWith("gg_") ? extra.find((x) => x.list)?.title : undefined;
    const currentTab = mapTab ?? ({ [PRESET]: "Preset", [VARIABLE]: "Variable", [FUNCTION]: "Function", [VALUE]: "Value" } as Record<number, string>)[current.type];
    const start = Math.max(0, currentTab ? tabOf(currentTab) : Math.max(tabOf("Value"), tabOf("Preset")));
    queueMicrotask(() => tabs.length && show(start));
    return [h("div.muted", {}, `Current: ${paramText(current, ed.display, type)}`), bar, body];
  }, ".trig-dialog-wide");
}
