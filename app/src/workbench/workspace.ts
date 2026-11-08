import type { ConfigurationProperty, FileInfo, ProjectInfo, SettingInfo, Settings, SettingsTarget, Disposable } from "../extensions/api";
import { invoke, isAbsolutePath, joinPath, readBytes, readText, writeBytes, writeText } from "./backend";
import { onWindows } from "../lib/paths";
import { Emitter } from "./dom";

/** A file's size and last write (ms) as the backend reports them. */
export interface Stamp { size: number; modified: number }
import { timeLimit } from "./timelimit";

export class WorkspaceService {
  private info: ProjectInfo | null = null;
  private fileList: FileInfo[] = [];
  /** The file list's paths, lower case with forward slashes: the lookup for a written file. */
  private listed = new Set<string>();
  private setList(list: FileInfo[]) {
    this.fileList = list;
    this.listed = new Set(list.map((f) => f.path.replace(/\\/g, "/").toLowerCase()));
  }
  private folderList: string[] = [];
  readonly onDidChange = new Emitter<void>();
  /** A project file was written (its path as given, with forward slashes). */
  readonly onDidSave = new Emitter<string>();

  constructor(private settings: SettingsService) {}

  project() {
    return this.info;
  }

  files() {
    return this.fileList;
  }
  folders() {
    return this.folderList;
  }

  async open(path: string) {
    this.info = await invoke<ProjectInfo>("project_open", { path });
    await this.refresh(false);
    await this.settings.loadProject(this.info.root);
    // The list first, as the entries were saved; then, off the open's way, the entries under another
    // spelling of a folder (8.3 short name) are merged (see tidyRecents).
    const root = this.info.root;
    const seen = new Set([root.toLowerCase()]);
    const others = this.settings.get<string[]>("recentProjects", []).filter((p) => !seen.has(p.toLowerCase()) && !!seen.add(p.toLowerCase()));
    await this.settings.set("recentProjects", [root, ...others].slice(0, 10));
    this.tidying = this.tidyRecents(root, ++this.openGen);
    this.onDidChange.fire();
  }

  private tidying: Promise<void> = Promise.resolve();
  /** Counts the opens: a tidy that finishes after a later open is out of date and writes nothing. */
  private openGen = 0;
  /** Resolves when the recent list has been tidied after the last open(). */
  recentsTidied() {
    return this.tidying;
  }

  /** Recent entries that are another spelling of one already listed go; each question to the disk
   *  has a time limit, since an offline share may never answer. */
  private async tidyRecents(root: string, gen: number) {
    try {
      const spelled = await Promise.all(this.settings.get<string[]>("recentProjects", []).map((p) => timeLimit(invoke<string>("path_normalize", { path: p }), 2000).catch(() => p)));
      if (gen !== this.openGen || this.info?.root !== root) return;
      const seen = new Set<string>();
      const list = spelled.filter((p) => !seen.has(p.toLowerCase()) && !!seen.add(p.toLowerCase()));
      if (list.length !== spelled.length || list.some((p, i) => p !== spelled[i])) await this.settings.set("recentProjects", list);
    } catch (e) {
      // Only a tidier list is lost; the open itself went well.
      console.warn(`could not tidy the recent projects: ${e}`);
    }
  }

  close() {
    this.info = null;
    this.setList([]);
    this.folderList = [];
    void this.settings.loadProject(null);
    this.onDidChange.fire();
  }

  async refresh(fire = true) {
    if (!this.info) return;
    // Writes that finish while this reads are neither lost from the list nor left for the next
    // external-change check to report: only what was known when it started is cleared.
    const ownBefore = new Map(this.ownWrites), listedBefore = this.listed;
    this.info = await invoke<ProjectInfo>("project_open", { path: this.info.root });
    const list = await invoke<FileInfo[]>("project_files", { root: this.info.root });
    this.folderList = await invoke<string[]>("project_folders", { root: this.info.root });
    this.setList(this.keepNoticed(list, listedBefore, ownBefore));
    for (const [k, v] of ownBefore) if (this.ownWrites.get(k) === v) this.ownWrites.delete(k);
    if (fire) this.onDidChange.fire();
  }

  /** Files written through the workspace since the last check (lower case), with their size and time as
   *  the disk had them right after the write (null: not known yet). The write counts as ours only while
   *  the disk still matches: another program changing the file afterwards is an external change. */
  private ownWrites = new Map<string, { stamp: Stamp | null; seq: number }>();

