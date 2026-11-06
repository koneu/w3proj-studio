// File browser for path fields (models, icons, textures): the map's imported files and the
// game's own, by folder and by words of the path, with a preview of the highlighted one. Shown as
// an overlay inside the object editor, like the object browser.

import type { W3Api } from "../../extensions/api";
import { toArchiveName } from "../../lib/formats/archivepath";
import { parseSlk } from "../../lib/formats/text";
import { ModelPreview } from "../../lib/model/preview";
import { SOUND_INFO } from "../../lib/script/jass";
import { h } from "../../workbench/dom";
import { findListed, folderTree, foldersOf, inFolder, labelFiles, storedSound, type Folder } from "./browse";

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
  /** What the panel beside the list shows; without it there's no panel. */
  preview?: "model" | "image" | "sound";
  /** Lists folders to the left. */
  folders?: boolean;
  /** Plays a label's sound. */
  play?: (label: string) => Promise<void>;
  stop?: () => void;
  w3?: W3Api;
}

/** Plays sound labels one at a time; `stop` silences it. */
export function soundPlayer(w3: W3Api) {
  let audio: HTMLAudioElement | null = null, url: string | null = null;
  let tables: Promise<Map<string, string>> | null = null;
  const stop = () => {
    audio?.pause();
    audio = null;
    if (url) URL.revokeObjectURL(url);
    url = null;
  };
  const play = async (label: string) => {
    stop();
    tables ??= Promise.all(SOUND_INFO.map((n) => w3.game.readText(`UI\\SoundInfo\\${n}.slk`).catch(() => ""))).then((t) => labelFiles(t.flatMap((x) => parseSlk(x))));
    const file = (await tables).get(label);
    if (!file) throw new Error(`${label} has no sound file.`);
    const path = storedSound(file, await loadGameFiles(w3));
    if (!path) throw new Error(`${file} isn't in the game's files.`);
    const bytes = await w3.game.read(path);
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const type = ext === "mp3" ? "audio/mpeg" : ext === "ogg" ? "audio/ogg" : ext === "wav" ? "audio/wav" : "audio/flac";
    url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    audio = new Audio(url);
    await audio.play();
  };
  return { play, stop };
}

/** Lets the user choose a file; resolves with its path, or null when cancelled. */
export function pickFile(w3: W3Api, host: HTMLElement, opts: { title: string; kind: FileKind; current: string; thumb?: (path: string) => Promise<string | null> }): Promise<string | null> {
  return pick(host, { ...opts, w3, folders: true, preview: opts.kind, images: opts.kind === "image", placeholder: "Search by words of the path, e.g. footman, BTN hero", load: () => filesOf(w3, opts.kind) });
}

/** Lets the user choose one of `labels` (sound labels); resolves with it, or null when cancelled. */
export function pickLabel(w3: W3Api, host: HTMLElement, opts: { title: string; current: string; labels: () => Promise<string[]> }): Promise<string | null> {
  const player = soundPlayer(w3);
  return pick(host, { title: opts.title, current: opts.current, images: false, placeholder: "Search by words of the label", preview: "sound", play: player.play, stop: player.stop,
    load: async () => (await opts.labels()).map((path) => ({ path, imported: false })) });
}

