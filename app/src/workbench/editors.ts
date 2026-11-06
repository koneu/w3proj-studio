import type { Disposable, EditorContribution, EditorDocument, EditorInstance, EditorProvider } from "../extensions/api";
import { disposable, Emitter, globMatch, h } from "./dom";

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
}

/** Open tabs as remembered per project (see EditorService.memory). */
export interface OpenEditors {
  tabs: { path: string; editor: string }[];
  active?: string;
}

export interface DocumentIO {
  resolve(path: string): string | null;
  readOnly(path: string): boolean;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeText(path: string, text: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
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

  /** Whether an editor of the file has unsaved changes. */
  unsavedPaths(): string[] {
    return [...new Set(this.tabs.filter((t) => t.dirty).map((t) => t.path))];
  }

  isDirty(path: string): boolean {
    return this.tabs.some((t) => t.path.toLowerCase() === path.toLowerCase() && t.dirty);
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
    const existing = this.tabs.find((t) => t.path === path && (!providerId || t.providerId === providerId));
    if (existing) return this.show(existing);
    const sameFile = this.tabs.find((t) => t.path === path);
    if (sameFile && providerId) await this.close(sameFile);

    let id = providerId ?? this.associated(path) ?? this.candidates(path).find((c) => c.priority !== "option")?.id;
    id ??= await this.fallback(path);
    const provider = await this.provider(id, path);
    const tab = this.addTab(path, id);
    this.show(tab);
    await this.resolveTab(tab, provider);
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
      for (const { path, editor } of state.tabs) {
        if (this.tabs.some((t) => t.path === path) || !this.contributions.some((c) => c.id === editor) && !this.providers.has(editor)) continue;
        this.addTab(path, editor).pending = true;
      }
    } finally {
      this.remembering = true;
    }
    const active = this.tabs.find((t) => t.path === state.active) ?? this.tabs.find((t) => t.pending);
    if (active) this.show(active);
  }

  private remember() {
    if (!this.remembering || this.awaitingRestore || !this.memory) return;
    this.memory.store({ tabs: this.tabs.map((t) => ({ path: t.path, editor: t.providerId })), active: this.active?.path });
  }

  private async load(tab: Tab) {
    try {
      tab.instance = await tab.provider!.resolve(tab.el, tab.doc!);
      this.showActions();
      if (this.active === tab) tab.instance.focus?.();
    } catch (e) {
      tab.el.replaceChildren(h("div.editor-error", {}, `Could not open ${tab.path}: ${e}`));
    }
  }

  /** Files changed outside the app: their editors without unsaved changes open the file again
   *  (in place); resolves with the paths whose editors have unsaved changes (left as they are). */
  async reload(paths: Set<string>): Promise<string[]> {
    const kept: string[] = [];
    for (const t of this.tabs.filter((x) => paths.has(x.path.toLowerCase()) && x.provider)) {
      if (t.dirty) { kept.push(t.path); continue; }
      await this.reopen(t);
    }
    return kept;
  }

  /** Opens a tab's editor again in place (its file as it is now). */
  private async reopen(t: Tab) {
    t.conflict = undefined;
    t.instance?.dispose?.();
    t.instance = undefined;
    t.el.replaceChildren();
    t.doc?.setDirty(false);
    await this.load(t);
  }

  /** Runs one of a tab's own writes (or its save): saves meanwhile aren't another writer's. */
  private async own<T>(tab: Tab, f: () => Promise<T>): Promise<T> {
    tab.writing++;
    try { return await f(); } finally { tab.writing--; }
  }

  /** A project file was saved inside the app (another editor, a tool, a sync). Editors of it
   *  other than the writer open it again, or, with unsaved changes, say so and offer to; editors
   *  watching it (`EditorInstance.watches`) open again when they have no unsaved changes. */
  async fileSaved(path: string) {
    const key = path.replace(/\\/g, "/").toLowerCase();
    for (const t of this.tabs.filter((x) => x.provider && x.instance && x.writing === 0)) {
      const own = t.path.toLowerCase() === key;
      if (!own && !t.instance!.watches?.some((w) => w.toLowerCase() === key)) continue;
      if (!t.dirty) {
        const inPlace = await t.instance!.reloadFile?.(key).catch(() => false);
        if (!inPlace && t.instance) await this.reopen(t);
        continue;
      }
      if (!own || t.conflict) continue;
      const bar: HTMLElement = h("div.editor-conflict", {},
        h("span", {}, "This file was saved by another editor or tool while you have unsaved changes here."),
        h("button", { onclick: () => void this.reopen(t) }, "Reload (discard mine)"),
        h("button", { title: "Saving here overwrites the other save", onclick: () => { bar.remove(); t.conflict = undefined; } }, "Keep mine"));
      t.conflict = bar;
      t.el.prepend(bar);
    }
  }

  async save() {
    const t = this.active;
    if (t?.instance?.save) {
      await this.own(t, () => t.instance!.save!());
      this.resolved(t);
    }
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

  /** Saves every editor with unsaved changes; resolves with how many were saved. */
  async saveAll(): Promise<number> {
    let n = 0;
    for (const t of this.tabs) {
      if (t.dirty && t.instance?.save) { await this.own(t, () => t.instance!.save!()); this.resolved(t); n++; }
    }
    return n;
  }

  /** Before switching projects: asks once about unsaved changes (save all, discard, cancel),
   *  then closes every editor. False when cancelled (nothing closed). */
  async closeAllAsking(): Promise<boolean> {
    const dirty = this.tabs.filter((t) => t.dirty);
    if (dirty.length) {
      const names = dirty.map((t) => t.path.split(/[/:]/).pop()).join(", ");
      const r = await this.confirm(`Unsaved changes in ${dirty.length === 1 ? names : `${dirty.length} files (${names})`}. Save before closing?`,
        "Save All", "Don't Save", "Cancel");
      if (r === "Save All") { for (const t of dirty) if (t.instance?.save) await this.own(t, () => t.instance!.save!()); }
      else if (r !== "Don't Save") return false;
    }
    await this.closeAll();
    return true;
  }

  /** Closes every editor (e.g. for a project switch: the project's tabs stay remembered). */
  async closeAll() {
    this.remembering = false;
    try {
      for (const t of [...this.tabs]) await this.close(t, true);
    } finally {
      this.remembering = true;
    }
  }

  private async close(tab: Tab, force = false) {
    if (tab.dirty && !force) {
      const r = await this.confirm(`Save changes to ${tab.path}?`, "Save", "Don't Save");
      if (r === "Save" && tab.instance?.save) await this.own(tab, () => tab.instance!.save!());
      else if (r !== "Don't Save") return;
    }
    tab.instance?.dispose?.();
    tab.el.remove();
    tab.tabEl.remove();
    const i = this.tabs.indexOf(tab);
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
        (e) => tab.el.replaceChildren(h("div.editor-error", {}, `Could not open ${tab.path}: ${e instanceof Error ? e.message : e}`)));
    }
  }
}