  /** `list`, just read from the disk, plus the files our own writes added to the list since
   *  `listedBefore` (the read may have started before they existed). */
  private keepNoticed(list: FileInfo[], listedBefore: ReadonlySet<string>, ownBefore: { has(k: string): boolean }): FileInfo[] {
    const have = new Set(list.map((f) => f.path.replace(/\\/g, "/").toLowerCase()));
    const extra = this.fileList.filter((f) => {
      const k = f.path.replace(/\\/g, "/").toLowerCase();
      return !listedBefore.has(k) && this.ownWrites.has(k) && !ownBefore.has(k) && !have.has(k);
    });
    return extra.length ? [...list, ...extra].sort((x, y) => x.path.toLowerCase().localeCompare(y.path.toLowerCase())) : list;
  }

  /** Re-reads the file list and returns the files changed, added or removed by something else
   *  (git, another program) since the last refresh, lower case; fires onDidChange if any. */
  async externalChanges(): Promise<Set<string>> {
    if (!this.info) return new Set();
    const before = new Map(this.fileList.map((f) => [f.path.toLowerCase(), f]));
    const ownBefore = new Map(this.ownWrites), listedBefore = this.listed;
    const root = this.info.root;
    const after = await invoke<FileInfo[]>("project_files", { root });
    if (this.info?.root !== root) return new Set();
    // Whether a difference is our own write: one that finished during the read always is (the read may
    // have missed it); an earlier one only while the file still has the size and time it was left with.
    const isOwn = (k: string, f?: FileInfo) => {
      if (this.writing.get(k)) return true;
      if (!this.ownWrites.has(k)) return false;
      if (!ownBefore.has(k)) return true;
      const stamp = ownBefore.get(k)!.stamp;
      return !stamp || (!!f && f.size === stamp.size && f.modified === stamp.modified);
    };
    // The listing and a stat of the file can differ in time or size (Windows takes the listing's from the
    // directory entry): where an own write seems changed, the file itself is asked, and if it still has
    // what the write left, the listing is the one that lags and its entry is corrected.
    for (const [k, own] of ownBefore) {
      const i = own.stamp ? after.findIndex((f) => f.path.toLowerCase() === k) : -1;
      if (i < 0 || (after[i].size === own.stamp!.size && after[i].modified === own.stamp!.modified)) continue;
      const truth = await invoke<Stamp | null>("fs_stat", { path: this.resolve(after[i].path) }).catch(() => null);
      if (truth && truth.size === own.stamp!.size && truth.modified === own.stamp!.modified) after[i] = { ...after[i], ...truth };
    }
    if (this.info?.root !== root) return new Set();
    const changed = new Set<string>();
    for (const f of after) {
      const k = f.path.toLowerCase(), b = before.get(k);
      before.delete(k);
      if ((!b || b.size !== f.size || b.modified !== f.modified) && !isOwn(k, f)) changed.add(k);
    }
    for (const k of before.keys()) if (!isOwn(k)) changed.add(k);
    this.setList(this.keepNoticed(after, listedBefore, ownBefore));
    for (const [k, v] of ownBefore) if (this.ownWrites.get(k) === v) this.ownWrites.delete(k);
    if (changed.size) {
      this.info = await invoke<ProjectInfo>("project_open", { path: root });
      this.onDidChange.fire();
    }
    return changed;
  }

  resolve(projectPath: string): string {
    if (/^[a-z]:[\\/]/i.test(projectPath) || projectPath.startsWith("\\\\")) return projectPath;
    // A full Linux path (the settings file, a user's rules) works with no project open too.
    if (!onWindows() && projectPath.startsWith("/")) return projectPath;
    if (!this.info) throw new Error("no project is open");
    if (isAbsolutePath(projectPath, this.info.root)) return projectPath;
    return joinPath(this.info.root, projectPath);
  }

