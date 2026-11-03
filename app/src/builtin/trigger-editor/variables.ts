// The variables table of the trigger editor (the World Editor's Variable
// Editor): name, type, array size and initial value of the map's global
// variables (udg_…). Renaming updates the GUI triggers that use a variable;
// deleting one resets those parameters; a used variable keeps its type.

import type { W3Api } from "../../extensions/api";
import type { TriggerEditorHandle } from "../../extensions/services";
import type { TriggerData } from "../../lib/triggers/triggerdata";
import type { Item, Param, TriggerFile, Variable } from "../../lib/triggers/wtg";
import { h } from "../../workbench/dom";

const VARIABLE = 1;
/** Base types whose initial value is typed in. */
const TYPED = ["integer", "real", "string", "StringExt", "boolean"];

export interface VariableHost {
  handle: TriggerEditorHandle;
  /** A new id for a tree item of `type` (Reforged numbering). */
  allocId(type: number): number;
  /** The category a new item goes into (Reforged files list variables in categories). */
  category(): { parent: number; index: number };
  select(variable: Variable): void;
  /** Custom script text that can name variables (map header, custom-text triggers). */
  scripts(): { get(): string | null; set(text: string): void }[];
}

/** udg_<name> as a whole identifier. */
const scriptRef = (name: string) => new RegExp(`(?<![A-Za-z0-9_])udg_${name}(?![A-Za-z0-9_])`, "g");

/** "Custom Script" actions in GUI triggers (their one parameter is script text). */
function customScriptParams(file: TriggerFile): Param[] {
  const out: Param[] = [];
  type E = { name: string; params: Param[]; children: E[] };
  const visit = (e: E) => { if (e.name === "CustomScriptCode" && e.params[0]) out.push(e.params[0]); e.children.forEach(visit); };
  for (const it of file.items) if ("ecas" in it) (it.ecas as E[]).forEach(visit);
  return out;
}

/** How often udg_<name> appears in custom script (texts, header, Custom Script actions). */
export function scriptUses(host: VariableHost, name: string): number {
  const re = scriptRef(name);
  const count = (t: string | null) => (t ? t.match(re)?.length ?? 0 : 0);
  return host.scripts().reduce((n, s) => n + count(s.get()), 0)
    + customScriptParams(host.handle.file).reduce((n, p) => n + count(p.value), 0);
}

/** Renames udg_<from> to udg_<to> in custom script. Run inside an edit. */
export function renameInScripts(host: VariableHost, from: string, to: string): void {
  for (const s of host.scripts()) {
    const t = s.get();
    if (t && scriptRef(from).test(t)) s.set(t.replace(scriptRef(from), `udg_${to}`));
  }
  for (const p of customScriptParams(host.handle.file)) p.value = p.value.replace(scriptRef(from), `udg_${to}`);
}

/** Every parameter that names a variable (array indexes and nested calls included). */
export function variableParams(file: TriggerFile, name?: string): Param[] {
  const out: Param[] = [];
  const visitP = (p: Param) => {
    if (p.type === VARIABLE && (name === undefined || p.value === name)) out.push(p);
    p.call?.params.forEach(visitP);
    if (p.index) visitP(p.index);
  };
  type E = { params: Param[]; children: E[] };
  const visitE = (e: E) => { e.params.forEach(visitP); e.children.forEach(visitE); };
  for (const it of file.items) if ("ecas" in it) (it.ecas as E[]).forEach(visitE);
  return out;
}

export const validName = (s: string) => /^[A-Za-z][A-Za-z0-9_]*$/.test(s) && !s.endsWith("_");

function treeItem(file: TriggerFile, v: Variable): Extract<Item, { type: 64 }> | undefined {
  return file.items.find((i): i is Extract<Item, { type: 64 }> => i.type === 64 && i.id === v.id);
}

export function newVariable(host: VariableHost): void {
  const ed = host.handle;
  ed.edit("New variable", () => {
    const file = ed.file;
    const taken = new Set(file.variables.map((v) => v.name));
    let name = "NewVariable";
    for (let n = 2; taken.has(name); n++) name = `NewVariable${n}`;
    const v: Variable = { name, type: "integer", unknown: 1, isArray: false, arraySize: 1, initialized: false, initialValue: "", id: file.variables.length, parent: -1 };
    if (file.reforged) {
      const { parent, index } = host.category();
      v.id = host.allocId(64);
      v.parent = parent;
      file.items.splice(index, 0, { type: 64, id: v.id, name, parent });
    }
    file.variables.push(v);
    host.select(v);
  });
}

