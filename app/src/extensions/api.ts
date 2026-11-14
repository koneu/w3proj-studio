// The public extension API. Built-in and user extensions get the same object;
// nothing else in the workbench is reachable from an extension.

export interface Disposable {
  dispose(): void;
}

export interface CommandContribution {
  id: string;
  title: string;
  category?: string;
  /** Its default key, e.g. "ctrl+shift+b", "f5", "ctrl+k ctrl+s" (more keys, or keys with a `when`:
   *  `contributes.keybindings`). The user can change it (Keyboard Shortcuts, keybindings.json). */
  keybinding?: string;
  /** Hide from the command palette. */
  hidden?: boolean;
  /** Where it shows in the menu bar: "Tools", or with a group and a place in it, "File:2:1". A menu
   *  not there yet is added. Without this it's in the command palette only. */
  menu?: string;
  /** What it needs to run; its menu entry is greyed out without it. */
  when?: "project" | "editor" | "save" | "undo" | "terrain";
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
  /** What happens to its tabs when the graphics mode (game.graphicsMode) changes. "reopen": it shows the mode's art,
   *  so its tabs without unsaved changes open again in place (their viewState kept). "self": the editor follows
   *  the mode by itself. Not given: only its tabs of game files ("game:…", which are read in the mode) open again. */
  graphicsMode?: "reopen" | "self";
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

/** An MCP tool (see extensions/mcp.ts). Declared here, it's listed without loading the extension. */
export interface McpToolContribution {
  /** Letters, digits, "_" and "-", at most 64: clients don't accept more. Like "terrain_screenshot". */
  name: string;
  /** What the AI reads to decide when to use it. */
  description: string;
  /** JSON Schema of the arguments; none by default. */
  inputSchema?: Record<string, unknown>;
  /** Changes nothing. Other tools are only offered with the setting "mcp.writeTools". */
  readOnly?: boolean;
  /** A boolean setting that must be on as well, for what asks for more trust than editing. */
  needs?: string;
}

export type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** Throw to report a failure. Returns text, MCP content (`{ type: "image", data: base64, mimeType }`)
 *  or anything else, which goes out as JSON. */
export type McpToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

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
  /** "*" | "onStartup" | "onCommand:<id>" | "onView:<id>" | "onEditor:<id>" | "onService:<id>" | "onMcpTool:<name>" */
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
    mcpTools?: McpToolContribution[];
    keybindings?: KeybindingContribution[];
  };
}

/** A default key of a command (as VS Code's `contributes.keybindings`): later ones win over earlier ones for the same
 *  key, the user's keybindings.json over all. */
export interface KeybindingContribution {
  /** "g", "ctrl+shift+l", "numpad8", "ctrl+k ctrl+s". */
  key: string;
  command: string;
  /** Where it applies: context keys with !, &&, ||, == and != ("terrainFocus"). Bindings whose `when` names a context
   *  key of the element with the keyboard (its `data-key-context`) are that view's to handle: it reads them through
   *  `w3.keybindings.commandsFor`. */
  when?: string;
}

/** A key in effect, as the Keyboard Shortcuts editor lists it. */
export interface KeybindingInfo { key: string; command: string; when?: string; source: "default" | "user"; extensionId?: string }

export interface ViewProvider {
  render(container: HTMLElement): void | Disposable;
  /** Its side bar container was shown again (the view stays rendered while another one is shown): the cue to
   *  look again at what can change outside the app. */
  shown?(): void;
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
  /** What the editor's `viewState()` gave when this tab was last open (the project's last session, or before it
   *  was opened again in place), if anything: the editor checks it, since the file may have changed meanwhile. */
  readonly viewState?: unknown;
}

