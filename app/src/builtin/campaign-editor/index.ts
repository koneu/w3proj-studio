// Campaign Editor: war3campaign.w3f (as JSON, format "w3proj.campaign/1") like
// the World Editor's Campaign Editor. Sections: General (name, author,
// description, difficulty), Campaign Screen (background, minimap picture,
// ambient sound, fog, interface race) and Chapters (the campaign screen's
// buttons and their maps). Texts that are TRIGSTR references are edited in
// war3campaign.wts. Chapter maps unpacked as projects live under maps/<file>/;
// "Add map…" unpacks another map there, "Open" switches to a chapter's project.
// "New Campaign…" starts an empty campaign project.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { toArchiveName, toProjectPath } from "../../lib/formats/archivepath";
import { addKeyContext, UNDO_CONTEXT, undoStepOf } from "../../lib/keybindings";
import { joinPath } from "../../lib/paths";
import { replaceQuestion, wouldDelete } from "../../lib/syncdeletes";
import { addChapter, buttonsOf, dropFromMapOrder } from "./chapters";
import { exportMap, removeMap, replaceMap, type CampaignFs, type FileStep } from "./mapfiles";
import { StringTable, WtsCutError, askWtsCuts, wtsCuts, wtsSafeText } from "../../lib/formats/wts";
import { h } from "../../workbench/dom";
import { FOG_UNSET_DENSITY, FOG_UNSET_Z, askNewCampaign, createCampaign } from "./newcampaign";

const FILE = "map/war3campaign.w3f.json", WTS = "map/war3campaign.wts";
const FORMAT = "w3proj.campaign/1";

interface Chapter { flags: number; chapter: string; title: string; map: string }
interface CampaignInfo {
  format: string;
  version: number;
  campaignVersion: number;
  editorVersion: number;
  name: string;
  difficulty: string;
  author: string;
  description: string;
  flags: number;
  background: number;
  backgroundPath: string;
  minimapPath: string;
  ambientSound: number;
  ambientSoundPath: string;
  fogStyle: number;
  fogStartZ: number;
  fogEndZ: number;
  fogDensity: number;
  fogColor: number[];
  race: number;
  chapters: Chapter[];
  mapOrder: { unknown: string; map: string }[];
  [more: string]: unknown;
}

const RACES: [number, string][] = [[0, "Human"], [1, "Orc"], [2, "Undead"], [3, "Night Elf"]];
/** A fog value the World Editor stores as "not set" (its new campaign's -1.8e38 and -1.7e38). */
const isUnsetFog = (v: number) => v <= -1e38;
const SECTIONS = [["general", "General"], ["screen", "Campaign Screen"], ["chapters", "Chapters"]] as const;
type SectionId = (typeof SECTIONS)[number][0];

/** Where the next editor (or the open ones) should go: from the side view. */
let requested: { section: SectionId; chapter?: number } | null = null;
const openViews = new Set<CampaignView>();

const isCampaign = (w3: W3Api) => w3.workspace.files().some((f) => f.path.replace(/\\/g, "/").toLowerCase() === FILE.toLowerCase());

