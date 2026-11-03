// Trigger Editor (host): war3map.wtg / war3map.wct as the World Editor's
// trigger module. It owns the tree (map header, variables, categories with
// triggers, comments and variables), the trigger's name, flags and comment,
// undo and saving. What a trigger contains is shown by trigger kinds that
// other extensions register through the "w3.triggers" service (GUI triggers,
// custom script, …). The files round-trip byte-exactly through lib/triggers.

import type { ExtensionContext, MenuItem, W3Api } from "../../extensions/api";
import { OBJECTS_SERVICE, TRIGGERS_SERVICE, type ObjectsService, type TriggerEditorHandle, type TriggerKind, type TriggersService } from "../../extensions/services";
import { StringTable } from "../../lib/formats/wts";
import { parseIni } from "../../lib/formats/text";
import { decodeImage } from "../../lib/image/index.ts";
import type { DisplayContext } from "../../lib/triggers/display";
import { parseTriggerData, type TriggerData } from "../../lib/triggers/triggerdata";
import {
  parseWct, parseWtg, textTriggers, writeWct, writeWtg,
  type CustomTextFile, type Eca, type Item, type Param, type TriggerFile, type TriggerItem, type Variable,
} from "../../lib/triggers/wtg";
import { h } from "../../workbench/dom";
import { dropMode, moveItem, pasteBlock, subtree, type DropMode } from "./tree";
import { deleteVariable, newVariable, variablesTable, type VariableHost } from "./variables";

const WTG = "map/war3map.wtg", WCT = "map/war3map.wct";
/** Item type → index in the per-type counts (and the high byte of its ids). */
const TYPE_INDEX: Record<number, number> = { 1: 0, 2: 1, 4: 2, 8: 3, 16: 4, 32: 5, 64: 6 };

class KindRegistry implements TriggersService {
  private kinds: TriggerKind[] = [];
  private listeners = new Set<() => void>();
  registerKind(kind: TriggerKind) {
    this.kinds.push(kind);
    this.listeners.forEach((l) => l());
    return { dispose: () => { this.kinds = this.kinds.filter((k) => k !== kind); this.listeners.forEach((l) => l()); } };
  }
  all() { return [...this.kinds].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)); }
  onChange(l: () => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
}

/** Copied tree items with their contents, custom text and variables (shared by all maps). */
let treeClipboard: { items: Item[]; texts: (string | null)[]; variables: Variable[] } | null = null;

