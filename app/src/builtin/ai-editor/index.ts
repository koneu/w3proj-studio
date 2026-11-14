// AI Editor: AI definitions (.wai) like the World Editor's AI Editor, in its
// tabs: General (name, race, options, workers, conditions), Heroes (heroes,
// training order, skills), Building (build, harvest and target priorities),
// Attacking (groups, waves) and Test Configuration. Conditions are function
// trees edited with the trigger editor's parameter dialog (service
// "w3.triggers.gui"), over the functions AIEditorData.txt allows. Objects are
// chosen in the object browser ("w3.objects").

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { OBJECTS_SERVICE, TRIGGER_GUI_SERVICE, type ObjectsService, type TriggerGuiService } from "../../extensions/services";
import {
  AI_OPTIONS, aiArgCount, aiTriggerData, clearObjectData, editorDate, embeddedObjectBytes, embeddedObjectData, embedObjectData, FIRST_HERO_ONLY, newWai, NO_ID, parseWai, W3O_KINDS, w3oOfKind, writeWai,
  type AiCall, type AiCondition, type AiFile, type BuildPriority, type HarvestPriority, type TargetPriority,
} from "../../lib/ai/wai";
import { generateAiScript } from "../../lib/ai/script";
import { addKeyContext, UNDO_CONTEXT, undoStepOf } from "../../lib/keybindings";
import { StackSave } from "../../lib/undo";
import { checkpointIfOn } from "../../lib/checkpoint";
import { projectWithFiles } from "../../lib/formats/mapdoc";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { callText, paramText, type DisplayContext } from "../../lib/triggers/display";
import { CONDITION, parseTriggerData, type TriggerData } from "../../lib/triggers/triggerdata";
import type { Param } from "../../lib/triggers/wtg";
import { h } from "../../workbench/dom";
import {
  ALL, BUILD_EXPANSION, BUILD_UNIT, BUILD_UPGRADE, buildTotals, conditionUses, CREEPS, HERO_ORDERS, quantityText, RACES, removeCondition,
  removeGroup, SPECIAL_BUILDS, TARGETS, townChoices, townText, workersText,
} from "./labels";

const WAI_FILTER = [{ name: "AI files", extensions: ["wai"] }];
const CODE_KINDS: Record<string, string> = { unitcode: "w3u", itemcode: "w3t", abilcode: "w3a", heroskillcode: "w3a", techcode: "w3q", upgradecode: "w3q" };
const NO_COND: AiCondition = { name: "", call: null };

/** The AI functions with the game's strings, loaded once. */
let dataPromise: Promise<TriggerData> | null = null;
function aiData(w3: W3Api): Promise<TriggerData> {
  dataPromise ??= (async () => {
    const strings = new Map<string, string>();
    for (const f of ["UI\\WorldEditStrings.txt", "UI\\WorldEditGameStrings.txt"]) {
      for (const sec of parseIni(await w3.game.readText(f).catch(() => "")).values()) for (const [k, v] of sec) strings.set(k.toUpperCase(), v);
    }
    const hints = await w3.game.readText("UI\\TriggerStrings.txt").catch(() => "");
    const parse = (text: string) => parseTriggerData(text, strings, hints);
    return aiTriggerData(parse(await w3.game.readText("UI\\TriggerData.txt")), await w3.game.readText("UI\\AIEditorData.txt"), parse);
  })();
  dataPromise.catch(() => { dataPromise = null; });
  return dataPromise;
}

/** Hero → its skills (Units\UnitAbilities.slk heroAbilList), loaded once. */
let heroSkills: Promise<Map<string, string[]>> | null = null;
function loadHeroSkills(w3: W3Api) {
  heroSkills ??= w3.game.readText("Units\\UnitAbilities.slk")
    .then((t) => new Map(parseSlk(t).filter((r) => r.heroAbilList).map((r) => [r.unitAbilID, r.heroAbilList.split(",").filter(Boolean)])))
    .catch(() => new Map());
  return heroSkills;
}

/** Absolute paths with forward slashes (the tab shows the file name). */
const slashes = (p: string) => p.replace(/\\/g, "/");

export function activate(w3: W3Api, ctx: ExtensionContext) {
  ctx.subscriptions.push(
    w3.commands.register("w3.ai.open", async () => {
      const path = await w3.window.pickFile({ title: "Open an AI file", filters: WAI_FILTER });
      if (path) await w3.editors.open(slashes(path), "w3.aiEditor");
    }),
    w3.commands.register("w3.ai.new", async () => {
      const path = await w3.window.pickSaveFile({ title: "New AI file", defaultPath: "Untitled.wai", filters: WAI_FILTER });
      if (!path) return;
      await w3.workspace.writeBytes(path, writeWai(newWai()));
      await w3.editors.open(slashes(path), "w3.aiEditor");
    }),
    w3.editors.registerProvider("w3.aiEditor", {
      async resolve(el, doc) {
        const [data, objects, gui] = await Promise.all([
          aiData(w3), w3.services.get<ObjectsService>(OBJECTS_SERVICE), w3.services.get<TriggerGuiService>(TRIGGER_GUI_SERVICE),
        ]);
        const bytes = await doc.readBytes();
        const ai = parseWai(bytes, aiArgCount(data));
        const view = new AiView(w3, el, ai, data, objects, gui, !doc.readOnly, (d) => doc.setDirty(d), doc.absolutePath ?? doc.path);
        current = view;
        return {
          undo: () => view.undo(),
          redo: () => view.redo(),
          save: async () => { const taken = view.take(); await doc.writeBytes(writeWai(view.ai)); view.saved(taken); },
          focus: () => el.focus(),
          dispose: () => { if (current === view) current = null; },
        };
      },
    }),
    // Side bar: new/open, the project's AI files and the game's own (read-only).
    w3.views.register("w3.ai.files", {
      render(el) {
        const run = (f: () => Promise<unknown>) => () => { f().catch((e) => w3.window.showError(String(e instanceof Error ? e.message : e))); };
        const row = (label: string, title: string, open: () => Promise<unknown>) =>
          h("div.tree-row.obj-kind", { title, onclick: run(open) }, h("span.tree-icon", {}, "›"), h("span.tree-label", {}, label));
        el.append(h("div.camp-side-actions", {},
          h("button", { onclick: run(() => w3.commands.execute("w3.ai.new")) }, "New AI…"), " ",
          h("button", { onclick: run(() => w3.commands.execute("w3.ai.open")) }, "Open AI…"), " ",
          h("button", { title: "Export the open AI's script (.ai)", onclick: run(() => w3.commands.execute("w3.ai.exportScript")) }, "Export…"), " ",
          h("button", { title: "Put the open AI's script into the open map as Scripts\\<name>.ai", disabled: !w3.workspace.project(), onclick: run(() => w3.commands.execute("w3.ai.addToMap")) }, "Add To Map")));
        const own = w3.workspace.project() ? w3.workspace.files().filter((f) => /\.wai$/i.test(f.path)) : [];
        el.append(h("div.camp-side-head", {}, "In this project"),
          own.length
            ? h("div.tree", {}, ...own.map((f) => row(f.path.split("/").pop()!, f.path, () => w3.editors.open(f.path, "w3.aiEditor"))))
            : h("div.view-empty", {}, w3.workspace.project() ? "No AI files (.wai) in this project." : "No project open."));
        const game = h("div.tree", {}, h("div.view-empty", {}, "Loading…"));
        el.append(h("div.camp-side-head", {}, "Game AIs (read-only)"), game);
        void w3.game.list().then((list) => {
          // One entry per file (the base game's copy), by name.
          const byName = new Map<string, string>();
          for (const full of list) {
            if (!/\.wai$/i.test(full)) continue;
            const name = full.split(/[:/\\]/).pop()!;
            if (!byName.has(name.toLowerCase()) || /^War3\.w3mod:[^_]/i.test(full)) byName.set(name.toLowerCase(), full);
          }
          const files = [...byName.values()].sort((a, b) => a.localeCompare(b));
          game.replaceChildren(...(files.length
            ? files.map((full) => row(full.split(/[:/\\]/).pop()!, full, () => w3.editors.open(`game:${full}`, "w3.aiEditor")))
            : [h("div.view-empty", {}, "None found.")]));
        }, (e) => game.replaceChildren(h("div.view-empty", {}, `Game data unavailable (${e})`)));
      },
    }),
    w3.workspace.onDidChange(() => w3.views.refresh("w3.ai.files")),
    w3.commands.register("w3.ai.exportScript", async () => {
      if (!current) throw new Error("Open an AI file in the AI Editor first.");
      await current.exportScript();
    }),
    w3.commands.register("w3.ai.addToMap", async () => {
      if (!current) throw new Error("Open an AI file in the AI Editor first.");
      return current.addToMap();
    }),
    w3.commands.register("w3.ai.importCustomData", async () => {
      if (!current) throw new Error("Open an AI file in the AI Editor first.");
      return current.importCustomData();
    }),
    w3.commands.register("w3.ai.exportCustomData", async () => {
      if (!current) throw new Error("Open an AI file in the AI Editor first.");
      return current.exportCustomData();
    }),
  );
}