/** Deletes `v`, after asking when triggers use it (their parameters become unset). */
export async function deleteVariable(w3: W3Api, host: VariableHost, v: Variable): Promise<void> {
  const ed = host.handle;
  const uses = variableParams(ed.file, v.name).length;
  if (uses) {
    const c = await w3.window.showWarning(`${v.name} is used ${uses} time${uses === 1 ? "" : "s"} in triggers. Delete it and clear those parameters?`, "Delete", "Cancel");
    if (c !== "Delete") return;
  }
  ed.edit(`Delete ${v.name}`, () => {
    const file = ed.file;
    for (const p of variableParams(file, v.name)) { p.type = -1; p.value = ""; delete p.call; delete p.index; }
    file.variables = file.variables.filter((x) => x.id !== v.id || x.name !== v.name);
    if (file.reforged) {
      file.items = file.items.filter((i) => !(i.type === 64 && i.id === v.id));
      file.counts[6]?.deleted.push(v.id);
    } else file.variables.forEach((x, i) => { x.id = i; });
  });
}

/** The table of `vars`, editable when the trigger file is. */
export function variablesTable(w3: W3Api, host: VariableHost, vars: Variable[]): HTMLElement {
  const ed = host.handle, data = ed.data, editable = ed.editable;
  const addButton = editable ? h("button", { onclick: () => newVariable(host) }, "New variable") : null;
  if (!vars.length) return h("div", {}, h("p.muted", {}, "No variables."), addButton);
  const rows = vars.map((v) => (editable ? editRow(w3, host, data, v) : viewRow(ed, data, v)));
  return h("div", {},
    h("table.trig-vars-table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Type"), h("th", {}, "Array"), h("th", {}, "Initial value"), editable ? h("th") : null)),
      h("tbody", {}, ...rows)),
    addButton ? h("div.trig-vars-actions", {}, addButton) : null);
}

function viewRow(ed: TriggerEditorHandle, data: TriggerData, v: Variable): HTMLElement {
  return h("tr", {},
    h("td", {}, h("code", { title: `udg_${v.name} in the script` }, v.name)),
    h("td", {}, data.types.get(v.type)?.name ?? v.type),
    h("td", {}, v.isArray ? `[${v.arraySize}]` : ""),
    h("td", {}, v.initialized
      ? data.presets.get(v.initialValue)?.name ?? ed.display.string?.(v.initialValue) ?? v.initialValue
      : h("span.muted", {}, "default")));
}