/** The open trigger editor (there is one war3map.wtg per project). */
let openView: TriggerView | null = null;
/** "Variables" asked before the editor was open: the new view starts there. */
let startWithVariables = false;

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const kinds = new KindRegistry();
  const open = () => w3.commands.execute("w3.triggers.open").catch((e) => w3.window.showError(String(e)));
  ctx.subscriptions.push(
    w3.services.provide(TRIGGERS_SERVICE, kinds),
    w3.commands.register("w3.triggers.open", async () => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      if (!w3.workspace.files().some((f) => f.path.toLowerCase() === WTG)) throw new Error("This project has no war3map.wtg.");
      await w3.editors.open(WTG, "w3.triggerEditor");
      openView?.setMode("triggers");
    }),
    w3.commands.register("w3.triggers.variables", async () => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      startWithVariables = !openView;
      await w3.editors.open(WTG, "w3.triggerEditor");
      openView?.showVariables();
    }),
    // Activity bar entry: a way in and what the map has.
    w3.views.register("w3.triggers.overview", {
      render(el) {
        if (!w3.workspace.project()) { el.append(h("div.view-empty", {}, "Open or import a project to see its triggers.")); return; }
        if (!w3.workspace.files().some((f) => f.path.toLowerCase() === WTG)) { el.append(h("div.view-empty", {}, "This project has no war3map.wtg.")); return; }
        const facts = h("div.terrain-facts.muted", {}, "Reading triggers…");
        el.append(h("div.tree", {}, h("div.tree-row.obj-kind", { onclick: open, title: "F4" },
          h("span.tree-icon", {}, "›"), h("span.tree-label", {}, "Open Trigger Editor")),
          h("div.tree-row.obj-kind", { onclick: () => w3.commands.execute("w3.triggers.variables").catch((e) => w3.window.showError(String(e))) },
            h("span.tree-icon", {}, "›"), h("span.tree-label", {}, "Variables"))), facts);
        void (async () => {
          const file = parseWtg(await w3.workspace.readBytes(WTG), await triggerData(w3));
          const n = (t: number) => file.items.filter((i) => i.type === t).length;
          facts.replaceChildren(
            h("div", {}, `${n(8) + n(32)} triggers · ${n(4)} categories`),
            h("div", {}, `${file.variables.length} variables${n(16) ? ` · ${n(16)} comments` : ""}`));
        })().catch((e) => { facts.textContent = String((e as Error).message ?? e); });
      },
    }),
    w3.workspace.onDidChange(() => w3.views.refresh("w3.triggers.overview")),
    w3.editors.registerProvider("w3.triggerEditor", {
      async resolve(el, doc) {
        el.classList.add("trig-editor");
        el.append(h("div.muted.trig-loading", {}, "Reading triggers…"));
        const data = await triggerData(w3);
        let file: TriggerFile;
        try {
          file = parseWtg(await doc.readBytes(), data);
        } catch (e) {
          el.replaceChildren(h("div.editor-error", {}, `Can't read ${doc.path}: ${(e as Error).message} `,
            h("button.link-inline", { onclick: () => w3.editors.open(doc.path, "w3.hexViewer") }, "Open in Binary Viewer")));
          return {};
        }
        const game = doc.path.startsWith("game:");
        const wctBytes = game ? null : await w3.workspace.readBytes(WCT).catch(() => null);
        const custom = wctBytes ? parseWct(wctBytes, textTriggers(file).length) : null;
        const wtsText = game ? null : await w3.workspace.readText("map/war3map.wts").catch(() => null);
        const strings = wtsText !== null ? new StringTable(wtsText) : null;
        const names = await objectNames(w3, file);
        // Ids that show up later (new parameters) are looked up on demand; the view redraws once.
        const objects = await w3.services.get<ObjectsService>(OBJECTS_SERVICE).catch(() => null);
        const asked = new Set(names.keys());
        let redraw = 0;
        const objectName = (id: string) => {
          if (!asked.has(id) && objects) {
            asked.add(id);
            void objects.name(id).then((n) => {
              if (!n) return;
              names.set(id, n);
              clearTimeout(redraw);
              redraw = window.setTimeout(() => view.refresh(), 50);
            });
          }
          return names.get(id);
        };
        const display: DisplayContext = { data, string: (v) => strings?.resolve(v) ?? v, objectName };
        const lua = await w3.workspace.readText("map/war3map.w3i.json").then((t) => JSON.parse(t).scriptType === 1).catch(() => false);
        el.replaceChildren();
        const view = new TriggerView(w3, el, kinds, file, custom, data, display, !doc.readOnly, lua ? "lua" : "jass", (d) => doc.setDirty(d));
        if (!doc.readOnly) openView = view;
        if (startWithVariables) { startWithVariables = false; view.showVariables(); }
        return {
          save: async () => {
            await doc.writeBytes(writeWtg(view.file));
            await w3.workspace.writeBytes(WCT, writeWct(view.customFile()));
            view.markSaved();
          },
          dispose: () => { view.dispose(); if (openView === view) openView = null; },
        };
      },
    }),
  );
}

/** TriggerData with WESTRING_ names resolved, loaded once. */
let dataPromise: Promise<TriggerData> | null = null;
function triggerData(w3: W3Api): Promise<TriggerData> {
  dataPromise ??= (async () => {
    const strings = new Map<string, string>();
    for (const f of ["UI\\WorldEditStrings.txt", "UI\\WorldEditGameStrings.txt"]) {
      for (const sec of parseIni(await w3.game.readText(f).catch(() => "")).values()) for (const [k, v] of sec) strings.set(k.toUpperCase(), v);
    }
    const hints = await w3.game.readText("UI\\TriggerStrings.txt").catch(() => "");
    return parseTriggerData(await w3.game.readText("UI\\TriggerData.txt"), strings, hints);
  })();
  dataPromise.catch(() => { dataPromise = null; });
  return dataPromise;
}

