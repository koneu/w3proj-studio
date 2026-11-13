// The extension API without a window, for the app's own code run by the w3proj CLI (src/headless/rebuild.ts): the
// workbench's own workspace, settings and game services over the CLI's pipe (ipc.ts), and for what needs a person
// (questions, editors, views) answers that change nothing. Messages and output lines are kept for the report.

import type { Disposable, ExtensionContext, ExtensionManifest, ExtensionModule, OutputChannel, SettingsTarget, W3Api } from "../extensions/api";
import { GameService } from "../workbench/game";
import { readBytes, writeBytes } from "../workbench/backend";
import { backendInvoke } from "../workbench/trackedinvoke";
import { SettingsService, WorkspaceService } from "../workbench/workspace";

const none: Disposable = { dispose() {} };

/** A notification the code showed: the report lists them. */
export interface Message {
  severity: "info" | "warning" | "error";
  text: string;
  /** A question with buttons (`notify`), which nobody answers here. */
  asked?: boolean;
}

/** The app's settings (defaults, the project's .w3proj/settings.json) under the CLI's own: the game folder it was
 *  given, and what the job switches on or off. Nothing is written: the user's settings file isn't the CLI's. */
export class HeadlessSettings extends SettingsService {
  constructor(private readonly fixed: Record<string, unknown>) { super(); }
  override get<T>(key: string, fallback?: T): T {
    return (key in this.fixed ? this.fixed[key] : super.get(key, fallback)) as T;
  }
  override async set(key: string, value: unknown, _target?: SettingsTarget) {
    this.fixed[key] = value;
  }
}

/** Any use of what this host leaves out fails with its name, rather than doing half of something. */
function absent<T extends object>(group: string): T {
  return new Proxy({} as T, {
    get: (_t, name) => () => { throw new Error(`w3.${group}.${String(name)} isn't available when w3proj runs without the app`); },
  });
}

export interface Headless {
  w3: W3Api;
  workspace: WorkspaceService;
  messages: Message[];
  /** Output channels' lines, by channel name. */
  output: Map<string, string[]>;
  /** Activates a built-in extension in this host. */
  activate(id: string, module: ExtensionModule): Promise<void>;
}