function editRow(w3: W3Api, host: VariableHost, data: TriggerData, v: Variable): HTMLElement {
  const ed = host.handle;
  const used = () => variableParams(ed.file, v.name).length;

  const name = h("input.trig-var-name", { type: "text", value: v.name, title: `udg_${v.name} in the script`, onchange: async () => {
    const n = name.value.trim();
    if (n === v.name) return;
    const clash = ed.file.variables.some((x) => x !== v && x.name === n);
    if (!validName(n) || clash) {
      w3.window.showError(clash ? `There already is a variable ${n}.` : "Names start with a letter and use letters, digits and _ (not at the end).");
      name.value = v.name;
      return;
    }
    // Custom script isn't updated by the World Editor; here it's offered.
    let scripts = false;
    const inScript = scriptUses(host, v.name);
    if (inScript) {
      const c = await w3.window.showWarning(`udg_${v.name} appears ${inScript} time${inScript === 1 ? "" : "s"} in custom script. Rename it there too?`,
        "Rename in script too", "Only GUI triggers");
      if (c === undefined) { name.value = v.name; return; }
      scripts = c === "Rename in script too";
    }
    ed.edit(`Rename ${v.name}`, () => {
      const target = ed.file.variables.find((x) => x.id === v.id && x.name === v.name)!;
      if (scripts) renameInScripts(host, target.name, n);
      for (const p of variableParams(ed.file, target.name)) p.value = n;
      const it = treeItem(ed.file, target);
      if (it) it.name = n;
      target.name = n;
    });
  } });

  const globalTypes = [...data.types].filter(([, t]) => t.global);
  if (!data.types.get(v.type)?.global) globalTypes.unshift([v.type, { name: v.type, global: true }]);
  const type = h("select", { onchange: () => {
    if (used()) {
      w3.window.showError(`${v.name} is used in triggers; its type can't change.`);
      type.value = v.type;
      return;
    }
    ed.edit(`Change type of ${v.name}`, () => {
      const target = current();
      target.type = type.value;
      target.initialized = false;
      target.initialValue = "";
    });
  } }, ...globalTypes.map(([k, t]) => h("option", { value: k, selected: k === v.type }, t.name)));

  const current = () => ed.file.variables.find((x) => x.id === v.id && x.name === v.name)!;
  const isArray = h("input", { type: "checkbox", checked: v.isArray, title: "Array", onchange: () => {
    if (used()) {
      w3.window.showError(`${v.name} is used in triggers; it can't become ${v.isArray ? "a single value" : "an array"}.`);
      isArray.checked = v.isArray;
      return;
    }
    ed.edit(`Change ${v.name}`, () => { current().isArray = isArray.checked; if (!isArray.checked) current().arraySize = 1; });
  } });
  const size = h("input.trig-var-size", { type: "number", min: 1, max: 32768, value: v.arraySize, disabled: !v.isArray, title: "Array size", onchange: () => {
    const n = Math.round(Number(size.value));
    if (!(n >= 1 && n <= 32768)) { size.value = String(v.arraySize); return; }
    ed.edit(`Change ${v.name}`, () => { current().arraySize = n; });
  } });

  const del = h("button.trig-var-del", { title: "Delete variable", onclick: () => void deleteVariable(w3, host, v) }, "✕");
  return h("tr", {},
    h("td", {}, name), h("td", {}, type), h("td", {}, h("label.trig-var-array", {}, isArray, size)),
    h("td", {}, initialValue(host, data, v, current)), h("td", {}, del));
}

/** Presets of the type to pick from, a typed value for numbers, text and object codes, else nothing. */
function initialValue(host: VariableHost, data: TriggerData, v: Variable, current: () => Variable): HTMLElement {
  const ed = host.handle;
  const set = (value: string | null) => ed.edit(`Initial value of ${v.name}`, () => {
    const t = current();
    t.initialized = value !== null;
    t.initialValue = value ?? "";
  });
  const base = data.types.get(v.type)?.base ?? v.type;
  const presets = [...data.presets].filter(([, p]) => p.type === v.type);
  if (presets.length || base === "boolean") {
    const options: [string, string][] = presets.length ? presets.map(([k, p]) => [k, p.name]) : [["true", "True"], ["false", "False"]];
    if (v.initialized && !options.some(([k]) => k === v.initialValue)) options.push([v.initialValue, v.initialValue]);
    const sel = h("select", { onchange: () => set(sel.value === "" ? null : sel.value) },
      h("option", { value: "", selected: !v.initialized }, "default"),
      ...options.map(([k, n]) => h("option", { value: k, selected: v.initialized && k === v.initialValue }, n)));
    return sel;
  }
  const typed = TYPED.includes(base) || /code$/.test(v.type);
  if (!typed) return h("span.muted", {}, "default");
  const input = h("input.trig-var-value", { type: "text", value: v.initialized ? v.initialValue : "", placeholder: "default", onchange: () => {
    const raw = input.value.trim();
    if (raw === "" && base !== "string") { set(null); return; }
    if (base === "integer" && !/^-?\d+$/.test(raw)) { input.value = v.initialValue; return; }
    if (base === "real") {
      const n = Number(raw);
      if (!Number.isFinite(n)) { input.value = v.initialValue; return; }
      set(n.toFixed(2));
      return;
    }
    if (/code$/.test(v.type) && !/^.{4}$/.test(raw)) { input.value = v.initialValue; return; }
    set(base === "string" && input.value === "" ? null : base === "string" ? input.value : raw);
  } });
  return input;
}