/** Names of the object ids the triggers mention (raw codes and gg_unit_xxxx globals). */
async function objectNames(w3: W3Api, file: TriggerFile): Promise<Map<string, string>> {
  const ids = new Set<string>();
  const visitParam = (p: Param) => {
    if (p.type === 3 && p.value.length === 4) ids.add(p.value);
    const g = /^gg_(?:unit|item|dest)_(.{4})_\d+$/.exec(p.value);
    if (g) ids.add(g[1]);
    p.call?.params.forEach(visitParam);
    if (p.index) visitParam(p.index);
  };
  const visit = (e: Eca) => { e.params.forEach(visitParam); e.children.forEach(visit); };
  for (const it of file.items) if ("ecas" in it) it.ecas.forEach(visit);
  const out = new Map<string, string>();
  const objects = await w3.services.get<ObjectsService>(OBJECTS_SERVICE).catch(() => null);
  if (!objects) return out;
  await Promise.all([...ids].map(async (id) => {
    const n = await objects.name(id).catch(() => undefined);
    if (n) out.set(id, n);
  }));
  return out;
}

/** Game images (category icons) as data URLs. */
const iconCache = new Map<string, Promise<string | null>>();
function icon(w3: W3Api, path: string): Promise<string | null> {
  if (!path) return Promise.resolve(null);
  let p = iconCache.get(path.toLowerCase());
  if (!p) {
    p = (async () => {
      const file = /\.\w+$/.test(path) ? path : `${path}.blp`;
      const mip = decodeImage(await w3.game.read(file), file).mip(0);
      const canvas = document.createElement("canvas");
      canvas.width = mip.width;
      canvas.height = mip.height;
      canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(mip.rgba), mip.width, mip.height), 0, 0);
      return canvas.toDataURL();
    })().catch(() => null);
    iconCache.set(path.toLowerCase(), p);
  }
  return p;
}

type Selection = { kind: "header" } | { kind: "variables" } | { kind: "item"; type: number; id: number };
interface Snapshot { file: TriggerFile; texts: (string | null)[]; header: string | null }

