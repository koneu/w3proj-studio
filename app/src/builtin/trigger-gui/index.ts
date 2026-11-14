// GUI Triggers: the trigger kind (sub-extension of the Trigger Editor) for
// triggers made of events, conditions and actions. Shows them as the World
// Editor words them, with category icons and nested blocks, and edits them:
// add / delete / move / disable, and parameters by clicking them in the
// sentence. It provides "w3.triggers.gui" so other extensions can add editors
// for parameter types (see trigger-gui-objects for the object pickers).

import type { ExtensionContext, MenuItem, W3Api } from "../../extensions/api";
import {
  TRIGGER_GUI_SERVICE, TRIGGERS_SERVICE,
  type TriggerEditorHandle, type TriggerGuiService, type TriggerLocation, type TriggerParamEditor, type TriggersService,
} from "../../extensions/services";
import { branchLabels, paramParts, paramText } from "../../lib/triggers/display";
import { keyOf } from "../../lib/keys";
import { ACTION, CONDITION, EVENT } from "../../lib/triggers/triggerdata";
import type { Eca, Param, TriggerItem } from "../../lib/triggers/wtg";
import { copyText, h } from "../../workbench/dom";
import { copyAs } from "../../lib/triggers/astext";
import { editParam, pickFunction } from "./dialogs";
import { argType, FUNCTION, isUnsetParam, newEca } from "./params";

class ParamEditors implements TriggerGuiService {
  private list: TriggerParamEditor[] = [];
  registerParamEditor(e: TriggerParamEditor) {
    this.list.push(e);
    return { dispose: () => { this.list = this.list.filter((x) => x !== e); } };
  }
  forType(type: string) { return this.list.filter((e) => e.types.includes(type)); }
  editParam(opts: Parameters<TriggerGuiService["editParam"]>[0]) {
    // A trigger editor of no map: no variables, nothing to undo.
    const ed: TriggerEditorHandle = {
      file: { reforged: true, version: 7, counts: [], unknown: 2, variables: [], items: [] }, data: opts.data, display: opts.display,
      editable: true, language: "jass", customText: () => null, setCustomText: () => {},
      customFile: () => ({ reforged: true, version: 1, comment: "", header: null, texts: [] }), edit: (_label, change) => change(),
      icon: async () => null, openTrigger: () => false,
    };
    return editParam(ed, opts.type, opts.current, this.forType(opts.type), opts.limits, { variables: false });
  }
}

/** What is selected in a trigger: an ECA (path of indices from the trigger's
 *  list through children) or a branch of a block (path of the block + branch). */
type Sel = { path: number[]; branch?: number } | { section: number };
const selection = new Map<number, Sel>();
/** A line and parameter shown for a found problem (Problems), per trigger, until the next selection. */
const flagged = new Map<number, TriggerLocation>();
const SECTIONS = [[EVENT, "Events"], [CONDITION, "Conditions"], [ACTION, "Actions"]] as const;
const KIND_NAMES = ["Event", "Condition", "Action"];
type DropAt = { path: number[] } | { path: number[]; branch: number } | { section: number };

/** Copied events/conditions/actions (shared by all triggers, also across maps). */
let clipboard: Eca[] = [];

/** Blocks have child lists per branch (If/Then/Else, loops, And/Or). */
const isBlock = (e: Eca) => /Multiple$/.test(e.name);

/** The list holding the ECA at `path` in `t`, and its index there. */
function locateIn(t: TriggerItem, path: number[]): { list: Eca[]; index: number; eca: Eca } | null {
  let list = t.ecas;
  for (let d = 0; d < path.length; d++) {
    const eca = list[path[d]];
    if (!eca) return null;
    if (d === path.length - 1) return { list, index: path[d], eca };
    list = eca.children;
  }
  return null;
}
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
        const view = new GuiView(w3, el, t, ed, editors);
        view.render();
        return { keyDown: (e) => view.keyDown(e) };
      },
      reveal: (t, at) => {
        selection.set(t.id, { path: at.path });
        flagged.set(t.id, at);
      },
      selectedLines: (t) => {
        const s = selection.get(t.id);
        const eca = s && "path" in s && s.branch === undefined ? locateIn(t, s.path)?.eca : undefined;
        return eca ? [eca] : [];
      },
    }));
  });
}

class GuiView {
  constructor(private w3: W3Api, private el: HTMLElement, private t: TriggerItem, private ed: TriggerEditorHandle, private editors: ParamEditors) {}

