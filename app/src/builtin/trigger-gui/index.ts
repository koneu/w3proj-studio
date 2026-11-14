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
import { createVariables, missingVariableNames, variablesOf } from "../../lib/triggers/pastevars";
import type { Eca, Param, TriggerItem, Variable } from "../../lib/triggers/wtg";
import { copyText, h } from "../../workbench/dom";
import { copyAs } from "../../lib/triggers/astext";
import { editParam, pickFunction } from "./dialogs";
import { chosenFrom, clickSelection, holdOf, locateIn, setOf, type Chosen, type Held } from "./selection";
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

/** The lines selected besides the one in `selection` (Shift/Ctrl-click, Select All), per trigger (see selection.ts). Any
 *  edit ends it: paths move. */
const multi = new Map<number, Held>();
const setMulti = (t: TriggerItem, paths: number[][]) => { const h = holdOf(t, paths); if (h) multi.set(t.id, h); else multi.delete(t.id); };
const primaryOf = (t: TriggerItem): number[] | null => {
  const s = selection.get(t.id);
  return s && "path" in s && s.branch === undefined ? s.path : null;
};
const chosenIn = (t: TriggerItem): Chosen[] => chosenFrom(t, primaryOf(t), multi.get(t.id));

/** Copied events/conditions/actions with the variables they use (type, array, initial value), shared by all triggers,
 *  also across maps: pasting into a map that lacks a variable can create it. */
let clipboard: { ecas: Eca[]; variables: Variable[] } = { ecas: [], variables: [] };

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
        const view = new GuiView(w3, el, t, ed, editors);
        view.render();
        return { keyDown: (e) => view.keyDown(e), run: (action) => view.run(action) };
      },
      reveal: (t, at) => {
        selection.set(t.id, { path: at.path });
        multi.delete(t.id);
        flagged.set(t.id, at);
      },
      selectedLines: (t) => chosenIn(t).map((c) => c.eca),
    }));
  });
}

class GuiView {
  constructor(private w3: W3Api, private el: HTMLElement, private t: TriggerItem, private ed: TriggerEditorHandle, private editors: ParamEditors) {}