export interface EditorInstance {
  /** Where the editor is in its file (scroll position, selection; small and JSON-able: one bigger than 4096
   *  characters as JSON isn't kept): kept with the project's open tabs and given back as `EditorDocument.viewState`. */
  viewState?(): unknown;
  save?(): Promise<void>;
  /** Applies edits still waiting (text committed after a pause in typing) and marks them unsaved: the workbench
   *  calls it before it saves the editor or asks whether it has unsaved changes (closing, reloading, Save All).
   *  Without it, a save first has the focused text field in the editor commit its text (it loses the focus and gets
   *  it back, which fires its `change` if the text changed); an editor with it commits its fields itself. */
  flush?(): void;
  /** Whether the only unsaved change is view state the file keeps (the Trigger Editor's opened and closed categories):
   *  actions that refuse while anything is unsaved save such an editor first (`editors.saveViewOnly`). */
  viewOnlyUnsaved?(): boolean;
  focus?(): void;
  dispose?(): void;
  /** The editor's undo and redo, for the Edit commands and the buttons by the tabs: they work
   *  wherever the focus is. An editor without them shows no buttons. */
  undo?(): void;
  redo?(): void;
  /** Its own file or a watched one was saved by something else, and it has no unsaved changes:
   *  takes the change in place, keeping what it has loaded. False: opened again, which is slow.
   *  `path`: the project path in lower case (on any system), to compare with lower-cased names. */
  reloadFile?(path: string): Promise<boolean>;
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
/** `checked`: an on/off entry, drawn with a check mark while on (false: off, room for the mark kept). */
export type MenuItem = "-" | { label: string; run: () => void; disabled?: boolean; hint?: string; shortcut?: string; checked?: boolean };

export interface QuickPickItem<T = unknown> {
  label: string;
  description?: string;
  detail?: string;
  value?: T;
  /** Greyed out with this reason; it can't be picked. */
  disabled?: string;
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

export interface GameReadOptions {
  tileset?: string;
  /** A read nobody is waiting on (a check, a prefetch, an icon): it goes after the reads someone waits
   *  on (a map opening, a model shown), but still gets a turn now and then. Once read, it doesn't count
   *  as a file in use, so a pass over many files doesn't push the ones in use out of the cache. */
  background?: boolean;
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
    /** The files with unsaved changes in an editor. */
    unsavedPaths(): string[];
    /** Saves the editors whose only unsaved change is view state (EditorInstance.viewOnlyUnsaved), the same save as
     *  by hand; any other unsaved change stays. Resolves with how many were saved. */
    saveViewOnly(): Promise<number>;
    /** When another tab becomes active (its file and editor id), or the last one closes (null). */
    onDidChangeActive(listener: (active: { path: string; editor: string } | null) => void): Disposable;
    /** Saves every editor with unsaved changes (e.g. before packing); resolves with how many. */
    saveAll(): Promise<number>;
    /** Saves the editors of one file that have unsaved changes, as their tab's Save does (asking first when the file
     *  changed on disk); resolves with how many were saved. */
    save(path: string): Promise<number>;
    /** Asks once about unsaved changes (save all / don't save / cancel), then closes every
     *  editor; false when cancelled. Use before switching projects. */
    closeAllAsking(): Promise<boolean>;
    /** Closes every editor without asking (used when files change on disk). */
    closeAll(): Promise<void>;
    /** Closes the editors of one file without asking. */
    close(path: string): Promise<void>;
    /** Opens the editors of one file (of one editor id, if given) again in place, in their tabs, for what they show
     *  besides the file (the graphics mode). Those with unsaved changes are left; resolves with how many. */
    reopen(path: string, providerId?: string): Promise<number>;
    /** Opens the project's remembered tabs again (their editors, order, active tab and viewState), e.g. after
     *  closeAll() for a sync that rewrote the files. Tabs open now stay. */
    restore(): Promise<void>;
  };
  window: {
    showInfo(message: string, ...actions: string[]): Promise<string | undefined>;
    showWarning(message: string, ...actions: string[]): Promise<string | undefined>;
    showError(message: string, ...actions: string[]): Promise<string | undefined>;
    /** Like showInfo/showWarning/showError; aborting `signal` closes it, answered with nothing (e.g. a question about
     *  one project, when another opens). */
    notify(severity: "info" | "warning" | "error", message: string, actions: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
    /** Asks with buttons `yes` and Cancel. After `expires` ms the question disappears, so nobody
     *  can answer one that's no longer being waited for. True only if `yes` was pressed. */
    confirm(message: string, yes: string, expires: number): Promise<boolean>;
    /** A question after pressing Delete: pressing it again answers yes, Escape no. A key held down doesn't. */
    askDelete(message: string, yes: string): Promise<boolean>;
    quickPick<T>(items: QuickPickItem<T>[], opts?: { placeholder?: string }): Promise<QuickPickItem<T> | undefined>;
    inputBox(opts?: { prompt?: string; value?: string; placeholder?: string }): Promise<string | undefined>;
    pickFile(opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string | null>;
    /** Several files at once; empty when cancelled. */
    pickFiles(opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string[]>;
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
    /** The project's files as listed so far: right after an open the list may not be read yet (see filesReady). */
    files(): FileInfo[];
    /** Resolves once files() lists every file of the open project; rejects when none is open or the list can't be
     *  read. Whatever deletes, drops or renumbers by what files() holds (strings nothing refers to, a language's
     *  table) waits for it first: a file not listed yet isn't an absent one. */
    filesReady(): Promise<void>;
    /** The project's folders (forward slashes), empty ones too. */
    folders(): string[];
    /** Creates a project folder, with those above it. */
    createFolder(projectPath: string): Promise<void>;
    /** Removes an empty project folder. */
    removeFolder(projectPath: string): Promise<void>;
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
    /** Copies [from, to] pairs in order, stopping at the first failure (`copied` of them were),
     *  with one refresh of the file list at the end. */
    copyMany(pairs: [from: string, to: string][]): Promise<{ copied: number; error: string | null }>;
    /** Deletes project files in order, stopping at the first failure, with one refresh. */
    deleteMany(projectPaths: string[]): Promise<{ deleted: number; error: string | null }>;
    /** Every file below a folder (any folder), relative to it, `/`-separated, sorted. */
    listFolder(path: string): Promise<string[]>;
    /** Moves a project file to another path in the project (fails if the target exists). */
    rename(from: string, to: string): Promise<void>;
    /** A project file was written through the workspace (path as written, forward slashes). */
    onDidSave(listener: (path: string) => void): Disposable;
  };
  settings: Settings;
  /** Keys of commands: the defaults and the user's keybindings.json. */
  keybindings: {
    /** The commands a key event is bound to where its `when` holds (for the element the event went to), the winner
     *  first. For a view that handles its own keys (`data-key-context`). */
    commandsFor(e: KeyboardEvent): string[];
    /** The commands a mouse button pressed or the wheel turned is bound to ("middlebutton", "alt+leftbutton",
     *  "wheelup"), for the element under the pointer, the winner first. A button held with more modifiers than its
     *  bindings name still matches them (the ones naming the most modifiers first). */
    mouseCommandsFor(e: MouseEvent): string[];
    /** The chord of a key event ("ctrl+shift+l"), null for a modifier alone. */
    chordOf(e: KeyboardEvent): string | null;
    /** The chord of a mouse button or wheel event ("ctrl+rightbutton", "wheeldown"), null for other buttons. */
    mouseChordOf(e: MouseEvent): string | null;
    /** A key in its one written form, or null when it isn't one. */
    normalize(key: string): string | null;
    /** "ctrl+k ctrl+s" as people read it: "Ctrl+K Ctrl+S". */
    label(key: string): string;
    /** The key a command's menu entry and tooltip show, as people read it; undefined for none. */
    labelFor(command: string): string | undefined;
    /** Every command (hidden ones too) with its keys in effect. */
    items(): { command: string; title: string; category?: string; extensionId?: string; bindings: KeybindingInfo[]; userTouched: boolean }[];
    /** Other keys in effect with the same key. */
    conflicts(b: Pick<KeybindingInfo, "key" | "command" | "when">): KeybindingInfo[];
    changeKey(b: KeybindingInfo, key: string): Promise<void>;
    /** Where the binding applies (empty: everywhere). */
    changeWhen(b: KeybindingInfo, when: string): Promise<void>;
    addKey(command: string, key: string, when?: string): Promise<void>;
    remove(b: KeybindingInfo): Promise<void>;
    /** The command back to its default keys. */
    reset(command: string): Promise<void>;
    /** keybindings.json: its path, why it isn't used (there but unreadable), entries left out. */
    file(): { path: string; problem: string | null; ignored: readonly string[] };
    onDidChange(listener: () => void): Disposable;
  };
  /** The installed game's own files (CASC storage), read-only. Plain paths
   *  like "Units\\UnitData.slk" resolve through the game's mod layers for
   *  the configured graphics mode; full paths ("War3.w3mod:…") are exact. */
  game: {
    info(): Promise<GameInfo>;
    /** Full paths of all stored files. */
    list(): Promise<string[]>;
    /** `tileset` (a letter, e.g. the map's): that tileset's own versions of files
     *  (`_Tilesets/<letter>.w3mod`, e.g. its water) win, as in the game. */
    resolve(path: string, opts?: GameReadOptions): Promise<string | null>;
    /** `resolve` for many paths in one call (one backend round trip): each one's result, in order. */
    resolveMany(paths: string[], opts?: GameReadOptions): Promise<(string | null)[]>;
    read(path: string, opts?: GameReadOptions): Promise<Uint8Array>;
    /** UTF-8 text with any byte-order mark removed. */
    readText(path: string, opts?: GameReadOptions): Promise<string>;
    /** Forgets the files read so far (they're kept for the session, and a file not found stays
     *  not found): for an install patched while the app runs. */
    reload(): void;
  };
  /** Escape hatch to the Rust backend commands. */
  backend: {
    invoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T>;
    listen<T = unknown>(event: string, handler: (payload: T) => void): Promise<Disposable>;
    /** A file anywhere on disk, for what a person picks: exports and imports. */
    readBytes(path: string): Promise<Uint8Array>;
    writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  };
  /** The parsers, writers and checks the built-ins use (see extensions/lib.ts), loaded on first
   *  use: `const { terrain } = await w3.lib(); terrain.parseW3e(bytes)`. Check `version`. */
  lib(): Promise<typeof import("./lib")>;
  extensions: {
    all(): { manifest: ExtensionManifest; source: string; active: boolean; disabled: boolean; error?: string }[];
  };
  /** Tools for the one MCP server. Declare a tool in `contributes.mcpTools`, answer it here. */
  mcp: {
    registerTool(name: string, handler: McpToolHandler): Disposable;
    /** The tools on offer now. */
    list(): { name: string; description: string }[];
    /** One JSON-RPC request; used by the MCP Server extension. */
    handle(message: string): Promise<string>;
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
