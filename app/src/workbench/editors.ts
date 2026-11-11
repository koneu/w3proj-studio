import type { Disposable, EditorContribution, EditorDocument, EditorInstance, EditorProvider } from "../extensions/api";
import { disposable, errorView, Emitter, globMatch, h } from "./dom";
import { graphicsModeReopens, keptView } from "./tabmemory";
import type { Stamp } from "./workspace";

interface Tab {
  path: string;
  providerId: string;
  el: HTMLElement;
  tabEl: HTMLElement;
  instance?: EditorInstance;
  dirty: boolean;
  doc?: EditorDocument;
  provider?: EditorProvider;
  /** Restored but not opened yet: the editor is created when the tab is first shown. */
  pending?: boolean;
  /** Writes of its own in progress (its document's writes, its save): those aren't "someone else". */
  writing: number;
  /** The bar saying another writer saved the file while it had unsaved changes. */
  conflict?: HTMLElement;
  /** Its editor is being created: what is saved meanwhile may have been read before the save. */
  loading?: boolean;
  /** Files saved (in the app or on disk; their keys) while it loaded: looked at once it's there. */
  missed?: Set<string>;
  /** Its editor couldn't be created: opening the file again, or the file being saved, tries again. */
  failed?: boolean;
  /** The file's size, time and contents' hash when the editor read it or last wrote it; a save over anything
   *  else asks first. Undefined: not a file on disk, or not known. */
  stamp?: Stamp | null;
  /** The view state its next editor gets (remembered from the last session, or kept over a reopen in place). */
  view?: unknown;
}

/** Size and time alike, and, where both have one, the contents' hash: a same-size write in the same millisecond
 *  leaves the first two as they were. */
const sameStamp =(a: Stamp | null, b: Stamp | null) => a === b
  || (!!a && !!b && a.size === b.size && a.modified === b.modified && (a.hash === undefined || b.hash === undefined || a.hash === b.hash));

/** Open tabs as remembered per project (see EditorService.memory). */
export interface OpenEditors {
  /** `view`: what the tab's editor gave as its viewState (see keptView). */
  tabs: { path: string; editor: string; view?: unknown }[];
  active?: string;
}

export interface DocumentIO {
  resolve(path: string): string | null;
  readOnly(path: string): boolean;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeText(path: string, text: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** The file's size and time on disk now, and a hash of its contents where it can (null: it doesn't exist;
   *  undefined: not a file on disk). */
  stat?(path: string): Promise<Stamp | null | undefined>;
  /** The key a file is known by (the workspace's `key`: lower case only where the file system ignores case);
   *  without it, lower case. Saved and changed files are matched to tabs by it. */
  key?(path: string): string;
}

/** Tabbed editor area. Picks an editor provider per file from the
 *  manifests' `editors` contributions. */
export class EditorService {
  readonly root = h("div.editor-area");
  private tabsEl = h("div.tabs");
  private undoButton = h("button.tabs-action", { title: "Undo", "aria-label": "Undo", onclick: () => this.undo() }, "↶");
  private redoButton = h("button.tabs-action", { title: "Redo", "aria-label": "Redo", onclick: () => this.redo() }, "↷");
  private tabActions = h("div.tabs-actions", {}, this.undoButton, this.redoButton);
  private content = h("div.editor-content");
  private empty = h("div.editor-empty", {}, h("div.watermark", {}, "W3Proj Studio"), h("div.hint", {}, "Ctrl+Shift+P — Command Palette"));
  private contributions: (EditorContribution & { extensionId: string })[] = [];
  private providers = new Map<string, EditorProvider>();
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  /** The active tab (file and editor id), or null when none is open. */
  readonly onDidChangeActive = new Emitter<{ path: string; editor: string } | null>();
  activate: (event: string) => Promise<void> = async () => {};
  /** "editorAssociations" setting: glob → editor id; checked before manifest defaults. */
  associations: () => Record<string, string> = () => ({});
  /** Fallback when no contribution matches: decides text vs binary. */
  fallback: (path: string) => Promise<string> = async () => "w3.textEditor";
  confirm: (message: string, ...actions: string[]) => Promise<string | undefined> = async () => undefined;
  /** Why an extension's editor isn't available (disabled, failed to activate). */
  whyUnavailable: (extensionId: string) => string | undefined = () => undefined;
  /** Where the open tabs are remembered (per project; null: not remembered). */
  memory: { load(): OpenEditors | null; store(state: OpenEditors): void } | null = null;
  /** Off while tabs are closed for a project switch or restored. */
  private remembering = true;
  /** From startup, and whenever a project opens, until its tabs are restored: tabs closed
   *  meanwhile (the welcome page at startup) must not overwrite what is remembered. */
  private awaitingRestore = true;