  /** Right-click: selects what was clicked, then offers what fits there. */
  private menu(e: MouseEvent, sel: Sel) {
    e.preventDefault();
    e.stopPropagation();
    this.select(sel);
    const items: MenuItem[] = [];
    const onEca = "path" in sel && sel.branch === undefined;
    if (!this.ed.editable) {
      // Read-only: copying and following references only.
      if (onEca) items.push({ label: "Copy", hint: "Ctrl+C", run: () => this.copy(false) });
    } else if ("section" in sel) items.push({ label: `New ${KIND_NAMES[sel.section]}…`, run: () => void this.add(sel.section) });
    else if (sel.branch !== undefined) {
      const at = this.locate(sel.path);
      const k = at ? branchKind(at.eca, sel.branch) : ACTION;
      items.push({ label: `New ${KIND_NAMES[k]}…`, run: () => void this.add(k) });
    } else {
      const at = this.locate(sel.path);
      if (!at) return;
      // Inside a block only the branch's own kind fits; at the top level any kind (added in its section).
      const kinds = sel.path.length > 1 ? [at.eca.kind] : [EVENT, CONDITION, ACTION];
      items.push(...kinds.map((k) => ({ label: `New ${KIND_NAMES[k]}…`, run: () => void this.add(k) })), "-",
        { label: at.eca.enabled ? "Disable" : "Enable", run: () => this.toggle() },
        { label: "Move Up", run: () => this.move(-1) },
        { label: "Move Down", run: () => this.move(1) }, "-",
        { label: "Cut", hint: "Ctrl+X", run: () => this.copy(true) },
        { label: "Copy", hint: "Ctrl+C", run: () => this.copy(false) });
    }
    if (this.ed.editable) {
      if (clipboard.length) items.push(...(items.length ? ["-" as const] : []), { label: `Paste ${clipboard.length > 1 ? `${clipboard.length} lines` : KIND_NAMES[clipboard[0].kind]}`, hint: "Ctrl+V", run: () => this.paste() });
      if (onEca) items.push("-", { label: "Delete", hint: "Del", run: () => this.remove() });
    }
    // The line onto the system clipboard, as the Trigger Editor words it or as script.
    if (onEca) items.push("-", { label: "Copy As Text", run: () => void this.copyAs("text") }, { label: "Copy As Script", run: () => void this.copyAs("script") });
    // Triggers this line refers to.
    if (onEca && "path" in sel) {
      const at = this.locate(sel.path);
      const refs = new Set<string>();
      const visitP = (p: Param) => { if (p.type === 1 && p.value.startsWith("gg_trg_")) refs.add(p.value); p.call?.params.forEach(visitP); };
      at?.eca.params.forEach(visitP);
      if (refs.size) items.push(...(items.length ? ["-" as const] : []), ...[...refs].map((r) => ({ label: `Go to ${r.slice(7).replace(/_/g, " ")}`, run: () => { this.ed.openTrigger(r); } })));
    }
    if (items.length) this.w3.window.showContextMenu({ x: e.clientX, y: e.clientY }, items);
  }

  /** Del removes the selected ECA; Ctrl+C/X/V copy, cut and paste ECAs. */
  keyDown(e: KeyboardEvent): boolean {
    const s = this.sel;
    const onEca = !!s && "path" in s && s.branch === undefined;
    if (e.ctrlKey || e.metaKey) {
      const k = keyOf(e).toLowerCase();
      if (k === "c" && onEca) { this.copy(false); return true; }
      if (k === "x" && onEca && this.ed.editable) { this.copy(true); return true; }
      if (k === "v" && this.ed.editable && clipboard.length) { this.paste(); return true; }
      return false;
    }
    if (keyOf(e) !== "Delete" || !this.ed.editable || !onEca) return false;
    this.remove();
    return true;
  }

  private get sel(): Sel | undefined { return selection.get(this.t.id); }
  private select(s: Sel) { selection.set(this.t.id, s); flagged.delete(this.t.id); this.render(); }
  /** An edit of the trigger: a problem's mark goes (its place may have moved). */
  private edit(label: string, change: () => void) { flagged.delete(this.t.id); this.ed.edit(label, change); }

  /** The list holding the ECA at `path`, and its index there. */
  private locate(path: number[]): { list: Eca[]; index: number; eca: Eca } | null {
    return locateIn(this.t, path);
  }

