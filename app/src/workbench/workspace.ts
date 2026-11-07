import type { ConfigurationProperty, FileInfo, ProjectInfo, SettingInfo, Settings, SettingsTarget, Disposable } from "../extensions/api";
import { invoke, joinPath, readBytes, readText, writeBytes, writeText } from "./backend";
import { Emitter } from "./dom";

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
    // Entries saved under another spelling of a folder (8.3 short name) are the same project.
    const spelled = await Promise.all(this.settings.get<string[]>("recentProjects", []).map((p) => invoke<string>("path_normalize", { path: p }).catch(() => p)));
    const seen = new Set([this.info.root.toLowerCase()]);
    const recent = spelled.filter((p) => !seen.has(p.toLowerCase()) && !!seen.add(p.toLowerCase()));
    await this.settings.set("recentProjects", [this.info.root, ...recent].slice(0, 10));
    this.onDidChange.fire();
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
    const ownBefore = new Set(this.ownWrites), listedBefore = this.listed;
    this.info = await invoke<ProjectInfo>("project_open", { path: this.info.root });
    const list = await invoke<FileInfo[]>("project_files", { root: this.info.root });
    this.folderList = await invoke<string[]>("project_folders", { root: this.info.root });
    this.setList(this.keepNoticed(list, listedBefore, ownBefore));
    for (const k of ownBefore) this.ownWrites.delete(k);
    if (fire) this.onDidChange.fire();
  }

  /** Files written through the workspace since the last refresh (lower case). */
  private ownWrites = new Set<string>();

  /** `list`, just read from the disk, plus the files our own writes added to the list since
   *  `listedBefore` (the read may have started before they existed). */
  private keepNoticed(list: FileInfo[], listedBefore: ReadonlySet<string>, ownBefore: ReadonlySet<string>): FileInfo[] {
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
    const own = new Set(this.ownWrites), ownBefore = new Set(own), listedBefore = this.listed;
    const root = this.info.root;
    const after = await invoke<FileInfo[]>("project_files", { root });
    if (this.info?.root !== root) return new Set();
    // Our own writes that finished during the read count as ours too, and stay in the list.
    for (const k of this.ownWrites) own.add(k);
    const changed = new Set<string>();
    for (const f of after) {
      const k = f.path.toLowerCase(), b = before.get(k);
      before.delete(k);
      if ((!b || b.size !== f.size || b.modified !== f.modified) && !own.has(k)) changed.add(k);
    }
    for (const k of before.keys()) if (!own.has(k)) changed.add(k);
    this.setList(this.keepNoticed(after, listedBefore, ownBefore));
    for (const k of ownBefore) this.ownWrites.delete(k);
    if (changed.size) {
      this.info = await invoke<ProjectInfo>("project_open", { path: root });
      this.onDidChange.fire();
    }
    return changed;
  }

  resolve(projectPath: string): string {
    if (/^[a-z]:[\\/]/i.test(projectPath) || projectPath.startsWith("\\\\")) return projectPath;
    if (!this.info) throw new Error("no project is open");
    return joinPath(this.info.root, projectPath);
  }

  readText(p: string) {
    return readText(this.resolve(p));
  }
  readBytes(p: string) {
    return readBytes(this.resolve(p));
  }
  async writeText(p: string, text: string) {
    const root = this.info?.root, target = this.resolve(p);
    await writeText(target, text);
    this.noticeWrite(target, root, new TextEncoder().encode(text).length);
    this.onDidSave.fire(p.replace(/\\/g, "/"));
  }
  /** After a write to `target`, resolved against `root` before the write started: a file inside the
   *  project that the list doesn't have yet (a new file, e.g. an export into map/Scripts/) is added
   *  to it at once, alone: nothing else is re-read, so changes made by others stay to be noticed.
   *  The write itself isn't an external change. Folders the list never has (build, .git,
   *  node_modules at the top) are left out; so is a write that finished after a project switch. */
  private noticeWrite(target: string, root: string | undefined, size: number) {
    if (!root || this.info?.root !== root) return;
    const abs = target.replace(/\\/g, "/"), base = root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!abs.toLowerCase().startsWith(base.toLowerCase() + "/")) return;
    const rel = abs.slice(base.length + 1), key = rel.toLowerCase();
    if (/^(build|\.git|node_modules)\//.test(key)) return;
    this.ownWrites.add(key);
    if (this.listed.has(key)) return;
    this.setList([...this.fileList, { path: rel, size, modified: Date.now() }].sort((x, y) => x.path.toLowerCase().localeCompare(y.path.toLowerCase())));
    this.onDidChange.fire();
  }
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
    const root = this.info?.root, target = this.resolve(p);
    await writeBytes(target, bytes);
    this.noticeWrite(target, root, bytes.length);
    this.onDidSave.fire(p.replace(/\\/g, "/"));
  }
}

/** settings.json in the app config dir. */
/** The workbench's own settings (machine-specific, so user scope). */
const CORE_SETTINGS: Record<string, ConfigurationProperty> = {
  "worldEditor.path": { type: "string", scope: "user", default: "C:\\Program Files (x86)\\Warcraft III\\_retail_\\x86_64\\World Editor.exe", description: "World Editor executable (Open in World Editor, F5)." },
  "game.path": { type: "string", scope: "user", default: "C:\\Program Files (x86)\\Warcraft III\\_retail_\\x86_64\\Warcraft III.exe", description: "Game executable (Test Map, Ctrl+F5)." },
  "game.installDir": { type: "string", scope: "user", default: "C:\\Program Files (x86)\\Warcraft III", description: "Game install folder whose data (CASC) is read." },
  "game.graphicsMode": { type: "string", scope: "user", default: "hd", enum: ["sd", "hd", "de"], enumDescriptions: ["Classic", "Reforged HD", "Reforged (DE)"], description: "Art set used to resolve game files (models, textures)." },
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