  /** A project was opened: the next restore() brings its tabs back; until then nothing is stored. */
  projectOpened() {
    this.awaitingRestore = true;
  }

  constructor(private io: DocumentIO) {
    this.content.append(this.empty);
    this.tabActions.hidden = true;
    this.root.append(h("div.tabs-row", {}, this.tabsEl, this.tabActions), this.content);
  }

  contribute(extensionId: string, c: EditorContribution) {
    this.contributions.push({ ...c, extensionId });
  }

  registerProvider(id: string, provider: EditorProvider): Disposable {
    this.providers.set(id, provider);
    return disposable(() => this.providers.delete(id));
  }

  /** Editors that can open a path, default ones first. */
  candidates(path: string) {
    return this.contributions
      .filter((c) => c.patterns.some((p) => globMatch(p, path)))
      // Defaults first; among them an exact file name ("war3mapMisc.txt") before a wildcard ("*.txt").
      .sort((a, b) => (a.priority === "option" ? 1 : 0) - (b.priority === "option" ? 1 : 0)
        || Number(!a.patterns.some((p) => !p.includes("*") && globMatch(p, path))) - Number(!b.patterns.some((p) => !p.includes("*") && globMatch(p, path))));
  }

  /** Editor chosen for a path by the "editorAssociations" setting, if it exists. */
  associated(path: string): string | undefined {
    for (const [glob, id] of Object.entries(this.associations())) {
      if (globMatch(glob, path) && this.contributions.some((c) => c.id === id)) return id;
    }
    return undefined;
  }

  allContributions() {
    return this.contributions;
  }

  /** Whether the tab has unsaved changes, counting edits its editor still holds back (EditorInstance.flush):
   *  typed a moment ago, they would otherwise be lost to a close or a reload that thinks the tab is clean. */
  private unsaved(t: Tab): boolean {
    this.flush(t);
    return t.dirty;
  }
  /** Applies the tab's held-back edits (EditorInstance.flush); one that fails leaves the tab as it was. */
  private flush(t: Tab) {
    try { t.instance?.flush?.(); } catch (e) { console.error(`flushing ${t.path}:`, e); }
  }

  /** Whether an editor of the file has unsaved changes. */
  unsavedPaths(): string[] {
    return [...new Set(this.tabs.filter((t) => this.unsaved(t)).map((t) => t.path))];
  }

  isDirty(path: string): boolean {
    const key = this.key(path);
    return this.tabs.some((t) => this.key(t.path) === key && this.unsaved(t));
  }

  /** Undoes in the active editor, wherever the focus is, and leaves the focus in it. False: it can't. */
  undo() { return this.step("undo"); }
  redo() { return this.step("redo"); }
  private step(what: "undo" | "redo") {
    const t = this.active?.instance;
    if (!t?.[what]) return false;
    t[what]!();
    t.focus?.();
    return true;
  }
  /** The buttons belong to the active editor: without undo of its own it shows none. */
  private showActions() { this.tabActions.hidden = !this.active?.instance?.undo; }

