// The public extension API. Built-in and user extensions get the same object;
// nothing else in the workbench is reachable from an extension.

export interface Disposable {
  dispose(): void;
}

export interface CommandContribution {
  id: string;
  title: string;
  category?: string;
  /** e.g. "ctrl+shift+b", "f5" */
  keybinding?: string;
  /** Hide from the command palette. */
  hidden?: boolean;
}

export interface ViewContainerContribution {
  id: string;
  title: string;
  /** A short glyph shown in the activity bar. */
  icon: string;
  order?: number;
}

export interface ViewContribution {
  id: string;
  title: string;
  container: string;
}

export interface EditorContribution {
  id: string;
  title: string;
  /** Globs matched against the file's project path, e.g. "*.w3u.json", "map/**". */
  patterns: string[];
  /** "default" editors open on click; "option" ones only via "Reopen With…". */
  priority?: "default" | "option";
}

/** One declared setting (shown in the Settings editor). */
export interface ConfigurationProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  default?: unknown;
  description?: string;
  /** Allowed values (shown as a dropdown), with optional labels. */
  enum?: unknown[];
  enumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
  /** "project" (default): a project may override it in .w3proj/settings.json;
   *  "user": machine-specific (paths, lists), user settings only. */
  scope?: "user" | "project";
}

export interface ConfigurationContribution {
  /** Section title in the Settings editor (defaults to the extension name). */
  title?: string;
  /** Setting key → declaration; keys are dotted ("terrain.minimap.blur"). */
  properties: Record<string, ConfigurationProperty>;
}

/** A service other extensions can use through `w3.services.get(id)`. */
export interface ServiceContribution {
  id: string;
  description?: string;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  main?: string;
  /** "*" | "onStartup" | "onCommand:<id>" | "onView:<id>" | "onEditor:<id>" | "onService:<id>" */
  activationEvents?: string[];
  /** Extensions that must be active first. If one is missing or disabled,
   *  this extension fails to activate with a message saying which. */
  extensionDependencies?: string[];
  contributes?: {
    commands?: CommandContribution[];
    viewContainers?: ViewContainerContribution[];
    views?: ViewContribution[];
    editors?: EditorContribution[];
    services?: ServiceContribution[];
    configuration?: ConfigurationContribution;
  };
}

export interface ViewProvider {
  render(container: HTMLElement): void | Disposable;
  /** Buttons in the view header. */
  actions?: { icon: string; title: string; command: string }[];
}

export interface EditorDocument {
  /** Project-relative path ("map/war3map.j") or a virtual uri ("w3:welcome"). */
  readonly path: string;
  /** Absolute path on disk, or null for virtual documents. */
  readonly absolutePath: string | null;
  /** Game files ("game:…") cannot be written. */
  readonly readOnly: boolean;
  /** Rejects with an error whose `name` is "NotUtf8Error" for binary files. */
  readText(): Promise<string>;
  readBytes(): Promise<Uint8Array>;
  writeText(text: string): Promise<void>;
  writeBytes(bytes: Uint8Array): Promise<void>;
  setDirty(dirty: boolean): void;
}

export interface EditorInstance {
  save?(): Promise<void>;
  focus?(): void;
  dispose?(): void;
  /** Other project files the editor shows (e.g. "map/war3map.wts" for TRIGSTR texts): when
   *  something else saves one, the editor is opened again if it has no unsaved changes. (Its own
   *  file always counts: saved by something else, it reopens, or asks when there are unsaved
   *  changes.) */
  watches?: string[];
}

export interface EditorProvider {
  resolve(container: HTMLElement, doc: EditorDocument): EditorInstance | Promise<EditorInstance>;
}

/** An entry of a context menu; "-" is a separator. */
export type MenuItem = "-" | { label: string; run: () => void; disabled?: boolean; hint?: string };

export interface QuickPickItem<T = unknown> {
  label: string;
  description?: string;
  detail?: string;
  value?: T;
}

export interface StatusBarItem extends Disposable {
  text: string;
  tooltip: string;
  command?: string;
}

export interface OutputChannel {
  append(line: string): void;
  clear(): void;
  show(): void;
}

export interface ProjectInfo {
  root: string;
  name: string;
  manifest: any;
  default_output: string;
}

export interface FileInfo {
  path: string;
  size: number;
  /** Last write (ms since 1970). */
  modified: number;
}

export interface GameInfo {
  version: string;
  /** Installed text locale, e.g. "dede". */
  locale: string;
  entries: number;
  stored: number;
}

export type SettingsTarget = "user" | "project";

/** A declared setting with its values per layer. */
export interface SettingInfo {
  key: string;
  property: ConfigurationProperty;
  /** Declaring extension id ("core" for the workbench) and section title. */
  source: string;
  section: string;
}

/** Settings in layers: project (.w3proj/settings.json of the open project),
 *  then user (settings.json), then the declared default. */
export interface Settings {
  get<T = unknown>(key: string, fallback?: T): T;
  /** Writes one layer (default "user"); `undefined` removes the key there. */
  set(key: string, value: unknown, target?: SettingsTarget): Promise<void>;
  inspect(key: string): { defaultValue?: unknown; user?: unknown; project?: unknown };
  /** Every declared setting (workbench and extensions). */
  declared(): SettingInfo[];
  onDidChange(listener: (key: string) => void): Disposable;
}