class TriggerView {
  private tree = h("div.trig-tree-rows");
  private detail = h("div.trig-detail");
  private selected: Selection = { kind: "header" };
  private collapsed = new Set<number>();
  /** Custom text per trigger (war3map.wct is stored in trigger order). */
  private texts = new Map<TriggerItem, string | null>();
  private header: string | null;
  private undo: { label: string; before: Snapshot; after: Snapshot }[] = [];
  private at = 0;
  private savedAt = 0;
  private body: { dispose?(): void; keyDown?(e: KeyboardEvent): boolean } | void = undefined;
  private handle: TriggerEditorHandle;
  private vars: VariableHost;
  private unsubscribe: () => void;
  /** Where the last click was: keys go to the trigger's contents or to the tree. */
  private area: "tree" | "detail" = "tree";
  private keydown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    if (this.area === "detail" && this.body?.keyDown?.(e)) { e.preventDefault(); return; }
    if (e.key === "Delete" && this.handle.editable) { e.preventDefault(); this.deleteSelected(); return; }
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (this.area === "tree" && (k === "c" || k === "x" || k === "v")) {
      e.preventDefault();
      if (k === "v") this.pasteItems(); else this.copyItem(k === "x");
      return;
    }
    if (k === "z" && !e.shiftKey) { e.preventDefault(); this.step(-1); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); this.step(1); }
  };

  constructor(private w3: W3Api, private el: HTMLElement, private kinds: KindRegistry, public file: TriggerFile,
    private custom: CustomTextFile | null, data: TriggerData, display: DisplayContext, editable: boolean,
    language: "jass" | "lua", private setDirty: (dirty: boolean) => void) {
    const tt = textTriggers(file);
    tt.forEach((t, i) => this.texts.set(t, custom?.texts[i] ?? null));
    this.header = custom?.header ?? null;
    for (const it of file.items) if ((it.type === 2 || it.type === 4) && !it.expanded) this.collapsed.add(it.id);
    const view = this;
    this.handle = {
      get file() { return view.file; }, data, display, editable, language,
      customText: (t) => this.texts.get(t) ?? null,
      setCustomText: (t, text) => { this.texts.set(t, text); },
      edit: (label, change) => this.edit(label, change),
      icon: (path) => icon(w3, path),
    };
    this.vars = {
      handle: this.handle,
      allocId: (type) => this.allocId(type),
      category: () => this.variableCategory(),
      select: (v) => {
        this.selected = this.file.reforged ? { kind: "item", type: 64, id: v.id } : { kind: "variables" };
        if (this.mode === "triggers") this.mode = "variables";
      },
      scripts: () => [
        { get: () => this.header, set: (t) => { this.header = t; } },
        ...textTriggers(this.file).map((t) => ({ get: () => this.texts.get(t) ?? null, set: (text: string) => { this.texts.set(t, text); } })),
      ],
    };
    el.tabIndex = -1;
    el.addEventListener("keydown", this.keydown);
    el.append(h("div.trig-tree", { onmousedown: () => { this.area = "tree"; } }, this.modeBar, editable ? this.toolbar() : null, this.tree), this.detail);
    this.detail.addEventListener("mousedown", () => { this.area = "detail"; });
    this.unsubscribe = kinds.onChange(() => this.renderDetail());
    this.renderTree();
    this.renderDetail();
  }

  dispose() { this.body?.dispose?.(); this.unsubscribe(); this.el.removeEventListener("keydown", this.keydown); }

  customFile(): CustomTextFile {
    const texts = textTriggers(this.file).map((t) => this.texts.get(t) ?? null);
    return this.custom
      ? { ...this.custom, header: this.header, texts }
      : { reforged: this.file.reforged, version: 1, comment: "", header: this.header, texts };
  }

  markSaved() { this.savedAt = this.at; this.setDirty(false); }

  /** Selects the variables table. */
  showVariables() { this.mode = "variables"; this.selected = { kind: "variables" }; this.renderTree(); this.renderDetail(); }

  /** What the tree lists: triggers and comments, variables, or both (as stored, Reforged files
   *  keep variables in the categories). Categories show in every mode. */
  private mode: "triggers" | "variables" | "all" = "triggers";
  private modeBar = h("div.trig-modes");
  setMode(m: "triggers" | "variables" | "all") {
    if (m === this.mode) return;
    this.mode = m;
    const s = this.find(this.selected);
    // A selection the tree no longer shows goes back to the map header.
    if (s && ((m === "triggers" && s.type === 64) || (m === "variables" && "ecas" in s))) this.selected = { kind: "header" };
    this.renderTree();
    this.renderDetail();
  }

  /** Redraws the selected item (e.g. after names were looked up). */
  refresh() { this.renderDetail(); }

  // ---- undo -------------------------------------------------------------------------
  private snapshot(): Snapshot {
    return { file: structuredClone(this.file), texts: textTriggers(this.file).map((t) => this.texts.get(t) ?? null), header: this.header };
  }
  private restore(s: Snapshot) {
    this.file = structuredClone(s.file);
    this.texts = new Map(textTriggers(this.file).map((t, i) => [t, s.texts[i]]));
    this.header = s.header;
    this.renderTree();
    this.renderDetail();
  }
  private edit(label: string, change: () => void) {
    const before = this.snapshot();
    change();
    this.undo.splice(this.at, this.undo.length, { label, before, after: this.snapshot() });
    this.at = this.undo.length;
    this.setDirty(this.at !== this.savedAt);
    this.renderTree();
    this.renderDetail();
  }
  private step(dir: -1 | 1) {
    if (dir < 0 && this.at > 0) this.restore(this.undo[--this.at].before);
    else if (dir > 0 && this.at < this.undo.length) this.restore(this.undo[this.at++].after);
    else return;
    this.setDirty(this.at !== this.savedAt);
  }

  // ---- items ------------------------------------------------------------------------
  private find(sel: Selection): Item | undefined {
    return sel.kind === "item" ? this.file.items.find((i) => i.type === sel.type && i.id === sel.id) : undefined;
  }
  private root(): number {
    const r = this.file.items.find((i) => i.type === 1);
    return r ? r.id : -1;
  }
  /** A new id for an item of `type` (Reforged: type index in the high byte, counted per type). */
  private allocId(type: number): number {
    if (this.file.reforged) {
      // Past the stored count and every id in use (category ids exceed the count in some maps).
      const idx = TYPE_INDEX[type], c = this.file.counts[idx];
      const used = this.file.items.filter((i) => TYPE_INDEX[i.type] === idx).map((i) => (i.id & 0xffffff) + 1);
      const n = Math.max(c.count, ...used);
      c.count = n + 1;
      return (idx << 24) | n;
    }
    return 1 + Math.max(-1, ...this.file.items.filter((i) => (type === 4 ? i.type === 4 : i.type !== 4)).map((i) => i.id));
  }
  /** Where a new item goes: into the selected category, or after the selected item. */
  private insertionPoint(category: boolean): { parent: number; index: number } {
    const sel = this.find(this.selected);
    const items = this.file.items;
    if (sel && (sel.type === 4 || sel.type === 2) && !category) {
      const last = items.reduce((at, it, i) => (it.parent === sel.id ? i : at), items.indexOf(sel));
      return { parent: sel.id, index: last + 1 };
    }
    if (sel && sel.type !== 1 && !(category && sel.type !== 4)) return { parent: sel.parent, index: items.indexOf(sel) + 1 };
    if (!category) {
      const cat = items.find((i) => i.type === 4);
      if (cat) return { parent: cat.id, index: items.reduce((at, it, i) => (it.parent === cat.id ? i : at), items.indexOf(cat)) + 1 };
    }
    return { parent: this.root(), index: items.length };
  }
  private uniqueName(base: string): string {
    const taken = new Set(this.file.items.map((i) => i.name));
    for (let n = 1; ; n++) { const name = `${base} ${String(n).padStart(3, "0")}`; if (!taken.has(name)) return name; }
  }

  private newCategory() {
    this.edit("New category", () => {
      const { parent, index } = this.insertionPoint(true);
      const it: Item = { type: 4, id: this.allocId(4), name: this.uniqueName("Untitled Category"), isComment: 0, expanded: 1, parent };
      this.file.items.splice(index, 0, it);
      this.collapsed.delete(parent);
      this.selected = { kind: "item", type: 4, id: it.id };
    });
  }
  private newTrigger(kind: TriggerKind | null) {
    this.edit(kind ? `New ${kind.title}` : "New comment", () => {
      const { parent, index } = this.insertionPoint(false);
      const type = kind ? 8 : 16;
      const t: TriggerItem = {
        type, name: this.uniqueName(kind ? "Untitled Trigger" : "Untitled Comment"), description: "", isComment: kind ? 0 : 1, id: this.allocId(type),
        enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent, ecas: [],
      };
      this.file.items.splice(index, 0, t);
      this.collapsed.delete(parent);
      if (kind) { this.texts.set(t, null); kind.init?.(t, this.handle); }
      this.selected = { kind: "item", type, id: t.id };
    });
  }
  /** Where a new variable goes: the selected category (or the selected item's), else the first one. */
  private variableCategory(): { parent: number; index: number } {
    const items = this.file.items;
    const at = this.insertionPoint(false);
    const isCategory = (id: number) => items.some((i) => i.type === 4 && i.id === id);
    if (isCategory(at.parent)) return at;
    let cat = items.find((i) => i.type === 4);
    if (!cat) {
      cat = { type: 4, id: this.allocId(4), name: "Variables", isComment: 0, expanded: 1, parent: this.root() };
      items.push(cat);
    }
    return { parent: cat.id, index: items.reduce((last, it, i) => (it.parent === cat!.id ? i : last), items.indexOf(cat)) + 1 };
  }
  private deleteSelected() {
    const sel = this.find(this.selected);
    if (!sel || sel.type === 1) return;
    if (sel.type === 64) {
      const v = this.file.variables.find((x) => x.id === sel.id);
      if (v) void deleteVariable(this.w3, this.vars, v).then(() => { if (!this.file.variables.includes(v)) { this.selected = { kind: "variables" }; this.renderTree(); this.renderDetail(); } });
      return;
    }
    this.edit(`Delete ${sel.name}`, () => {
      const gone = new Set<Item>();
      const collect = (it: Item) => { gone.add(it); for (const c of this.file.items) if (c.parent === it.id && (it.type === 2 || it.type === 4) && c !== it) collect(c); };
      collect(sel);
      for (const it of gone) {
        if (this.file.reforged) this.file.counts[TYPE_INDEX[it.type]]?.deleted.push(it.id);
        if (it.type === 64) this.file.variables = this.file.variables.filter((v) => v.id !== it.id);
      }
      this.file.items = this.file.items.filter((i) => !gone.has(i));
      this.selected = { kind: "header" };
    });
  }
  private move(dir: -1 | 1) {
    const sel = this.find(this.selected);
    if (!sel || sel.type === 1) return;
    const items = this.file.items;
    const siblings = items.filter((i) => i.parent === sel.parent && i.type !== 1);
    const other = siblings[siblings.indexOf(sel) + dir];
    if (!other) return;
    this.edit(`Move ${sel.name}`, () => {
      const a = items.indexOf(sel), b = items.indexOf(other);
      [items[a], items[b]] = [items[b], items[a]];
    });
  }

  // ---- copy and paste ---------------------------------------------------------------
  private copyItem(cut: boolean) {
    const sel = this.find(this.selected);
    if (!sel || sel.type === 1) return;
    const block = subtree(this.file, sel);
    treeClipboard = {
      items: structuredClone(block),
      texts: block.map((it) => ("ecas" in it ? this.texts.get(it) ?? null : null)),
      variables: structuredClone(this.file.variables.filter((v) => block.some((i) => i.type === 64 && i.id === v.id))),
    };
    if (cut && this.handle.editable) this.deleteSelected();
  }
  /** Pastes copied items after the selection (or into the selected category). */
  private pasteItems() {
    const clip = treeClipboard;
    if (!clip || !this.handle.editable) return;
    // Variables live in Reforged files' tree only.
    if (!this.file.reforged && clip.items.some((i) => i.type === 64)) { void this.w3.window.showWarning("This trigger file keeps variables outside the tree; use the Variables table."); return; }
    this.edit("Paste", () => {
      const root = clip.items[0];
      const at = root.type === 64 ? this.variableCategory() : this.insertionPoint(root.type === 4 || root.type === 2);
      const pasted = pasteBlock(this.file, clip, at, (type) => this.allocId(type));
      pasted.forEach((it, k) => { if ("ecas" in it) this.texts.set(it, clip.texts[k]); });
      this.collapsed.delete(at.parent);
      this.selected = { kind: "item", type: pasted[0].type, id: pasted[0].id };
    });
  }

  // ---- drag and drop ----------------------------------------------------------------
  private drop(drag: Item, target: Item, mode: DropMode) {
    this.edit(`Move ${drag.name}`, () => {
      moveItem(this.file, drag, target, mode);
      if (mode === "into") this.collapsed.delete(target.id);
    });
  }
  private dragging: Item | null = null;
  private dragHandlers(sel: Selection): Record<string, unknown> {
    const it = this.find(sel);
    if (!this.handle.editable || !it || it.type === 1) return {};
    const clear = () => this.tree.querySelectorAll(".drop-into, .drop-before").forEach((e) => e.classList.remove("drop-into", "drop-before"));
    const mode = (e: DragEvent) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      return this.dragging ? dropMode(this.file, this.dragging, it, e.clientY < r.top + r.height / 3) : null;
    };
    return {
      draggable: true,
      ondragstart: (e: DragEvent) => { this.dragging = it; e.dataTransfer?.setData("text/plain", it.name); },
      ondragend: () => { this.dragging = null; clear(); },
      ondragover: (e: DragEvent) => {
        const m = mode(e);
        if (!m) return;
        e.preventDefault();
        clear();
        (e.currentTarget as HTMLElement).classList.add(m === "into" ? "drop-into" : "drop-before");
      },
      ondragleave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("drop-into", "drop-before"),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        const m = mode(e), d = this.dragging;
        clear();
        this.dragging = null;
        if (m && d) { this.selected = { kind: "item", type: d.type, id: d.id }; this.drop(d, it, m); }
      },
    };
  }

  private toolbar(): HTMLElement {
    const newMenu = h("select.trig-new", { title: "Add to the selected category", onchange: () => {
      const v = newMenu.value;
      newMenu.value = "";
      if (v === "category") this.newCategory();
      else if (v === "comment") this.newTrigger(null);
      else if (v === "variable") newVariable(this.vars);
      else { const k = this.kinds.all().find((x) => x.id === v); if (k) this.newTrigger(k); }
    } });
    const fill = () => newMenu.replaceChildren(h("option", { value: "" }, "New…"), h("option", { value: "category" }, "Category"),
      ...this.kinds.all().filter((k) => k.init).map((k) => h("option", { value: k.id }, k.title)), h("option", { value: "comment" }, "Comment"),
      h("option", { value: "variable" }, "Variable"));
    fill();
    this.kinds.onChange(fill);
    return h("div.trig-toolbar", {}, newMenu,
      h("button", { title: "Move up", onclick: () => this.move(-1) }, "↑"),
      h("button", { title: "Move down", onclick: () => this.move(1) }, "↓"),
      h("button", { title: "Delete (Del)", onclick: () => this.deleteSelected() }, "Delete"));
  }

  // ---- tree -------------------------------------------------------------------------
  private row(label: string, cls: string, depth: number, sel: Selection, opts: { toggle?: number; title?: string; off?: boolean } = {}) {
    const s = this.selected;
    const active = s.kind === sel.kind && (sel.kind !== "item" || (s.kind === "item" && s.type === sel.type && s.id === sel.id));
    const caret = opts.toggle !== undefined
      ? h("span.trig-caret", { onclick: (e: Event) => { e.stopPropagation(); this.toggle(opts.toggle!); } }, this.collapsed.has(opts.toggle) ? "▸" : "▾")
      : h("span.trig-caret");
    return h(`div.trig-row.${cls}${active ? ".active" : ""}${opts.off ? ".off" : ""}`, {
      style: { paddingLeft: `${6 + depth * 14}px` }, title: opts.title ?? "",
      onclick: () => { this.selected = sel; this.renderTree(); this.renderDetail(); this.el.focus(); },
      ondblclick: () => { if (opts.toggle !== undefined) this.toggle(opts.toggle); },
      oncontextmenu: (e: MouseEvent) => this.menu(e, sel, opts.toggle),
      ...this.dragHandlers(sel),
    }, caret, h("span.trig-label", {}, label));
  }
  /** Right-click in the tree: selects the row, then offers new items, moving and deleting. */
  private menu(e: MouseEvent, sel: Selection, category?: number) {
    e.preventDefault();
    this.selected = sel;
    this.renderTree();
    this.renderDetail();
    this.el.focus();
    const items: MenuItem[] = [];
    if (category !== undefined) items.push({ label: this.collapsed.has(category) ? "Expand" : "Collapse", run: () => this.toggle(category) }, "-");
    if (this.handle.editable) {
      items.push({ label: "New Category", run: () => this.newCategory() },
        ...this.kinds.all().filter((k) => k.init).map((k) => ({ label: `New ${k.title}`, run: () => this.newTrigger(k) })),
        { label: "New Comment", run: () => this.newTrigger(null) }, { label: "New Variable", run: () => newVariable(this.vars) });
      if (sel.kind === "item") {
        items.push("-", { label: "Move Up", run: () => this.move(-1) }, { label: "Move Down", run: () => this.move(1) },
          "-", { label: "Cut", hint: "Ctrl+X", run: () => this.copyItem(true) }, { label: "Copy", hint: "Ctrl+C", run: () => this.copyItem(false) });
      }
      if (treeClipboard) items.push("-", { label: `Paste ${treeClipboard.items[0].name}`, hint: "Ctrl+V", run: () => this.pasteItems() });
      if (sel.kind === "item") items.push("-", { label: "Delete", hint: "Del", run: () => this.deleteSelected() });
    }
    if (items.length) this.w3.window.showContextMenu({ x: e.clientX, y: e.clientY }, items);
  }

  private toggle(id: number) {
    if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id);
    this.renderTree();
  }
  private renderTree() {
    const modes = [["triggers", "Triggers"], ["variables", "Variables"], ["all", "All"]] as const;
    this.modeBar.replaceChildren(...modes.map(([m, label]) =>
      h(`button.trig-mode${this.mode === m ? ".active" : ""}`, { onclick: () => this.setMode(m) }, label)));
    const rows: HTMLElement[] = [];
    const root = this.file.items.find((i) => i.type === 1);
    rows.push(this.row(root?.name || this.w3.workspace.project()?.name || "Map", "trig-map", 0, { kind: "header" }, { title: "Map header: custom script code" }));
    rows.push(this.row(`Variables (${this.file.variables.length})`, "trig-vars", 0, { kind: "variables" }));
    const children = new Map<number, Item[]>();
    for (const it of this.file.items) if (it.type !== 1) children.set(it.parent, [...(children.get(it.parent) ?? []), it]);
    const walk = (parent: number, depth: number) => {
      for (const it of children.get(parent) ?? []) {
        const sel: Selection = { kind: "item", type: it.type, id: it.id };
        if (it.type === 2 || it.type === 4) {
          rows.push(this.row(it.name, it.type === 4 ? "trig-cat" : "trig-lib", depth, sel, { toggle: it.id }));
          if (!this.collapsed.has(it.id)) walk(it.id, depth + 1);
        } else if (it.type === 64) { if (this.mode !== "triggers") rows.push(this.row(it.name, "trig-var", depth, sel)); }
        else if ("ecas" in it && this.mode !== "variables") {
          rows.push(this.row(it.name, it.type === 16 ? "trig-comment" : it.isCustom ? "trig-custom" : "trig-gui", depth, sel, { off: !it.enabled }));
        }
      }
    };
    walk(root ? root.id : -1, 1);
    this.tree.replaceChildren(...rows);
  }

  // ---- detail -----------------------------------------------------------------------
  private renderDetail() {
    this.body?.dispose?.();
    this.body = undefined;
    const s = this.selected;
    const editable = this.handle.editable;
    if (s.kind === "header") {
      const area = h("textarea.trig-code-edit", {
        spellcheck: false, readOnly: !editable, rows: 16, value: this.header ?? "",
        placeholder: `Map-specific ${this.handle.language === "lua" ? "Lua" : "JASS"} code, placed in the map script before the triggers.`,
        onchange: () => this.edit("Edit map script", () => { this.header = area.value || (this.header === null ? null : ""); }),
      });
      this.detail.replaceChildren(h("h2", {}, "Map script header"),
        ...(this.custom?.comment ? [h("p.trig-desc", {}, this.custom.comment)] : []), area);
      return;
    }
    if (s.kind === "variables") { this.detail.replaceChildren(h("h2", {}, "Variables"), variablesTable(this.w3, this.vars, this.file.variables)); return; }
    const it = this.find(s);
    if (!it) { this.detail.replaceChildren(h("p.muted", {}, "Nothing selected.")); return; }
    const name = h("input.trig-name", { type: "text", value: it.name, readOnly: !editable, onchange: () => {
      const v = name.value.trim();
      if (v && v !== it.name) this.edit("Rename", () => { it.name = v; });
      else name.value = it.name;
    } });
    if (it.type === 64) {
      const v = this.file.variables.find((x) => x.id === it.id);
      this.detail.replaceChildren(h("h2", {}, "Variable"), v ? variablesTable(this.w3, this.vars, [v]) : h("p.muted", {}, "Variable not found."));
      return;
    }
    if (!("ecas" in it)) {
      const n = this.file.items.filter((i) => i.parent === it.id).length;
      this.detail.replaceChildren(h("div.trig-head", {}, name), h("p.muted", {}, `Category · ${n} item${n === 1 ? "" : "s"}`));
      return;
    }
    const flag = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const box = h("input", { type: "checkbox", checked: get(), disabled: !editable, onchange: () => this.edit(label, () => set(box.checked)) });
      return h("label.trig-flag", {}, box, label);
    };
    const desc = h("textarea.trig-desc-edit", {
      rows: 2, value: it.description, readOnly: !editable, placeholder: it.type === 16 ? "Comment" : "Trigger comment",
      onchange: () => this.edit("Edit comment", () => { it.description = desc.value; }),
    });
    const head = h("div.trig-head", {}, name,
      ...(it.type === 16 ? [] : [
        flag("Enabled", () => it.enabled, (v) => { it.enabled = v; }),
        flag("Initially on", () => !it.initiallyOff, (v) => { it.initiallyOff = !v; }),
      ]));
    if (it.type === 16) { this.detail.replaceChildren(head, desc); return; }
    const kind = this.kinds.all().find((k) => k.matches(it, this.handle));
    const body = h("div.trig-body");
    this.detail.replaceChildren(head, desc, body);
    if (!kind) { body.append(h("p.muted", {}, "No installed extension shows this kind of trigger.")); return; }
    this.body = kind.render(body, it, this.handle);
  }
}