  activePath(): string | null {
    return this.active?.path ?? null;
  }

  /** What the active editor can do: the Welcome page is a tab, but has nothing to save. */
  canSave() { return !!this.active?.instance?.save; }
  canUndo() { return !!this.active?.instance?.undo; }

  async open(path: string, providerId?: string) {
    const opened = () => this.tabs.find((t) => t.path === path && (!providerId || t.providerId === providerId));
    /** The file's tab in another editor is closed first: false when that's cancelled (unsaved changes). */
    const closeOther = async () => {
      const other = this.tabs.find((t) => t.path === path);
      return !other || !providerId || this.close(other);
    };
    const existing = opened();
    if (existing) return this.showAgain(existing);
    if (!(await closeOther())) return;

    let id = providerId ?? this.associated(path) ?? this.candidates(path).find((c) => c.priority !== "option")?.id;
    id ??= await this.fallback(path);
    const provider = await this.provider(id, path);
    // Opened meanwhile, while the editor's extension started: by the project's tabs coming back
    // (restore) or another open of the same file. That tab, not a second editor loading it all
    // again; in another editor, it's closed as above, and if that's cancelled nothing opens.
    for (;;) {
      const meanwhile = opened();
      if (meanwhile) return this.showAgain(meanwhile);
      if (!this.tabs.some((t) => t.path === path)) break;
      if (!(await closeOther())) return;
    }
    const tab = this.addTab(path, id);
    this.show(tab);
    await this.resolveTab(tab, provider);
  }

  /** An open tab asked for again: shown, and if its editor couldn't be created (the file wasn't
   *  there yet: a tab of the project's last session, a file being written), created again. */
  private async showAgain(tab: Tab) {
    this.show(tab);
    if (!tab.failed || tab.loading) return;
    if (tab.provider) return this.reopen(tab);
    tab.failed = false;
    await this.resolveTab(tab, await this.provider(tab.providerId, tab.path));
  }

  /** The provider of an editor id, its extension activated first. */
  private async provider(id: string, path: string): Promise<EditorProvider> {
    // Always fired: extensions that hook into an editor (e.g. terrain tool groups)
    // start with it even when the editor's own extension is already running.
    await this.activate(`onEditor:${id}`);
    const provider = this.providers.get(id);
    if (!provider) {
      const ext = this.contributions.find((c) => c.id === id)?.extensionId;
      const why = ext ? this.whyUnavailable(ext) : undefined;
      throw new Error(why ? `Can't open ${path}: ${why}` : `no editor provider ${id} — is its extension disabled ("extensions.disabled") or failed to load?`);
    }
    return provider;
  }

  /** Where keys go that no element has the focus for: a focusable canvas (3D editors listen
   *  there), else the active editor's pane. */
  keyTarget(): HTMLElement | null {
    return this.active ? this.active.el.querySelector<HTMLElement>("canvas[tabindex]") ?? this.active.el : null;
  }

  private addTab(path: string, id: string): Tab {
    const el = h("div.editor-pane", { tabindex: -1 });
    // Virtual documents show their editor's title; "w3:<kind>:<file>" ones (e.g. a diff) the file too.
    const editorTitle = this.contributions.find((c) => c.id === id)?.title ?? path;
    const about = /^w3:[^:]+:(.+)$/.exec(path)?.[1];
    const title = path.startsWith("w3:")
      ? (about ? `${about.split("/").pop()} (${editorTitle})` : editorTitle)
      : path.split(/[/:]/).pop()!;
    const tab: Tab = { path, providerId: id, el, dirty: false, writing: 0, tabEl: h("div.tab", { title: path }) };
    const closeBtn = h("span.tab-close", { onclick: (e: MouseEvent) => { e.stopPropagation(); this.close(tab); } }, "×");
    tab.tabEl.append(h("span.tab-label", {}, title), closeBtn);
    tab.tabEl.addEventListener("mousedown", (e) => {
      if (e.button === 1) { e.preventDefault(); this.close(tab); }
      else if (e.button === 0) this.show(tab);
    });
    this.tabs.push(tab);
    this.tabsEl.append(tab.tabEl);
    this.content.append(el);
    el.hidden = true;
    return tab;
  }

