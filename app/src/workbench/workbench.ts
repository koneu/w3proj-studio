import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { W3Api } from "../extensions/api";
import { ExtensionHost, type ExtensionRecord } from "../extensions/host";
import { McpTools } from "../extensions/mcp";
import { invoke, listen, NotUtf8Error } from "./backend";
import { CommandService } from "./commands";
import { h, showContextMenu } from "./dom";
import { MenuBar } from "./menubar";
import { menuTree } from "./menus";
import { TitleBar } from "./titlebar";
import { EditorService, type OpenEditors } from "./editors";
import { GAME_SCHEME, GameService } from "./game";
import { Notifications, Progress } from "./notifications";
import { OutputPanel } from "./output";
import { QuickInput } from "./quickinput";
import { StatusBar } from "./statusbar";
import { ViewService } from "./views";
import { PROJECT_SETTINGS, SettingsService, WorkspaceService } from "./workspace";

/** Shows the mouse pointer before a native dialog (see ui_show_cursor in the backend). */
const showCursor = () => invoke("ui_show_cursor").catch(() => {});

const TEXT_EXT = /\.(j|lua|ai|txt|wts|json|toml|fdf|toc|slk|md|csv|ini|xml|html|css|js|ts|gitignore|gitattributes)$/i;

/** What the user's "don't care about undo steps" tells AI clients. */
const UNDO_NOTE = "The user doesn't need undo steps for this work: don't plan around them, skip begin_edit unless it helps you, split the work however is quickest, and don't mention undo.";

export class Workbench {
  readonly commands = new CommandService();
  readonly views = new ViewService();
  readonly settings = new SettingsService();
  readonly workspace = new WorkspaceService(this.settings);
  readonly output = new OutputPanel();
  readonly game = new GameService(this.settings);
  readonly mcp = new McpTools({
    activate: (event) => this.host.fire(event),
    note: (name) => (name === "begin_edit" && this.settings.get<boolean>("mcp.ignoreUndoSteps", false) === true ? UNDO_NOTE : undefined),
    allowed: ({ source, readOnly, needs }) => (readOnly || this.settings.get<boolean>("mcp.writeTools", false) === true)
      && (source !== "project" || this.settings.get<boolean>("mcp.projectTools", false) === true)
      && (!needs || this.settings.get<boolean>(needs, false) === true),
    whyUnavailable: (id) => {
      const e = this.host.extensions.find((x) => x.manifest.id === id);
      return e?.error ? `${e.manifest.name} ${e.error}.` : undefined;
    },
    log: (line) => this.log.append(line),
  });
  readonly editors: EditorService;
  readonly statusBar: StatusBar;
  private menuBar: MenuBar;
  private titleBar: TitleBar;
  readonly notifications: Notifications;
  readonly quickInput: QuickInput;
  readonly progress: Progress;
  readonly host: ExtensionHost;
  readonly api: W3Api;
  private log = this.output.channel("Extension Host");

  constructor(root: HTMLElement) {
    const isGame = (p: string) => p.startsWith(GAME_SCHEME);
    const gamePath = (p: string) => p.slice(GAME_SCHEME.length);
    this.editors = new EditorService({
      resolve: (p) => (p.startsWith("w3:") || isGame(p) ? null : this.workspace.resolve(p)),
      readOnly: isGame,
      readText: async (p) => {
        if (!isGame(p)) return this.workspace.readText(p);
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(await this.game.read(gamePath(p)));
        } catch (e) {
          if (e instanceof TypeError) throw new NotUtf8Error(p);
          throw e;
        }
      },
      readBytes: (p) => (isGame(p) ? this.game.read(gamePath(p)) : this.workspace.readBytes(p)),
      writeBytes: async (p, b) => {
        if (isGame(p)) throw new Error("game files are read-only");
        await this.workspace.writeBytes(p, b);
      },
      writeText: async (p, t) => {
        if (isGame(p)) throw new Error("game files are read-only");
        await this.workspace.writeText(p, t);
        // Settings edited as JSON take effect on save.
        if (p === this.settings.settingsPath()) await this.settings.load(p);
        const project = this.workspace.project();
        if (project && (p === PROJECT_SETTINGS || p === this.settings.projectSettingsPath())) await this.settings.loadProject(project.root);
      },
    });
    this.statusBar = new StatusBar((c) => this.run(c));
    this.progress = new Progress(this.statusBar.progress);