function pick(host: HTMLElement, opts: PickOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let all: FileEntry[] = [];
    let shown: FileEntry[] = [];
    let active = 0;
    /** The folder listed, "" for all of them; which ones show their subfolders. */
    let folder = "";
    let tree: Folder | null = null;
    const open = new Set<string>();
    const model = opts.preview === "model" && opts.w3 ? new ModelPreview(opts.w3) : null;
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (path: string | null) => {
      clearTimeout(previewTimer);
      seen.disconnect();
      opts.stop?.();
      model?.dispose();
      overlay.remove();
      resolve(path);
    };
    const countEl = h("span.muted", {}, "Reading files…");
    const rowsEl = h("div.picker-rows");
    const treeEl = h("div.browse-tree");
    const big = h("img.browse-image", { alt: "" });
    const caption = h("div.browse-caption.muted");
    const noise = h("div.browse-sound.muted");
    const play = h("button.browse-play", { title: "Play this sound", onclick: () => {
      const f = shown[active];
      if (!f || !opts.play) return;
      noise.textContent = "";
      void opts.play(f.path).catch((e) => { noise.textContent = String((e as Error).message ?? e); });
    } }, "▶ Play");
    const previewEl = opts.preview ? h("div.browse-preview", {},
      model?.el ?? null, opts.preview === "image" ? big : null, opts.preview === "sound" ? play : null, noise, caption) : null;
    /** Shows the highlighted file, a moment later: arrowing through a list shouldn't load each model. */
    const showPreview = () => {
      clearTimeout(previewTimer);
      const f = shown[active];
      caption.textContent = f?.path ?? "";
      caption.title = f?.path ?? "";
      noise.textContent = "";
      previewTimer = setTimeout(() => {
        if (model) model.show(f?.path ?? null);
        if (opts.preview === "image") {
          big.removeAttribute("src");
          if (f) void opts.thumb?.(f.path).then((src) => { if (src && shown[active] === f) big.src = src; });
        }
      }, 120);
    };
    const mark = () => {
      [...rowsEl.children].forEach((row, i) => row.classList.toggle("active", i === active));
      rowsEl.children[active]?.scrollIntoView({ block: "nearest" });
      showPreview();
    };
    // Lists without folders start from the current name. With folders that would hide nearly every
    // file of every other folder: those open at the current file instead.
    const start = opts.folders ? "" : (opts.current.split(",")[0] ?? "").trim().replace(/^.*\\/, "").replace(/\.\w+$/, "");
    const search = h("input.picker-search", {
      placeholder: opts.placeholder,
      value: start === "_" ? "" : start,
      oninput: () => { active = 0; filter(); },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "ArrowDown") { active = Math.min(active + 1, Math.min(shown.length, MAX_ROWS) - 1); mark(); e.preventDefault(); }
        else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); mark(); e.preventDefault(); }
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
      if (!shown.length && all.length) {
        rowsEl.replaceChildren(h("div.browse-empty.muted", {}, search.value.trim() ? `Nothing here matches "${search.value.trim()}". Clear the search to see this folder.` : "No files here."));
        mark();
        return;
      }
      rowsEl.replaceChildren(...shown.slice(0, MAX_ROWS).map((f, i) => {
        const img = opts.images && opts.thumb ? h("img.picker-icon", { alt: "", "data-path": f.path }) : null;
        if (img) seen.observe(img);
        // A click only highlights, so the row has to stay for the second one.
        return h("div.picker-row", {
          onclick: () => { active = i; mark(); },
          ondblclick: () => finish(f.path),
        }, img, h("span.picker-name", { title: f.path }, f.path), f.imported ? h("span.badge", { title: "Imported into this map" }, "map") : null);
      }));
      mark();
    };
    const filter = () => {
      const words = search.value.toLowerCase().split(/[\s\\/]+/).filter(Boolean);
      shown = all.filter((f) => { const p = f.path.toLowerCase(); return inFolder(f.path, folder) && words.every((w) => p.includes(w)); });
      countEl.textContent = shown.length > MAX_ROWS ? `${MAX_ROWS} of ${shown.length}` : String(shown.length);
      renderRows();
    };
    const renderTree = () => {
      const row = (f: Folder, depth: number): HTMLElement[] => {
        const isOpen = open.has(f.path), label = f.path ? f.name : "All files";
        return [
          h(`div.browse-folder${folder === f.path ? ".active" : ""}`, {
            style: { paddingLeft: `${6 + depth * 12}px` }, title: f.path || "All files",
            onclick: () => {
              folder = f.path;
              if (f.path) { if (isOpen) open.delete(f.path); else open.add(f.path); }
              active = 0;
              renderTree();
              filter();
            },
          }, h("span.browse-arrow", {}, f.children.length && f.path ? (isOpen ? "▾" : "▸") : ""), h("span.browse-name", {}, label), h("span.muted", {}, String(f.files))),
          ...(isOpen || !f.path ? f.children.flatMap((c) => row(c, depth + (f.path ? 1 : 0))) : []),
        ];
      };
      if (tree) treeEl.replaceChildren(...row(tree, 0));
    };
    const body = h("div.browse-body", {}, opts.folders ? treeEl : null, rowsEl, previewEl);
    const overlay = h("div.picker-overlay", { onmousedown: (e: MouseEvent) => { if (e.target === overlay) finish(null); } },
      h("div.picker.picker-browse", {},
        h("div.picker-header", {}, h("strong", {}, opts.title), countEl, h("button.icon-button", { title: "Cancel (Esc)", onclick: () => finish(null) }, "×")),
        search,
        body,
        h("div.picker-hint.muted", {}, "↑↓ move · Enter or double-click choose · Esc cancel")));
    host.append(overlay);
    search.focus();
    search.select();
    void opts.load().then((files) => {
      all = files;
      if (opts.folders) {
        const paths = files.map((f) => f.path);
        tree = folderTree(paths);
        // Open where the current file is, highlighted.
        const listed = findListed(opts.current, paths);
        if (listed) {
          const parents = foldersOf(listed);
          for (const f of parents) open.add(f);
          folder = parents[parents.length - 1] ?? "";
        }
        renderTree();
        filter();
        if (listed) {
          active = Math.max(0, shown.findIndex((f) => f.path === listed));
          mark();
        }
      } else filter();
    }, (e) => { countEl.textContent = String((e as Error).message ?? e); });
  });
}