  private async resolveTab(tab: Tab, provider: EditorProvider) {
    const path = tab.path;
    const doc: EditorDocument = {
      path,
      absolutePath: this.io.resolve(path),
      readOnly: this.io.readOnly(path),
      readText: () => this.io.readText(path),
      readBytes: () => this.io.readBytes(path),
      writeText: (text) => this.own(tab, () => this.io.writeText(path, text)),
      writeBytes: (bytes) => this.own(tab, () => this.io.writeBytes(path, bytes)),
      setDirty: (d) => { tab.dirty = d; tab.tabEl.classList.toggle("dirty", d); },
      // Read when the editor is made: a reopen in place gives the state from just before.
      get viewState() { return tab.view; },
    };
    tab.doc = doc;
    tab.provider = provider;
    await this.load(tab);
  }

  /** Reopens the tabs remembered for the current project (the active one is loaded, the
   *  others when they are first shown). Tabs already open stay. */
  async restore() {
    this.awaitingRestore = false;
    const state = this.memory?.load();
    if (!state?.tabs.length) return;
    this.remembering = false;
    try {
      for (const { path, editor, view } of state.tabs) {
        if (this.tabs.some((t) => t.path === path) || !this.contributions.some((c) => c.id === editor) && !this.providers.has(editor)) continue;
        const tab = this.addTab(path, editor);
        tab.pending = true;
        tab.view = keptView(view);
      }
    } finally {
      this.remembering = true;
    }
    const active = this.tabs.find((t) => t.path === state.active) ?? this.tabs.find((t) => t.pending);
    if (active) this.show(active);
  }

  /** Stores the open tabs (with their editors' view states) for the project: on every tab change, and before the
   *  window closes or the tabs close for a project switch. */
  remember() {
    if (!this.remembering || this.awaitingRestore || !this.memory) return;
    this.memory.store({ tabs: this.tabs.map((t) => ({ path: t.path, editor: t.providerId, view: this.viewOf(t) })), active: this.active?.path });
  }

  /** What a tab's editor gives as its view state now; a tab not opened yet keeps the one it came back with. */
  private viewOf(t: Tab): unknown {
    if (!t.instance?.viewState) return t.instance ? undefined : t.view;
    try { return keptView(t.instance.viewState()); } catch { return undefined; }
  }

  /** The file's size and time on disk now; undefined when that isn't known. */
  private async stampOf(path: string): Promise<Stamp | null | undefined> {
    return this.io.stat ? this.io.stat(path).catch(() => undefined) : undefined;
  }

  /** The key a file is known by (DocumentIO.key). */
  private key(path: string) {
    return this.io.key ? this.io.key(path) : path.replace(/\\/g, "/").toLowerCase();
  }

  /** The files a tab's editor shows: its own and those it watches (`key`: a file's key). */
  private shows(t: Tab, key: string) {
    return this.key(t.path) === key || !!t.instance?.watches?.some((w) => this.key(w) === key);
  }

  private async load(tab: Tab) {
    // Set before anything is awaited: a save from now on may come after the editor read the file.
    tab.loading = true;
    tab.failed = false;
    tab.missed = new Set();
    try {
      tab.stamp = await this.stampOf(tab.path);
      const instance = await tab.provider!.resolve(tab.el, tab.doc!);
      // The tab was closed while its editor loaded: nobody would dispose it (GPU buffers, timers, listeners).
      if (!this.tabs.includes(tab)) { instance.dispose?.(); return; }
      tab.instance = instance;
      this.showActions();
      if (this.active === tab) tab.instance.focus?.();
    } catch (e) {
      tab.failed = true;
      tab.el.replaceChildren(errorView(`Could not open ${tab.path}: ${e}`));
    } finally {
      tab.loading = false;
    }
    // Saved while it loaded (an AI tool right after the project opened and brought this tab back, a
    // file still being written): what it shows may be from before. Opened again, or flagged.
    const missed = [...tab.missed ?? []];
    tab.missed = undefined;
    if (!this.tabs.includes(tab)) return;
    if (tab.failed ? missed.includes(this.key(tab.path)) : missed.some((k) => this.shows(tab, k))) {
      if (!this.unsaved(tab)) await this.reopen(tab);
      else this.flagConflict(tab);
    }
  }