/** The campaign project a chapter project sits in (…/maps/<file>), or null. */
async function parentCampaign(w3: W3Api): Promise<string | null> {
  const root = w3.workspace.project()?.root;
  const m = root ? /^(.*)[\\/]maps[\\/][^\\/]+[\\/]?$/.exec(root) : null;
  if (!m) return null;
  return (await w3.backend.invoke<boolean>("fs_exists", { path: joinPath(m[1], FILE) })) ? m[1] : null;
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const open = async (section?: SectionId, chapter?: number) => {
    if (!w3.workspace.project()) throw new Error("Open or import a project first.");
    if (!isCampaign(w3)) throw new Error("This project isn't a campaign (no map/war3campaign.w3f.json). Import a .w3n to get one.");
    if (section) {
      requested = { section, chapter };
      for (const v of openViews) v.show(section, chapter);
    }
    await w3.editors.open(FILE, "w3.campaignEditor");
  };
  /** Opens a chapter's project: through an open editor (it asks about unsaved changes). */
  const openChapter = async (map: string) => {
    const view = [...openViews][0];
    if (view) return view.openMap(map);
    const dir = joinPath(w3.workspace.project()!.root, "maps", toProjectPath(map));
    if (!(await w3.backend.invoke<boolean>("fs_exists", { path: joinPath(dir, "w3proj.toml") }))) throw new Error(`${map} isn't unpacked as a project.`);
    await w3.commands.execute("w3.project.open", dir);
  };
  const run = (f: () => Promise<unknown>) => () => { f().catch((e) => w3.window.showError(String(e instanceof Error ? e.message : e))); };

  ctx.subscriptions.push(
    w3.commands.register("w3.campaign.open", (section?: SectionId, chapter?: number) => open(section, chapter)),
    // Chapters from the side bar: through the editor (it records the change and saves).
    w3.commands.register("w3.campaign.addMap", async () => { await open("chapters"); await [...openViews][0]?.addMap(); }),
    w3.commands.register("w3.campaign.new", async () => {
      const o = await askNewCampaign(w3);
      if (!o) return;
      if (await w3.backend.invoke<boolean>("fs_exists", { path: o.dir })) throw new Error(`${o.dir} already exists.`);
      if (!(await w3.editors.closeAllAsking())) return;
      await w3.window.withProgress(`Creating ${o.name}`, () => createCampaign(w3, o));
      await open("general");
    }),
    w3.commands.register("w3.campaign.newMap", async () => { await open("chapters"); await [...openViews][0]?.newMap(); }),
    // A chapter's map (`map`, else the selected button's): through the editor, which keeps the undo step.
    ...(["exportMap", "replaceMap", "removeMap"] as const).map((action) => w3.commands.register(`w3.campaign.${action}`, async (map?: unknown) => {
      await open("chapters");
      const view = [...openViews][0];
      if (!view) throw new Error("The Campaign Editor didn't open.");
      const name = typeof map === "string" && map ? map : view.selectedMap();
      if (!name) throw new Error("Select a chapter button whose map to take, or name the map.");
      await view[action](name);
    })),
    w3.commands.register("w3.campaign.back", async () => {
      const parent = await parentCampaign(w3);
      if (!parent) throw new Error("This project isn't a chapter map of a campaign.");
      await w3.commands.execute("w3.project.open", parent);
      await open();
    }),
    // Side bar: the campaign's sections and chapters, or the way back from a chapter map.
    w3.views.register("w3.campaign.overview", {
      render(el) {
        const newCampaign = () => h("button", { onclick: run(() => w3.commands.execute("w3.campaign.new")) }, "New campaign…");
        if (!w3.workspace.project()) {
          el.append(h("div.view-empty", {}, "Open or import a campaign (.w3n) to edit it."),
            h("div.camp-side-actions", {}, newCampaign(), " ", h("button", { onclick: run(() => w3.commands.execute("w3.project.importMap")) }, "Import a campaign…")));
          return;
        }
        if (!isCampaign(w3)) {
          el.append(h("div.view-empty", {}, "This project isn't a campaign."));
          void parentCampaign(w3).then((parent) => {
            if (!parent) {
              el.append(h("div.camp-side-actions", {}, newCampaign(), " ", h("button", { onclick: run(() => w3.commands.execute("w3.project.importMap")) }, "Import a campaign…")));
              return;
            }
            el.replaceChildren(h("div.view-empty", {}, "This map is a chapter of a campaign."),
              h("div.camp-side-actions", {}, h("button", { onclick: run(() => w3.commands.execute("w3.campaign.back")) }, "Back to campaign")),
              h("div.view-empty.camp-side-path", { title: parent }, parent.split(/[\\/]/).pop() ?? parent));
          });
          return;
        }
        const row = (label: string, onclick: () => void, extra?: HTMLElement, title = "") =>
          h("div.tree-row.obj-kind", { onclick, title }, h("span.tree-icon", {}, "›"), h("span.tree-label", {}, label), extra ?? null);
        el.append(h("div.tree", {}, ...SECTIONS.map(([id, label]) => row(label, run(() => open(id)))),
          row("Gameplay Constants", run(() => w3.commands.execute("w3.gameplayConstants.open")), undefined, "The campaign's war3campaignMisc.txt"),
          row("Game Interface", run(() => w3.commands.execute("w3.gameInterface.open")), undefined, "The campaign's war3campaignSkin.txt"),
          row("Object Editor", run(() => w3.commands.execute("w3.objectEditor.open")), undefined, "The campaign's custom objects (war3campaign.w3u, …), which every chapter map has")));
        const list = h("div.tree.camp-side-chapters", {}, h("div.view-empty", {}, "Loading chapters…"));
        el.append(h("div.camp-side-head", {}, "Chapters"), list,
          h("div.camp-side-actions", {},
            h("button", { onclick: run(() => w3.commands.execute("w3.campaign.newMap")), title: "Create a new map as the next chapter" }, "New map…"), " ",
            h("button", { onclick: run(() => w3.commands.execute("w3.campaign.addMap")), title: "Add an existing .w3x/.w3m as the next chapter" }, "Add map…")));
        void (async () => {
          const info: CampaignInfo = JSON.parse(await w3.workspace.readText(FILE));
          const wts = await w3.workspace.readText(WTS).catch(() => null);
          const strings = wts !== null ? new StringTable(wts) : null;
          const text = (v: string) => strings?.resolve(v) ?? v;
          list.replaceChildren(...info.chapters.map((c, i) => row(`${text(c.chapter)}: ${text(c.title)}`, run(() => open("chapters", i)),
            h("button.icon-button.camp-side-open", { title: `Open ${c.map}`, onclick: (e: MouseEvent) => { e.stopPropagation(); run(() => openChapter(c.map))(); } }, "↗"),
            c.map)));
          if (!info.chapters.length) list.replaceChildren(h("div.view-empty", {}, "No chapters yet."));
        })().catch((e) => list.replaceChildren(h("div.view-empty", {}, String(e))));
      },
    }),
    w3.workspace.onDidChange(() => w3.views.refresh("w3.campaign.overview")),
    w3.workspace.onDidSave((p) => { if (/war3campaign\.(w3f\.json|wts)$/i.test(p)) w3.views.refresh("w3.campaign.overview"); }),
    w3.editors.registerProvider("w3.campaignEditor", {
      async resolve(el, doc) {
        const info: CampaignInfo = JSON.parse(await doc.readText());
        if (info.format !== FORMAT) throw new Error(`unsupported format ${info.format}`);
        const wtsText = await w3.workspace.readText(WTS).catch(() => null);
        const save = async () => {
          const root = w3.workspace.project()!.root;
          await view.checkCuts();
          await doc.writeText(await w3.backend.invoke<string>("codec_canonicalize", { root, path: doc.path, text: JSON.stringify(view.info) }));
          await view.saveStrings();
          view.saved();
        };
        const view: CampaignView = new CampaignView(w3, el, info, wtsText !== null ? new StringTable(wtsText) : null, !doc.readOnly, (d) => doc.setDirty(d), save);
        if (requested) { view.show(requested.section, requested.chapter); requested = null; }
        openViews.add(view);
        const stop = w3.workspace.onDidChange(() => view.render());
        return {
          undo: () => view.undo(),
          redo: () => view.redo(),
          save,
          focus: () => el.focus(),
          dispose: () => { stop.dispose(); openViews.delete(view); view.disposed = true; },
        };
      },
    }),
  );
}

