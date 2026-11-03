import type { ConfigurationProperty, FileInfo, ProjectInfo, SettingInfo, Settings, SettingsTarget, Disposable } from "../extensions/api";
import { invoke, joinPath, readBytes, readText, writeBytes, writeText } from "./backend";
import { Emitter } from "./dom";

export class WorkspaceService {
  private info: ProjectInfo | null = null;
  private fileList: FileInfo[] = [];
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

  async open(path: string) {
    this.info = await invoke<ProjectInfo>("project_open", { path });
    await this.refresh(false);
    await this.settings.loadProject(this.info.root);
    const recent = this.settings.get<string[]>("recentProjects", []).filter((p) => p.toLowerCase() !== this.info!.root.toLowerCase());
    await this.settings.set("recentProjects", [this.info.root, ...recent].slice(0, 10));
    this.onDidChange.fire();
  }

  close() {
    this.info = null;
    this.fileList = [];
    void this.settings.loadProject(null);
    this.onDidChange.fire();
  }

  async refresh(fire = true) {
    if (!this.info) return;
    this.info = await invoke<ProjectInfo>("project_open", { path: this.info.root });
    this.fileList = await invoke<FileInfo[]>("project_files", { root: this.info.root });
    if (fire) this.onDidChange.fire();
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
    await writeText(this.resolve(p), text);
    this.onDidSave.fire(p.replace(/\\/g, "/"));
  }
  /** Deletes a project file (empty folders it leaves go too); the file list is refreshed. */
  async delete(p: string) {
    if (!this.info) throw new Error("no project is open");
    await invoke("fs_delete", { root: this.info.root, path: this.resolve(p) });
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
  async writeBytes(p: string, bytes: Uint8Array) {
    await writeBytes(this.resolve(p), bytes);
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