  /** Files changed outside the app: their editors without unsaved changes, and those watching
   *  them, open the file again (in place); resolves with the paths whose editors have unsaved
   *  changes (left as they are). */
  async reload(paths: Set<string>): Promise<string[]> {
    const kept: string[] = [];
    for (const t of this.tabs.filter((x) => x.provider)) {
      if (t.loading) { for (const k of paths) t.missed?.add(k); continue; }
      if (![...paths].some((k) => this.shows(t, k)) && !(t.failed && paths.has(this.key(t.path)))) continue;
      if (this.unsaved(t)) { kept.push(t.path); continue; }
      const own = paths.has(this.key(t.path));
      const inPlace = !own && t.instance?.reloadFile
        ? (await Promise.all([...paths].filter((k) => this.shows(t, k)).map((k) => t.instance!.reloadFile!(k.toLowerCase()).catch(() => false)))).every(Boolean)
        : false;
      if (inPlace) t.stamp = await this.stampOf(t.path);
      else await this.reopen(t);
    }
    return kept;
  }

  /** Opens the editors of one file (of one provider, if given) again in place, in their tabs: what they show
   *  depends on more than the file (the graphics mode). Those with unsaved changes are left as they are; one still
   *  loading opens again once it's there (if it has none then); one not opened yet loads anew anyway. Resolves with
   *  how many were left for unsaved changes. */
  async reopenClean(path: string, providerId?: string): Promise<number> {
    const key = this.key(path);
    return (await this.reopenCleanWhere((t) => this.key(t.path) === key && (!providerId || t.providerId === providerId))).length;
  }

  /** reopenClean for the tabs `which` picks; resolves with the paths of those left for unsaved changes. */
  private async reopenCleanWhere(which: (t: Tab) => boolean): Promise<string[]> {
    const kept: string[] = [];
    for (const t of this.tabs.filter((x) => x.provider && which(x))) {
      // Closed while an earlier tab of this loop was opening again.
      if (!this.tabs.includes(t)) continue;
      if (t.loading) { t.missed?.add(this.key(t.path)); continue; }
      if (this.unsaved(t)) { kept.push(t.path); continue; }
      await this.reopen(t);
    }
    return kept;
  }

  /** The graphics mode changed: the tabs showing the mode's art (graphicsModeReopens) open again in place, their
   *  view states kept. Resolves with the files of those left as they are for unsaved changes. */
  async followGraphicsMode(): Promise<string[]> {
    const kept = await this.reopenCleanWhere((t) => graphicsModeReopens(this.contributions.find((c) => c.id === t.providerId), t.path));
    return [...new Set(kept)];
  }

  /** Opens a tab's editor again in place (its file as it is now), where it was (its view state). */
  private async reopen(t: Tab) {
    if (t.instance) t.view = this.viewOf(t);
    t.conflict = undefined;
    t.instance?.dispose?.();
    t.instance = undefined;
    t.el.replaceChildren();
    t.doc?.setDirty(false);
    await this.load(t);
  }

  /** Runs one of a tab's own writes (or its save): saves meanwhile aren't another writer's. What
   *  the file is afterwards is the editor's own. */
  private async own<T>(tab: Tab, f: () => Promise<T>): Promise<T> {
    tab.writing++;
    let r: T;
    try { r = await f(); } finally { tab.writing--; }
    if (tab.stamp !== undefined) tab.stamp = await this.stampOf(tab.path);
    return r;
  }