  /** Copy As Text / Copy As Script of the selected line onto the system clipboard. */
  private async copyAs(as: "text" | "script") {
    const s = this.sel;
    const at = s && "path" in s && s.branch === undefined ? this.locate(s.path) : null;
    if (!at) return;
    const text = copyAs(as, this.ed, this.t, [at.eca]);
    if (text === null) return;
    const how = as === "text" ? "as text" : "as script";
    if (await copyText(text)) void this.w3.window.showInfo(`Copied a line of ${this.t.name} ${how}.`);
    else void this.w3.window.showWarning(`The clipboard refused the copy of a line of ${this.t.name} ${how}.`);
  }

  render() {
    const ed = this.ed;
    const parts: HTMLElement[] = [];
    if (ed.editable) parts.push(this.toolbar());
    for (const [kind, label] of SECTIONS) {
      const active = this.sel && "section" in this.sel && this.sel.section === kind;
      parts.push(h(`div.trig-section.trig-pick${active ? ".active" : ""}`, {
        onclick: () => this.select({ section: kind }), oncontextmenu: (e: MouseEvent) => this.menu(e, { section: kind }),
        ...this.dnd({ section: kind }),
      }, label));
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
    this.edit(`New ${KIND_NAMES[target.kind].toLowerCase()}`, () => {
      target.list.splice(target.index, 0, newEca(this.ed.data, f, this.ed.file, target.group));
      selection.set(this.t.id, { path: target.path });
    });
  }
  /** Copies the selected ECA (with its contents); `cut` also removes it. */
  private copy(cut: boolean) {
    const s = this.sel;
    const at = s && "path" in s && s.branch === undefined ? this.locate(s.path) : null;
    if (!at) return;
    clipboard = [structuredClone(at.eca)];
    if (cut) this.remove(); else this.render();
  }
  /** Where an ECA of `kind` goes for the current selection, or a reason it can't. */
  private target(kind: number): { list: Eca[]; index: number; group?: number; path: number[] } | string {
    const s = this.sel;
    if (s && "path" in s) {
      const at = this.locate(s.path);
      if (!at) return "Nothing selected.";
      if (s.branch !== undefined) {
        const k = branchKind(at.eca, s.branch);
        if (k !== kind) return `This branch takes ${KIND_NAMES[k].toLowerCase()}s.`;
        const last = at.eca.children.reduce((n, c, i) => ((c.group ?? 0) === s.branch ? i : n), -1);
        return { list: at.eca.children, index: last + 1, group: s.branch, path: [...s.path, last + 1] };
      }
      if (s.path.length > 1) {
        if (at.eca.kind !== kind) return `Only ${KIND_NAMES[at.eca.kind].toLowerCase()}s fit here.`;
        return { list: at.list, index: at.index + 1, group: at.eca.group, path: [...s.path.slice(0, -1), at.index + 1] };
      }
      if (at.eca.kind === kind) return { list: this.t.ecas, index: at.index + 1, path: [at.index + 1] };
    }
    // At the top level: after the last one of its kind.
    const last = this.t.ecas.reduce((n, e, i) => (e.kind <= kind ? i : n), -1);
    return { list: this.t.ecas, index: last + 1, path: [last + 1] };
  }
  private paste() {
    if (!clipboard.length) return;
    const kind = clipboard[0].kind;
    const to = this.target(kind);
    if (typeof to === "string") { void this.w3.window.showWarning(`Can't paste a ${KIND_NAMES[kind].toLowerCase()} here. ${to}`); return; }
    const missing = this.missingVariables(clipboard);
    this.edit(`Paste ${KIND_NAMES[kind].toLowerCase()}`, () => {
      const ecas = clipboard.map((e) => {
        const c = structuredClone(e);
        if (to.group === undefined) delete c.group; else c.group = to.group;
        return c;
      });
      to.list.splice(to.index, 0, ...ecas);
      selection.set(this.t.id, { path: to.path });
    });
    if (missing.length) void this.w3.window.showWarning(`The pasted lines use variables this map doesn't have: ${missing.join(", ")}.`);
  }
  /** Variables (udg_, not generated gg_ globals) the ECAs name that the map lacks. */
  private missingVariables(ecas: Eca[]): string[] {
    const have = new Set(this.ed.file.variables.map((v) => v.name)), out = new Set<string>();
    const visitP = (p: Param) => {
      if (p.type === 1 && p.value && !p.value.startsWith("gg_") && !have.has(p.value)) out.add(p.value);
      p.call?.params.forEach(visitP);
      if (p.index) visitP(p.index);
    };
    const visit = (e: Eca) => { e.params.forEach(visitP); e.children.forEach(visit); };
    ecas.forEach(visit);
    return [...out];
  }

  // ---- drag and drop ----------------------------------------------------------------
  /** Where a dragged line can land: before a line, at the end of a branch, or of a section. */
  private dragFrom: number[] | null = null;
  private canDrop(to: DropAt): boolean {
    const from = this.dragFrom;
    const src = from ? this.locate(from) : null;
    if (!from || !src || !this.ed.editable) return false;
    const path = "section" in to ? [] : to.path;
    // Not into itself.
    if (path.length >= from.length && from.every((v, i) => path[i] === v)) return false;
    const k = src.eca.kind;
    if ("section" in to) return to.section === k;
    const at = this.locate(to.path);
    if (!at) return false;
    if ("branch" in to) return branchKind(at.eca, to.branch) === k;
    return at.eca.kind === k;
  }
  private dropAt(to: DropAt) {
    const from = this.dragFrom!;
    this.edit("Move", () => {
      const src = this.locate(from)!;
      const eca = src.eca;
      let list: Eca[], anchor: Eca | null = null, group: number | undefined, after: () => number;
      if ("section" in to) {
        list = this.t.ecas;
        after = () => list.reduce((n, e, i) => (e.kind <= to.section ? i : n), -1) + 1;
      } else if ("branch" in to) {
        const block = this.locate(to.path)!.eca;
        list = block.children;
        group = to.branch;
        after = () => list.reduce((n, c, i) => ((c.group ?? 0) === to.branch ? i : n), -1) + 1;
      } else {
        const at = this.locate(to.path)!;
        list = at.list;
        anchor = at.eca;
        group = to.path.length > 1 ? at.eca.group : undefined;
        after = () => list.indexOf(anchor!);
      }
      src.list.splice(src.index, 1);
      if (group === undefined) delete eca.group; else eca.group = group;
      list.splice(after(), 0, eca);
      const path = this.pathOf(eca);
      if (path) selection.set(this.t.id, { path });
    });
  }
  /** The path of an ECA object in this trigger. */
  private pathOf(target: Eca): number[] | null {
    const walk = (list: Eca[], prefix: number[]): number[] | null => {
      for (let i = 0; i < list.length; i++) {
        if (list[i] === target) return [...prefix, i];
        const inner = walk(list[i].children, [...prefix, i]);
        if (inner) return inner;
      }
      return null;
    };
    return walk(this.t.ecas, []);
  }
  /** Drag handlers for a line (draggable) or a drop target (`to`). */
  private dnd(to: DropAt, dragPath?: number[]): Record<string, unknown> {
    if (!this.ed.editable) return {};
    const clear = () => this.el.querySelectorAll(".drop-before, .drop-into").forEach((x) => x.classList.remove("drop-before", "drop-into"));
    return {
      ...(dragPath ? {
        draggable: true,
        ondragstart: (e: DragEvent) => { e.stopPropagation(); this.dragFrom = dragPath; e.dataTransfer?.setData("text/plain", "eca"); },
        ondragend: () => { this.dragFrom = null; clear(); },
      } : {}),
      ondragover: (e: DragEvent) => {
        if (!this.canDrop(to)) return;
        e.preventDefault();
        e.stopPropagation();
        clear();
        (e.currentTarget as HTMLElement).classList.add("path" in to && !("branch" in to) ? "drop-before" : "drop-into");
      },
      ondragleave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("drop-before", "drop-into"),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        clear();
        if (this.canDrop(to)) this.dropAt(to);
        this.dragFrom = null;
      },
    };
  }

