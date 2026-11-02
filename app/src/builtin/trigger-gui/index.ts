// GUI Triggers: the trigger kind (sub-extension of the Trigger Editor) for
// triggers made of events, conditions and actions. Shows them as the World
// Editor words them, with category icons and nested blocks, and edits them:
// add / delete / move / disable, and parameters by clicking them in the
// sentence. It provides "w3.triggers.gui" so other extensions can add editors
// for parameter types (see trigger-gui-objects for the object pickers).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import {
  TRIGGER_GUI_SERVICE, TRIGGERS_SERVICE,
  type TriggerEditorHandle, type TriggerGuiService, type TriggerParamEditor, type TriggersService,
} from "../../extensions/services";
import { branchLabels, paramText } from "../../lib/triggers/display";
import { ACTION, CONDITION, EVENT } from "../../lib/triggers/triggerdata";
import type { Eca, Param, TriggerItem } from "../../lib/triggers/wtg";
import { h } from "../../workbench/dom";
import { editParam, pickFunction } from "./dialogs";
import { argType, FUNCTION, newEca } from "./params";

class ParamEditors implements TriggerGuiService {
  private list: TriggerParamEditor[] = [];
  registerParamEditor(e: TriggerParamEditor) {
    this.list.push(e);
    return { dispose: () => { this.list = this.list.filter((x) => x !== e); } };
  }
  forType(type: string) { return this.list.filter((e) => e.types.includes(type)); }
}

/** What is selected in a trigger: an ECA (path of indices from the trigger's
 *  list through children) or a branch of a block (path of the block + branch). */
type Sel = { path: number[]; branch?: number } | { section: number };
const selection = new Map<number, Sel>();
const SECTIONS = [[EVENT, "Events"], [CONDITION, "Conditions"], [ACTION, "Actions"]] as const;
const KIND_NAMES = ["Event", "Condition", "Action"];

/** Blocks have child lists per branch (If/Then/Else, loops, And/Or). */
const isBlock = (e: Eca) => /Multiple$/.test(e.name);
/** Kind of the ECAs in a branch: the If part and And/Or take conditions. */
const branchKind = (e: Eca, branch: number) =>
  (e.name.startsWith("IfThenElse") && branch === 0) || e.name === "AndMultiple" || e.name === "OrMultiple" ? CONDITION : ACTION;

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const editors = new ParamEditors();
  ctx.subscriptions.push(w3.services.provide(TRIGGER_GUI_SERVICE, editors));
  void w3.services.get<TriggersService>(TRIGGERS_SERVICE).then((s) => {
    ctx.subscriptions.push(s.registerKind({
      id: "gui",
      priority: 10,
      title: "GUI Trigger",
      matches: (t) => !t.isCustom,
      init: () => { /* an empty trigger: no events, conditions or actions */ },
      render: (el, t, ed) => {
        const view = new GuiView(el, t, ed, editors);
        view.render();
        return { keyDown: (e) => view.keyDown(e) };
      },
    }));
  });
}

class GuiView {
  constructor(private el: HTMLElement, private t: TriggerItem, private ed: TriggerEditorHandle, private editors: ParamEditors) {}

  /** Del removes the selected ECA (instead of the host deleting the whole trigger). */
  keyDown(e: KeyboardEvent): boolean {
    const s = this.sel;
    if (e.key !== "Delete" || !this.ed.editable || !s || !("path" in s) || s.branch !== undefined) return false;
    this.remove();
    return true;
  }

  private get sel(): Sel | undefined { return selection.get(this.t.id); }
  private select(s: Sel) { selection.set(this.t.id, s); this.render(); }

  /** The list holding the ECA at `path`, and its index there. */
  private locate(path: number[]): { list: Eca[]; index: number; eca: Eca } | null {
    let list = this.t.ecas;
    for (let d = 0; d < path.length; d++) {
      const eca = list[path[d]];
      if (!eca) return null;
      if (d === path.length - 1) return { list, index: path[d], eca };
      list = eca.children;
    }
    return null;
  }