export interface W3Api {
  readonly version: string;
  commands: {
    register(id: string, handler: (...args: any[]) => unknown): Disposable;
    execute<T = unknown>(id: string, ...args: any[]): Promise<T>;
  };
  views: {
    register(id: string, provider: ViewProvider): Disposable;
    /** Re-render a view (e.g. after its data changed). */
    refresh(id: string): void;
    /** Shows a view container in the side bar (its activity bar id, e.g. "problems"). */
    show(container: string): Promise<void>;
  };
  editors: {
    registerProvider(id: string, provider: EditorProvider): Disposable;
    open(path: string, providerId?: string): Promise<void>;
    activePath(): string | null;
    /** Whether an editor of the file has unsaved changes. */
    isDirty(path: string): boolean;
    /** When another tab becomes active (its file and editor id), or the last one closes (null). */
    onDidChangeActive(listener: (active: { path: string; editor: string } | null) => void): Disposable;
    /** Saves every editor with unsaved changes (e.g. before packing); resolves with how many. */
    saveAll(): Promise<number>;
    /** Asks once about unsaved changes (save all / don't save / cancel), then closes every
     *  editor; false when cancelled. Use before switching projects. */
    closeAllAsking(): Promise<boolean>;
    /** Closes every editor without asking (used when files change on disk). */
    closeAll(): Promise<void>;
    /** Closes the editors of one file without asking. */
    close(path: string): Promise<void>;
  };
  window: {
    showInfo(message: string, ...actions: string[]): Promise<string | undefined>;
    showWarning(message: string, ...actions: string[]): Promise<string | undefined>;
    showError(message: string, ...actions: string[]): Promise<string | undefined>;
    quickPick<T>(items: QuickPickItem<T>[], opts?: { placeholder?: string }): Promise<QuickPickItem<T> | undefined>;
    inputBox(opts?: { prompt?: string; value?: string; placeholder?: string }): Promise<string | undefined>;
    pickFile(opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
    pickFolder(opts?: { title?: string }): Promise<string | null>;
    pickSaveFile(opts?: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
    withProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
    /** A context menu at a screen point (usually a contextmenu event's clientX/Y). */
    showContextMenu(at: { x: number; y: number }, items: MenuItem[]): void;
  };
  statusBar: {
    add(opts: { id: string; text: string; tooltip?: string; command?: string; align?: "left" | "right"; priority?: number }): StatusBarItem;
  };
  output: {
    channel(name: string): OutputChannel;
  };
  workspace: {
    /** The open project, or null. */
    project(): ProjectInfo | null;
    open(path: string): Promise<void>;
    close(): void;
    files(): FileInfo[];
    refresh(): Promise<void>;
    resolve(projectPath: string): string;
    /** Rejects with an error whose `name` is "NotUtf8Error" for binary files. */
    readText(projectPath: string): Promise<string>;
    writeText(projectPath: string, text: string): Promise<void>;
    readBytes(projectPath: string): Promise<Uint8Array>;
    writeBytes(projectPath: string, bytes: Uint8Array): Promise<void>;
    onDidChange(listener: () => void): Disposable;
    /** Deletes a project file (only inside the project; empty folders it leaves go too). */
    delete(projectPath: string): Promise<void>;
    /** Copies a file (project or absolute paths) without loading it: for large files. */
    copy(from: string, to: string): Promise<void>;
    /** Moves a project file to another path in the project (fails if the target exists). */
    rename(from: string, to: string): Promise<void>;
    /** A project file was written through the workspace (path as written, forward slashes). */
    onDidSave(listener: (path: string) => void): Disposable;
  };
  settings: Settings;
  /** The installed game's own files (CASC storage), read-only. Plain paths
   *  like "Units\\UnitData.slk" resolve through the game's mod layers for
   *  the configured graphics mode; full paths ("War3.w3mod:…") are exact. */
  game: {
    info(): Promise<GameInfo>;
    /** Full paths of all stored files. */
    list(): Promise<string[]>;
    resolve(path: string): Promise<string | null>;
    read(path: string): Promise<Uint8Array>;
    /** UTF-8 text with any byte-order mark removed. */
    readText(path: string): Promise<string>;
  };
  /** Escape hatch to the Rust backend commands. */
  backend: {
    invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
    listen<T = unknown>(event: string, handler: (payload: T) => void): Promise<Disposable>;
  };
  extensions: {
    all(): { manifest: ExtensionManifest; source: string; active: boolean; disabled: boolean; error?: string }[];
  };
  /** Shared functionality between extensions. A provider declares the id in
   *  `contributes.services` and registers it in activate(); users list the
   *  provider in `extensionDependencies`. Service types live in
   *  `extensions/services.ts`. */
  services: {
    provide<T>(id: string, impl: T): Disposable;
    /** Activates the providing extension if needed. Rejects when no
     *  extension provides `id` or its provider is disabled. */
    get<T>(id: string): Promise<T>;
  };
}

export interface ExtensionContext {
  readonly extensionId: string;
  /** Folder of a user/project extension; null for built-ins. */
  readonly extensionPath: string | null;
  readonly subscriptions: Disposable[];
}

export interface ExtensionModule {
  activate(w3: W3Api, ctx: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
