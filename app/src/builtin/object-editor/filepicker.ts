// File browser for path fields (models, icons, textures): the map's imported files and the
// game's own, searchable by words of the path, with thumbnails for images. Shown as an
// overlay inside the object editor, like the object browser.

import type { W3Api } from "../../extensions/api";
import { toArchiveName } from "../../lib/formats/archivepath";
import { h } from "../../workbench/dom";

const MAX_ROWS = 300;
export type FileKind = "model" | "image";
const EXTENSIONS: Record<FileKind, RegExp> = { model: /\.(mdx|mdl)$/i, image: /\.(blp|dds|tga)$/i };

interface FileEntry { path: string; imported: boolean }

/** The game's files as data writes them ("Units\Human\…"): no storage or art-set prefix, one
 *  entry per path (any case). Read once. */
let gameFiles: Promise<string[]> | null = null;
function loadGameFiles(w3: W3Api): Promise<string[]> {
  gameFiles ??= w3.game.list().then((list) => {
    const seen = new Map<string, string>();
    for (const full of list) {
      const plain = full.slice(full.lastIndexOf(":") + 1).replace(/\//g, "\\");
      if (!seen.has(plain.toLowerCase())) seen.set(plain.toLowerCase(), plain);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  });
  gameFiles.catch(() => { gameFiles = null; });
  return gameFiles;
}

/** Files of a kind: the map's imports first, then the game's, named the way object data names
 *  them (models .mdl, the game's .dds images .blp; the game resolves both to what it stores). */
async function filesOf(w3: W3Api, kind: FileKind): Promise<FileEntry[]> {
  const ext = EXTENSIONS[kind];
  const show = (p: string) => (kind === "model" ? p.replace(/\.mdx$/i, ".mdl") : p);
  const showGame = (p: string) => (kind === "image" ? p.replace(/\.dds$/i, ".blp") : show(p));
  const imported = w3.workspace.files()
    .map((f) => f.path.replace(/\\/g, "/"))
    .filter((p) => p.toLowerCase().startsWith("map/") && ext.test(p))
    .map((p): FileEntry => ({ path: show(toArchiveName(p.slice(4))), imported: true }));
  const have = new Set(imported.map((f) => f.path.toLowerCase()));
  const game: FileEntry[] = [];
  for (const p of await loadGameFiles(w3).catch(() => [])) {
    if (!ext.test(p) || /\.mdl$/i.test(p)) continue;
    const path = showGame(p), key = path.toLowerCase();
    // Imports replace game files; an image stored as .blp and .dds is listed once.
    if (have.has(key)) continue;
    have.add(key);
    game.push({ path, imported: false });
  }
  return [...imported, ...game];
}

interface PickOptions {
  title: string;
  /** Search hint. */
  placeholder: string;
  /** The entries, read when the list opens. */
  load: () => Promise<FileEntry[]>;
  /** Rows show thumbnails. */
  images: boolean;
  /** The field's value now (preselects the search). */
  current: string;
  /** Thumbnail (data URL) of an image path. */
  thumb?: (path: string) => Promise<string | null>;
}

/** Lets the user choose a file; resolves with its path, or null when cancelled. */
export function pickFile(w3: W3Api, host: HTMLElement, opts: { title: string; kind: FileKind; current: string; thumb?: (path: string) => Promise<string | null> }): Promise<string | null> {
  return pick(host, { ...opts, images: opts.kind === "image", placeholder: "Search by words of the path, e.g. footman, BTN hero", load: () => filesOf(w3, opts.kind) });
}

/** Lets the user choose one of `labels` (sound labels); resolves with it, or null when cancelled. */
export function pickLabel(host: HTMLElement, opts: { title: string; current: string; labels: () => Promise<string[]> }): Promise<string | null> {
  return pick(host, { title: opts.title, current: opts.current, images: false, placeholder: "Search by words of the label",
    load: async () => (await opts.labels()).map((path) => ({ path, imported: false })) });
}

function pick(host: HTMLElement, opts: PickOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let all: FileEntry[] = [];
    let shown: FileEntry[] = [];
    let active = 0;
    const finish = (path: string | null) => { overlay.remove(); resolve(path); };
    const countEl = h("span.muted", {}, "Reading files…");
    const rowsEl = h("div.picker-rows");
    // The current file's name, without folders and extension, as the first search.
    const start = (opts.current.split(",")[0] ?? "").trim().replace(/^.*\\/, "").replace(/\.\w+$/, "");
    const search = h("input.picker-search", {
      placeholder: opts.placeholder,
      value: start === "_" ? "" : start,
      oninput: () => { active = 0; filter(); },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "ArrowDown") { active = Math.min(active + 1, shown.length - 1); renderRows(); e.preventDefault(); }
        else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); renderRows(); e.preventDefault(); }
        else if (e.key === "Enter") { if (shown[active]) finish(shown[active].path); e.preventDefault(); }
        else if (e.key === "Escape") { finish(null); e.preventDefault(); }
      },
    });
    // Thumbnails load when their row scrolls into view.
    const seen = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const img = e.target as HTMLImageElement;
        seen.unobserve(img);
        void opts.thumb?.(img.dataset.path!).then((src) => { if (src) img.src = src; });
      }
    }, { root: rowsEl });
    const renderRows = () => {
      seen.disconnect();
      rowsEl.replaceChildren(...shown.slice(0, MAX_ROWS).map((f, i) => {
        const img = opts.images && opts.thumb ? h("img.picker-icon", { alt: "", "data-path": f.path }) : null;
        if (img) seen.observe(img);
        return h(`div.picker-row${i === active ? ".active" : ""}`, {
          onmousedown: (e: MouseEvent) => { e.preventDefault(); finish(f.path); },
          onmouseenter: () => { active = i; },
        }, img, h("span.picker-name", {}, f.path), f.imported ? h("span.badge", { title: "Imported into this map" }, "map") : null);
      }));
      rowsEl.children[active]?.scrollIntoView({ block: "nearest" });
    };
    const filter = () => {
      const words = search.value.toLowerCase().split(/[\s\\/]+/).filter(Boolean);
      shown = all.filter((f) => { const p = f.path.toLowerCase(); return words.every((w) => p.includes(w)); });
      countEl.textContent = shown.length > MAX_ROWS ? `${MAX_ROWS} of ${shown.length}` : String(shown.length);
      renderRows();
    };
    const overlay = h("div.picker-overlay", { onmousedown: (e: MouseEvent) => { if (e.target === overlay) finish(null); } },
      h("div.picker", {},
        h("div.picker-header", {}, h("strong", {}, opts.title), countEl, h("button.icon-button", { title: "Cancel (Esc)", onclick: () => finish(null) }, "×")),
        search,
        rowsEl,
        h("div.picker-hint.muted", {}, "↑↓ move · Enter choose · Esc cancel")));
    host.append(overlay);
    search.focus();
    search.select();
    void opts.load().then((files) => { all = files; filter(); }, (e) => { countEl.textContent = String((e as Error).message ?? e); });
  });
}
