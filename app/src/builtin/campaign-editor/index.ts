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
import { joinPath } from "../../lib/paths";
import { addChapter } from "./chapters";
import { StringTable, WtsCutError, askWtsCuts, wtsCuts, wtsSafeText } from "../../lib/formats/wts";
import { h } from "../../workbench/dom";
import { askNewCampaign, createCampaign } from "./newcampaign";

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
          row("Game Interface", run(() => w3.commands.execute("w3.gameInterface.open")), undefined, "The campaign's war3campaignSkin.txt")));
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
          dispose: () => { stop.dispose(); openViews.delete(view); },
        };
      },
    }),
  );
}

/** What undo restores: the campaign info and the edited string table texts. */
interface State { info: CampaignInfo; texts: Map<number, string> }

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
  /** `rerender`: false while typing (the field keeps focus). */
  private change(fn: () => void, rerender = true) {
    if (!this.editable) return;
    this.undoStack.push(this.snapshot());
    this.redoStack = [];
    if (this.savedAt > this.undoStack.length - 1) this.savedAt = -1;
    fn();
    this.setDirty(this.undoStack.length !== this.savedAt);
    if (rerender) this.render();
  }
  undo() { this.step(this.undoStack, this.redoStack); }
  redo() { this.step(this.redoStack, this.undoStack); }
  private step(from: State[], to: State[]) {
    const s = from.pop();
    if (!s) return;
    to.push(this.snapshot());
    this.restore(s);
    this.setDirty(this.undoStack.length !== this.savedAt);
    this.render();
  }
  private keyDown(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if ((t instanceof HTMLInputElement && t.type !== "checkbox") || t instanceof HTMLTextAreaElement) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) { this.step(this.undoStack, this.redoStack); e.preventDefault(); }
    else if (k === "y" || (k === "z" && e.shiftKey)) { this.step(this.redoStack, this.undoStack); e.preventDefault(); }
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
  private num(value: number, set: (n: number) => void, opts: { int?: boolean } = {}) {
    const input = h("input.form-input.form-num", { type: "number", value: String(value), step: opts.int ? "1" : "any", readOnly: !this.editable });
    input.addEventListener("change", () => {
      const n = Number(input.value);
      if (input.value === "" || Number.isNaN(n) || (opts.int && !Number.isInteger(n))) { input.classList.add("invalid"); return; }
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
    await this.w3.window.withProgress(`Adding ${name}`, () => this.w3.backend.invoke("project_unpack", {
      map: src, dir, allowIncomplete: false, install: this.w3.settings.get<string>("game.installDir"),
    }));
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
          h("button.camp-interface", { title: "war3campaignSkin.txt: icons, models, sounds and texts of the interface for every chapter", onclick: run(() => this.w3.commands.execute("w3.gameInterface.open")) }, "Game Interface…"))),
      h("div.form-section", {}, h("h3", {}, "File"),
        h("p.muted", {}, `Format version ${c.version} · saved ${c.campaignVersion} times · editor ${c.editorVersion}`)),
    ];
  }

  private screen(): HTMLElement[] {
    const c = this.info;
    return [
      h("div.form-section", {}, h("h3", {}, "Background"),
        this.row("Background", this.num(c.background, (v) => { c.background = v; }, { int: true }), "Preset number; -1: the model or movie below"),
        this.row("Custom background", this.text(() => c.backgroundPath, (v) => { c.backgroundPath = v; }), "Model (.mdx) or movie in the campaign or the game"),
        this.row("Campaign picture", this.text(() => c.minimapPath, (v) => { c.minimapPath = v; }), "Shown in the campaign list")),
      h("div.form-section", {}, h("h3", {}, "Ambient Sound"),
        this.row("Sound", this.num(c.ambientSound, (v) => { c.ambientSound = v; }, { int: true }), "Preset number; -1: the file below; 0: none"),
        this.row("Custom sound", this.text(() => c.ambientSoundPath, (v) => { c.ambientSoundPath = v; }))),
      h("div.form-section", {}, h("h3", {}, "Fog"),
        this.row("Fog style", this.num(c.fogStyle, (v) => { c.fogStyle = v; }, { int: true }), "-1 or 0: no fog"),
        this.row("Start / end height", h("div.form-inline", {}, this.num(c.fogStartZ, (v) => { c.fogStartZ = v; }), this.num(c.fogEndZ, (v) => { c.fogEndZ = v; }))),
        this.row("Density", this.num(c.fogDensity, (v) => { c.fogDensity = v; })),
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
            h("button", { disabled: !ch, onclick: () => this.change(() => { c.chapters.splice(i, 1); this.selected = Math.min(i, c.chapters.length - 1); }) }, "Remove button"),
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
          (unused.length ? ` Not on a chapter button: ${unused.map((m) => m.name).join(", ")}.` : ""))),
    ];
  }
}
