// Dialogs of the GUI trigger kind: choosing a function (event, condition,
// action or call) and editing one parameter (preset, variable, function,
// value, or an editor another extension registered for the type).

import type { TriggerEditorHandle, TriggerParamEditor } from "../../extensions/services";
import { paramText } from "../../lib/triggers/display";
import type { TriggerFunction } from "../../lib/triggers/triggerdata";
import type { Param } from "../../lib/triggers/wtg";
import { h } from "../../workbench/dom";
import { callParam, FUNCTION, functionsFor, PRESET, presetsFor, takesValue, VALUE, VARIABLE, variablesFor } from "./params";

/** A modal over the whole window; resolves with what `body` passes to `done`. */
function modal<T>(title: string, body: (done: (v: T | undefined) => void, hide: (hidden: boolean) => void) => HTMLElement[], cls = ""): Promise<T | undefined> {
  return new Promise((resolve) => {
    const close = (v: T | undefined) => { overlay.remove(); resolve(v); };
    const overlay = h("div.picker-overlay.newmap-overlay", {
      tabindex: -1,
      onmousedown: (e: MouseEvent) => { if (e.target === overlay) close(undefined); },
      onkeydown: (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(undefined); } },
    }, h(`div.picker.trig-dialog${cls}`, {},
      h("div.picker-header", {}, h("strong", {}, title), h("button.icon-button", { title: "Close (Esc)", onclick: () => close(undefined) }, "×")),
      ...body(close, (hidden) => { overlay.hidden = hidden; })));
    document.body.append(overlay);
    // The search/value field, not the header's close button (a typed space would press it).
    ((overlay.querySelector("input, textarea") ?? overlay.querySelector(".picker-tabs button, .picker-row")) as HTMLElement | null)?.focus();
  });
}

/** A filterable list; Enter or double-click takes the highlighted row. */
function listPicker<T>(items: { label: string; detail?: string; value: T }[], done: (v: T) => void, placeholder = "Search"): HTMLElement[] {
  let shown = items, active = 0;
  const rows = h("div.picker-rows");
  const render = () => {
    rows.replaceChildren(...shown.slice(0, 500).map((it, i) => h(`div.picker-row${i === active ? ".active" : ""}`, {
      onclick: () => { active = i; render(); }, ondblclick: () => done(it.value),
    }, h("span.picker-name", {}, it.label), it.detail ? h("span.picker-tags", {}, it.detail) : null)));
    rows.children[active]?.scrollIntoView({ block: "nearest" });
  };
  const search = h("input.picker-search", { type: "text", placeholder, oninput: () => {
    const q = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    shown = items.filter((it) => q.every((w) => `${it.label} ${it.detail ?? ""}`.toLowerCase().includes(w)));
    active = 0;
    render();
  }, onkeydown: (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { active = Math.min(shown.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (e.key === "Enter" && shown[active]) done(shown[active].value);
  } });
  render();
  return [search, rows];
}

/** "Unit - Kill" style label of a function. */
export function functionLabel(ed: TriggerEditorHandle, f: TriggerFunction): { label: string; detail: string } {
  const cat = ed.data.categories.get(f.category);
  return { label: cat && !cat.hideName ? `${cat.name} - ${f.displayName}` : f.displayName, detail: f.name };
}

export function pickFunction(ed: TriggerEditorHandle, title: string, functions: TriggerFunction[]): Promise<TriggerFunction | undefined> {
  const items = functions.map((f) => ({ ...functionLabel(ed, f), value: f })).sort((a, b) => a.label.localeCompare(b.label));
  return modal<TriggerFunction>(title, (done) => listPicker(items, done, "Search by name or category"), ".trig-dialog-wide");
}

/** Edits one parameter of argument type `type`. */
export function editParam(ed: TriggerEditorHandle, type: string, current: Param, extra: TriggerParamEditor[]): Promise<Param | undefined> {
  const data = ed.data, file = ed.file;
  const typeName = data.types.get(type)?.name ?? type;
  return modal<Param>(`${typeName}`, (done, hide) => {
    const tabs: { label: string; build: () => HTMLElement[] }[] = [];
    const presets = presetsFor(data, type);
    if (presets.length) tabs.push({ label: "Preset", build: () => listPicker(presets.map(([k, n]) => ({ label: n, detail: k, value: k })), (v) => done({ type: PRESET, value: v })) });
    const vars = variablesFor(data, file, type);
    tabs.push({ label: "Variable", build: () => {
      const items = vars.map((v) => ({ label: v.name + (v.isArray ? "[]" : ""), detail: data.types.get(v.type)?.name ?? v.type, value: v }));
      return items.length
        ? listPicker(items, (v) => done({ type: VARIABLE, value: v.name, ...(v.isArray ? { index: { type: VALUE, value: "0" } } : {}) }))
        : [h("p.muted", {}, `No ${typeName} variables in this map.`)];
    } });
    const fns = functionsFor(data, type);
    if (fns.length) tabs.push({ label: "Function", build: () => listPicker(
      fns.map((f) => ({ ...functionLabel(ed, f), value: f })).sort((a, b) => a.label.localeCompare(b.label)),
      (f) => done(callParam(data, f, file))) });
    if (takesValue(data, type)) tabs.push({ label: "Value", build: () => {
      const input = h("input.picker-search", { type: "text", value: current.type === VALUE ? current.value : "",
        onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") done({ type: VALUE, value: input.value }); } });
      return [input, h("div.newmap-buttons", {}, h("button.primary", { onclick: () => done({ type: VALUE, value: input.value }) }, "OK"))];
    } });
    const body = h("div.trig-dialog-body");
    const bar = h("div.picker-tabs");
    const show = (i: number) => {
      bar.querySelectorAll("button.trig-tab").forEach((b, j) => b.classList.toggle("active", i === j));
      body.replaceChildren(...tabs[i].build());
      (body.querySelector("input") as HTMLElement | null)?.focus();
    };
    tabs.forEach((t, i) => bar.append(h("button.trig-tab", { onclick: () => show(i) }, t.label)));
    for (const x of extra) {
      bar.append(h("button.trig-tab-extra", { onclick: async () => {
        // Hidden meanwhile, so the extension's own dialog is on top.
        hide(true);
        const p = await x.edit({ type, current, editor: ed }).catch(() => undefined);
        hide(false);
        if (p) done(p);
      } }, x.title));
    }
    // The tab of the current kind of value; an unset parameter starts at Value, else Preset.
    const tabOf = (label: string) => tabs.findIndex((t) => t.label === label);
    const currentTab = ({ [PRESET]: "Preset", [VARIABLE]: "Variable", [FUNCTION]: "Function", [VALUE]: "Value" } as Record<number, string>)[current.type];
    const start = Math.max(0, currentTab ? tabOf(currentTab) : Math.max(tabOf("Value"), tabOf("Preset")));
    queueMicrotask(() => tabs.length && show(start));
    return [h("div.muted", {}, `Current: ${paramText(current, ed.display, type)}`), bar, body];
  }, ".trig-dialog-wide");
}