    const main = h("div.main", {}, this.views.activityBar, this.views.sidebar, h("div.editor-column", {}, this.editors.root, this.output.root));
    this.menuBar = new MenuBar(() => menuTree(this.commands.all()), (c) => this.run(c));
    this.titleBar = new TitleBar(this.menuBar.root, () => this.run("workbench.commandPalette"));
    this.titleBar.guardClose(() => this.editors.unsavedPaths().length, () => this.editors.closeAllAsking());
    this.workspace.onDidChange.on(() => this.titleBar.show(this.workspace.project()?.name ?? null));
    root.append(this.titleBar.root, main, this.statusBar.root);
    this.notifications = new Notifications(root);
    this.quickInput = new QuickInput(root);

    this.api = this.createApi();
    this.host = new ExtensionHost(this.api, (rec) => this.applyContributions(rec), (l) => this.log.append(l),
      (id) => this.settings.get<string[]>("extensions.disabled", []).includes(id));
    this.editors.associations = () => this.settings.get<Record<string, string>>("editorAssociations", {});
    const fire = (event: string) => this.host.fire(event);
    this.commands.activate = fire;
    this.views.activate = fire;
    this.editors.activate = fire;
    this.views.run = (c) => this.run(c);
    this.editors.confirm = (m, ...a) => this.notifications.show("warning", m, a);
    this.editors.whyUnavailable = (id) => {
      const e = this.host.extensions.find((x) => x.manifest.id === id);
      if (!e) return undefined;
      if (e.disabled) return `${e.manifest.name} is disabled ("extensions.disabled").`;
      return e.error ? `${e.manifest.name} ${e.error}.` : undefined;
    };
    this.editors.fallback = async (path) => {
      if (path.startsWith("w3:")) throw new Error(`unknown virtual document ${path}`);
      if (TEXT_EXT.test(path)) return "w3.textEditor";
      const read = isGame(path) ? this.game.read(gamePath(path)) : this.workspace.readBytes(path);
      const bytes = await read.catch(() => new Uint8Array());
      const sample = bytes.subarray(0, 4096);
      return sample.includes(0) ? "w3.hexViewer" : "w3.textEditor";
    };
    // Open tabs are remembered per project in the webview's storage (this machine only, not
    // in the project): files that are gone by the next start are left out.
    const memoryKey = () => {
      const root = this.workspace.project()?.root;
      return root ? `w3.openEditors:${root.replace(/[\\/]+$/, "").toLowerCase()}` : null;
    };
    this.editors.memory = {
      load: () => {
        const key = memoryKey();
        let state: OpenEditors | null = null;
        try { state = key ? JSON.parse(localStorage.getItem(key) ?? "null") : null; } catch { return null; }
        if (!state || !Array.isArray(state.tabs)) return null;
        const files = new Set(this.workspace.files().map((f) => f.path.toLowerCase()));
        const exists = (p: string) => p.startsWith("w3:") || isGame(p) || /^[a-z]:[\\/]/i.test(p) || files.has(p.replace(/\\/g, "/").toLowerCase());
        return { tabs: state.tabs.filter((t) => typeof t.path === "string" && typeof t.editor === "string" && exists(t.path)), active: state.active };
      },
      store: (state) => {
        const key = memoryKey();
        try { if (key) localStorage.setItem(key, JSON.stringify(state)); } catch { /* not remembered */ }
      },
    };
    this.registerCoreCommands();
    this.registerKeybindings();
  }

  async start() {
    const paths = await invoke<{ settings: string; user_extensions: string }>("app_paths");
    await this.settings.load(paths.settings);
    this.host.addBuiltins();
    try {
      this.host.addExternal(await invoke("extensions_scan", { projectRoot: null }));
    } catch (e) {
      this.log.append(`could not scan user extensions: ${e}`);
    }
    await this.host.fire("onStartup");
    await this.host.fire("*");
    await this.views.showContainer("explorer");

    // A file saved inside the app reopens (or flags) other editors showing it.
    this.workspace.onDidSave.on((p) => void this.editors.fileSaved(p));

    // Files changed outside the app (git checkout, another editor) are noticed when the window
    // gets the focus back: the file list refreshes and their open editors reload.
    let checking = false;
    window.addEventListener("focus", async () => {
      if (checking || !this.workspace.project()) return;
      checking = true;
      try {
        const changed = await this.workspace.externalChanges();
        if (!changed.size) return;
        this.log.append(`${changed.size} file(s) changed outside the app`);
        const kept = await this.editors.reload(changed);
        if (kept.length) {
          void this.notifications.show("warning", `Changed on disk while you have unsaved edits: ${kept.join(", ")}. Saving overwrites the file; close without saving to load it again.`, []);
        }
      } catch (e) {
        this.log.append(`checking for external changes failed: ${e}`);
      } finally {
        checking = false;
      }
    });

    // Projects can ship their own extensions in .w3proj/extensions. Then the project's tabs
    // from last time are opened again. The last project may already be open (reopened by an
    // extension during onStartup), so this also runs once now.
    let scannedRoot: string | null = null;
    const projectChanged = async () => {
      const root = this.workspace.project()?.root ?? null;
      if (root === scannedRoot) return;
      scannedRoot = root;
      if (!root) return;
      this.editors.projectOpened();
      try {
        this.host.addExternal(await invoke("extensions_scan", { projectRoot: root }));
        await this.host.fire("onStartup");
        await this.host.fire("*");
      } catch (e) {
        this.log.append(`could not scan project extensions: ${e}`);
      }
      if (this.workspace.project()?.root === root) await this.editors.restore().catch((e) => this.log.append(`could not restore tabs: ${e}`));
    };
    this.workspace.onDidChange.on(projectChanged);
    void projectChanged();
  }

  run(command: string, ...args: unknown[]) {
    this.commands.execute(command, ...args).catch((e) => {
      this.notifications.show("error", `${this.commands.info(command)?.title ?? command}: ${e?.message ?? e}`);
    });
  }

  private applyContributions(rec: ExtensionRecord) {
    const c = rec.manifest.contributes ?? {};
    for (const cmd of c.commands ?? []) this.commands.contribute(rec.manifest.id, cmd);
    if (c.commands?.length) this.menuBar.render();
    for (const vc of c.viewContainers ?? []) this.views.contributeContainer(vc);
    for (const v of c.views ?? []) this.views.contributeView(v);
    for (const e of c.editors ?? []) this.editors.contribute(rec.manifest.id, e);
    if (c.configuration) this.settings.contribute(rec.manifest.id, c.configuration.title ?? rec.manifest.name, c.configuration.properties);
    if (c.mcpTools) this.mcp.declare(rec.manifest.id, rec.source, c.mcpTools);
  }

  private createApi(): W3Api {
    const wb = this;
    return {
      version: "0.1.0",
      commands: {
        register: (id, handler) => wb.commands.register(id, handler),
        execute: (id, ...args) => wb.commands.execute(id, ...args),
      },
      views: {
        register: (id, provider) => wb.views.register(id, provider),
        refresh: (id) => wb.views.refresh(id),
        show: (container) => wb.views.showContainer(container),
      },
      editors: {
        registerProvider: (id, provider) => wb.editors.registerProvider(id, provider),
        open: (path, providerId) => wb.editors.open(path, providerId),
        activePath: () => wb.editors.activePath(),
        onDidChangeActive: (l) => wb.editors.onDidChangeActive.on(l),
        isDirty: (p) => wb.editors.isDirty(p),
        unsavedPaths: () => wb.editors.unsavedPaths(),
        closeAll: () => wb.editors.closeAll(),
        closeAllAsking: () => wb.editors.closeAllAsking(),
        saveAll: () => wb.editors.saveAll(),
        close: (p) => wb.editors.closeWhere((x) => x === p),
      },
      window: {
        showInfo: (m, ...a) => wb.notifications.show("info", m, a),
        showWarning: (m, ...a) => wb.notifications.show("warning", m, a),
        confirm: async (m, yes, expires) => (await wb.notifications.show("warning", m, [yes, "Cancel"], expires)) === yes,
        showError: (m, ...a) => wb.notifications.show("error", m, a),
        quickPick: (items, opts) => wb.quickInput.pick(items, opts),
        inputBox: (opts) => wb.quickInput.ask(opts),
        pickFile: async (opts) => (await showCursor(), (await openDialog({ title: opts?.title, filters: opts?.filters, multiple: false, directory: false })) as string | null),
        pickFiles: async (opts) => (await showCursor(), ((await openDialog({ title: opts?.title, filters: opts?.filters, multiple: true, directory: false })) ?? []) as string[]),
        pickFolder: async (opts) => (await showCursor(), (await openDialog({ title: opts?.title, directory: true, multiple: false })) as string | null),
        pickSaveFile: async (opts) => (await showCursor(), (await saveDialog({ title: opts?.title, defaultPath: opts?.defaultPath, filters: opts?.filters })) ?? null),
        withProgress: (title, task) => wb.progress.run(title, task),
        showContextMenu: (at, items) => showContextMenu(at, items),
      },
      statusBar: { add: (opts) => wb.statusBar.add(opts) },
      output: { channel: (name) => wb.output.channel(name) },
      workspace: {
        project: () => wb.workspace.project(),
        open: (p) => wb.workspace.open(p),
        close: () => wb.workspace.close(),
        files: () => wb.workspace.files(),
        folders: () => wb.workspace.folders(),
        createFolder: (p) => wb.workspace.createFolder(p),
        removeFolder: (p) => wb.workspace.removeFolder(p),
        refresh: () => wb.workspace.refresh(),
        resolve: (p) => wb.workspace.resolve(p),
        readText: (p) => wb.workspace.readText(p),
        writeText: (p, t) => wb.workspace.writeText(p, t),
        readBytes: (p) => wb.workspace.readBytes(p),
        writeBytes: (p, b) => wb.workspace.writeBytes(p, b),
        onDidChange: (l) => wb.workspace.onDidChange.on(l),
        onDidSave: (l) => wb.workspace.onDidSave.on(l),
        delete: (p) => wb.workspace.delete(p),
        rename: (a, b) => wb.workspace.rename(a, b),
        copy: (a, b) => wb.workspace.copy(a, b),
        copyMany: (pairs) => wb.workspace.copyMany(pairs),
        deleteMany: (paths) => wb.workspace.deleteMany(paths),
        listFolder: (path) => wb.workspace.listFolder(path),
      },
      settings: wb.settings,
      game: {
        info: () => wb.game.info(),
        list: () => wb.game.list(),
        resolve: (p, o) => wb.game.resolve(p, o?.tileset),
        read: (p, o) => wb.game.read(p, o?.tileset),
        readText: (p, o) => wb.game.readText(p, o?.tileset),
      },
      backend: { invoke, listen },
      lib: () => import("../extensions/lib"),
      mcp: { registerTool: (name, handler) => wb.mcp.registerTool(name, handler), list: () => wb.mcp.list(), handle: (message) => wb.mcp.handle(message) },
      extensions: {
        all: () => wb.host.extensions.map((e) => ({ manifest: e.manifest, source: e.source, active: e.active, disabled: e.disabled, error: e.error })),
      },
      services: {
        provide: (id, impl) => wb.host.provideService(id, impl),
        get: (id) => wb.host.getService(id),
      },
    };
  }

  private registerCoreCommands() {
    const c = (id: string, title: string, run: (...a: any[]) => unknown, extra: { keybinding?: string; category?: string; hidden?: boolean; menu?: string } = {}) => {
      this.commands.contribute("core", { id, title, category: extra.category ?? "View", ...extra });
      this.commands.register(id, run);
    };
    c("workbench.commandPalette", "Show All Commands", async () => {
      const items = this.commands.all().map((cmd) => ({
        label: cmd.category ? `${cmd.category}: ${cmd.title}` : cmd.title,
        description: cmd.keybinding?.toUpperCase(),
        value: cmd.id,
      }));
      items.sort((a, b) => a.label.localeCompare(b.label));
      const pick = await this.quickInput.pick(items, { placeholder: "Type a command" });
      if (pick) this.run(pick.value!);
    }, { keybinding: "ctrl+shift+p", menu: "Edit:2:2" });
    c("workbench.quickOpen", "Go to File…", async () => {
      const files = this.workspace.files();
      if (!files.length) return;
      const pick = await this.quickInput.pick(
        files.map((f) => ({ label: f.path.split("/").pop()!, description: f.path, value: f.path })),
        { placeholder: "Search files by name" },
      );
      if (pick) await this.editors.open(pick.value!);
    }, { keybinding: "ctrl+p", category: "Go", menu: "Edit:2:1" });
    c("workbench.toggleSidebar", "Toggle Side Bar", () => this.views.toggleSidebar(), { keybinding: "ctrl+b", menu: "View:1:1" });
    c("workbench.togglePanel", "Toggle Output Panel", () => this.output.toggle(), { keybinding: "ctrl+j", menu: "View:1:2" });
    c("workbench.save", "Save", () => this.editors.save(), { keybinding: "ctrl+s", category: "File", menu: "File:3:1" });
    c("workbench.closeEditor", "Close Editor", () => this.editors.closeActive(), { keybinding: "ctrl+w", category: "File", menu: "File:3:2" });
    c("workbench.reopenWith", "Reopen Editor With…", async () => {
      const path = this.editors.activePath();
      if (!path) return;
      const options = [...this.editors.candidates(path)];
      for (const id of ["w3.textEditor", "w3.hexViewer"]) {
        const contrib = this.editors.allContributions().find((e) => e.id === id);
        if (contrib && !options.includes(contrib)) options.push(contrib);
      }
      const pick = await this.quickInput.pick(options.map((o) => ({ label: o.title, description: o.extensionId, value: o.id })), { placeholder: `Open ${path} with…` });
      if (pick) await this.editors.open(path, pick.value!);
    }, { category: "File" });
    c("workbench.configureEditorAssociation", "Configure Default Editor for This File Type…", async () => {
      const path = this.editors.activePath();
      if (!path || path.startsWith("w3:")) throw new Error("Open a file first.");
      // "*.w3u.json" for "map/war3map.w3u.json": everything from the first dot of the name.
      const name = path.split(/[/:]/).pop()!;
      const glob = name.includes(".") ? `*${name.slice(name.indexOf("."))}` : name;
      const options = [...this.editors.candidates(path)];
      for (const id of ["w3.textEditor", "w3.hexViewer"]) {
        const contrib = this.editors.allContributions().find((e) => e.id === id);
        if (contrib && !options.includes(contrib)) options.push(contrib);
      }
      const current = this.editors.associated(path);
      const pick = await this.quickInput.pick(
        [
          ...options.map((o) => ({ label: o.title, description: `${o.id}${o.id === current ? " · current default" : ""}`, value: o.id })),
          ...(current ? [{ label: "Remove association", description: `back to the extensions' default for ${glob}`, value: "" }] : []),
        ],
        { placeholder: `Default editor for ${glob}` },
      );
      if (!pick) return;
      const assoc = { ...this.settings.get<Record<string, string>>("editorAssociations", {}) };
      if (pick.value) assoc[glob] = pick.value;
      else delete assoc[glob];
      await this.settings.set("editorAssociations", assoc);
      if (pick.value) await this.editors.open(path, pick.value);
      this.notifications.show("info", pick.value ? `${glob} now opens with ${pick.label}.` : `Removed the default editor for ${glob}.`);
    }, { category: "File" });
    // No keys: each editor binds Ctrl+Z itself, and bound here too they'd step twice.
    c("workbench.undo", "Undo", () => { if (!this.editors.undo()) this.notifications.show("info", "This editor has no undo."); }, { category: "Edit", menu: "Edit:1:1" });
    c("workbench.redo", "Redo", () => { if (!this.editors.redo()) this.notifications.show("info", "This editor has no redo."); }, { category: "Edit", menu: "Edit:1:2" });
    c("workbench.openSettings", "Open Settings (JSON)", async () => {
      const p = this.settings.settingsPath();
      if (!(await invoke<boolean>("fs_exists", { path: p }))) await this.settings.set("worldEditor.path", this.settings.get("worldEditor.path"));
      await this.editors.open(p, "w3.textEditor");
    }, { category: "Preferences" });
    c("workbench.openProjectSettings", "Open Project Settings (JSON)", async () => {
      const p = this.settings.projectSettingsPath();
      if (!p) throw new Error("Open a project first.");
      if (!(await invoke<boolean>("fs_exists", { path: p }))) await this.workspace.writeText(PROJECT_SETTINGS, "{}\n");
      await this.workspace.refresh();
      await this.editors.open(PROJECT_SETTINGS, "w3.textEditor");
    }, { category: "Preferences" });
    c("workbench.reload", "Reload Window", () => location.reload(), { category: "Developer", keybinding: "ctrl+r" });
    c("workbench.showLog", "Show Extension Host Log", () => this.log.show(), { category: "Developer", menu: "Help:2:1" });
  }

  private registerKeybindings() {
    window.addEventListener("keydown", (e) => {
      const chord = CommandService.chord(e);
      const cmd = this.commands.forChord(chord);
      if (cmd) {
        e.preventDefault();
        e.stopPropagation();
        this.run(cmd.id);
        return;
      }
      // A re-render removed the focused field, or the clicked button: the focus fell to the page
      // and the key would reach no editor (Ctrl+Z, Delete, …). It goes to the active editor.
      if (e.target !== document.body || document.querySelector(".picker-overlay")) return;
      const target = this.editors.keyTarget();
      if (!target) return;
      e.stopPropagation();
      target.focus({ preventScroll: true });
      const copy = new KeyboardEvent("keydown", e);
      target.dispatchEvent(copy);
      if (copy.defaultPrevented) e.preventDefault();
    }, true);
  }
}

export { NotUtf8Error };