  private remove() {
    const s = this.sel;
    const at = s && "path" in s ? this.locate(s.path) : null;
    if (!at || !s || !("path" in s)) return;
    this.edit(`Delete ${at.eca.name}`, () => {
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
    this.edit("Move", () => {
      [at.list[at.index], at.list[j]] = [at.list[j], at.list[at.index]];
      selection.set(this.t.id, { path: [...s.path.slice(0, -1), j] });
    });
  }
  private toggle() {
    const s = this.sel;
    const at = s && "path" in s ? this.locate(s.path) : null;
    if (at) this.edit(at.eca.enabled ? "Disable" : "Enable", () => { at.eca.enabled = !at.eca.enabled; });
  }
  private async editParamAt(owner: Param[], i: number, type: string, limits?: [number | null, number | null]) {
    const p = await editParam(this.ed, type, owner[i], this.editors.forType(type), limits);
    if (p) this.edit("Edit parameter", () => { owner[i] = p; });
  }
  /** The index of an array variable parameter (an integer of its own). */
  private async editIndex(p: Param) {
    const current = p.index ?? { type: 3, value: "0" };
    const v = await editParam(this.ed, "integer", current, this.editors.forType("integer"));
    if (v) this.edit("Edit array index", () => { p.index = v; });
  }

  // ---- display ----------------------------------------------------------------------
  /** A function's sentence with each argument as a link (nested calls inside). `at`: where its parameters
   *  are in the line marked for a problem (indices through nested calls), null elsewhere. */
  private sentence(kind: number, name: string, params: Param[], at: number[] | null = null): (HTMLElement | string)[] {
    const ed = this.ed, f = ed.data.find(kind, name);
    const marked = flagged.get(this.t.id)?.param?.join();
    const mark = (here: number[] | null) => (here && here.join() === marked ? ".trig-flagged" : "");
    const link = (i: number): HTMLElement => {
      const p = params[i], type = argType(ed.data, ed.file, kind, name, params, i);
      const here = at ? [...at, i] : null, inIndex = here ? [...here, -1] : null;
      const unset = isUnsetParam(p);
      const content: (HTMLElement | string)[] = !unset && p.type === FUNCTION && p.call
        ? ["(", ...this.sentence(p.call.kind, p.call.name, p.call.params, here), ")"]
        : [unset ? `<${f?.args[i] ?? "?"}>` : paramParts(p, ed.display, type).text];
      if (p?.index) {
        const idx = p.index;
        content.push("[", h(`span.trig-param${ed.editable ? ".editable" : ""}${mark(inIndex)}`, {
          title: "Array index (integer)",
          onclick: (e: Event) => { if (!ed.editable) return; e.stopPropagation(); void this.editIndex(p); },
        }, idx.type === FUNCTION && idx.call ? ["(", ...this.sentence(idx.call.kind, idx.call.name, idx.call.params, inIndex), ")"] : paramText(idx, ed.display, "integer")), "]");
      }
      const trigRef = p && p.type === 1 && p.value.startsWith("gg_trg_");
      return h(`span.trig-param${unset ? ".unset" : ""}${ed.editable ? ".editable" : ""}${mark(here)}`, {
        title: `${ed.data.types.get(type)?.name ?? type}${trigRef ? " · Ctrl+click opens the trigger" : ""}`,
        onclick: (e: MouseEvent) => {
          if (trigRef && (e.ctrlKey || e.metaKey)) { e.stopPropagation(); ed.openTrigger(p.value); return; }
          if (!ed.editable) return;
          e.stopPropagation(); void this.editParamAt(params, i, type, f?.limits?.[i]); },
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
    // The line of a found problem: marked itself when the problem isn't one parameter's.
    const flag = flagged.get(this.t.id), onFlag = !!flag && flag.path.join() === path.join();
    const line = h(`div.trig-eca.trig-pick${e.enabled ? "" : ".off"}${active ? ".active" : ""}${onFlag && !flag?.param ? ".trig-flagged" : ""}`, {
      title: e.name, onclick: () => this.select({ path }), oncontextmenu: (ev: MouseEvent) => this.menu(ev, { path }),
      ...this.dnd({ path }, path),
    }, img, h("span", {}, ...(cat && !cat.hideName ? [`${cat.name} - `] : []), ...this.sentence(e.kind, e.name, e.params, onFlag ? [] : null)));
    if (!isBlock(e) && !e.children.length) return line;
    const labels = branchLabels(e.name);
    const groups = new Set([...labels.keys(), ...e.children.map((c) => c.group ?? 0)]);
    return h("div.trig-block", {}, line, ...[...groups].sort((a, b) => a - b).map((g) => {
      const bActive = !!s && "path" in s && s.branch === g && s.path.join() === path.join();
      return h("div.trig-branch", {},
        h(`div.trig-branch-label.trig-pick${bActive ? ".active" : ""}`, {
          onclick: () => this.select({ path, branch: g }), oncontextmenu: (ev: MouseEvent) => this.menu(ev, { path, branch: g }),
          ...this.dnd({ path, branch: g }),
        }, labels[g] ?? "Actions"),
        ...e.children.map((c, i) => ((c.group ?? 0) === g ? this.node(c, [...path, i]) : null)).filter((x): x is HTMLElement => !!x));
    }));
  }
}