  /** Whether a tab may save: when its file changed on disk since the editor read or last wrote it
   *  (another program, git, a tool it didn't hear of), only if the user says so. */
  private async mayOverwrite(t: Tab): Promise<boolean> {
    if (t.stamp === undefined) return true;
    const now = await this.stampOf(t.path);
    if (now === undefined || sameStamp(now, t.stamp)) return true;
    const name = t.path.split(/[/:]/).pop();
    const r = await this.confirm(`${name} changed on disk since this editor read it${now ? "" : " (it was deleted)"}. Saving writes over that change with what the editor has.`, "Overwrite", "Cancel");
    return r === "Overwrite";
  }

  /** Saves a tab (asking first if its file changed on disk meanwhile). False: not saved. */
  private async saveTab(t: Tab): Promise<boolean> {
    if (!t.instance?.save) return false;
    // What was typed a moment ago is saved with the rest (and isn't left unsaved after the save).
    this.flush(t);
    if (!(await this.mayOverwrite(t))) return false;
    // Typed while the question about the file on disk was open.
    this.flush(t);
    if (!t.instance?.save) return false;
    await this.own(t, () => t.instance!.save!());
    this.resolved(t);
    return true;
  }

  /** A project file was saved inside the app (another editor, a tool, a sync). Editors of it
   *  other than the writer open it again, or, with unsaved changes, say so and offer to; editors
   *  watching it (`EditorInstance.watches`) open again when they have no unsaved changes. */
  async fileSaved(path: string) {
    const key = this.key(path);
    for (const t of this.tabs.filter((x) => x.provider && x.writing === 0)) {
      // Closed while an earlier tab of this loop was reloading.
      if (!this.tabs.includes(t)) continue;
      // Still loading: it may have read the file before this save. Looked at once it's there.
      if (t.loading) { t.missed?.add(key); continue; }
      const own = this.key(t.path) === key;
      // Its editor couldn't be created, perhaps because the file wasn't there yet: it is now.
      if (!t.instance) { if (own && t.failed) await this.reopen(t); continue; }
      if (!this.shows(t, key)) continue;
      if (!this.unsaved(t)) {
        const inPlace = await t.instance!.reloadFile?.(key.toLowerCase()).catch(() => false);
        if (inPlace) t.stamp = await this.stampOf(t.path);
        else if (t.instance) await this.reopen(t);
        continue;
      }
      if (own) this.flagConflict(t);
    }
  }

  /** The bar saying that something else saved the tab's file while it has unsaved changes. */
  private flagConflict(t: Tab) {
    if (t.conflict) return;
    const bar: HTMLElement = h("div.editor-conflict", {},
      h("span", {}, "This file was saved by another editor or tool while you have unsaved changes here."),
      h("button", { onclick: () => void this.reopen(t) }, "Reload (discard mine)"),
      h("button", { title: "Saving here overwrites the other save", onclick: () => void (async () => {
        bar.remove();
        t.conflict = undefined;
        // Chosen: the next save doesn't ask again about this change.
        if (t.stamp !== undefined) t.stamp = await this.stampOf(t.path);
      })() }, "Keep mine"));
    t.conflict = bar;
    t.el.prepend(bar);
  }

  async save() {
    const t = this.active;
    if (t) await this.saveTab(t);
  }

  /** After a tab's own save: its "saved elsewhere" bar is answered (the file is now its own). */
  private resolved(t: Tab) {
    t.conflict?.remove();
    t.conflict = undefined;
  }

  async closeActive() {
    if (this.active) await this.close(this.active);
  }

  /** Closes tabs whose files no longer exist (e.g. after a sync). */
  async closeWhere(pred: (path: string) => boolean) {
    for (const t of this.tabs.filter((t) => pred(t.path))) await this.close(t, true);
  }