/** What undo restores: the campaign info and the edited string table texts; `files`: a change of the campaign's map
 *  files made with it (done at once on disk; undone and redone there). */
interface State { info: CampaignInfo; texts: Map<number, string>; files?: FileStep }

class CampaignView {
  private section: SectionId = "general";
  /** Edited texts of war3campaign.wts (written on save). */
  private texts = new Map<number, string>();
  private undoStack: State[] = [];
  private redoStack: State[] = [];
  private savedAt = 0;
  private selected = -1;

  constructor(private w3: W3Api, private el: HTMLElement, public info: CampaignInfo, private strings: StringTable | null,
    private editable: boolean, private setDirty: (dirty: boolean) => void, private save: () => Promise<void>) {
    el.classList.add("camp-editor");
    el.tabIndex = -1;
    addKeyContext(el, UNDO_CONTEXT);
    el.addEventListener("keydown", (e) => this.keyDown(e));
    this.render();
  }

  saved() { this.savedAt = this.undoStack.length; this.setDirty(false); }

  /** Shows a section (and selects a chapter button). */
  show(section: SectionId, chapter?: number) {
    this.section = section;
    if (chapter !== undefined) this.selected = chapter;
    this.render();
  }

  /** Before a save: a text with a `}` line would be cut by the game, so it is changed (one undo step) or
   *  the save stops with the reason. */
  async checkCuts() {
    const cuts = wtsCuts(this.texts);
    if (!cuts.length) return;
    if (!(await askWtsCuts((m, yes, ms) => this.w3.window.confirm(m, yes, ms), cuts))) throw new WtsCutError(cuts);
    const now = wtsCuts(this.texts);
    if (now.length) this.change(() => { this.texts = new Map(this.texts); for (const c of now) this.texts.set(c.num, wtsSafeText(this.texts.get(c.num)!)); });
  }

  async saveStrings() {
    if (!this.strings || !this.texts.size) return;
    for (const [n, t] of this.texts) this.strings.set(n, t);
    if (!this.strings.dirty) return;
    await this.w3.workspace.writeText(WTS, this.strings.serialize());
    this.strings.markSaved();
  }