/** `manifests`: the job's extensions (their settings are declared as the workbench does); `fixed`: the values that win. */
export function headless(manifests: ExtensionManifest[], fixed: Record<string, unknown>): Headless {
  const settings = new HeadlessSettings(fixed);
  for (const m of manifests) {
    const c = m.contributes?.configuration;
    if (c) settings.contribute(m.id, c.title ?? m.name, c.properties);
  }
  const messages: Message[] = [];
  settings.warn = (text) => messages.push({ severity: "warning", text });
  const workspace = new WorkspaceService(settings);
  const game = new GameService(settings);
  const output = new Map<string, string[]>();
  const commands = new Map<string, (...a: unknown[]) => unknown>();
  const services = new Map<string, unknown>();
  const waiting = new Map<string, ((v: unknown) => void)[]>();
  const say = (severity: Message["severity"]) => async (text: string) => { messages.push({ severity, text }); return undefined; };
  const subscriptions: Disposable[] = [];

  const w3 = {
    version: "headless",
    commands: {
      register: (id: string, run: (...a: unknown[]) => unknown) => { commands.set(id, run); return { dispose: () => commands.delete(id) }; },
      execute: async (id: string, ...a: unknown[]) => {
        const run = commands.get(id);
        if (!run) throw new Error(`command ${id} isn't available when w3proj runs without the app`);
        return run(...a);
      },
    },
    views: { register: () => none, refresh() {}, show: async () => {} },
    editors: {
      registerProvider: () => none,
      open: async (path: string) => { throw new Error(`${path} can't be opened when w3proj runs without the app`); },
      activePath: () => null,
      // No editor holds anything: the files are all there is.
      isDirty: () => false,
      unsavedPaths: () => [],
      saveViewOnly: async () => 0,
      onDidChangeActive: () => none,
      saveAll: async () => 0,
      save: async () => 0,
      closeAllAsking: async () => true,
      closeAll: async () => {},
      close: async () => {},
      reopen: async () => 0,
      restore: async () => {},
    },
    // Nobody answers: every question is left unanswered, as a notification closed without a choice.
    window: {
      showInfo: say("info"), showWarning: say("warning"), showError: say("error"),
      notify: async (severity: Message["severity"], text: string) => { messages.push({ severity, text, asked: true }); return undefined; },
      confirm: async () => false,
      askDelete: async () => false,
      quickPick: async () => undefined,
      inputBox: async () => undefined,
      pickFile: async () => null, pickFiles: async () => [], pickFolder: async () => null, pickSaveFile: async () => null,
      withProgress: <T,>(_title: string, task: () => Promise<T>) => task(),
      showContextMenu() {},
    },
    statusBar: { add: () => ({ text: "", tooltip: "", dispose() {} }) },
    output: {
      channel: (name: string): OutputChannel => {
        const lines = output.get(name) ?? [];
        output.set(name, lines);
        return { append: (line) => { lines.push(line); }, clear: () => { lines.length = 0; }, show() {} };
      },
    },
    workspace: {
      project: () => workspace.project(),
      open: (p: string) => workspace.open(p),
      close: () => workspace.close(),
      files: () => workspace.files(),
      folders: () => workspace.folders(),
      createFolder: (p: string) => workspace.createFolder(p),
      removeFolder: (p: string) => workspace.removeFolder(p),
      refresh: () => workspace.refresh(),
      resolve: (p: string) => workspace.resolve(p),
      readText: (p: string) => workspace.readText(p),
      writeText: (p: string, t: string) => workspace.writeText(p, t),
      readBytes: (p: string) => workspace.readBytes(p),
      writeBytes: (p: string, b: Uint8Array) => workspace.writeBytes(p, b),
      onDidChange: (l: () => void) => workspace.onDidChange.on(l),
      onDidSave: (l: (path: string) => void) => workspace.onDidSave.on(l),
      delete: (p: string) => workspace.delete(p),
      rename: (a: string, b: string) => workspace.rename(a, b),
      copy: (a: string, b: string) => workspace.copy(a, b),
      copyMany: (pairs: [string, string][]) => workspace.copyMany(pairs),
      deleteMany: (paths: string[]) => workspace.deleteMany(paths),
      listFolder: (path: string) => workspace.listFolder(path),
    },
    settings,
    keybindings: { ...absent<object>("keybindings"), labelFor: () => undefined, label: (k: string) => k, onDidChange: () => none },
    game: {
      info: () => game.info(),
      list: () => game.list(),
      resolve: (p: string, o?: { tileset?: string }) => game.resolve(p, o?.tileset),
      resolveMany: (paths: string[], o?: { tileset?: string }) => game.resolveMany(paths, o?.tileset),
      read: (p: string, o?: { tileset?: string; background?: boolean }) => game.read(p, o?.tileset, o?.background === true),
      readText: (p: string, o?: { tileset?: string; background?: boolean }) => game.readText(p, o?.tileset, o?.background === true),
      reload: () => game.reload(),
    },
    backend: {
      invoke: (command: string, args?: Record<string, unknown>) => backendInvoke(workspace, command, args),
      listen: async () => none,
      readBytes,
      writeBytes: (path: string, bytes: Uint8Array) => writeBytes(path, bytes).then(() => {}),
    },
    lib: () => import("../extensions/lib"),
    mcp: { registerTool: () => none, list: () => [], handle: async () => "" },
    extensions: { all: () => [] },
    services: {
      provide: (id: string, impl: unknown) => {
        services.set(id, impl);
        for (const give of waiting.get(id) ?? []) give(impl);
        waiting.delete(id);
        return { dispose: () => services.delete(id) };
      },
      // Only what this host's extensions provide; asked for before it's there, it comes when provided.
      get: (id: string) => (services.has(id) ? Promise.resolve(services.get(id)) : new Promise((give) => waiting.set(id, [...(waiting.get(id) ?? []), give]))),
    },
  } as unknown as W3Api;

  return {
    w3, workspace, messages, output,
    activate: async (id, module) => {
      const ctx: ExtensionContext = { extensionId: id, extensionPath: null, subscriptions };
      await module.activate(w3, ctx);
    },
  };
}