  readText(p: string) {
    return readText(this.resolve(p));
  }
  readBytes(p: string) {
    return readBytes(this.resolve(p));
  }
  async writeText(p: string, text: string) {
    await this.tracked(p, new TextEncoder().encode(text).length, (target) => writeText(target, text));
    this.onDidSave.fire(p.replace(/\\/g, "/"));
  }
  /** The key a file is known by in `ownWrites` and the list: project-relative, `/`, lower case. Null for a
   *  file outside the project or in a folder the list never has (build, .git, node_modules at the top). */
  private keyOf(target: string, root: string | undefined): { rel: string; key: string } | null {
    if (!root) return null;
    const abs = target.replace(/\\/g, "/"), base = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!abs.toLowerCase().startsWith(base.toLowerCase() + "/")) return null;
    const rel = abs.slice(base.length + 1), key = rel.toLowerCase();
    return /^(build|\.git|node_modules)\//.test(key) ? null : { rel, key };
  }
  /** Runs a write of project file `p` that answers with the size and time it left (every backend write
   *  of a project file does), and notes it: the file counts as ours while the write runs, and afterwards
   *  while the disk still has that size and time, so that a change by another program is told from it.
   *  Of overlapping writes to one file the one that started last has the last word. A file the list
   *  doesn't have yet (an export into map/Scripts/) is added to it at once, alone: nothing else is
   *  re-read, so what others changed stays to be noticed. A write that ends after a project switch
   *  is not noted. `size`: what the file will be, for the list until the answer comes. */
  async tracked(p: string, size: number, write: (target: string) => Promise<Stamp | void>): Promise<void> {
    const root = this.info?.root, target = this.resolve(p), at = this.keyOf(target, root);
    if (!at) { await write(target); return; }
    const seq = ++this.writeSeq;
    this.writing.set(at.key, (this.writing.get(at.key) ?? 0) + 1);
    let stamp: Stamp | void;
    try {
      stamp = await write(target);
    } finally {
      const left = (this.writing.get(at.key) ?? 1) - 1;
      if (left > 0) this.writing.set(at.key, left); else this.writing.delete(at.key);
    }
    if (this.info?.root !== root) return;
    const known = this.ownWrites.get(at.key);
    if (known && known.seq > seq) return;
    this.ownWrites.set(at.key, { stamp: stamp ?? null, seq });
    const entry: FileInfo = { path: at.rel, size: stamp ? stamp.size : size, modified: stamp ? stamp.modified : Date.now() };
    const i = this.listed.has(at.key) ? this.fileList.findIndex((f) => f.path.replace(/\\/g, "/").toLowerCase() === at.key) : -1;
    if (i >= 0) {
      if (stamp) this.fileList[i] = { ...this.fileList[i], size: entry.size, modified: entry.modified };
    } else {
      this.setList([...this.fileList, entry].sort((x, y) => x.path.toLowerCase().localeCompare(y.path.toLowerCase())));
      this.onDidChange.fire();
    }
  }
  private writeSeq = 0;
  /** Own writes under way, per key. */
  private writing = new Map<string, number>();
  /** Deletes a project file (empty folders it leaves go too); the file list is refreshed. */
  async delete(p: string) {
    if (!this.info) throw new Error("no project is open");
    await invoke("fs_delete", { root: this.info.root, path: this.resolve(p) });
    await this.refresh();
  }
  /** Creates a project folder; the file list is refreshed. */
  async createFolder(p: string) {
    if (!this.info) throw new Error("no project is open");
    await invoke("fs_mkdir", { root: this.info.root, path: this.resolve(p) });
    await this.refresh();
  }
  /** Removes an empty project folder; the file list is refreshed. */
  async removeFolder(p: string) {
    if (!this.info) throw new Error("no project is open");
    await invoke("fs_rmdir", { root: this.info.root, path: this.resolve(p) });
    await this.refresh();
  }
  /** Moves a project file to another project path; the file list is refreshed. */
  async rename(from: string, to: string) {
    if (!this.info) throw new Error("no project is open");
    await invoke("fs_rename", { root: this.info.root, from: this.resolve(from), to: this.resolve(to) });
    await this.refresh();
  }
  /** Copies a file (project paths or absolute ones) in the backend; the file list is refreshed. */
  async copy(from: string, to: string) {
    await invoke("fs_copy", { from: this.resolve(from), to: this.resolve(to) });
    if (this.info) await this.refresh();
    this.onDidSave.fire(to.replace(/\\/g, "/"));
  }
  /** Copies pairs in order, stopping at the first failure; one refresh at the end. */
  async copyMany(pairs: [string, string][]) {
    let copied = 0, error: string | null = null;
    try {
      for (const [from, to] of pairs) {
        await invoke("fs_copy", { from: this.resolve(from), to: this.resolve(to) });
        copied++;
      }
    } catch (e) { error = String(e); }
    if (this.info) await this.refresh();
    for (const [, to] of pairs.slice(0, copied)) this.onDidSave.fire(to.replace(/\\/g, "/"));
    return { copied, error };
  }
  /** Deletes project files in order, stopping at the first failure; one refresh at the end. */
  async deleteMany(paths: string[]) {
    if (!this.info) throw new Error("no project is open");
    let deleted = 0, error: string | null = null;
    try {
      for (const p of paths) {
        await invoke("fs_delete", { root: this.info.root, path: this.resolve(p) });
        deleted++;
      }
    } catch (e) { error = String(e); }
    await this.refresh();
    return { deleted, error };
  }
  /** Every file below a folder, relative to it (`/`-separated, sorted). */
  listFolder(path: string) {
    return invoke<string[]>("fs_list_tree", { path: this.resolve(path) });
  }
  async writeBytes(p: string, bytes: Uint8Array) {
    await this.tracked(p, bytes.length, (target) => writeBytes(target, bytes));
    this.onDidSave.fire(p.replace(/\\/g, "/"));
  }
}