  // ---- changes and undo ---------------------------------------------------------------
  private snapshot(): State { return { info: structuredClone(this.info), texts: new Map(this.texts) }; }
  private restore(s: State) { this.info = s.info; this.texts = s.texts; }
  /** `rerender`: false while typing (the field keeps focus). `files`: the map files this change moved already. */
  private change(fn: () => void, rerender = true, files?: FileStep) {
    if (!this.editable) return;
    this.undoStack.push({ ...this.snapshot(), files });
    this.redoStack = [];
    if (this.savedAt > this.undoStack.length - 1) this.savedAt = -1;
    fn();
    this.setDirty(this.undoStack.length !== this.savedAt);
    if (rerender) this.render();
  }
  /** A map file change (or its undo) is being done: undo, redo and other map changes wait for it (refused). */
  private busy = false;
  /** The editor closed: a map change waiting for a question or a file choice stops. */
  disposed = false;
  undo() { void this.step(this.undoStack, this.redoStack, -1); }
  redo() { void this.step(this.redoStack, this.undoStack, 1); }
  private async step(from: State[], to: State[], dir: -1 | 1) {
    if (this.busy) return;
    const s = from.at(-1);
    if (!s) return;
    if (s.files) {
      // The files first: if they can't move back (something took their place), the step stays where it is.
      this.busy = true;
      try { await (dir < 0 ? s.files.undo() : s.files.redo()); } catch (e) {
        void this.w3.window.showError(`Can't ${dir < 0 ? "undo" : "redo"} the change of the campaign's maps: ${e instanceof Error ? e.message : e}`);
        return;
      } finally { this.busy = false; }
      if (from.at(-1) !== s) return;
    }
    from.pop();
    to.push({ ...this.snapshot(), files: s.files });
    this.restore(s);
    this.setDirty(this.undoStack.length !== this.savedAt);
    this.render();
  }
  private keyDown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if ((t instanceof HTMLInputElement && t.type !== "checkbox") || t instanceof HTMLTextAreaElement) return;
    const step = undoStepOf(this.w3.keybindings.commandsFor(e));
    if (step === "undo") { this.undo(); e.preventDefault(); }
    else if (step === "redo") { this.redo(); e.preventDefault(); }
  }

  // ---- strings -------------------------------------------------------------------------
  /** The text of a value: a TRIGSTR reference's string table text, else the value itself. */
  private textOf(value: string): string {
    const n = StringTable.ref(value);
    if (n === null || !this.strings?.has(n)) return value;
    return this.texts.get(n) ?? this.strings.get(n)!;
  }

  // ---- form controls -------------------------------------------------------------------
  private row(label: string, control: Node, hint?: string) {
    return h("label.form-row", {}, h("span.form-label", {}, label), h("div.form-control", {}, control, hint ? h("small.muted", {}, hint) : null));
  }
  /** A text; TRIGSTR references edit war3campaign.wts. One undo step per field visit. */
  private text(get: () => string, set: (s: string) => void, opts: { multiline?: boolean } = {}) {
    const ref = StringTable.ref(get());
    const viaTable = ref !== null && !!this.strings?.has(ref);
    const value = this.textOf(get());
    const input = opts.multiline
      ? h("textarea.form-input", { rows: 6, value, readOnly: !this.editable })
      : h("input.form-input", { value, readOnly: !this.editable });
    let first = true;
    input.addEventListener("input", () => {
      const v = input.value;
      const apply = () => { if (viaTable) this.texts.set(ref!, v); else set(v); };
      // The first keystroke records the undo step; later ones extend it.
      if (first) { first = false; this.change(apply, false); } else { apply(); this.setDirty(true); }
    });
    input.addEventListener("blur", () => { first = true; });
    return viaTable ? h("div.form-stack", {}, input, h("small.muted", { title: "Stored in war3campaign.wts" }, `string table · ${get()}`)) : input;
  }
  /** `unset`: the value the World Editor stores for "not set" (shown empty; emptying the field stores it). */
  private num(value: number, set: (n: number) => void, opts: { int?: boolean; unset?: number } = {}) {
    const isUnset = opts.unset !== undefined && isUnsetFog(value);
    const input = h("input.form-input.form-num", { type: "number", value: isUnset ? "" : String(value), step: opts.int ? "1" : "any", readOnly: !this.editable,
      placeholder: opts.unset !== undefined ? "not set" : "" });
    input.addEventListener("change", () => {
      if (input.value === "" && opts.unset !== undefined && !input.validity.badInput) {
        input.classList.remove("invalid");
        if (!isUnset) this.change(() => set(opts.unset!));
        return;
      }
      const n = Number(input.value);
      if (input.value === "" || !Number.isFinite(n) || (opts.int && !Number.isInteger(n))) { input.classList.add("invalid"); return; }
      if (n !== value) this.change(() => set(n));
    });
    return input;
  }
  private select<T extends string | number>(options: [T, string][], value: T, set: (v: T) => void) {
    const opts = options.some(([k]) => k === value) ? options : [[value, `${value} (unknown)`] as [T, string], ...options];
    const sel = h("select.form-input", { disabled: !this.editable }, ...opts.map(([k, l]) => h("option", { selected: k === value }, l)));
    sel.addEventListener("change", () => { const v = opts[sel.selectedIndex][0]; if (v !== value) this.change(() => set(v)); });
    return sel;
  }
  private check(label: string, on: boolean, set: (on: boolean) => void, title = "") {
    return h("label.form-check", { title }, h("input", { type: "checkbox", checked: on, disabled: !this.editable,
      onchange: (e: Event) => this.change(() => set((e.target as HTMLInputElement).checked)) }), label);
  }
  private bit(label: string, get: () => number, set: (v: number) => void, bit: number, title = "") {
    return this.check(label, (get() & bit) !== 0, (on) => set(on ? get() | bit : get() & ~bit), title);
  }

  // ---- maps of the campaign ------------------------------------------------------------
  /** Map files of the campaign: chapter projects under maps/ and packed maps in map/. */
  private campaignMaps(): { name: string; project: boolean }[] {
    const out = new Map<string, { name: string; project: boolean }>();
    for (const f of this.w3.workspace.files()) {
      const p = f.path.replace(/\\/g, "/");
      const nested = /^maps\/([^/]+)\/w3proj\.toml$/i.exec(p);
      if (nested) out.set(nested[1].toLowerCase(), { name: toArchiveName(nested[1]), project: true });
      const packed = /^map\/([^/]+\.w3[mx])$/i.exec(p);
      if (packed && !out.has(packed[1].toLowerCase())) out.set(packed[1].toLowerCase(), { name: toArchiveName(packed[1]), project: false });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  private projectDir(map: string): string | null {
    const dir = toProjectPath(map);
    const has = this.w3.workspace.files().some((f) => f.path.replace(/\\/g, "/").toLowerCase() === `maps/${dir}/w3proj.toml`.toLowerCase());
    return has ? joinPath(this.w3.workspace.project()!.root, "maps", dir) : null;
  }

  async addMap() {
    const src = await this.w3.window.pickFile({ title: "Add a map to the campaign", filters: [{ name: "Warcraft III map", extensions: ["w3x", "w3m"] }] });
    if (!src) return;
    const name = src.split(/[\\/]/).pop()!;
    if (this.campaignMaps().some((m) => m.name.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is already in the campaign.`);
    const dir = joinPath(this.w3.workspace.project()!.root, "maps", toProjectPath(name));
    // A folder of that name left under maps/ (not a chapter: no w3proj.toml) isn't written over.
    await this.w3.window.withProgress(`Adding ${name}`, () => this.w3.backend.invoke("project_unpack", {
      map: src, dir, allowIncomplete: false, install: this.w3.settings.get<string>("game.installDir"), refuseDeletes: true,
    })).catch((e) => {
      const gone = wouldDelete(e);
      if (!gone) throw e;
      throw new Error(`Nothing was added: maps/${toProjectPath(name)} already holds files the map doesn't have (${gone.slice(0, 3).join(", ")}${gone.length > 3 ? " …" : ""}). Move it away first.`);
    });
    await this.w3.workspace.refresh();
    this.change(() => {
      this.selected = addChapter(this.info, name, name.replace(/\.w3[mx]$/i, ""));
    });
    void this.w3.window.showInfo(`${name} was unpacked into maps/ and added as a chapter. Save the campaign to keep the chapter.`);
  }

  /** A new map as the next chapter: created under maps/ (and opened), the button added and the
   *  campaign saved first (opening the map closes this editor). */
  async newMap() {
    if (!this.editable) return;
    if (this.undoStack.length !== this.savedAt) {
      const c = await this.w3.window.showWarning("The campaign has unsaved changes. They are saved before the new map opens.", "Save and continue", "Cancel");
      if (c !== "Save and continue") return;
    }
    const root = this.w3.workspace.project()!.root;
    await this.w3.commands.execute("w3.map.new", {
      parent: joinPath(root, "maps"), suffix: ".w3x", title: "New Chapter Map",
      beforeCreate: async (o: { dir: string; name: string }) => {
        const map = toArchiveName(o.dir.split(/[\\/]/).pop()!);
        if (this.campaignMaps().some((m) => m.name.toLowerCase() === map.toLowerCase())) throw new Error(`${map} is already in the campaign.`);
        this.change(() => {
          this.selected = addChapter(this.info, map, o.name);
        });
        await this.save();
      },
    });
  }

  // ---- a chapter's map: export, replace, remove ----------------------------------------
  private campaignFs(): CampaignFs {
    const ws = this.w3.workspace, root = ws.project()!.root;
    return {
      exists: (p) => this.w3.backend.invoke<boolean>("fs_exists", { path: joinPath(root, p) }),
      rename: (from, to) => ws.rename(from, to),
      unpack: async (src, dir, replaces) => {
        await this.w3.backend.invoke("project_unpack", {
          map: src, dir: joinPath(root, dir), allowIncomplete: false, install: this.w3.settings.get<string>("game.installDir"),
          ...(replaces === undefined ? {} : { refuseDeletes: true, replaces: joinPath(root, replaces) }),
        });
      },
      copy: (from, to) => ws.copy(from, to),
      pack: async (dir, output) => { await this.w3.backend.invoke("project_pack", { root: joinPath(root, dir), output }); },
    };
  }
  /** The map of the selected chapter button, if any. */
  selectedMap(): string | null { return this.info.chapters[this.selected]?.map ?? null; }
  private mapOf(map: string) { return this.campaignMaps().find((m) => m.name.toLowerCase() === map.toLowerCase()) ?? null; }
  /** Runs a change of the campaign's map files, one at a time, only while this editor and its project are open. */
  private async mapChange(map: string, ask: () => Promise<boolean>, apply: (m: { name: string; project: boolean }) => Promise<void>) {
    if (!this.editable) throw new Error("This campaign can't be changed here.");
    if (this.busy) throw new Error("Another change of the campaign's maps is still being done.");
    const m = this.mapOf(map);
    if (!m) throw new Error(`${map} isn't in the campaign.`);
    const root = this.w3.workspace.project()?.root;
    if (!(await ask())) return;
    if (this.disposed || this.busy || this.w3.workspace.project()?.root !== root) return;
    this.busy = true;
    try { await apply(m); } finally { this.busy = false; }
  }

  /** Export Map: the chapter's map as a map file of its own (a project map packed). */
  async exportMap(map: string) {
    const m = this.mapOf(map);
    if (!m) throw new Error(`${map} isn't in the campaign.`);
    const ext = /\.w3m$/i.test(m.name) ? "w3m" : "w3x";
    const target = await this.w3.window.pickSaveFile({ title: `Export ${m.name}`, defaultPath: m.name, filters: [{ name: "Warcraft III map", extensions: [ext] }] });
    if (!target || this.disposed) return;
    await this.w3.window.withProgress(`Exporting ${m.name}`, () => exportMap(this.campaignFs(), m.name, m.project, target));
    void this.w3.window.showInfo(`Exported ${m.name} to ${target}.`);
  }
  /** Replace Map: another map file in the chapter map's place (same file name; its buttons keep opening it). One undo step. */
  async replaceMap(map: string) {
    let src: string | null = null;
    await this.mapChange(map, async () => {
      src = await this.w3.window.pickFile({ title: `Replace ${map} with`, filters: [{ name: "Warcraft III map", extensions: ["w3x", "w3m"] }] });
      return !!src;
    }, async (m) => {
      const root = this.w3.workspace.project()?.root;
      const name = src!.split(/[\\/]/).pop()!;
      // Files of the chapter's project the new map doesn't have: asked about first, as a sync does.
      const askLoss = async (gone: string[]) => {
        const q = replaceQuestion(gone, m.name, name);
        const ok = (await this.w3.window.showWarning(q.message, ...q.actions)) === q.actions[0];
        // During the question the editor may have closed or another project opened: then nothing happens.
        return ok && !this.disposed && this.w3.workspace.project()?.root === root;
      };
      const files = await this.w3.window.withProgress(`Replacing ${m.name}`, () => replaceMap(this.campaignFs(), m.name, m.project, src!, askLoss));
      if (!files) return;
      this.change(() => {}, true, files);
      void this.w3.window.showInfo(`${m.name} now holds ${src!.split(/[\\/]/).pop()}. Ctrl+Z puts the old map back.`);
    });
  }
  /** Remove Map: the map leaves the campaign (and its map order); buttons opening it stay and show it missing, as in
   *  the World Editor, which asks first. One undo step. */
  async removeMap(map: string) {
    await this.mapChange(map, () => (buttonsOf(this.info, map).length
      ? this.w3.window.confirm(`This map is still in use by one or more chapter buttons. Remove ${map} anyway?`, "Remove", 60000)
      : this.w3.window.askDelete(`Remove ${map} from the campaign?`, "Remove")), async (m) => {
      const files = await removeMap(this.campaignFs(), m.name, m.project);
      this.change(() => dropFromMapOrder(this.info, m.name), true, files);
    });
  }
  /** Remove Button: when no other button opens its map, asks whether the map goes too (one undo step either way). */
  async removeButton(index: number) {
    if (!this.editable) return;
    const ch = this.info.chapters[index];
    if (!ch) return;
    const alone = buttonsOf(this.info, ch.map).length === 1 && !!this.mapOf(ch.map);
    let withMap = false;
    if (alone) {
      const a = await this.w3.window.showWarning(`No other button opens ${ch.map}. Remove the map from the campaign too?`, "Remove button and map", "Remove button only");
      if (a === undefined || this.disposed) return;
      withMap = a === "Remove button and map";
    }
    // During the question the buttons may have changed (undo, another edit): the button is looked for again.
    const at = this.info.chapters.findIndex((x) => x.map === ch.map && x.chapter === ch.chapter && x.title === ch.title && x.flags === ch.flags);
    if (at < 0) { void this.w3.window.showWarning("Not removed: the button changed while the question was open."); return; }
    const drop = () => { this.info.chapters.splice(at, 1); this.selected = Math.min(at, this.info.chapters.length - 1); };
    if (!withMap) { this.change(drop); return; }
    await this.mapChange(ch.map, async () => true, async (m) => {
      const files = await removeMap(this.campaignFs(), m.name, m.project);
      this.change(() => { drop(); dropFromMapOrder(this.info, m.name); }, true, files);
    });
  }

  async openMap(map: string) {
    const dir = this.projectDir(map);
    if (!dir) throw new Error(`${map} isn't unpacked as a project (it stays packed in the campaign, e.g. because not all of its files could be named).`);
    // Opening the map's project asks about unsaved changes (the campaign's too).
    await this.w3.commands.execute("w3.project.open", dir);
  }

  // ---- view ----------------------------------------------------------------------------
  render() {
    const scroll = this.el.querySelector(".form-body")?.scrollTop ?? 0;
    const nav = h("nav.form-nav", {}, ...SECTIONS.map(([id, label]) =>
      h(`button.form-nav-item${id === this.section ? ".active" : ""}`, { onclick: () => { this.section = id; this.render(); } }, label)));
    const body = h("div.form-body", {}, h("h2", {}, SECTIONS.find(([id]) => id === this.section)![1]),
      ...(this.section === "general" ? this.general() : this.section === "screen" ? this.screen() : this.chapters()));
    this.el.replaceChildren(h("div.map-info", {}, nav, body));
    body.scrollTop = scroll;
    const a = document.activeElement;
    if ((!a || a === document.body || !a.isConnected) && this.el.isConnected) this.el.focus({ preventScroll: true });
  }

  private general(): HTMLElement[] {
    const c = this.info;
    const run = (f: () => Promise<unknown>) => () => { f().catch((e) => this.w3.window.showError(String(e instanceof Error ? e.message : e))); };
    return [
      h("div.form-section", {},
        this.row("Name", this.text(() => c.name, (v) => { c.name = v; })),
        this.row("Author", this.text(() => c.author, (v) => { c.author = v; })),
        this.row("Description", this.text(() => c.description, (v) => { c.description = v; }, { multiline: true })),
        this.row("Difficulty", this.text(() => c.difficulty, (v) => { c.difficulty = v; }), "Text shown for the campaign's difficulty")),
      h("div.form-section", {}, h("h3", {}, "Options"),
        h("div.form-checks", {},
          this.bit("Variable difficulty", () => c.flags, (v) => { c.flags = v; }, 1),
          this.bit("Flag 2", () => c.flags, (v) => { c.flags = v; }, 2, "Meaning unknown (set in one sample)"),
          this.bit("Flag 4", () => c.flags, (v) => { c.flags = v; }, 4, "Meaning unknown (set in one sample)"))),
      // The World Editor's Campaign Editor › Advanced: the campaign's own values, which apply to its chapters.
      h("div.form-section", {}, h("h3", {}, "Advanced"),
        h("div.camp-advanced", {},
          h("button.camp-gameplay", { title: "war3campaignMisc.txt: max hero level, experience, damage tables, … for every chapter", onclick: run(() => this.w3.commands.execute("w3.gameplayConstants.open")) }, "Gameplay Constants…"), " ",
          h("button.camp-interface", { title: "war3campaignSkin.txt: icons, models, sounds and texts of the interface for every chapter", onclick: run(() => this.w3.commands.execute("w3.gameInterface.open")) }, "Game Interface…"), " ",
          h("button.camp-objects", { title: "war3campaign.w3u, .w3t, …: custom units, items, abilities and the rest for every chapter", onclick: run(() => this.w3.commands.execute("w3.objectEditor.open")) }, "Object Editor…"))),
      h("div.form-section", {}, h("h3", {}, "File"),
        h("p.muted", {}, `Format version ${c.version} · saved ${c.campaignVersion} times · editor ${c.editorVersion}`)),
    ];
  }

  private screen(): HTMLElement[] {
    const c = this.info;
    return [
      h("div.form-section", {}, h("h3", {}, "Background"),
        this.row("Background", this.num(c.background, (v) => { c.background = v; }, { int: true }), "Preset number; -1: the model or movie below, none when that is empty"),
        this.row("Custom background", this.text(() => c.backgroundPath, (v) => { c.backgroundPath = v; }), "Model (.mdx) or movie in the campaign or the game"),
        this.row("Campaign picture", this.text(() => c.minimapPath, (v) => { c.minimapPath = v; }), "Shown in the campaign list")),
      h("div.form-section", {}, h("h3", {}, "Ambient Sound"),
        this.row("Sound", this.num(c.ambientSound, (v) => { c.ambientSound = v; }, { int: true }), "Preset number; -1: the file below, none when that is empty"),
        this.row("Custom sound", this.text(() => c.ambientSoundPath, (v) => { c.ambientSoundPath = v; }))),
      h("div.form-section", {}, h("h3", {}, "Fog"),
        this.row("Fog style", this.num(c.fogStyle, (v) => { c.fogStyle = v; }, { int: true }), "-1 or 0: no fog"),
        this.row("Start / end height", h("div.form-inline", {},
          this.num(c.fogStartZ, (v) => { c.fogStartZ = v; }, { unset: FOG_UNSET_Z }), this.num(c.fogEndZ, (v) => { c.fogEndZ = v; }, { unset: FOG_UNSET_Z })),
          "Empty: not set (a new campaign's)"),
        this.row("Density", this.num(c.fogDensity, (v) => { c.fogDensity = v; }, { unset: FOG_UNSET_DENSITY })),
        this.row("Color", this.color(c.fogColor, (v) => { c.fogColor = v; }))),
      h("div.form-section", {}, h("h3", {}, "Interface"),
        this.row("Race", this.select(RACES, c.race, (v) => { c.race = v; }), "Cursor and interface of the campaign screen")),
    ];
  }
  /** RGBA as stored ([r, g, b, a]); the picker edits the colour, alpha stays. */
  private color(rgba: number[], set: (v: number[]) => void) {
    const hex = "#" + rgba.slice(0, 3).map((x) => x.toString(16).padStart(2, "0")).join("");
    return h("input", { type: "color", value: hex, disabled: !this.editable, onchange: (e: Event) => {
      const v = (e.target as HTMLInputElement).value;
      this.change(() => set([parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), rgba[3] ?? 255]));
    } });
  }

  private chapters(): (HTMLElement | null)[] {
    const c = this.info;
    const maps = this.campaignMaps();
    const i = this.selected;
    const ch = c.chapters[i];
    const move = (d: number) => {
      const j = i + d;
      if (i < 0 || j < 0 || j >= c.chapters.length) return;
      this.change(() => { [c.chapters[i], c.chapters[j]] = [c.chapters[j], c.chapters[i]]; this.selected = j; });
    };
    const run = (f: () => Promise<void>) => () => { f().catch((e) => this.w3.window.showError(String(e instanceof Error ? e.message : e))); };
    const table = h("table.form-table.camp-chapters", {},
      h("thead", {}, h("tr", {}, ...["#", "Button", "Map title", "Map file", "Shown"].map((x) => h("th", {}, x)))),
      h("tbody", {}, ...c.chapters.map((x, k) => {
        const missing = !maps.some((m) => m.name.toLowerCase() === x.map.toLowerCase());
        return h(`tr.camp-row${k === i ? ".active" : ""}`, { onclick: () => { this.selected = k; this.render(); }, ondblclick: run(() => this.openMap(x.map)) },
          h("td", {}, String(k + 1)), h("td", {}, this.textOf(x.chapter)), h("td", {}, this.textOf(x.title)),
          h(`td${missing ? ".camp-missing" : ""}`, { title: missing ? "Not in the campaign" : "" }, x.map),
          h("td", {}, x.flags & 1 ? "from the start" : "later"));
      })));
    const unused = maps.filter((m) => !c.chapters.some((x) => x.map.toLowerCase() === m.name.toLowerCase()));
    return [
      h("div.form-section", {},
        c.chapters.length ? table : h("p.muted", {}, "No chapters yet."),
        h("div.camp-buttons", {},
          ...(this.editable ? [
            h("button", { onclick: run(() => this.newMap()) }, "New map…"),
            h("button", { onclick: run(() => this.addMap()) }, "Add map…"),
            h("button", { disabled: !unused.length, onclick: () => this.change(() => {
              this.selected = addChapter(c, unused[0].name, unused[0].name.replace(/\.w3[mx]$/i, ""));
            }) }, "New chapter button"),
            h("button.camp-remove-button", { disabled: !ch, title: "Asks whether its map goes too when no other button opens it", onclick: run(() => this.removeButton(i)) }, "Remove button"),
            h("button", { disabled: i <= 0, onclick: () => move(-1) }, "Move up"),
            h("button", { disabled: i < 0 || i >= c.chapters.length - 1, onclick: () => move(1) }, "Move down"),
          ] : []),
          h("button", { disabled: !ch || !this.projectDir(ch.map), onclick: run(() => this.openMap(ch!.map)), title: "Opens the chapter's project (this campaign closes)" }, "Open map"))),
      ch ? h("div.form-section", {}, h("h3", {}, `Chapter button ${i + 1}`),
        this.row("Button text", this.text(() => ch.chapter, (v) => { ch.chapter = v; })),
        this.row("Map title", this.text(() => ch.title, (v) => { ch.title = v; })),
        this.row("Map file", this.select(maps.map((m): [string, string] => [m.name, m.project ? m.name : `${m.name} (packed)`]), ch.map, (v) => { ch.map = v; })),
        this.row("", h("div.form-checks", {},
          this.bit("Shown from the start", () => ch.flags, (v) => { ch.flags = v; }, 1, "Flag 1: the button is there before the campaign unlocks it"),
          this.bit("Flag 2", () => ch.flags, (v) => { ch.flags = v; }, 2, "Set on interludes and cinematics in the samples; meaning unconfirmed"))),
        c.version === 1 && ch.flags > 3 ? h("p.muted", {}, `Stored flags: ${ch.flags} (old campaigns store leftover values here).`) : null) : null,
      h("div.form-section", {}, h("h3", {}, "Maps in the campaign"),
        h("p.muted", {}, `${maps.length} maps: ${maps.filter((m) => m.project).length} unpacked as projects under maps/, ${maps.filter((m) => !m.project).length} packed.` +
          (unused.length ? ` Not on a chapter button: ${unused.map((m) => m.name).join(", ")}.` : "")),
        maps.length ? h("table.form-table.camp-maps", {}, h("tbody", {}, ...maps.map((m) => h("tr.camp-map-row", { "data-map": m.name },
          h("td", {}, m.name), h("td.muted", {}, m.project ? "project" : "packed"),
          h("td", {},
            h("button.camp-map-export", { title: "Save it as a map file of its own", onclick: run(() => this.exportMap(m.name)) }, "Export…"),
            ...(this.editable ? [
              h("button.camp-map-replace", { title: "Another map file in its place, under the same name (Ctrl+Z takes it back)", onclick: run(() => this.replaceMap(m.name)) }, "Replace…"),
              h("button.camp-map-remove", { title: "Take it out of the campaign (Ctrl+Z puts it back)", onclick: run(() => this.removeMap(m.name)) }, "Remove")] : [])))))) : null),
    ];
  }
}
