// The web demo's stand-in for the Rust side: what Tauri's IPC would answer, from memory. It is installed as
// `window.__TAURI_INTERNALS__` (what `@tauri-apps/api` calls) before the app loads, so the app's own code runs
// unchanged. A small sample project (src/demo/sample, made up) is the file system; everything that needs the game, a
// real folder or a program is answered with a "needs the desktop app" error, which the app shows as it would any
// failed command.

const samples = import.meta.glob("./sample/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

// The made-up trigger definitions (src/demo/gamedata, in the format of the game's UI/TriggerData.txt and its strings): the
// only "game files" the demo has. Everything else under game_read is refused, so icons and unit names stay unavailable.
const gameData = import.meta.glob("./gamedata/*.txt", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const gameFiles = new Map(Object.entries(gameData).map(([k, v]) => [k.slice("./gamedata/".length).toLowerCase(), enc0(v)]));
function enc0(text: string) { return new TextEncoder().encode(text); }

export const ROOT = "/demo/sample-map";
export const SETTINGS = "/demo/config/settings.json";
const NEEDS = "This needs the desktop app: it isn't available in the web demo.";

type Entry = { text: string; modified: number };
const files = new Map<string, Entry>();
const folders = new Set<string>();

const T0 = Date.UTC(2026, 0, 1);

function put(path: string, text: string, modified = Date.now()) {
  files.set(path, { text, modified });
  const parts = path.split("/");
  for (let i = 2; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
}

for (const [k, v] of Object.entries(samples)) put(`${ROOT}/${k.slice("./sample/".length)}`, v, T0);
// The app starts with the sample project open, as it does with the last project of a desktop run.
put(SETTINGS, JSON.stringify({ recentProjects: [ROOT], "game.askForFolder": false }, null, 2));

const enc = new TextEncoder();
const size = (e: Entry) => enc.encode(e.text).length;
const stamp = (e: Entry) => ({ size: size(e), modified: e.modified });
const under = (root: string, path: string) => path === root || path.startsWith(`${root}/`);
const norm = (p: string) => p.split("\\").join("/");

function listTree(path: string): string[] {
  const base = norm(path).replace(/\/+$/, "");
  if (!folders.has(base) && base !== ROOT) throw `${path}: no such folder`;
  return [...files.keys()].filter((f) => f.startsWith(`${base}/`)).map((f) => f.slice(base.length + 1)).sort();
}

function projectFolders(): string[] {
  const out = new Set<string>();
  for (const f of files.keys()) {
    if (!under(ROOT, f)) continue;
    const parts = f.slice(ROOT.length + 1).split("/");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return [...out];
}

type Handler = (args: any, options?: { headers?: Record<string, string> }) => unknown;
const handlers: Record<string, Handler> = {
  app_paths: () => ({ settings: SETTINGS, user_extensions: "/demo/config/extensions", user_guides: "/demo/config/guides", config_dir: "/demo/config" }),
  extensions_scan: () => [],
  formats_list: () => [],
  path_normalize: ({ path }) => path,
  watched_maps: () => [],
  git_status: () => null,
  project_strays: () => [],
  game_find: () => [],
  game_maps_folder: () => null,
  mcp_clients: () => [],
  mcp_serve: () => undefined,
  // The three made-up UI files (TriggerData, TriggerStrings, WorldEditStrings); anything else needs the desktop app.
  game_read: ({ path }) => {
    const name = norm(String(path)).split("/").pop()!.toLowerCase();
    const bytes = norm(String(path)).toLowerCase().startsWith("ui/") ? gameFiles.get(name) : undefined;
    if (!bytes) { refused.game_read = (refused.game_read ?? 0) + 1; throw `${NEEDS} (game_read ${path})`; }
    return bytes.slice().buffer;
  },
  project_open: ({ path }) => {
    const root = norm(String(path)).replace(/\/w3proj\.toml$/, "");
    if (root !== ROOT) throw `${path}: only the sample project can be opened in the web demo`;
    return { root: ROOT, name: "Sample Map", manifest: { format: 1 }, default_output: `${ROOT}/build/Sample Map.w3x` };
  },
  project_files_partial: ({ root }) => ({
    files: [...files].filter(([p]) => under(root, p)).map(([p, e]) => ({ path: p.slice(root.length + 1), ...stamp(e) }))
      .sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase())),
    unreadable: [],
  }),
  project_folders: () => projectFolders(),
  fs_exists: ({ path }) => files.has(norm(path)) || folders.has(norm(path)),
  fs_stat: ({ path }) => { const e = files.get(norm(path)); return e ? stamp(e) : null; },
  fs_stat_hashed: ({ path }) => { const e = files.get(norm(path)); return e ? { ...stamp(e), hash: `${e.text.length}:${e.text.slice(0, 16)}` } : null; },
  fs_read_text: ({ path }) => { const e = files.get(norm(path)); if (!e) throw `${path}: no such file`; return e.text; },
  fs_read_bytes: ({ path }) => { const e = files.get(norm(path)); if (!e) throw `${path}: no such file`; return enc.encode(e.text).buffer; },
  fs_write_text: ({ path, text }) => { put(norm(path), String(text)); return stamp(files.get(norm(path))!); },
  // A binary write (the body is the raw bytes, the path a header): the demo keeps text only.
  fs_write_bytes: (args, options) => {
    const path = norm(decodeURIComponent(options?.headers?.path ?? ""));
    put(path, args instanceof Uint8Array ? new TextDecoder().decode(args) : "");
    return stamp(files.get(path)!);
  },
  fs_list_tree: ({ path }) => listTree(path),
  fs_mkdir: ({ path }) => { folders.add(norm(path)); },
  fs_rmdir: ({ path }) => { folders.delete(norm(path)); },
  fs_delete: ({ path }) => { if (!files.delete(norm(path))) throw `${path}: no such file`; },
  fs_rename: ({ from, to }) => {
    const a = norm(from), b = norm(to), e = files.get(a);
    if (!e) throw `${from}: no such file`;
    if (files.has(b)) throw `${to} already exists`;
    files.delete(a);
    put(b, e.text);
  },
  fs_copy: ({ from, to }) => { const e = files.get(norm(from)); if (!e) throw `${from}: no such file`; put(norm(to), e.text); },
  // The trigger folders (map/triggers/): the demo keeps the tree as the app holds it, in one made-up file
  // (map/triggers/triggers.json: the TriggerFile with its texts in `custom`), not in the folders' own format, which the
  // Rust backend reads and writes (crates/backend/src/triggers.rs). The demo never packs.
  triggers_read: ({ root }) => {
    const e = files.get(`${norm(String(root))}/map/triggers/triggers.json`);
    if (!e) return null;
    const { file, custom } = JSON.parse(e.text);
    return { file, custom, files: file.items.map(() => null), headerFile: null, stored: {}, language: "jass", script: "kept", warnings: [] };
  },
  triggers_write: ({ root, save }) => {
    const path = `${norm(String(root))}/map/triggers/triggers.json`, { file, custom } = save as { file: unknown; custom: unknown };
    put(path, JSON.stringify({ file, custom }, null, 2));
    const s = stamp(files.get(path)!);
    return { also: [{ path, ...s }], written: ["map/triggers/triggers.json"], deleted: [], files: (file as { items: unknown[] }).items.map(() => null), headerFile: null };
  },
  triggers_plan: ({ save }) => ({ write: [{ path: "map/triggers/triggers.json", text: JSON.stringify(save, null, 2) }], delete: [] }),
  "plugin:event|listen": () => 1,
  "plugin:event|unlisten": () => undefined,
  "plugin:dialog|open": () => null,
  "plugin:dialog|save": () => null,
  "plugin:dialog|message": () => true,
  "plugin:dialog|ask": () => false,
  "plugin:dialog|confirm": () => false,
};

/** The commands the demo answered with "needs the desktop app", by count (`window.__w3demoRefused`, for the check). */
export const refused: Record<string, number> = {};

export function installTauri() {
  let callback = 0;
  (window as any).__TAURI_INTERNALS__ = {
    invoke(command: string, args: unknown, options?: { headers?: Record<string, string> }) {
      const f = handlers[command];
      if (!f) {
        refused[command] = (refused[command] ?? 0) + 1;
        return Promise.reject(`${NEEDS} (${command})`);
      }
      return Promise.resolve().then(() => f(args, options));
    },
    transformCallback: () => ++callback,
    unregisterCallback() {},
    convertFileSrc: (p: string) => p,
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
  };
  (window as any).__w3demoRefused = refused;
}
