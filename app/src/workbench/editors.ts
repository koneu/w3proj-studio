import type { Disposable, EditorContribution, EditorDocument, EditorInstance, EditorProvider } from "../extensions/api";
import { disposable, Emitter, globMatch, h } from "./dom";

interface Tab {
  path: string;
  providerId: string;
  el: HTMLElement;
  tabEl: HTMLElement;
  instance?: EditorInstance;
  dirty: boolean;
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
  private content = h("div.editor-content");
  private empty = h("div.editor-empty", {}, h("div.watermark", {}, "W3Proj Studio"), h("div.hint", {}, "Ctrl+Shift+P — Command Palette"));
  private contributions: (EditorContribution & { extensionId: string })[] = [];
  private providers = new Map<string, EditorProvider>();
  private tabs: Tab[] = [];
  private active: Tab | null = null;
  readonly onDidChangeActive = new Emitter<string | null>();
  activate: (event: string) => Promise<void> = async () => {};
  /** "editorAssociations" setting: glob → editor id; checked before manifest defaults. */
  associations: () => Record<string, string> = () => ({});
  /** Fallback when no contribution matches: decides text vs binary. */
  fallback: (path: string) => Promise<string> = async () => "w3.textEditor";
  confirm: (message: string, ...actions: string[]) => Promise<string | undefined> = async () => undefined;
  /** Why an extension's editor isn't available (disabled, failed to activate). */
  whyUnavailable: (extensionId: string) => string | undefined = () => undefined;

  constructor(private io: DocumentIO) {
    this.content.append(this.empty);
    this.root.append(this.tabsEl, this.content);
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

  activePath(): string | null {
    return this.active?.path ?? null;
  }

  async open(path: string, providerId?: string) {
    const existing = this.tabs.find((t) => t.path === path && (!providerId || t.providerId === providerId));
    if (existing) return this.show(existing);
    const sameFile = this.tabs.find((t) => t.path === path);
    if (sameFile && providerId) await this.close(sameFile);

    let id = providerId ?? this.associated(path) ?? this.candidates(path).find((c) => c.priority !== "option")?.id;
    id ??= await this.fallback(path);
    // Always fired: extensions that hook into an editor (e.g. terrain tool groups)
    // start with it even when the editor's own extension is already running.
    await this.activate(`onEditor:${id}`);
    const provider = this.providers.get(id);
    if (!provider) {
      const ext = this.contributions.find((c) => c.id === id)?.extensionId;
      const why = ext ? this.whyUnavailable(ext) : undefined;
      throw new Error(why ? `Can't open ${path}: ${why}` : `no editor provider ${id} — is its extension disabled ("extensions.disabled") or failed to load?`);
    }

    const el = h("div.editor-pane");
    const title = path.startsWith("w3:")
      ? (this.contributions.find((c) => c.id === id)?.title ?? path)
      : path.split(/[/:]/).pop()!;
    const tab: Tab = { path, providerId: id, el, dirty: false, tabEl: h("div.tab", { title: path }) };
    const closeBtn = h("span.tab-close", { onclick: (e: MouseEvent) => { e.stopPropagation(); this.close(tab); } }, "×");
    tab.tabEl.append(h("span.tab-label", {}, title), closeBtn);
    tab.tabEl.addEventListener("mousedown", (e) => {
      if (e.button === 1) { e.preventDefault(); this.close(tab); }
      else if (e.button === 0) this.show(tab);
    });
    this.tabs.push(tab);
    this.tabsEl.append(tab.tabEl);
    this.content.append(el);
    this.show(tab);

    const doc: EditorDocument = {
      path,
      absolutePath: this.io.resolve(path),
      readOnly: this.io.readOnly(path),
      readText: () => this.io.readText(path),
      readBytes: () => this.io.readBytes(path),
      writeText: (text) => this.io.writeText(path, text),
      writeBytes: (bytes) => this.io.writeBytes(path, bytes),
      setDirty: (d) => { tab.dirty = d; tab.tabEl.classList.toggle("dirty", d); },
    };
    try {
      tab.instance = await provider.resolve(el, doc);
      if (this.active === tab) tab.instance.focus?.();
    } catch (e) {
      el.replaceChildren(h("div.editor-error", {}, `Could not open ${path}: ${e}`));
    }
  }

  async save() {
    const t = this.active;
    if (t?.instance?.save) {
      await t.instance.save();
    }
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
      if (t.dirty && t.instance?.save) { await t.instance.save(); n++; }
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
      if (r === "Save All") { for (const t of dirty) await t.instance?.save?.(); }
      else if (r !== "Don't Save") return false;
    }
    await this.closeAll();
    return true;
  }

  async closeAll() {
    for (const t of [...this.tabs]) await this.close(t, true);
  }

  private async close(tab: Tab, force = false) {
    if (tab.dirty && !force) {
      const r = await this.confirm(`Save changes to ${tab.path}?`, "Save", "Don't Save");
      if (r === "Save") await tab.instance?.save?.();
      else if (r !== "Don't Save") return;
    }
    tab.instance?.dispose?.();
    tab.el.remove();
    tab.tabEl.remove();
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.show(next);
      else {
        this.empty.hidden = false;
        this.onDidChangeActive.fire(null);
      }
    }
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
    this.onDidChangeActive.fire(tab.path);
  }
}