  render() {
    const ed = this.ed;
    const parts: HTMLElement[] = [];
    if (ed.editable) parts.push(this.toolbar());
    for (const [kind, label] of SECTIONS) {
      const active = this.sel && "section" in this.sel && this.sel.section === kind;
      parts.push(h(`div.trig-section.trig-pick${active ? ".active" : ""}`, { onclick: () => this.select({ section: kind }) }, label));
      parts.push(h("div.trig-ecas", {}, ...this.t.ecas.map((e, i) => (e.kind === kind ? this.node(e, [i]) : null)).filter((x): x is HTMLElement => !!x)));
    }
    this.el.replaceChildren(...parts);
  }

  private toolbar(): HTMLElement {
    const s = this.sel;
    const at = s && "path" in s && s.branch === undefined ? this.locate(s.path) : null;
    return h("div.trig-gui-toolbar", {},
      ...SECTIONS.map(([kind]) => h("button", { title: `New ${KIND_NAMES[kind]} (after the selection)`, onclick: () => void this.add(kind) }, `+ ${KIND_NAMES[kind]}`)),
      h("button", { disabled: !at, title: "Delete (Del)", onclick: () => this.remove() }, "Delete"),
      h("button", { disabled: !at, title: "Move up", onclick: () => this.move(-1) }, "↑"),
      h("button", { disabled: !at, title: "Move down", onclick: () => this.move(1) }, "↓"),
      h("button", { disabled: !at, title: "Enable or disable", onclick: () => this.toggle() }, at && !at.eca.enabled ? "Enable" : "Disable"));
  }

  // ---- editing ----------------------------------------------------------------------
  /** Adds an ECA of `kind` where the selection says: into a selected branch, after a selected ECA, or at the end. */
  private async add(kind: number) {
    const s = this.sel;
    let target: { list: Eca[]; index: number; group?: number; kind: number; path: number[] };
    const branchAt = s && "path" in s && s.branch !== undefined ? this.locate(s.path) : null;
    const ecaAt = s && "path" in s && s.branch === undefined ? this.locate(s.path) : null;
    if (branchAt && s && "path" in s) {
      const b = s.branch!;
      const k = branchKind(branchAt.eca, b);
      const last = branchAt.eca.children.reduce((at, c, i) => ((c.group ?? 0) === b ? i : at), -1);
      target = { list: branchAt.eca.children, index: last + 1, group: b, kind: k, path: [...s.path, last + 1] };
    } else if (ecaAt && s && "path" in s && (s.path.length > 1 || ecaAt.eca.kind === kind)) {
      const k = s.path.length > 1 ? ecaAt.eca.kind : kind;
      target = { list: ecaAt.list, index: ecaAt.index + 1, group: ecaAt.eca.group, kind: k, path: [...s.path.slice(0, -1), ecaAt.index + 1] };
    } else {
      const last = this.t.ecas.reduce((at, e, i) => (e.kind <= kind ? i : at), -1);
      target = { list: this.t.ecas, index: last + 1, kind, path: [last + 1] };
    }
    const f = await pickFunction(this.ed, `New ${KIND_NAMES[target.kind]}`, [...this.ed.data.functions[target.kind].values()]);
    if (!f) return;
    this.ed.edit(`New ${KIND_NAMES[target.kind].toLowerCase()}`, () => {
      target.list.splice(target.index, 0, newEca(this.ed.data, f, this.ed.file, target.group));
      selection.set(this.t.id, { path: target.path });
    });
  }
  private remove() {
    const s = this.sel;
    const at = s && "path" in s ? this.locate(s.path) : null;
    if (!at || !s || !("path" in s)) return;
    this.ed.edit(`Delete ${at.eca.name}`, () => {
      at.list.splice(at.index, 1);
      selection.delete(this.t.id);
    });
  }
  private move(dir: -1 | 1) {
    const s = this.sel;
    const at = s && "path" in s ? this.locate(s.path) : null;
    if (!at || !s || !("path" in s)) return;
    // Neighbours of the same kind (top level) or branch (children).
    const same = (e: Eca) => (s.path.length === 1 ? e.kind === at.eca.kind : (e.group ?? 0) === (at.eca.group ?? 0));
    let j = at.index + dir;
    while (j >= 0 && j < at.list.length && !same(at.list[j])) j += dir;
    if (j < 0 || j >= at.list.length) return;
    this.ed.edit("Move", () => {
      [at.list[at.index], at.list[j]] = [at.list[j], at.list[at.index]];
      selection.set(this.t.id, { path: [...s.path.slice(0, -1), j] });
    });
  }
  private toggle() {
    const s = this.sel;
    const at = s && "path" in s ? this.locate(s.path) : null;
    if (at) this.ed.edit(at.eca.enabled ? "Disable" : "Enable", () => { at.eca.enabled = !at.eca.enabled; });
  }
  private async editParamAt(owner: Param[], i: number, type: string) {
    const p = await editParam(this.ed, type, owner[i], this.editors.forType(type));
    if (p) this.ed.edit("Edit parameter", () => { owner[i] = p; });
  }