/** Object data files the AI Editor takes in: a .w3o, or one kind's file. */
const OBJECT_FILTER = [{ name: "Object data (.w3o, .w3u, .w3t, .w3b, .w3d, .w3a, .w3h, .w3q)", extensions: ["w3o", ...W3O_KINDS] }];
/** Flags of an import entry current editors write (the path as listed). */
const IMPORT_FLAGS = 21;
interface ImportList { format?: string; version: number; files: { flags: number; path: string }[] }

/** The map's import list: the project's JSON, the raw file through its codec, or none (null). One that is
 *  there and can't be read throws: it is never taken for an empty list. */
async function readImportList(w3: W3Api): Promise<{ doc: ImportList; raw: boolean } | null> {
  const has = (p: string) => w3.workspace.files().some((f) => f.path.toLowerCase() === p);
  const root = w3.workspace.project()!.root;
  try {
    if (has("map/war3map.imp.json")) return { doc: JSON.parse(await w3.workspace.readText("map/war3map.imp.json")), raw: false };
    if (has("map/war3map.imp")) return { doc: JSON.parse(await w3.backend.invoke<string>("codec_decode", { root, path: "map/war3map.imp" })), raw: true };
  } catch (e) {
    throw new Error(`The map's import list can't be read (${e instanceof Error ? e.message : String(e)}), so nothing was added.`);
  }
  return null;
}

/** The AI Editor last opened (for the export command). */
let current: AiView | null = null;

type Selection = { list: "build" | "harvest" | "targets"; i: number } | null;

class AiView {
  private tab = 0;
  private undoStack: AiFile[] = [];
  private redoStack: AiFile[] = [];
  /** Undo depth at the last save (dirty when it differs). */
  private mark = new StackSave();
  private sel: Selection = null;
  private cond = -1;
  private group = 0;
  private unit = -1;
  private wave = -1;
  private hero = 0;
  private names = new Map<string, string>();
  private pending = new Set<string>();
  private skills = new Map<string, string[]>();
  private display: DisplayContext;

  constructor(private w3: W3Api, private el: HTMLElement, public ai: AiFile, private data: TriggerData, private objects: ObjectsService,
    private gui: TriggerGuiService, private editable: boolean, private setDirty: (dirty: boolean) => void, private source: string) {
    this.display = { data, objectName: (id) => this.names.get(id) };
    el.classList.add("ai-editor");
    el.tabIndex = -1;
    addKeyContext(el, UNDO_CONTEXT);
    el.addEventListener("keydown", (e) => this.keyDown(e));
    void loadHeroSkills(w3).then((m) => { this.skills = m; if (this.tab === 1) this.render(); });
    this.render();
  }

  /** Text typed into a field that its `change` hasn't committed yet: the tab counts as unsaved meanwhile. */
  private typing = false;
  private showDirty() { this.setDirty(this.typing || this.undoStack.length !== this.mark.at); }
  /** The tab unsaved while `input` holds other text than it was drawn with (`change` commits it as one step). */
  private watchTyping(input: HTMLInputElement) {
    const drawn = input.value;
    input.addEventListener("input", () => { this.typing = input.value !== drawn; this.showDirty(); });
    return input;
  }

  // Typing during the write stays unsaved.
  take() { return this.mark.take(this.undoStack.length); }
  saved(taken: ReturnType<StackSave["take"]>) { this.mark.saved(taken); this.showDirty(); }

  /** Runs a button's work; a failure is shown. */
  private act(f: () => Promise<unknown>) { f().catch((e) => this.w3.window.showError(String(e instanceof Error ? e.message : e))); }

  /** The AI's file name without .wai. */
  private baseName() { return this.source.replace(/\\/g, "/").split(/[/:]/).pop()!.replace(/\.wai$/i, ""); }