  /** Right-click: selects what was clicked, then offers what fits there. */
  private menu(e: MouseEvent, sel: Sel) {
    e.preventDefault();
    e.stopPropagation();
    // A line of the selection keeps it: the menu then acts on all of them.
    if (!("path" in sel && sel.branch === undefined && this.chosen().length > 1 && this.chosen().some((c) => c.path.join() === sel.path.join()))) this.select(sel);
    const items: MenuItem[] = [];
    const onEca = "path" in sel && sel.branch === undefined;
    const many = onEca ? this.chosen().length : 1;
    if (!this.ed.editable) {
      // Read-only: copying and following references only.
      if (onEca) items.push({ label: many > 1 ? `Copy ${many} lines` : "Copy", hint: "Ctrl+C", run: () => this.copy(false) });
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
        { label: this.chosen().some((c) => c.eca.enabled) ? "Disable" : "Enable", run: () => this.toggle() },
        ...(many > 1 ? [] : [{ label: "Move Up", run: () => this.move(-1) }, { label: "Move Down", run: () => this.move(1) }]), "-",
        { label: many > 1 ? `Cut ${many} lines` : "Cut", hint: "Ctrl+X", run: () => this.copy(true) },
        { label: many > 1 ? `Copy ${many} lines` : "Copy", hint: "Ctrl+C", run: () => this.copy(false) });
    }
    if (this.ed.editable) {
      if (clipboard.ecas.length) items.push(...(items.length ? ["-" as const] : []), { label: `Paste ${clipboard.ecas.length > 1 ? `${clipboard.ecas.length} lines` : KIND_NAMES[clipboard.ecas[0].kind]}`, hint: "Ctrl+V", run: () => this.paste() });
      if (onEca) items.push("-", { label: many > 1 ? `Delete ${many} lines` : "Delete", hint: "Del", run: () => this.remove() });
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
      if (k === "v" && this.ed.editable && clipboard.ecas.length) { this.paste(); return true; }
      return false;
    }
    if (keyOf(e) !== "Delete" || !this.ed.editable || !onEca) return false;
    this.remove();
    return true;
  }

  private get sel(): Sel | undefined { return selection.get(this.t.id); }
  private select(s: Sel) { selection.set(this.t.id, s); multi.delete(this.t.id); flagged.delete(this.t.id); this.render(); }
  /** The selected lines (see chosenIn). */
  private chosen(): Chosen[] { return chosenIn(this.t); }
  /** A click on a line: Ctrl toggles it in the selection, Shift selects the lines between the selected one and it (of
   *  one list and kind), neither selects it alone. A line that doesn't fit the selection (another list or kind) starts a
   *  new one. */
  private click(e: MouseEvent, path: number[]) {
    const now = this.chosen();
    const anchor = now.length ? (this.sel as { path: number[] }).path : null;
    const got = clickSelection(this.t, now.map((c) => c.path), anchor, path, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    if (!got) { this.select({ path }); return; }
    selection.set(this.t.id, { path: got.lead });
    setMulti(this.t, got.paths);
    flagged.delete(this.t.id);
    this.render();
  }
  /** Select All (the lines of the selected line's list and kind, or of the selected section or branch), Clear, and
   *  Toggle Function Enabled, as the editor's commands. False when there's nothing to act on. */
  run(action: "selectAll" | "clear" | "toggleFunction"): boolean {
    if (action === "toggleFunction") { if (!this.ed.editable || !this.chosen().length) return false; this.toggle(); return true; }
    if (action === "clear") {
      if (!this.sel) return false;
      selection.delete(this.t.id);
      multi.delete(this.t.id);
      this.render();
      return true;
    }
    const s = this.sel;
    let paths: number[][] = [];
    if (s && "section" in s) paths = this.t.ecas.flatMap((e, i) => (e.kind === s.section ? [[i]] : []));
    else if (s && s.branch !== undefined) {
      const at = this.locate(s.path);
      paths = at ? at.eca.children.flatMap((c, i) => ((c.group ?? 0) === s.branch ? [[...s.path, i]] : [])) : [];
    } else if (s) paths = setOf(this.t, s.path);
    if (!paths.length) return false;
    selection.set(this.t.id, { path: paths[0] });
    setMulti(this.t, paths);
    flagged.delete(this.t.id);
    this.render();
    return true;
  }
  /** An edit of the trigger: a problem's mark goes (its place may have moved), and so does a multi-selection. */
  private edit(label: string, change: () => void) { flagged.delete(this.t.id); multi.delete(this.t.id); this.ed.edit(label, change); }

  /** The list holding the ECA at `path`, and its index there. */
  private locate(path: number[]): { list: Eca[]; index: number; eca: Eca } | null {
    return locateIn(this.t, path);
  }

  /** Copy As Text / Copy As Script of the selected line onto the system clipboard. */
  private async copyAs(as: "text" | "script") {
    const lines = this.chosen();
    if (!lines.length) return;
    const text = copyAs(as, this.ed, this.t, lines.map((c) => c.eca));
    if (text === null) return;
    const how = as === "text" ? "as text" : "as script";
    const what = lines.length > 1 ? `${lines.length} lines` : "a line";
    if (await copyText(text)) void this.w3.window.showInfo(`Copied ${what} of ${this.t.name} ${how}.`);
    else void this.w3.window.showWarning(`The clipboard refused the copy of ${what} of ${this.t.name} ${how}.`);
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
    const many = this.chosen().length > 1;
    return h("div.trig-gui-toolbar", {},
      ...SECTIONS.map(([kind]) => h("button", { title: `New ${KIND_NAMES[kind]} (after the selection)`, onclick: () => void this.add(kind) }, `+ ${KIND_NAMES[kind]}`)),
      h("button", { disabled: !at, title: "Delete (Del)", onclick: () => this.remove() }, "Delete"),
      h("button", { disabled: !at || many, title: "Move up", onclick: () => this.move(-1) }, "↑"),
      h("button", { disabled: !at || many, title: "Move down", onclick: () => this.move(1) }, "↓"),
      h("button", { disabled: !at, title: "Enable or disable", onclick: () => this.toggle() }, at && !this.chosen().some((c) => c.eca.enabled) ? "Enable" : "Disable"));
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
    const lines = this.chosen();
    if (!lines.length) return;
    const ecas = lines.map((c) => structuredClone(c.eca));
    clipboard = { ecas, variables: variablesOf(this.ed.file, ecas) };
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
    const clip = clipboard;
    if (!clip.ecas.length) return;
    const kind = clip.ecas[0].kind;
    const to = this.target(kind);
    if (typeof to === "string") { void this.w3.window.showWarning(`Can't paste a ${KIND_NAMES[kind].toLowerCase()} here. ${to}`); return; }
    const missing = missingVariableNames(this.ed.file, clip.ecas);
    const auto = missing.length > 0 && this.w3.settings.get<boolean>("triggers.autoCreateVariables") !== false;
    let created: string[] = [], refused = "";
    const label = clip.ecas.length > 1 ? `Paste ${clip.ecas.length} lines` : `Paste ${KIND_NAMES[kind].toLowerCase()}`;
    this.edit(label, () => {
      // The variables first, in the same step: one undo takes lines and variables back. A map that can't hold them
      // (no category) gets the lines alone.
      if (auto) {
        try { created = createVariables(this.ed.file, clip.variables, missing); } catch (e) { refused = (e as Error).message; }
      }
      const ecas = clip.ecas.map((e) => {
        const c = structuredClone(e);
        if (to.group === undefined) delete c.group; else c.group = to.group;
        return c;
      });
      to.list.splice(to.index, 0, ...ecas);
      selection.set(this.t.id, { path: to.path });
      setMulti(this.t, ecas.map((_, i) => [...to.path.slice(0, -1), to.path[to.path.length - 1] + i]));
    });
    if (created.length) void this.w3.window.showInfo(`Created the variable${created.length > 1 ? "s" : ""} ${created.join(", ")} for the pasted lines.`);
    const left = missing.filter((n) => !created.some((c) => c.toLowerCase() === n.toLowerCase()));
    if (left.length) void this.w3.window.showWarning(`The pasted lines use variables this map doesn't have: ${left.join(", ")}.${refused ? ` ${refused}` : auto ? " The copy didn't carry them." : " Turn on the setting triggers.autoCreateVariables to create them with the lines."}`);
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
    const lines = this.chosen();
    if (!lines.length) return;
    this.edit(lines.length > 1 ? `Delete ${lines.length} lines` : `Delete ${lines[0].eca.name}`, () => {
      // From the last: the indices before it stay.
      for (const c of [...lines].reverse()) c.list.splice(c.index, 1);
      selection.delete(this.t.id);
    });
  }
  private move(dir: -1 | 1) {
    const s = this.sel;
    const at = s && "path" in s ? this.locate(s.path) : null;
    if (!at || !s || !("path" in s) || this.chosen().length > 1) return;
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
    const lines = this.chosen();
    if (!lines.length) return;
    // Several: all off if any is on, else all on.
    const to = lines.length > 1 ? !lines.some((c) => c.eca.enabled) : !lines[0].eca.enabled;
    this.edit(`${to ? "Enable" : "Disable"}${lines.length > 1 ? ` ${lines.length} lines` : ""}`, () => { for (const c of lines) c.eca.enabled = to; });
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
    const active = !!s && "path" in s && s.branch === undefined && (s.path.join() === path.join() || this.chosen().some((c) => c.path.join() === path.join()));
    // The line of a found problem: marked itself when the problem isn't one parameter's.
    const flag = flagged.get(this.t.id), onFlag = !!flag && flag.path.join() === path.join();
    const line = h(`div.trig-eca.trig-pick${e.enabled ? "" : ".off"}${active ? ".active" : ""}${onFlag && !flag?.param ? ".trig-flagged" : ""}`, {
      title: e.name, onclick: (ev: MouseEvent) => this.click(ev, path), oncontextmenu: (ev: MouseEvent) => this.menu(ev, { path }),
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