  // ---- display ----------------------------------------------------------------------
  /** A function's sentence with each argument as a link (nested calls inside). */
  private sentence(kind: number, name: string, params: Param[]): (HTMLElement | string)[] {
    const ed = this.ed, f = ed.data.find(kind, name);
    const link = (i: number): HTMLElement => {
      const p = params[i], type = argType(ed.data, ed.file, kind, name, params, i);
      const unset = !p || p.type < 0;
      const content: (HTMLElement | string)[] = p && p.type === FUNCTION && p.call
        ? ["(", ...this.sentence(p.call.kind, p.call.name, p.call.params), ")"]
        : [unset ? `<${f?.args[i] ?? "?"}>` : paramText(p, ed.display, type)];
      if (p?.index) content.push("[", paramText(p.index, ed.display, "integer"), "]");
      return h(`span.trig-param${unset ? ".unset" : ""}${ed.editable ? ".editable" : ""}`, {
        title: ed.data.types.get(type)?.name ?? type,
        onclick: (e: Event) => { if (!ed.editable) return; e.stopPropagation(); void this.editParamAt(params, i, type); },
      }, ...content);
    };
    if (!f) return name ? [`${name}(`, ...params.flatMap((_, i) => (i ? [", ", link(i)] : [link(i)])), ")"] : [];
    if (!f.pattern.length) return params.length ? [f.displayName, "(", ...params.flatMap((_, i) => (i ? [", ", link(i)] : [link(i)])), ")"] : [f.displayName];
    let i = 0;
    return f.pattern.map((part) => (typeof part === "string" ? part : params[i] !== undefined ? link(i++) : `<${part.arg}>`));
  }

  private node(e: Eca, path: number[]): HTMLElement {
    const ed = this.ed;
    const img = h("img.trig-icon", { alt: "" });
    const f = ed.data.find(e.kind, e.name);
    const cat = f ? ed.data.categories.get(f.category) : undefined;
    void ed.icon(cat?.icon ?? "").then((url) => { if (url) img.src = url; else img.classList.add("none"); });
    const s = this.sel;
    const active = !!s && "path" in s && s.branch === undefined && s.path.join() === path.join();
    const line = h(`div.trig-eca.trig-pick${e.enabled ? "" : ".off"}${active ? ".active" : ""}`, {
      title: e.name, onclick: () => this.select({ path }),
    }, img, h("span", {}, ...(cat && !cat.hideName ? [`${cat.name} - `] : []), ...this.sentence(e.kind, e.name, e.params)));
    if (!isBlock(e) && !e.children.length) return line;
    const labels = branchLabels(e.name);
    const groups = new Set([...labels.keys(), ...e.children.map((c) => c.group ?? 0)]);
    return h("div.trig-block", {}, line, ...[...groups].sort((a, b) => a - b).map((g) => {
      const bActive = !!s && "path" in s && s.branch === g && s.path.join() === path.join();
      return h("div.trig-branch", {},
        h(`div.trig-branch-label.trig-pick${bActive ? ".active" : ""}`, { onclick: () => this.select({ path, branch: g }) }, labels[g] ?? "Actions"),
        ...e.children.map((c, i) => ((c.group ?? 0) === g ? this.node(c, [...path, i]) : null)).filter((x): x is HTMLElement => !!x));
    }));
  }
}