  /** Add To Map: the AI script, as it is now (unsaved changes included), into the open map as
   *  Scripts\<name>.ai, registered in its import list, as the World Editor's AI Editor does. A script of
   *  that name in the map is replaced after a question (and a checkpoint). The archive path, or null when
   *  cancelled. */
  async addToMap(): Promise<string | null> {
    const project = this.w3.workspace.project();
    if (!project) throw new Error("Open a map's project first: Add To Map puts the AI script into its imports.");
    // The import list and the script are found by the file list: one still being read after an open lacks them, and
    // the list would be written anew without its entries.
    await projectWithFiles(this.w3, project.root);
    const busy = this.w3.editors.unsavedPaths().filter((p) => /^map\/war3map\.imp(\.json)?$/i.test(p));
    if (busy.length) throw new Error(`Save or discard the changes of ${busy.join(", ")} first.`);
    const base = this.baseName(), archive = `Scripts\\${base}.ai`;
    const script = generateAiScript(this.ai, this.data);
    const existing = this.w3.workspace.files().find((f) => f.path.toLowerCase() === `map/scripts/${base.toLowerCase()}.ai`);
    if (existing && !(await this.w3.window.confirm(`The map has ${archive} already. Replace it with this AI's script? A checkpoint is made first, to come back to, where they're enabled.`, "Replace", 60_000))) return null;
    // Another project meanwhile: not the map that was asked about.
    if (this.w3.workspace.project()?.root !== project.root) throw new Error("The project changed meanwhile; nothing was added.");
    // Read after the question: the list may have changed while it was open.
    const list = await readImportList(this.w3);
    if (existing) await checkpointIfOn(this.w3, "Add AI To Map");
    await this.w3.workspace.writeText(existing?.path ?? `map/Scripts/${base}.ai`, script);
    const doc = list?.doc ?? { format: "w3proj.imports/1", version: 1, files: [] };
    doc.files ??= [];
    if (!doc.files.some((e) => e.path.replace(/\//g, "\\").toLowerCase() === archive.toLowerCase())) {
      doc.files.push({ flags: IMPORT_FLAGS, path: archive });
      if (list?.raw) await this.w3.backend.invoke("codec_write", { root: project.root, path: "map/war3map.imp", text: JSON.stringify({ format: "w3proj.imports/1", ...doc }) });
      else await this.w3.workspace.writeText("map/war3map.imp.json", await this.w3.backend.invoke<string>("codec_canonicalize", { root: project.root, path: "map/war3map.imp.json", text: JSON.stringify(doc) }));
    }
    await this.w3.workspace.refresh();
    void this.w3.window.showInfo(`${existing ? "Replaced" : "Added"} ${archive} in the map's imports. Triggers start it with "AI - Start Melee AI Script" or "Start Campaign AI Script" and the path ${archive}.`);
    return archive;
  }

  /** Import Custom Data: object data the AI carries (a .w3o, or one kind's file), which the AI Editor shows its
   *  custom objects from, instead of the open map's. One undo step. False when cancelled. */
  async importCustomData(): Promise<boolean> {
    if (!this.editable) throw new Error("This AI is read-only.");
    const path = await this.w3.window.pickFile({ title: "Import Custom Data", filters: OBJECT_FILTER });
    if (!path) return false;
    const ext = path.split(".").pop()!.toLowerCase();
    const bytes = await this.w3.backend.readBytes(path);
    const objects = (text: string) => { const f = JSON.parse(text) as { custom?: unknown[]; original?: unknown[] }; return (f.custom?.length ?? 0) + (f.original?.length ?? 0); };
    // Read through the object data code first: what it can't read doesn't go into the AI.
    let w3o: Uint8Array, count: number;
    if (ext === "w3o") {
      const parts = await this.w3.backend.invoke<{ kind: string; text: string }[]>("w3o_import", { path });
      count = parts.reduce((n, p) => n + objects(p.text), 0);
      w3o = bytes;
    } else if (W3O_KINDS.includes(ext)) {
      count = objects(await this.w3.backend.invoke<string>("objects_import", { name: `war3map.${ext}`, path }));
      w3o = w3oOfKind(ext, bytes);
    } else throw new Error("Choose a .w3o or one kind's object data (.w3u, .w3t, .w3b, .w3d, .w3a, .w3h, .w3q).");
    if (!count) throw new Error(`${path} holds no objects.`);
    this.change(() => embedObjectData(this.ai, slashes(path), editorDate(new Date()), w3o));
    void this.w3.window.showInfo(`The AI carries ${count} object${count === 1 ? "" : "s"} from ${slashes(path).split("/").pop()} now.`);
    return true;
  }

  /** Export Custom Data: the object data the AI carries, as a .w3o (which Import Object Data takes). The path,
   *  or null when cancelled. */
  async exportCustomData(): Promise<string | null> {
    const bytes = embeddedObjectBytes(this.ai);
    if (!bytes) throw new Error("This AI carries no custom data.");
    const target = await this.w3.window.pickSaveFile({ title: "Export Custom Data", defaultPath: `${this.baseName()}.w3o`, filters: [{ name: "Object data (.w3o)", extensions: ["w3o"] }] });
    if (!target) return null;
    const path = /\.w3o$/i.test(target) ? target : `${target}.w3o`;
    await this.w3.backend.writeBytes(path, bytes);
    // Read back as Import Object Data would: say so if it can't be.
    const parts = await this.w3.backend.invoke<{ kind: string; text: string }[]>("w3o_import", { path }).catch((e) => e instanceof Error ? e : new Error(String(e)));
    if (parts instanceof Error) void this.w3.window.showWarning(`Wrote ${path} as the AI holds it, but it doesn't read as object data: ${parts.message}`);
    else void this.w3.window.showInfo(`Exported the AI's custom data (${parts.map((p) => p.kind).join(", ")}) to ${path}.`);
    return path;
  }

  /** Writes the .ai script for the AI as it is now (unsaved changes included). */
  async exportScript() {
    const base = this.baseName();
    const target = await this.w3.window.pickSaveFile({ title: "Export AI script", defaultPath: `${base}.ai`, filters: [{ name: "AI scripts", extensions: ["ai"] }] });
    if (!target) return;
    await this.w3.workspace.writeText(target, generateAiScript(this.ai, this.data));
    void this.w3.window.showInfo(`AI script written to ${target}. Add To Map puts it into the open map as Scripts\\${base}.ai; triggers start it with "AI - Start Campaign AI Script" or "Start Melee AI Script".`);
  }

  // ---- changes and undo ---------------------------------------------------------------
  private change(fn: () => void) {
    if (!this.editable) return;
    this.undoStack.push(structuredClone(this.ai));
    this.redoStack = [];
    // A save point that was undone past can't be reached again.
    this.mark.pushed(this.undoStack.length);
    fn();
    this.afterChange();
  }
  private afterChange() {
    this.typing = false;
    this.showDirty();
    this.render();
  }
  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.mark.moved();
    this.redoStack.push(this.ai);
    this.ai = prev;
    this.afterChange();
  }
  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.mark.moved();
    this.undoStack.push(this.ai);
    this.ai = next;
    this.afterChange();
  }
  private keyDown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.type === "text" || t instanceof HTMLTextAreaElement) return;
    const step = undoStepOf(this.w3.keybindings.commandsFor(e));
    if (step === "undo") { this.undo(); e.preventDefault(); }
    else if (step === "redo") { this.redo(); e.preventDefault(); }
  }

  // ---- names ---------------------------------------------------------------------------
  /** Display name of an object id; unknown ones are looked up and shown when found. */
  private nameOf(id: string): string {
    if (id === NO_ID || !id) return "(none)";
    const special = SPECIAL_BUILDS.find(([s]) => s === id);
    if (special) return special[1];
    const n = this.names.get(id);
    if (n !== undefined) return n;
    if (!this.pending.has(id)) {
      this.pending.add(id);
      void this.objects.name(id).then((name) => {
        this.names.set(id, name ?? id);
        if ([...this.pending].every((p) => this.names.has(p))) this.render();
      });
    }
    return id;
  }
  private label(id: string) {
    const n = this.nameOf(id);
    return n === id || id === NO_ID || SPECIAL_BUILDS.some(([s]) => s === id) ? n : `${n} (${id})`;
  }

  private async pick(title: string, kinds: string[]): Promise<{ id: string; kind: string } | undefined> {
    const o = await this.objects.pick(document.body, { title, kinds });
    if (o) this.names.set(o.id, o.name);
    return o;
  }

  // ---- controls ------------------------------------------------------------------------
  private field(label: string, ...control: (HTMLElement | string | null)[]) {
    return h("div.ai-field", {}, h("label", {}, label), h("div", {}, ...control));
  }
  private num(value: number, set: (v: number) => void, opts: { min?: number; max?: number; width?: string } = {}) {
    return this.watchTyping(h("input.ai-num", {
      type: "number", value: String(value), min: opts.min, max: opts.max, disabled: !this.editable,
      onchange: (e: Event) => {
        const v = Math.round(Number((e.target as HTMLInputElement).value));
        if (!Number.isFinite(v) || v === value) return;
        this.change(() => set(Math.max(opts.min ?? -Infinity, Math.min(opts.max ?? Infinity, v))));
      },
    }));
  }
  private text(value: string, set: (v: string) => void, cls = "ai-text") {
    return this.watchTyping(h(`input.${cls}`, {
      type: "text", value, readOnly: !this.editable,
      onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; if (v !== value) this.change(() => set(v)); },
    }));
  }
  private select<T extends number | string>(value: T, options: [T, string][], set: (v: T) => void) {
    return h("select", {
      disabled: !this.editable,
      onchange: (e: Event) => {
        const i = (e.target as HTMLSelectElement).selectedIndex;
        if (options[i] && options[i][0] !== value) this.change(() => set(options[i][0]));
      },
    }, ...options.map(([v, l]) => h("option", { selected: v === value }, l)));
  }
  /** A select whose last entry (`more`) asks for a value: `ask` makes the change itself and
   *  resolves false when cancelled. A value not among `options` shows as that entry. */
  private choose<T extends number | string>(value: T, options: [T, string][], more: string, ask: () => Promise<boolean>, set: (v: T) => void) {
    return h("select", {
      disabled: !this.editable,
      onchange: async (e: Event) => {
        const i = (e.target as HTMLSelectElement).selectedIndex;
        if (i < options.length) { if (options[i][0] !== value) this.change(() => set(options[i][0])); return; }
        if (!(await ask())) this.render();
      },
    }, ...options.map(([v, l]) => h("option", { selected: v === value }, l)), h("option", { selected: !options.some(([v]) => v === value) }, more));
  }
  private check(label: string, on: boolean, set: (v: boolean) => void, title = "") {
    return h("label.ai-check", { title }, h("input", { type: "checkbox", checked: on, disabled: !this.editable,
      onchange: (e: Event) => this.change(() => set((e.target as HTMLInputElement).checked)) }), label);
  }
  private objectButton(id: string, title: string, kinds: string[], set: (id: string, kind: string) => void, none = false) {
    return h("span.ai-object", {},
      h("button", { disabled: !this.editable, title: id === NO_ID ? "" : id, onclick: async () => {
        const o = await this.pick(title, kinds);
        if (o && o.id !== id) this.change(() => set(o.id, o.kind));
      } }, this.label(id)),
      none && id !== NO_ID && this.editable ? h("button.icon-button", { title: "None", onclick: () => this.change(() => set(NO_ID, "")) }, "×") : null);
  }
  private buttons(...list: [string, () => void, boolean?][]) {
    return h("div.ai-buttons", {}, ...list.map(([l, run, disabled]) => h("button", { disabled: !this.editable || disabled, onclick: run }, l)));
  }
  /** Moves entry `i` of a list by `d` (selection follows). */
  private move<T>(list: T[], i: number, d: number, follow: (j: number) => void) {
    const j = i + d;
    if (i < 0 || j < 0 || j >= list.length) return;
    this.change(() => { [list[i], list[j]] = [list[j], list[i]]; follow(j); });
  }

  // ---- conditions ----------------------------------------------------------------------
  private condText(call: AiCall | null): string {
    return call ? callText({ kind: CONDITION, ...call }, this.display) : "";
  }
  private condCell(condIndex: number, cond: AiCondition): string {
    if (condIndex === -2) return this.condText(cond.call);
    if (condIndex >= 0) return this.ai.conditions.find((c) => c.index === condIndex)?.name ?? `#${condIndex}`;
    return "";
  }
  /** Asks for a condition function (comparison, And, Or) with its default arguments. */
  private async newCondition(current: AiCall | null): Promise<AiCall | undefined> {
    const p = await this.gui.editParam({
      data: this.data, display: this.display, type: "boolcall",
      current: current ? { type: 2, value: "", call: { kind: CONDITION, ...current } } : { type: -1, value: "" },
    });
    if (!p?.call) return undefined;
    return { name: p.call.name, hasParams: p.call.hasParams, params: p.call.params, trailer: p.call.trailer ?? 0 };
  }
  /** Parameter `i` of `owner` through the parameter dialog (object types: the object browser). */
  private async editArg(owner: Param[], i: number, type: string) {
    const current = owner[i];
    const kind = CODE_KINDS[type];
    let p: Param | undefined;
    if (kind && (current.type === 3 || current.type === -1)) {
      const o = await this.pick(this.data.types.get(type)?.name ?? type, [kind]);
      p = o ? { type: 3, value: o.id } : undefined;
    } else {
      p = await this.gui.editParam({ data: this.data, display: this.display, type, current });
    }
    if (p) this.change(() => { owner[i] = p!; });
  }
  /** A function's sentence with each argument clickable. A nested call's own words replace the
   *  whole call (`self`); its arguments are clickable in turn. */
  private sentence(kind: number, name: string, params: Param[], self?: (e: MouseEvent) => void): (HTMLElement | string)[] {
    const f = this.data.find(kind, name);
    const words = (t: string) => (self && this.editable ? h("span.trig-param.editable", { onclick: self }, t) : t);
    if (!f) return [words(`${name}(…)`)];
    const arg = (i: number): HTMLElement => {
      const p = params[i], type = f.args[i] ?? "";
      const open = (e: MouseEvent) => { e.stopPropagation(); if (this.editable) void this.editArg(params, i, type); };
      if (!p) return h("span.trig-param.unset", {}, "?");
      if (p.call) return h("span.ai-call", {}, this.wordsOf("(", open), ...this.sentence(p.call.kind, p.call.name, p.call.params, open), this.wordsOf(")", open));
      return h(`span.trig-param${p.type === -1 ? ".unset" : ""}${this.editable ? ".editable" : ""}`, { onclick: open },
        p.type === -1 ? `<${this.data.types.get(type)?.name ?? type}>` : paramText(p, this.display, type));
    };
    if (!f.pattern.length) return [words(f.displayName), ...(f.args.length ? [words("("), ...f.args.flatMap((_, i) => (i ? [words(", "), arg(i)] : [arg(i)])), words(")")] : [])];
    let n = 0;
    return f.pattern.map((part) => (typeof part === "string" ? words(part) : arg(n++)));
  }
  private wordsOf(t: string, open: (e: MouseEvent) => void) {
    return this.editable ? h("span.trig-param.editable", { onclick: open }, t) : t;
  }
  /** Looks up the names of objects the conditions mention (shown once known). */
  private conditionNames() {
    const visit = (kind: number, name: string, params: Param[]) => {
      const f = this.data.find(kind, name);
      params.forEach((p, i) => {
        if (p.type === 3 && /code$/.test(f?.args[i] ?? "") && p.value.length === 4) this.nameOf(p.value);
        if (p.call) visit(p.call.kind, p.call.name, p.call.params);
      });
    };
    const conds = [...this.ai.conditions, ...[...this.ai.build, ...this.ai.harvest, ...this.ai.targets, ...this.ai.groups.flatMap((g) => g.units)].map((x) => x.cond)];
    for (const c of conds) if (c.call) visit(CONDITION, c.call.name, c.call.params);
  }

  /** The condition of a priority or attack unit: none, a named one, or its own. */
  private condEditor(x: { condIndex: number; cond: AiCondition }) {
    const choices: [number, string][] = [[-1, "(none)"], ...this.ai.conditions.map((c): [number, string] => [c.index, c.name])];
    const kind = this.choose(x.condIndex, choices, "Custom…", async () => {
      const call = await this.newCondition(null);
      if (call) this.change(() => { x.condIndex = -2; x.cond = { name: "", call }; });
      return !!call;
    }, (v) => { x.condIndex = v; x.cond = { ...NO_COND }; });
    return h("div", {}, this.field("Condition", kind),
      x.condIndex === -2 && x.cond.call ? this.callEditor(x.cond.call, (c) => { x.cond = { name: "", call: c }; }) : null);
  }
  private callEditor(call: AiCall, set: (c: AiCall) => void) {
    return h("div.ai-cond", {},
      h("div.ai-cond-text", {}, ...this.sentence(CONDITION, call.name, call.params)),
      this.editable ? h("button", { onclick: async () => { const c = await this.newCondition(call); if (c) this.change(() => set(c)); } }, "Change function…") : null);
  }

  // ---- view ----------------------------------------------------------------------------
  render() {
    // The fields are drawn anew: what was typed and not committed is gone with them.
    if (this.typing) { this.typing = false; this.showDirty(); }
    this.conditionNames();
    const scroll = [...this.el.querySelectorAll(".ai-scroll")].map((e) => e.scrollTop);
    const tabs = ["General", "Heroes", "Building", "Attacking", "Test Configuration"];
    const body = [() => this.general(), () => this.heroes(), () => this.building(), () => this.attacking(), () => this.testConfig()][this.tab]();
    this.el.replaceChildren(
      h("div.ai-tabs", {}, ...tabs.map((t, i) => h(`button${i === this.tab ? ".active" : ""}`, { onclick: () => { this.tab = i; this.render(); } }, t)),
        h("span.muted.ai-title", {}, this.ai.name), this.editable ? null : h("span.muted", {}, "(read-only)"),
        h("button.ai-export", { title: "Write the AI script (.ai) the game runs, like the World Editor's File > Export AI Script",
          onclick: () => void this.exportScript().catch((e) => this.w3.window.showError(String(e instanceof Error ? e.message : e))) }, "Export AI Script…"),
        h("button.ai-add-to-map", { title: "Put the AI script into the open map as Scripts\\<name>.ai, in its imports, like the World Editor's Add To Map",
          onclick: () => this.act(() => this.addToMap()) }, "Add To Map")),
      body);
    this.el.querySelectorAll(".ai-scroll").forEach((e, i) => { e.scrollTop = scroll[i] ?? 0; });
    // The changed control was replaced (or a dialog closed): keep the keys (undo) here.
    const a = document.activeElement;
    if ((!a || a === document.body || !a.isConnected) && this.el.isConnected) this.el.focus({ preventScroll: true });
  }

  private general() {
    const ai = this.ai;
    const custom = ai.race === 0;
    const workers: [string, string, string[]][] = [["Gold Worker", "unit", ["w3u"]], ["Lumber Worker", "unit", ["w3u"]],
      ["Base Building", "building", ["w3u"]], ["Mine Building", "building", ["w3u"]]];
    const obj = embeddedObjectData(ai);
    const conds = h("table.ai-table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Used"), h("th", {}, "Condition"))),
      h("tbody", {}, ...ai.conditions.map((c, i) => h(`tr.ai-row${i === this.cond ? ".active" : ""}`, { onclick: () => { this.cond = i; this.render(); } },
        h("td", {}, c.name), h("td", {}, String(conditionUses(ai, c.index))), h("td.ai-cond-cell", {}, this.condText(c.call))))));
    const c = ai.conditions[this.cond];
    return h("div.ai-page.ai-scroll", {},
      this.field("Name", this.text(ai.name, (v) => { ai.name = v; })),
      this.field("Race", this.select(ai.race, RACES.map((r, i): [number, string] => [i, r]), (v) => { ai.race = v; })),
      this.field("Options", h("div.ai-options", {}, ...AI_OPTIONS.map(([bit, l]) =>
        this.check(l, (ai.options & bit) !== 0, (on) => { ai.options = on ? ai.options | bit : ai.options & ~bit; })))),
      ...workers.map(([l, what, kinds], i) => this.field(l, this.objectButton(ai.workers[i] ?? NO_ID, `${l} (a ${what})`, kinds, (id) => { ai.workers[i] = id; }),
        custom ? null : h("span.muted", {}, " used by Custom race AIs only"))),
      this.field("Custom Data", obj
        ? h("span.ai-custom-data", {}, `Object data from ${obj.path} (${obj.date}) `,
          h("button.ai-custom-export", { title: "Save it as a .w3o, which Import Object Data takes", onclick: () => this.act(() => this.exportCustomData()) }, "Export…"), " ",
          this.editable ? h("button.ai-custom-import", { title: "Replace it with a .w3o or one kind's object data", onclick: () => this.act(() => this.importCustomData()) }, "Import…") : null, " ",
          this.editable ? h("button.ai-custom-clear", { onclick: () => this.change(() => clearObjectData(ai)) }, "Clear") : null)
        : h("span.ai-custom-data", {}, h("span.muted", {}, "None: custom units come from the map the AI is used in. "),
          this.editable ? h("button.ai-custom-import", { title: "Take in a .w3o or one kind's object data (.w3u, .w3a, …): the AI carries its objects", onclick: () => this.act(() => this.importCustomData()) }, "Import…") : null)),
      h("h3", {}, "Conditions (used by building and attacking)"),
      ai.conditions.length ? conds : h("p.muted", {}, "No conditions yet."),
      this.buttons(
        ["Add Condition", async () => {
          const call = await this.newCondition(null);
          if (!call) return;
          const name = await this.w3.window.inputBox({ prompt: "Condition name", value: "Untitled Condition" });
          if (!name) return;
          if (ai.conditions.some((x) => x.name.toLowerCase() === name.toLowerCase())) { void this.w3.window.showError("This condition name is already in use."); return; }
          this.change(() => { ai.conditions.push({ index: ai.conditions.length, name, call }); this.cond = ai.conditions.length - 1; });
        }],
        ["Delete Condition", () => {
          if (!c) return;
          this.change(() => { removeCondition(ai, c.index); this.cond = -1; });
        }, !c]),
      c ? h("div.ai-detail", {},
        this.field("Name", this.text(c.name, (v) => {
          if (ai.conditions.some((x) => x !== c && x.name.toLowerCase() === v.toLowerCase())) { void this.w3.window.showError("This condition name is already in use."); return; }
          c.name = v;
        })),
        c.call ? this.callEditor(c.call, (call) => { c.call = call; }) : null,
        conditionUses(ai, c.index) ? h("p.muted", {}, `Used by ${conditionUses(ai, c.index)} priorities or attack units. Deleting it removes the condition from them.`) : null)
        : null);
  }

  private heroes() {
    const ai = this.ai;
    const hero = ai.heroes[this.hero] ?? NO_ID;
    const known = this.skills.get(hero) ?? [];
    const skillSelect = (list: string[], level: number) => {
      const ids = [...new Set([...known, ...list.filter((x) => x !== NO_ID)])];
      const options: [string, string][] = [[NO_ID, "(none)"], ...ids.map((x): [string, string] => [x, this.label(x)])];
      // The last entry asks for any ability.
      return this.choose(list[level], options, "Other ability…", async () => {
        const o = await this.pick("Hero skill", ["w3a"]);
        if (o) this.change(() => { list[level] = o.id; });
        return !!o;
      }, (v) => { list[level] = v; });
    };
    const lists = [0, 1, 2].map((pos) => ai.skills[this.hero * 3 + pos]);
    return h("div.ai-page.ai-scroll", {},
      h("h3", {}, "Heroes Used"),
      ...[0, 1, 2].map((i) => this.field(`Hero ${i + 1}`, this.objectButton(ai.heroes[i], `Hero ${i + 1}`, ["w3u"], (id) => { ai.heroes[i] = id; }, true))),
      h("h3", {}, "Training Order"),
      h("div.ai-orders", {}, ...HERO_ORDERS.map((o, i) => this.field(`Heroes ${o}`, this.num(ai.heroChances[i], (v) => { ai.heroChances[i] = v; }, { min: 0, max: 100 }), " %"))),
      h("p.muted", {}, `Chances add up to ${ai.heroChances.reduce((a, b) => a + b, 0)} %.`),
      h("h3", {}, "Skill Selection"),
      h("div.ai-tabs.ai-subtabs", {}, ...[0, 1, 2].map((i) => h(`button${i === this.hero ? ".active" : ""}`, { onclick: () => { this.hero = i; this.render(); } },
        `Hero ${i + 1}: ${this.nameOf(ai.heroes[i])}`))),
      h("table.ai-table.ai-skills", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Level"), h("th", {}, "as first Hero"), h("th", {}, "as second Hero"), h("th", {}, "as third Hero"))),
        h("tbody", {}, ...Array.from({ length: 10 }, (_, level) => h("tr", {}, h("td", {}, String(level + 1)), ...lists.map((l) => h("td", {}, skillSelect(l, level))))))),
      this.buttons(["Same as first Hero for all", () => this.change(() => { lists[1].splice(0, 10, ...lists[0]); lists[2].splice(0, 10, ...lists[0]); })]));
  }

  // ---- building ------------------------------------------------------------------------
  private building() {
    const ai = this.ai;
    const totals = buildTotals(ai);
    const isSel = (list: string, i: number) => this.sel?.list === list && this.sel.i === i;
    const row = (list: "build" | "harvest" | "targets", i: number, ...cells: string[]) =>
      h(`tr.ai-row${isSel(list, i) ? ".active" : ""}`, { onclick: () => { this.sel = { list, i }; this.render(); } }, ...cells.map((c) => h("td", {}, c)));
    const section = (title: string, list: "build" | "harvest" | "targets", head: string[], rows: HTMLElement[], add: () => void) => {
      const arr = ai[list] as unknown[];
      const i = this.sel?.list === list ? this.sel.i : -1;
      return h("div.ai-section", {},
        h("h3", {}, title),
        h("div.ai-list.ai-scroll", {}, h("table.ai-table", {}, h("thead", {}, h("tr", {}, ...head.map((x) => h("th", {}, x)))), h("tbody", {}, ...rows))),
        this.buttons(["Add Priority", add],
          ["Remove", () => this.change(() => { arr.splice(i, 1); this.sel = arr.length ? { list, i: Math.min(i, arr.length - 1) } : null; }), i < 0],
          ["Move Up", () => this.move(arr, i, -1, (j) => { this.sel = { list, i: j }; }), i <= 0],
          ["Move Down", () => this.move(arr, i, 1, (j) => { this.sel = { list, i: j }; }), i < 0 || i >= arr.length - 1]));
    };
    const insertAt = (list: "build" | "harvest" | "targets") => (this.sel?.list === list ? this.sel.i + 1 : ai[list].length);
    const build = section("Build Priorities", "build", ["#", "Build", "Total", "Town", "Conditions"],
      ai.build.map((b, i) => row("build", i, String(i + 1), this.buildName(b), String(totals[i]), townText(b.town), this.condCell(b.condIndex, b.cond))),
      async () => {
        const o = await this.pick("Build a unit or upgrade", ["w3u", "w3q"]);
        if (!o) return;
        const at = insertAt("build");
        this.change(() => {
          ai.build.splice(at, 0, { type: 0, kind: o.kind === "w3q" ? BUILD_UPGRADE : BUILD_UNIT, id: o.id, town: ALL, condIndex: -1, cond: { ...NO_COND } });
          this.sel = { list: "build", i: at };
        });
      });
    const harvest = section("Harvest Priorities", "harvest", ["#", "Harvest", "Workers", "Town", "Conditions"],
      ai.harvest.map((b, i) => row("harvest", i, String(i + 1), b.resource ? "Lumber" : "Gold", workersText(b.workers), townText(b.town), this.condCell(b.condIndex, b.cond))),
      () => {
        const at = insertAt("harvest");
        this.change(() => { ai.harvest.splice(at, 0, { type: 1, resource: 0, town: 0, workers: 5, condIndex: -1, cond: { ...NO_COND } }); this.sel = { list: "harvest", i: at }; });
      });
    const targets = section("Target Priorities", "targets", ["#", "Target", "Conditions"],
      ai.targets.map((t, i) => row("targets", i, String(i + 1), this.targetName(t), this.condCell(t.condIndex, t.cond))),
      () => {
        const at = insertAt("targets");
        this.change(() => { ai.targets.splice(at, 0, { type: 2, target: 2, condIndex: -1, cond: { ...NO_COND } }); this.sel = { list: "targets", i: at }; });
      });
    return h("div.ai-split", {}, h("div.ai-lists", {}, build, harvest, targets), h("div.ai-detail-pane.ai-scroll", {}, this.priorityDetail()));
  }
  private buildName(b: BuildPriority) {
    return b.kind === BUILD_EXPANSION || SPECIAL_BUILDS.some(([s]) => s === b.id) ? this.nameOf(b.id) : this.label(b.id);
  }
  private targetName(t: TargetPriority) {
    const name = TARGETS[t.target] ?? `Target ${t.target}`;
    return t.target === CREEPS && t.creep ? `${name} (${t.creep.min}-${t.creep.max}${t.creep.allowFlyers ? ", flyers" : ""})` : name;
  }
  private priorityDetail(): HTMLElement {
    const s = this.sel;
    if (!s) return h("p.muted", {}, "Select a priority to edit it. Workers go through the lists from the top every few seconds.");
    const town = (x: { town: number }) => this.field("Town", this.select(x.town, townChoices(x.town), (v) => { x.town = v; }));
    if (s.list === "build") {
      const b = this.ai.build[s.i];
      if (!b) return h("div");
      const what = b.kind === BUILD_UPGRADE ? "upgrade" : SPECIAL_BUILDS.find(([id]) => id === b.id)?.[0] ?? "unit";
      const kinds: [string, string][] = [["unit", "Specific Unit"], ["upgrade", "Specific Upgrade"], ...SPECIAL_BUILDS];
      return h("div", {},
        h("h3", {}, `Build priority ${s.i + 1}`),
        this.field("Build", this.select(what, kinds, (v) => {
          const special = SPECIAL_BUILDS.find(([id]) => id === v);
          if (special) { b.id = v; b.kind = v === "XEIA" ? BUILD_EXPANSION : BUILD_UNIT; }
          else {
            b.kind = v === "upgrade" ? BUILD_UPGRADE : BUILD_UNIT;
            if (SPECIAL_BUILDS.some(([id]) => id === b.id)) b.id = v === "upgrade" ? "Rhme" : "hfoo";
          }
        })),
        what === "unit" || what === "upgrade"
          ? this.field(what === "unit" ? "Unit" : "Upgrade", this.objectButton(b.id, what === "unit" ? "Unit" : "Upgrade", [what === "unit" ? "w3u" : "w3q"], (id) => { b.id = id; }))
          : null,
        town(b),
        this.condEditor(b));
    }
    if (s.list === "harvest") {
      const b: HarvestPriority | undefined = this.ai.harvest[s.i];
      if (!b) return h("div");
      const mode = (b.workers | 0) === -1 ? "all" : (b.workers | 0) === -2 ? "na" : "fixed";
      return h("div", {},
        h("h3", {}, `Harvest priority ${s.i + 1}`),
        this.field("Harvest", this.select(b.resource, [[0, "Gold"], [1, "Lumber"]], (v) => { b.resource = v; })),
        town(b),
        this.field("Workers", this.select(mode, [["all", "All"], ["na", "All Not Attacking"], ["fixed", "Fixed Value"]], (v) => {
          b.workers = v === "all" ? ALL : v === "na" ? -2 >>> 0 : 5;
        }), mode === "fixed" ? this.num(b.workers, (v) => { b.workers = v; }, { min: 0, max: 100 }) : null),
        this.condEditor(b));
    }
    const t = this.ai.targets[s.i];
    if (!t) return h("div");
    return h("div", {},
      h("h3", {}, `Target priority ${s.i + 1}`),
      this.field("Target", this.select(t.target, TARGETS.map((n, i): [number, string] => [i, n]), (v) => {
        t.target = v;
        if (v === CREEPS) t.creep ??= { min: 0, max: 9, allowFlyers: 0 };
        else delete t.creep;
      })),
      t.target === CREEPS && t.creep ? h("div", {},
        this.field("Minimum Strength", this.num(t.creep.min, (v) => { t.creep!.min = v; }, { min: 0 })),
        this.field("Maximum Strength", this.num(t.creep.max, (v) => { t.creep!.max = v; }, { min: 0 })),
        this.field("", this.check("Allow Flyers", t.creep.allowFlyers !== 0, (on) => { t.creep!.allowFlyers = on ? 1 : 0; }))) : null,
      this.condEditor(t));
  }

  // ---- attacking -----------------------------------------------------------------------
  private attacking() {
    const ai = this.ai;
    const g = ai.groups[this.group];
    const groupChoices = ai.groups.map((x): [number, string] => [x.index, x.name]);
    const groups = h("div.ai-section", {},
      h("h3", {}, "Attack Groups"),
      h("div.ai-chips", {}, ...ai.groups.map((x, i) => h(`button${i === this.group ? ".active" : ""}`, { onclick: () => { this.group = i; this.unit = -1; this.render(); } }, x.name))),
      this.buttons(
        ["Add Group", () => this.change(() => { ai.groups.push({ index: ai.groups.length, name: "Untitled Attack Group", units: [] }); this.group = ai.groups.length - 1; this.unit = -1; })],
        ["Delete Group", () => this.change(() => { removeGroup(ai, g.index); this.group = Math.max(0, this.group - 1); this.unit = -1; }), !g]),
      g ? h("div", {},
        this.field("Name", this.text(g.name, (v) => { g.name = v; })),
        h("div.ai-list.ai-scroll", {}, h("table.ai-table", {},
          h("thead", {}, h("tr", {}, h("th", {}, "Unit Type"), h("th", {}, "Quantity"), h("th", {}, "Conditions"))),
          h("tbody", {}, ...g.units.map((u, i) => h(`tr.ai-row${i === this.unit ? ".active" : ""}`, { onclick: () => { this.unit = i; this.render(); } },
            h("td", {}, this.buildName({ id: u.id, kind: 0 } as BuildPriority)), h("td", {}, quantityText(u.quantity, u.max)), h("td", {}, this.condCell(u.condIndex, u.cond))))))),
        this.buttons(
          ["Add Unit", async () => {
            const o = await this.pick("Attack unit", ["w3u"]);
            if (o) this.change(() => { g.units.push({ id: o.id, quantity: ALL, max: ALL, condIndex: -1, cond: { ...NO_COND } }); this.unit = g.units.length - 1; });
          }],
          ["Delete Unit", () => this.change(() => { g.units.splice(this.unit, 1); this.unit = -1; }), this.unit < 0]),
        this.unitDetail()) : null);

    const waves = h("div.ai-section", {},
      h("h3", {}, "Attack Waves"),
      this.field("Initial Delay", this.num(ai.initialDelay, (v) => { ai.initialDelay = v; }, { min: 0 }), h("span.muted", {}, " seconds before the first wave attacks")),
      this.field("Repeat Waves", this.num(ai.repeatWaves, (v) => { ai.repeatWaves = v; }, { min: 0 }), h("span.muted", {}, " waves repeated after the last one")),
      this.field("Minimum Forces", this.select(ai.minForces, [[FIRST_HERO_ONLY, "First Hero Only"], ...groupChoices], (v) => { ai.minForces = v; })),
      h("div.ai-list.ai-scroll", {}, h("table.ai-table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Attack Group"), h("th", {}, "Delay"))),
        h("tbody", {}, ...ai.waves.map((w, i) => h(`tr.ai-row${i === this.wave ? ".active" : ""}`, { onclick: () => { this.wave = i; this.render(); } },
          h("td", {}, String(i + 1)), h("td", {}, ai.groups.find((x) => x.index === w.group)?.name ?? `#${w.group}`), h("td", {}, `${w.delay} s`)))))),
      this.buttons(
        ["Add Wave", () => this.change(() => { const at = this.wave >= 0 ? this.wave + 1 : ai.waves.length; ai.waves.splice(at, 0, { group: g?.index ?? 0, delay: 0 }); this.wave = at; }), !ai.groups.length],
        ["Delete Wave", () => this.change(() => { ai.waves.splice(this.wave, 1); this.wave = Math.min(this.wave, ai.waves.length - 1); }), this.wave < 0],
        ["Move Up", () => this.move(ai.waves, this.wave, -1, (j) => { this.wave = j; }), this.wave <= 0],
        ["Move Down", () => this.move(ai.waves, this.wave, 1, (j) => { this.wave = j; }), this.wave < 0 || this.wave >= ai.waves.length - 1]),
      ai.waves[this.wave] ? h("div.ai-detail", {},
        this.field("Attack Group", this.select(ai.waves[this.wave].group, groupChoices, (v) => { ai.waves[this.wave].group = v; })),
        this.field("Delay", this.num(ai.waves[this.wave].delay, (v) => { ai.waves[this.wave].delay = v; }, { min: 0 }), h("span.muted", {}, " seconds before the next wave"))) : null);
    return h("div.ai-split.ai-attack", {}, h("div.ai-lists", {}, groups), h("div.ai-lists", {}, waves));
  }
  private unitDetail() {
    const u = this.ai.groups[this.group]?.units[this.unit];
    if (!u) return null;
    const all = (u.quantity | 0) === -1, upToAll = !all && (u.max | 0) === -1;
    const mode = all ? "all" : upToAll ? "minAll" : u.quantity === u.max ? "fixed" : "range";
    return h("div.ai-detail", {},
      this.field("Unit", this.objectButton(u.id, "Attack unit", ["w3u"], (id) => { u.id = id; }),
        h("span.muted", {}, " "), this.select(SPECIAL_BUILDS.some(([s]) => s === u.id) ? u.id : "", [["", "Specific unit"], ...SPECIAL_BUILDS.slice(0, 3)] as [string, string][],
          (v) => { if (v) u.id = v; })),
      this.field("Quantity", this.select(mode, [["all", "All"], ["fixed", "Fixed Value"], ["minAll", "Range: Minimum - All"], ["range", "Range: Minimum - Maximum"]], (v) => {
        const n = all ? 1 : u.quantity;
        if (v === "all") { u.quantity = ALL; u.max = ALL; }
        else if (v === "fixed") { u.quantity = n; u.max = n; }
        else if (v === "minAll") { u.quantity = n; u.max = ALL; }
        else { u.quantity = n; u.max = n + 1; }
      }),
      mode !== "all" ? this.num(u.quantity, (v) => { u.quantity = v; if (mode === "fixed" || (mode === "range" && u.max < v)) u.max = v; }, { min: 0 }) : null,
      mode === "range" ? h("span", {}, " to ", this.num(u.max, (v) => { u.max = Math.max(v, u.quantity); }, { min: 0 })) : null),
      this.condEditor(u));
  }

  // ---- test configuration --------------------------------------------------------------
  private testConfig() {
    const ai = this.ai;
    const races: [number, string][] = [[1, "Human"], [2, "Orc"], [4, "Undead"], [8, "Night Elf"], [32, "Random"]];
    const diffs: [number, string][] = [[0, "Easy"], [1, "Normal"], [2, "Insane"]];
    const withCurrent = (list: [number, string][], v: number) => (list.some(([x]) => x === v) ? list : [...list, [v, String(v)] as [number, string]]);
    return h("div.ai-page.ai-scroll", {},
      h("p.muted", {}, "Settings for the World Editor's test game (stored with the AI; running a test game isn't supported here)."),
      this.field("Game Speed", this.num(ai.gameSpeed, (v) => { ai.gameSpeed = v; }, { min: 0 }), h("span.muted", {}, " × regular game speed")),
      this.field("Game Options", h("div", {},
        this.check("Disable Fog of War", (ai.gameOptions & 1) !== 0, (on) => { ai.gameOptions = on ? ai.gameOptions | 1 : ai.gameOptions & ~1; }, "Option bit 1"),
        this.check("Disable Victory/Defeat Conditions", (ai.gameOptions & 2) !== 0, (on) => { ai.gameOptions = on ? ai.gameOptions | 2 : ai.gameOptions & ~2; }, "Option bit 2"))),
      this.field("Map File (Melee only)", this.text(ai.mapPath, (v) => { ai.mapPath = v; })),
      h("h3", {}, "Players"),
      ai.players.length ? h("table.ai-table", {},
        h("thead", {}, h("tr", {}, ...["Slot", "Team", "Race", "Color", "Handicap", "AI", "AI Difficulty", "AI Script"].map((x) => h("th", {}, x)))),
        h("tbody", {}, ...ai.players.map((p) => h("tr", {},
          h("td", {}, String(p.index + 1)),
          h("td", {}, this.num(p.team, (v) => { p.team = v; }, { min: 0 })),
          h("td", {}, this.select(p.race, withCurrent(races, p.race), (v) => { p.race = v; })),
          h("td", {}, this.num(p.color, (v) => { p.color = v; }, { min: 0 })),
          h("td", {}, this.num(p.handicap, (v) => { p.handicap = v; }, { min: 50, max: 100 })),
          h("td", { title: "Control and AI type as stored" }, this.num(p.aiType, (v) => { p.aiType = v; }, { min: 0 })),
          h("td", {}, this.select(p.difficulty, withCurrent(diffs, p.difficulty), (v) => { p.difficulty = v; })),
          h("td", {}, this.text(p.script, (v) => { p.script = v; })))))) : h("p.muted", {}, "No players configured."));
  }
}