/** settings.json in the app config dir. */
/** The workbench's own settings (machine-specific, so user scope). */
const CORE_SETTINGS: Record<string, ConfigurationProperty> = {
  "worldEditor.path": { type: "string", scope: "user", default: "", description: "World Editor executable (Open in World Editor, F5). Empty: _retail_/x86_64/World Editor.exe in game.installDir. On Linux a Windows program is started through Steam's Proton, in the Steam prefix it's in." },
  "game.path": { type: "string", scope: "user", default: "", description: "Game executable (Test Map, Ctrl+F5). Empty: _retail_/x86_64/Warcraft III.exe in game.installDir. On Linux started through Steam's Proton, in the Steam prefix it's in." },
  "game.installDir": { type: "string", scope: "user", default: "C:\\Program Files (x86)\\Warcraft III", description: "Game install folder whose data (CASC) is read." },
  "game.graphicsMode": { type: "string", scope: "user", default: "hd", enum: ["sd", "hd", "de"], enumDescriptions: ["Classic", "Reforged HD", "Reforged (DE)"], description: "Art set used to resolve game files (models, textures)." },
  "game.cacheMegabytes": { type: "number", scope: "user", default: 1024, description: "Game files read are kept in memory up to this size, so a map opened again reads nothing from the game's storage. Less than what a map reads (GoldRush in HD: about 600 MB) keeps little of it. 0 keeps nothing." },
  "project.syncOnWorldEditorSave": { type: "string", scope: "user", default: "ask", enum: ["ask", "always", "never"], description: "Sync the project back when the World Editor saves the map." },
  "recentProjects": { type: "array", scope: "user", default: [], description: "Recently opened projects (Welcome page)." },
  "extensions.disabled": { type: "array", scope: "user", default: [], description: "Extension ids that aren't loaded (built-ins included). Applies after a reload." },
  "editorAssociations": { type: "object", scope: "user", default: {}, description: "File glob → editor id, e.g. { \"*.w3u.json\": \"w3.textEditor\" }." },
};

export class SettingsService implements Settings {
  private user: Record<string, unknown> = {};
  private project: Record<string, unknown> = {};
  private path = "";
  private projectFile: string | null = null;
  private changed = new Emitter<string>();
  private schema = new Map<string, SettingInfo>(
    Object.entries(CORE_SETTINGS).map(([key, property]) => [key, { key, property, source: "core", section: "Workbench" }]),
  );

  /** Declares settings from an extension manifest. */
  contribute(source: string, section: string, properties: Record<string, ConfigurationProperty>) {
    for (const [key, property] of Object.entries(properties)) this.schema.set(key, { key, property, source, section });
  }

  declared(): SettingInfo[] {
    return [...this.schema.values()];
  }

  async load(path: string) {
    this.path = path;
    this.user = await readJson(path);
    for (const k of Object.keys(this.user)) this.changed.fire(k);
  }

  /** Switches the project layer (null: no project open). */
  async loadProject(root: string | null) {
    const before = Object.keys(this.project);
    this.projectFile = root ? joinPath(root, PROJECT_SETTINGS) : null;
    this.project = this.projectFile ? await readJson(this.projectFile) : {};
    for (const k of new Set([...before, ...Object.keys(this.project)])) this.changed.fire(k);
  }

  settingsPath() {
    return this.path;
  }

  /** Absolute path of the open project's settings file, or null. */
  projectSettingsPath() {
    return this.projectFile;
  }

  private projectAllowed(key: string) {
    return this.schema.get(key)?.property.scope !== "user";
  }

  get<T>(key: string, fallback?: T): T {
    if (key in this.project && this.projectAllowed(key)) return this.project[key] as T;
    if (key in this.user) return this.user[key] as T;
    const decl = this.schema.get(key);
    return (decl && "default" in decl.property ? decl.property.default : fallback) as T;
  }

  inspect(key: string) {
    return { defaultValue: this.schema.get(key)?.property.default, user: this.user[key], project: this.project[key] };
  }

  async set(key: string, value: unknown, target: SettingsTarget = "user") {
    if (target === "project") {
      if (!this.projectFile) throw new Error("No project is open.");
      if (!this.projectAllowed(key)) throw new Error(`${key} is a user setting; projects can't override it.`);
    }
    const values = target === "project" ? this.project : this.user;
    if (value === undefined) delete values[key];
    else values[key] = value;
    await writeText(target === "project" ? this.projectFile! : this.path, JSON.stringify(values, null, 2) + "\n");
    this.changed.fire(key);
  }

  onDidChange(listener: (key: string) => void): Disposable {
    return this.changed.on(listener);
  }
}

/** Project settings, versioned with the project. */
export const PROJECT_SETTINGS = ".w3proj/settings.json";

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    const v = JSON.parse(await readText(path));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
