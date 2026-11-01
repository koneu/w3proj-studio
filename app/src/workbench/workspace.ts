import type { FileInfo, ProjectInfo, Settings, Disposable } from "../extensions/api";
import { invoke, joinPath, readBytes, readText, writeText } from "./backend";
import { Emitter } from "./dom";

export class WorkspaceService {
  private info: ProjectInfo | null = null;
  private fileList: FileInfo[] = [];
  readonly onDidChange = new Emitter<void>();

  constructor(private settings: Settings) {}

  project() {
    return this.info;
  }

  files() {
    return this.fileList;
  }

  async open(path: string) {
    this.info = await invoke<ProjectInfo>("project_open", { path });
    await this.refresh(false);
    const recent = this.settings.get<string[]>("recentProjects", []).filter((p) => p.toLowerCase() !== this.info!.root.toLowerCase());
    await this.settings.set("recentProjects", [this.info.root, ...recent].slice(0, 10));
    this.onDidChange.fire();
  }

  close() {
    this.info = null;
    this.fileList = [];
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
  }
}

/** settings.json in the app config dir. */
export class SettingsService implements Settings {
  private values: Record<string, unknown> = {};
  private path = "";
  private changed = new Emitter<string>();

  static readonly defaults: Record<string, unknown> = {
    "worldEditor.path": "C:\\Program Files (x86)\\Warcraft III\\_retail_\\x86_64\\World Editor.exe",
    "game.path": "C:\\Program Files (x86)\\Warcraft III\\_retail_\\x86_64\\Warcraft III.exe",
    "project.syncOnWorldEditorSave": "ask",
    "game.installDir": "C:\\Program Files (x86)\\Warcraft III",
    /** Art set for resolving game paths: "sd", "hd" or "de". */
    "game.graphicsMode": "hd",
    "recentProjects": [],
    /** Extension ids that are not loaded (built-ins included). Reload to apply. */
    "extensions.disabled": [],
    /** File glob → editor id, e.g. { "*.w3u.json": "w3.textEditor" }. */
    "editorAssociations": {},
  };

  async load(path: string) {
    this.path = path;
    try {
      this.values = JSON.parse(await readText(path));
    } catch {
      this.values = {};
    }
    for (const k of Object.keys(this.values)) this.changed.fire(k);
  }

  settingsPath() {
    return this.path;
  }

  get<T>(key: string, fallback?: T): T {
    return (key in this.values ? this.values[key] : key in SettingsService.defaults ? SettingsService.defaults[key] : fallback) as T;
  }

  async set(key: string, value: unknown) {
    this.values[key] = value;
    await writeText(this.path, JSON.stringify(this.values, null, 2) + "\n");
    this.changed.fire(key);
  }

  onDidChange(listener: (key: string) => void): Disposable {
    return this.changed.on(listener);
  }
}