  /** Saves the editors of one file that have unsaved changes; resolves with how many were saved. */
  async saveFile(path: string): Promise<number> {
    const key = this.key(path);
    let n = 0;
    for (const t of this.tabs.filter((x) => this.key(x.path) === key)) {
      // Closed while an earlier one was saving.
      if (this.tabs.includes(t) && this.unsaved(t) && (await this.saveTab(t))) n++;
    }
    return n;
  }

  /** Saves every editor with unsaved changes; resolves with how many were saved. */
  async saveAll(): Promise<number> {
    let n = 0;
    for (const t of [...this.tabs]) {
      if (this.unsaved(t) && (await this.saveTab(t))) n++;
    }
    return n;
  }

  /** Before switching projects: asks once about unsaved changes (save all, discard, cancel),
   *  then closes every editor. False when cancelled (nothing closed). */
  async closeAllAsking(): Promise<boolean> {
    const dirty = this.tabs.filter((t) => this.unsaved(t));
    if (dirty.length) {
      const names = dirty.map((t) => t.path.split(/[/:]/).pop()).join(", ");
      const r = await this.confirm(`Unsaved changes in ${dirty.length === 1 ? names : `${dirty.length} files (${names})`}. Save before closing?`,
        "Save All", "Don't Save", "Cancel");
      if (r === "Save All") {
        // One not saved (its file changed on disk and overwriting it was refused): nothing closes.
        let all = true;
        for (const t of dirty) if (t.instance?.save && !(await this.saveTab(t))) all = false;
        if (!all) return false;
      } else if (r !== "Don't Save") return false;
    }
    await this.closeAll();
    return true;
  }

  /** Closes every editor (e.g. for a project switch: the project's tabs stay remembered). */
  async closeAll() {
    // Where each editor was, before they go.
    this.remember();
    this.remembering = false;
    try {
      for (const t of [...this.tabs]) await this.close(t, true);
    } finally {
      this.remembering = true;
    }
  }

  /** True when the tab is gone (closed here or meanwhile), false when closing it was cancelled. */
  private async close(tab: Tab, force = false): Promise<boolean> {
    if (!this.tabs.includes(tab)) return true;
    if (!force && this.unsaved(tab)) {
      const r = await this.confirm(`Save changes to ${tab.path}?`, "Save", "Don't Save");
      if (r === "Save" && tab.instance?.save) { if (!(await this.saveTab(tab))) return false; }
      else if (r !== "Don't Save") return false;
    }
    // Closed by something else while the question was open: splice(-1) would take another tab.
    const i = this.tabs.indexOf(tab);
    if (i < 0) return true;
    tab.instance?.dispose?.();
    tab.instance = undefined;
    tab.el.remove();
    tab.tabEl.remove();
    this.tabs.splice(i, 1);
    if (this.active === tab) {
      this.active = null;
      this.showActions();
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.show(next);
      else {
        this.empty.hidden = false;
        this.onDidChangeActive.fire(null);
      }
    }
    this.remember();
    return true;
  }

  private show(tab: Tab) {
    this.active = tab;
    this.empty.hidden = true;
    for (const t of this.tabs) {
      t.el.hidden = t !== tab;
      t.tabEl.classList.toggle("active", t === tab);
    }
    tab.tabEl.scrollIntoView({ block: "nearest", inline: "nearest" });
    tab.instance?.focus?.();
    this.showActions();
    this.onDidChangeActive.fire({ path: tab.path, editor: tab.providerId });
    this.remember();
    if (tab.pending) {
      tab.pending = false;
      this.provider(tab.providerId, tab.path).then((p) => this.resolveTab(tab, p),
        (e) => { tab.failed = true; tab.el.replaceChildren(errorView(`Could not open ${tab.path}: ${e instanceof Error ? e.message : e}`)); });
    }
  }
}
