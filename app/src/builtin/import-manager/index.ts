// Import Manager: the map's imported files (war3map.imp) like the World
// Editor's Import Manager. Imported files are ordinary files in the project's
// map folder; the list says which of them the map registers and under which
// archive path. Changes apply at once: the files on disk move, and the list is
// written right after (so the two never disagree).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { formatBytes, h } from "../../workbench/dom";
import { findPathRefs, updatePathRefs } from "./references";
import { clickSelection } from "../../lib/selection";
import { keyOf } from "../../lib/keys";
import { BusyQueue } from "../../lib/busyqueue";
import { addKeyContext, UNDO_CONTEXT, undoStepOf } from "../../lib/keybindings";
import { archivePath, CAMPAIGN_IMPORT_FOLDER, classicPathOf, CUSTOM_PATH_FLAGS, entryCandidates, hasModeVersions, IMPORT_FOLDER, importPath, importRows, importTreePath, isJunkFile, kindOf, newEntryFlags, pathForUse, projectPath, rowEntries, rowMoves, samePath, sidePathOf, SIDES, takenWithVersions, unlistedFiles, type ImportEntry, type ImportRow, type Side, type UseIn } from "../../lib/imports";
import { bringsTextures, followingTextures, modelTextures, shownEntry, SIDE_NAME, SIDE_PREFER, versionsToAdd, versionToAdd } from "./versions";
import type { FileInfo } from "../../extensions/api";
import { decodeImage } from "../../lib/image/index.ts";
import { ModelPreview } from "../../lib/model/preview";
import { previewKey } from "./previewkind";
import { replaceFile, stepReplace, UNDO_LIMIT, type ReplaceFs, type ReplaceStep } from "./replace";
import { keepFiles, removeStep, stepRemove, type RemoveStep } from "./remove";

/** The import list: the map's, or in a campaign project the campaign's. */
const lists = (campaign: boolean) => {
  const raw = campaign ? "map/war3campaign.imp" : "map/war3map.imp";
  return { RAW: raw, FILE: `${raw}.json` };
};
/** Files above this size aren't opened in a viewer (they're read whole into the window). */
const MAX_OPEN = 256 * 1024 * 1024;
/** Longest side the preview needs: the first mip level at least this large is drawn. */
const PREVIEW_SIDE = 320;
/** A folder with more files than this is confirmed first (it's easily the wrong folder). */
const CONFIRM_FOLDER = 100;

interface ImportsDoc { format?: string; version: number; files: ImportEntry[] }
/** A file to import: absolute source, and for folder imports its path inside the folder. */
interface ImportSource { src: string; relative?: string }
const entryKey = (e: ImportEntry) => e.path.toLowerCase();
const plural = (n: number, what: string) => `${n.toLocaleString()} ${what}${n === 1 ? "" : "s"}`;
/** The answers to removing entries whose files are in the project. */
const REMOVE_ONLY = "Remove from list", REMOVE_AND_DELETE = "Remove and delete file";
/** The open Import Manager that can change files (for its commands). */
let openView: ImportView | null = null;

export function activate(w3: W3Api, ctx: ExtensionContext) {
  ctx.subscriptions.push(
    w3.commands.register("w3.imports.open", async () => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      const files = new Set(w3.workspace.files().map((f) => f.path.replace(/\\/g, "/").toLowerCase()));
      const { RAW, FILE } = lists(files.has("map/war3campaign.w3f.json") || files.has("map/war3campaign.w3f"));
      if (!files.has(FILE) && files.has(RAW)) { await w3.editors.open(RAW, "w3.importManager"); return; }
      // A map without imports opens an empty list; the file is written with the first import.
      await w3.editors.open(FILE, "w3.importManager");
    }),
    // Archive paths of files in the map folder into the import list (the Problems view's "Add to import list").
    w3.commands.register("w3.imports.add", (paths: string[]) => addQueue(() => addToList(w3, paths))),
    w3.commands.register("w3.imports.replace", async () => {
      if (!openView) throw new Error("Open the Import Manager and select a file first.");
      await openView.replaceSelected();
    }),
    // The selected import's other version (Reforged for a plain file, Classic for a Reforged one), or the import of
    // `path` (an archive path, either version; the Problems view's fixes), picked on disk.
    w3.commands.register("w3.imports.addVersion", async (path?: string, side?: Side) => {
      if (typeof path === "string" && path) {
        await w3.commands.execute("w3.imports.open");
        if (!openView?.isListOf(w3.workspace.project()?.root)) throw new Error("The Import Manager can't change this project's list.");
        openView.selectPath(path);
      }
      if (!openView) throw new Error("Open the Import Manager and select a file first.");
      await openView.addVersionSelected(side);
    }),
    // The selected import's 3.0 version (`_DE.w3mod\`).
    w3.commands.register("w3.imports.addDeVersion", async () => {
      if (!openView) throw new Error("Open the Import Manager and select a file first.");
      await openView.addVersionSelected("de");
    }),
    w3.editors.registerProvider("w3.importManager", {
      async resolve(el, doc) {
        const raw = !doc.path.toLowerCase().endsWith(".json");
        const root = w3.workspace.project()!.root;
        let isNew = !raw && !w3.workspace.files().some((f) => f.path.toLowerCase() === doc.path.toLowerCase());
        const list: ImportsDoc = isNew ? { format: "w3proj.imports/1", version: 1, files: [] }
          : JSON.parse(raw ? await w3.backend.invoke<string>("codec_decode", { root, path: doc.path }) : await doc.readText());
        list.files ??= [];
        // Written after every change (the files on disk have changed already).
        const write = async () => {
          if (raw) await w3.backend.invoke("codec_write", { root, path: doc.path, text: JSON.stringify({ format: "w3proj.imports/1", ...list }) });
          else await doc.writeText(await w3.backend.invoke<string>("codec_canonicalize", { root, path: doc.path, text: JSON.stringify(list) }));
          if (isNew) { isNew = false; await w3.workspace.refresh(); }
          doc.setDirty(false);
        };
        const campaign = /war3campaign\.imp(\.json)?$/i.test(doc.path);
        const view = new ImportView(w3, el, list, write, !doc.readOnly, campaign ? CAMPAIGN_IMPORT_FOLDER : IMPORT_FOLDER);
        const stop = w3.workspace.onDidChange(() => view.render());
        // The preview shows the version of the graphics mode set.
        const stopMode = w3.settings.onDidChange((key) => { if (key === "game.graphicsMode") view.modeChanged(); });
        if (!doc.readOnly) openView = view;
        // Replace File is the one change here with a way back (the others act on the files at once, as there).
        return { undo: () => view.step(-1), redo: () => view.step(1), dispose: () => { view.disposed = true; view.dropModelPreview(); stop.dispose(); stopMode.dispose(); if (openView === view) openView = null; } };
      },
    }),
  );
}

/** Adds to the list one at a time: two adds reading and writing the list at once would lose an entry. */
let addTail: Promise<unknown> = Promise.resolve();
function addQueue<T>(task: () => Promise<T>): Promise<T> {
  const run = addTail.then(task, task);
  addTail = run.catch(() => {});
  return run;
}

/** Lists archive paths in the project's import list (the campaign's in a campaign project), with the flags new
 *  imports get; paths listed already stay as they are. Through the open Import Manager, whose list is the one in
 *  memory, else into the file: the project's JSON, or the raw file through its codec, or a new JSON list. A list that
 *  is there and can't be read throws, nothing written. */
async function addToList(w3: W3Api, paths: string[]): Promise<void> {
  const root = w3.workspace.project()?.root;
  if (!root) throw new Error("Open or import a project first.");
  if (!Array.isArray(paths) || !paths.length || paths.some((p) => typeof p !== "string" || !p)) throw new Error("No archive paths to add.");
  if (openView?.isListOf(root)) { await openView.add(paths); return; }
  const files = new Set(w3.workspace.files().map((f) => f.path.replace(/\\/g, "/").toLowerCase()));
  const { RAW, FILE } = lists(files.has("map/war3campaign.w3f.json") || files.has("map/war3campaign.w3f"));
  const raw = !files.has(FILE) && files.has(RAW);
  let list: ImportsDoc;
  try {
    const text = raw ? await w3.backend.invoke<string>("codec_decode", { root, path: RAW }) : files.has(FILE) ? await w3.workspace.readText(FILE) : null;
    list = text === null ? { format: "w3proj.imports/1", version: 1, files: [] } : JSON.parse(text);
    if (!Array.isArray(list?.files)) throw new Error("no file list");
  } catch (e) {
    throw new Error(`${raw ? RAW : FILE} can't be read (${(e as Error).message ?? e}); nothing was added.`);
  }
  const fresh = paths.filter((p, i) => !list.files.some((f) => samePath(f.path, p)) && paths.findIndex((q) => samePath(q, p)) === i);
  if (!fresh.length) return;
  list.files.push(...fresh.map((path) => ({ flags: newEntryFlags(path), path })));
  const text = raw ? JSON.stringify({ format: "w3proj.imports/1", ...list }) : await w3.backend.invoke<string>("codec_canonicalize", { root, path: FILE, text: JSON.stringify(list) });
  // Another project meanwhile, or the Import Manager opened on this one (its list in memory would be written over).
  if (w3.workspace.project()?.root !== root) throw new Error("The project changed meanwhile; nothing was added.");
  if (openView?.isListOf(root)) { await openView.add(paths); return; }
  if (raw) await w3.backend.invoke("codec_write", { root, path: RAW, text });
  else await w3.workspace.writeText(FILE, text);
  await w3.workspace.refresh();
}

class ImportView {
  /** Selected rows (ImportRow.key: a file and its Reforged version are one row); render() drops what the filter hides,
   *  so that actions only ever touch rows that can be seen. */
  private selected = new Set<string>();
  private anchor: string | null = null;
  /** The rows as shown (selection ranges, Ctrl+A). */
  private shown: ImportRow[] = [];
  private query = "";
  /** "Use in" for the next imports of models and textures (lib/imports.ts UseIn). */
  private useIn: UseIn = "both";
  /** The image last previewed (the list redraws often; decoding it each time would be slow). */
  private preview_: { key: string; canvas: HTMLCanvasElement } | null = null;
  /** The model previewed (one WebGL context at a time: a new one replaces it, none when a non-model is selected). */
  private modelPreview: { key: string; view: ModelPreview; failed: boolean } | null = null;
  /** Replace File and Remove steps, for undo and redo; `at` of them are done. */
  private history: ({ replace: ReplaceStep } | { remove: RemoveStep<ImportEntry> })[] = [];
  private at = 0;
  /** A replace, undo or redo is writing: another replace is refused meanwhile, undo and redo wait for it (in order;
   *  dropped when the editor closes or another project opens). */
  private queue = new BusyQueue(() => !this.disposed && this.w3.workspace.project()?.root === this.root);
  private get busy() { return this.queue.busy; }
  private readonly root: string | undefined;
  /** The editor closed: a replace that was waiting for a file choice stops, waiting undo and redo steps too. */
  disposed = false;

  constructor(private w3: W3Api, private el: HTMLElement, private list: ImportsDoc, private write: () => Promise<void>, private editable: boolean,
    private folder: string) {
    this.root = w3.workspace.project()?.root;
    el.classList.add("imp-editor");
    el.tabIndex = -1;
    addKeyContext(el, UNDO_CONTEXT);
    el.addEventListener("keydown", (e) => {
      // The filter field keeps its own keys (Ctrl+Z there takes back what was typed).
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      const key = keyOf(e).toLowerCase();
      // Replace File's undo and redo, as the title bar's buttons.
      const step = undoStepOf(w3.keybindings.commandsFor(e));
      if (step) {
        e.preventDefault();
        this.step(step === "undo" ? -1 : 1);
      } else if (key === "a" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.selected = new Set(this.shown.map((r) => r.key));
        this.render();
      } else if (key === "delete" && this.editable && this.selected.size) {
        this.remove(this.shown.filter((r) => this.selected.has(r.key)));
      }
    });
    this.render();
  }

  /** Project files by lower-case project path, with sizes. */
  private files() {
    return new Map(this.w3.workspace.files().map((f) => [f.path.replace(/\\/g, "/").toLowerCase(), f]));
  }
  /** The project file an entry stands for (sounds may be stored under another extension). */
  private fileOf(e: ImportEntry, files = this.files()): FileInfo | undefined {
    for (const c of entryCandidates(e, this.folder)) { const f = files.get(c.toLowerCase()); if (f) return f; }
    return undefined;
  }
  /** The path the game uses for an entry: standard-path entries found in the import folder get it in front. */
  private shownPath(e: ImportEntry, f: FileInfo | undefined): string {
    const inFolder = f?.path.replace(/\\/g, "/").toLowerCase().startsWith(`map/${this.folder.toLowerCase()}/`);
    return inFolder && !e.path.toLowerCase().startsWith(`${this.folder.toLowerCase()}\\`) ? `${this.folder}\\${e.path}` : e.path;
  }
  private taken(path: string) {
    return this.list.files.some((f) => samePath(f.path, path)) || this.files().has(projectPath(path).toLowerCase());
  }
  /** The list as rows: an import and its Reforged version (`_HD.w3mod\…`) are one. */
  private rows(files = this.files()): ImportRow[] {
    return importRows(this.list.files, (e) => this.shownPath(e, this.fileOf(e, files)));
  }
  /** The graphics mode set (game.graphicsMode): which version of a row the previews show. */
  private mode() {
    return this.w3.settings.get<string>("game.graphicsMode") ?? "hd";
  }
  /** Another graphics mode: the previews show its version. */
  modeChanged() {
    this.preview_ = null;
    this.dropModelPreview();
    this.render();
  }
  /** Selects the row of an archive path (either version), as the Problems view's fixes name it. */
  selectPath(path: string) {
    const row = this.rows().find((r) => samePath(r.path, classicPathOf(path)));
    if (!row) throw new Error(`${path} isn't in the import list.`);
    // A filter that hides the row would drop the selection.
    this.query = "";
    this.selected = new Set([row.key]);
    this.anchor = row.key;
    this.render();
  }
  /** False when `f` failed (its error is shown). */
  private async run(label: string, f: () => Promise<void>): Promise<boolean> {
    let ok = true;
    try { await f(); } catch (e) { ok = false; void this.w3.window.showError(`${label}: ${(e as Error).message ?? e}`); }
    this.render();
    return ok;
  }

  // ---- actions ----------------------------------------------------------------------
  private importFiles() {
    void this.run("Import", async () => {
      const picked = await this.w3.window.pickFiles({ title: "Import files into the map" });
      if (picked.length) await this.importAll(picked.map((src) => ({ src })));
    });
  }
  /** A folder with what's below it: its structure stays, below the import folder. */
  private importFolder() {
    void this.run("Import", async () => {
      const dir = await this.w3.window.pickFolder({ title: "Import a folder into the map" });
      if (!dir) return;
      const base = dir.replace(/[\\/]+$/, "");
      const name = base.split(/[\\/]/).pop() ?? "";
      const found = await this.w3.workspace.listFolder(dir);
      const files = found.filter((f) => !isJunkFile(f));
      if (!files.length) { void this.w3.window.showInfo(`${dir} has no files to import.`); return; }
      if (files.length > CONFIRM_FOLDER) {
        const c = await this.w3.window.showWarning(`Import ${plural(files.length, "file")} from ${dir}?`, "Import", "Cancel");
        if (c !== "Import") return;
      }
      // A drive root has no name of its own.
      await this.importAll(files.map((f) => ({ src: `${base}/${f}`, relative: name.endsWith(":") ? f : `${name}/${f}` })));
    });
  }
  private async importAll(sources: ImportSource[]) {
    // A map or campaign is more likely meant to become a project of its own.
    const maps = sources.filter((s) => /\.w3[mxn]$/i.test(s.src));
    if (sources.length === 1 && maps.length) {
      const src = sources[0].src;
      const c = await this.w3.window.showWarning(`${src.split(/[\\/]/).pop()} is a map or campaign. Import it into this map as a file anyway?`,
        "Import as file", "Open as new project…", "Cancel");
      if (c === "Open as new project…") { await this.w3.commands.execute("w3.project.importMap", src); return; }
      if (c !== "Import as file") return;
    } else if (maps.length) {
      const c = await this.w3.window.showWarning(`${maps.length} of these ${maps.length === 1 ? "is a map or campaign" : "are maps or campaigns"}. Import as files too?`, "Import as files", "Skip them", "Cancel");
      if (c === "Skip them") sources = sources.filter((s) => !maps.includes(s));
      else if (c !== "Import as files") return;
    }
    if (!sources.length) return;
    const existing = this.files();
    const used = new Set(this.list.files.map(entryKey));
    // Also against the batch itself, which isn't on disk or in the list yet, and against each name's other version (an
    // unrelated file there would stand in for it in the other graphics mode).
    const takenOne = (p: string) => used.has(p.toLowerCase()) || existing.has(projectPath(p).toLowerCase());
    const taken = (p: string) => takenWithVersions(p, takenOne);
    const use = this.useIn;
    const paths = sources.map((s) => {
      const plain = s.relative ? importTreePath(s.relative, taken, this.folder) : importPath(s.src, taken, this.folder);
      // Reforged only / 3.0 only: models and textures below _HD.w3mod\ / _DE.w3mod\ (the object data names the plain path all the same).
      const path = pathForUse(plain, use);
      used.add(path.toLowerCase());
      return path;
    });
    // Copied in the backend: imports can be far larger than the webview can hold.
    const title = paths.length === 1 ? `Importing ${paths[0]}` : `Importing ${plural(paths.length, "file")}`;
    const { copied, error } = await this.w3.window.withProgress(title, () =>
      this.w3.workspace.copyMany(sources.map((s, i) => [s.src, projectPath(paths[i])])));
    const done = paths.slice(0, copied);
    // What was copied is listed even if a later file failed: the list and the disk agree.
    this.list.files.push(...done.map((path) => ({ flags: newEntryFlags(path), path })));
    if (done.length) await this.write();
    this.select(done);
    if (error) throw new Error(`${done.length} of ${paths.length} imported, then: ${error}`);
    if (done.length > 1) void this.w3.window.showInfo(`Imported ${plural(done.length, "file")}${use === "reforged" ? " (models and textures for Reforged only)" : use === "de" ? " (models and textures for 3.0 only)" : ""}.`);
    // A model for one graphics mode: the textures next to it on disk can go into the same mode's folder.
    if (use !== "both" && !sources.some((s) => s.relative)) {
      for (const [i, path] of done.entries()) if (bringsTextures(path)) await this.bringTextures(sources[i].src, path, use === "reforged" ? "reforged" : use === "de" ? "de" : "classic");
    }
    if (use === "classic" && done.some(hasModeVersions)) {
      // A note, not a question: the import is done either way.
      const one = done.length === 1 ? done[0] : null;
      void this.w3.window.showInfo(`Imported for Classic. Reforged reads ${one ? "it" : "them"} too until ${one ? "it has" : "each has"} a Reforged version.`, ...(one ? ["Add Reforged Version…"] : []))
        .then(async (pick) => {
          if (!one || pick !== "Add Reforged Version…" || !this.isListOf(this.w3.workspace.project()?.root)) return;
          this.select([one]);
          await this.addVersionSelected();
        });
    }
  }
  /** Asks whether the textures a model names that lie next to it on disk (`src`) go into the map with it, at the
   *  model's graphics mode's path (`reforged`: below _HD.w3mod\), and imports them. Textures whose path is taken stay
   *  out; a model that can't be read brings none. */
  private async bringTextures(src: string, model: string, side: Side) {
    let bytes: Uint8Array;
    try { bytes = await this.w3.backend.readBytes(src); } catch { return; }
    const textures = modelTextures(bytes);
    if (!textures) return;
    const dir = src.replace(/[\\/][^\\/]*$/, "");
    const found = await followingTextures(dir, textures, (a) => sidePathOf(a, side),
      (f) => this.w3.backend.invoke<boolean>("fs_exists", { path: f }).catch(() => false), (a) => this.taken(a));
    if (!found.length || this.disposed) return;
    const mode = SIDE_NAME[side];
    const names = found.map((t) => t.archive).join(", ");
    const c = await this.w3.window.showInfo(`${model.split("\\").pop()} names ${plural(found.length, "texture")} found next to it: ${names}. Import ${found.length === 1 ? "it" : "them"} for ${mode} too?`, "Import textures", "Skip");
    if (c !== "Import textures" || this.disposed || this.w3.workspace.project()?.root !== this.root) return;
    // Taken meanwhile (another action during the question): left out.
    const fresh = found.filter((t) => !this.taken(t.archive));
    const { copied, error } = await this.w3.window.withProgress(`Importing ${plural(fresh.length, "texture")}`, () =>
      this.w3.workspace.copyMany(fresh.map((t) => [t.file, projectPath(t.archive)])));
    const done = fresh.slice(0, copied);
    this.list.files.push(...done.map((t) => ({ flags: newEntryFlags(t.archive), path: t.archive })));
    if (done.length) await this.write();
    if (error) throw new Error(`${done.length} of ${fresh.length} textures imported, then: ${error}`);
  }
  private select(paths: string[]) {
    this.selected = new Set(paths.map((p) => classicPathOf(p).toLowerCase()));
    this.anchor = paths.length ? classicPathOf(paths[paths.length - 1]).toLowerCase() : null;
  }
  private register(path: string) {
    void this.run("Add", () => this.add([path]));
  }
  /** Lists files of the map folder (archive paths) that aren't listed yet, and selects them. */
  async add(paths: string[]) {
    const fresh = paths.filter((p, i) => !this.list.files.some((f) => samePath(f.path, p)) && paths.findIndex((q) => samePath(q, p)) === i);
    if (fresh.length) {
      this.list.files.push(...fresh.map((path) => ({ flags: newEntryFlags(path), path })));
      await this.write();
    }
    this.select(paths);
    this.render();
  }
  /** Whether this is the open, changeable list of the project `root`. */
  isListOf(root: string | undefined) {
    return !this.disposed && this.editable && !!root && this.root === root;
  }
  /** Moves a row's files and entries: an import and its Reforged version move together (the Reforged one into its
   *  folder), so what names the plain path finds both. */
  private changePath(row: ImportRow, to: string) {
    void this.run("Change path", async () => {
      to = to.trim().replace(/\//g, "\\").replace(/^\\+/, "");
      const files = this.files();
      const pathOf = (e: ImportEntry) => this.shownPath(e, this.fileOf(e, files));
      const moves = rowMoves(row, to, pathOf).filter((m) => !samePath(m.from, m.to));
      if (!to || !moves.length) return;
      if (moves.some((m) => m.to.split("\\").some((part) => part === ".." || part === ""))) throw new Error("Not a valid path.");
      // A move onto the row's own other path (the case of a name changed) isn't a clash.
      const own = new Set(moves.map((m) => m.from.toLowerCase()));
      const clash = moves.find((m) => !own.has(m.to.toLowerCase()) && this.taken(m.to));
      if (clash) throw new Error(`${clash.to} is already in the map.`);
      let changed = false;
      try {
        for (const m of moves) {
          const f = this.fileOf(m.entry, files);
          if (f) await this.w3.workspace.rename(f.path, projectPath(m.to));
          // A standard-path entry (name inside the import folder) now has a path of its own.
          if (m.entry.path !== m.from) m.entry.flags = CUSTOM_PATH_FLAGS;
          m.entry.path = m.to;
          changed = true;
        }
      } finally {
        // Also after a failed second move: the list says where the first file went.
        if (changed) await this.write();
      }
      // The data names the plain path, whichever versions moved.
      const from = classicPathOf(moves[0].from);
      to = classicPathOf(moves[0].to);
      this.select([to]);
      if (samePath(from, to)) return;
      // What used the old path (object data, triggers, scripts, models) can follow.
      const refs = await findPathRefs(this.w3, from, projectPath(moves[0].to));
      const raw = refs.raw.length ? ` Not changeable (kept in binary form; re-sync the project to get text): ${refs.raw.map((p) => p.slice(4)).join(", ")}.` : "";
      if (!refs.files.length) {
        void this.w3.window.showInfo(`Moved. Nothing in the map's text files or models used the old path.${raw}`);
        return;
      }
      const count = refs.files.reduce((n, r) => n + r.count, 0);
      const list = refs.files.map((r) => `${r.path.slice(4)} (${r.count})`).join(", ");
      const pick = await this.w3.window.showInfo(`Moved. ${count} reference${count === 1 ? "" : "s"} to the old path in ${list}.${raw}`, "Update references", "Keep them");
      if (pick !== "Update references") return;
      await updatePathRefs(this.w3, refs, from, to);
      void this.w3.window.showInfo(`Updated ${count} reference${count === 1 ? "" : "s"} to ${to}.`);
    });
  }
  /** Removes entries from the list. Entries whose files are in the project ask whether the files go too: a file left
   *  in the map folder without an entry is still packed into the map and used by the game (the Problems view warns
   *  of it), so that is never done without saying so. */
  private remove(rows: ImportRow[], only?: typeof SIDES[number][]) {
    void this.run("Remove", async () => {
      const versions = rows.length === 1 ? SIDES.filter((s) => rows[0][s]) : [];
      // A row with several versions asks which of them go (Remove both / one side / Cancel); the buttons of the
      // detail pane name the side up front. Removing one leaves the other as a row of its own.
      let chosen = only;
      if (!chosen && versions.length > 1) {
        const all = versions.length === 2 ? "Remove both" : "Remove all";
        const answer = await this.w3.window.showWarning(`${rows[0].path} has ${versions.slice(0, -1).map((s) => SIDE_NAME[s]).join(", ")} and ${SIDE_NAME[versions[versions.length - 1]]} versions. Which should be removed from the import list?`,
          all, ...versions.map((s) => `Remove ${SIDE_NAME[s]} only`), "Cancel");
        if (answer === all) chosen = versions;
        else { const side = versions.find((s) => answer === `Remove ${SIDE_NAME[s]} only`); if (!side) return; chosen = [side]; }
      }
      let entries = chosen ? chosen.flatMap((s) => rows[0][s] ?? []) : rows.flatMap(rowEntries);
      const picked = chosen ?? versions;
      const what = versions.length > 1 ? (picked.length === 1 ? `the ${SIDE_NAME[picked[0]]} version of ${rows[0].path}` : `${rows[0].path} (its ${picked.slice(0, -1).map((s) => SIDE_NAME[s]).join(", ")} and ${SIDE_NAME[picked[picked.length - 1]]} versions)`) : entries.length === 1 ? entries[0].path : `${entries.length.toLocaleString()} entries`;
      const asked = [...new Set(entries.flatMap((e) => this.fileOf(e)?.path ?? []))];
      let withFiles = false;
      if (!asked.length) {
        const none = entries.length === 1 ? "Its file isn't in the project." : "None of their files is in the project.";
        if (!(await this.w3.window.askDelete(`Remove ${what} from the import list? ${none}`, "Remove"))) return;
      } else {
        const files = asked.length === 1 ? (entries.length === 1 ? "Its file" : "1 of their files") : `${asked.length} of their files`;
        const answer = await this.w3.window.showWarning(`Remove ${what} from the import list? ${files} ${asked.length === 1 ? "is" : "are"} in the project: `
          + `kept, ${asked.length === 1 ? "it is" : "they are"} still packed into the map and used by the game, without an entry.`, REMOVE_ONLY, REMOVE_AND_DELETE, "Cancel");
        if (answer !== REMOVE_ONLY && answer !== REMOVE_AND_DELETE) return;
        withFiles = answer === REMOVE_AND_DELETE;
      }
      // The editor closed or another project opened during the question: nothing is done.
      if (this.disposed || this.w3.workspace.project()?.root !== this.root) return;
      if (this.busy) throw new Error("Another change is still being written.");
      // Files too large to keep for undo: asked, as with Replace File.
      if (withFiles) {
        const sizes = asked.reduce((n, p) => n + (this.files().get(p.toLowerCase())?.size ?? 0), 0);
        if (sizes > UNDO_LIMIT && !(await this.w3.window.confirm(`${what} has files too large to keep for undo: deleting them can't be taken back.`, "Remove", 60000))) return;
        if (this.disposed || this.w3.workspace.project()?.root !== this.root) return;
        if (this.busy) throw new Error("Another change is still being written.");
      }
      let error: string | null = null, count = 0, total = 0;
      await this.queue.hold(async () => {
        // Entries another action removed meanwhile are left out; the files as they are now.
        entries = entries.filter((e) => this.list.files.includes(e));
        const files = this.files();
        const fileOf = new Map(entries.map((e) => [e, withFiles ? this.fileOf(e, files)?.path : undefined]));
        // Sound entries of different extensions can stand for the same file.
        const paths = [...new Set([...fileOf.values()].filter((p): p is string => !!p))];
        const kept = paths.length ? await keepFiles(this.replaceFs(), paths) : [];
        const res = paths.length ? await this.w3.window.withProgress(`Removing ${plural(entries.length, "file")}`, () => this.w3.workspace.deleteMany(paths))
          : { deleted: 0, error: null };
        error = res.error;
        const left = new Set(paths.slice(res.deleted));
        const gone = new Set(entries.filter((e) => !left.has(fileOf.get(e) ?? "")));
        const step = removeStep(this.list.files, gone, kept.filter((f) => !left.has(f.path)));
        this.list.files = this.list.files.filter((f) => !gone.has(f));
        count = gone.size; total = entries.length;
        if (gone.size) { this.history.splice(this.at, this.history.length, { remove: step }); this.at = this.history.length; }
        await this.write();
      });
      this.select([]);
      if (error) throw new Error(`${count} of ${total} removed, then: ${error}`);
    });
  }
  /** The workspace as a replace uses it. */
  private replaceFs(): ReplaceFs {
    const ws = this.w3.workspace;
    return {
      readBytes: (p) => ws.readBytes(p), writeBytes: (p, b) => ws.writeBytes(p, b), copy: (a, b) => ws.copy(a, b), delete: (p) => ws.delete(p),
      size: (p) => this.files().get(p.toLowerCase())?.size,
    };
  }
  /** Replace File: the entry keeps its path and flags, the project file (`file`) gets the content of a file chosen
   *  on disk, as one undo step. Editors showing the file take the new content (it is saved through the workspace). */
  replace(e: ImportEntry, file: string) {
    void this.run("Replace", async () => {
      if (this.busy) throw new Error("Another replace is still being written.");
      const root = this.w3.workspace.project()?.root;
      const src = await this.w3.window.pickFile({ title: `Replace ${e.path} with` });
      // The editor closed or another project opened during the choice: nothing is done.
      if (!src || this.disposed || this.w3.workspace.project()?.root !== root) return;
      const ext = (p: string) => (/\.([^.\\/]+)$/.exec(p)?.[1] ?? "").toLowerCase();
      if (ext(src) !== ext(e.path) && !(await this.w3.window.confirm(`${src.split(/[\\/]/).pop()} isn't a .${ext(e.path) || "(no extension)"} file. It is stored as ${e.path} anyway, and what uses that path reads it as such.`, "Replace", 60000))) return;
      const size = this.files().get(file.toLowerCase())?.size ?? 0;
      if (size > UNDO_LIMIT && !(await this.w3.window.confirm(`${e.path} is too large to keep for undo: replacing it can't be taken back.`, "Replace", 60000))) return;
      if (this.disposed || this.w3.workspace.project()?.root !== root || this.busy) return;
      await this.queue.hold(async () => {
        const step = await this.w3.window.withProgress(`Replacing ${e.path}`, () => replaceFile(this.replaceFs(), file, src));
        this.history.splice(this.at, this.history.length, { replace: step });
        this.at = this.history.length;
      });
      this.preview_ = null;
      void this.w3.window.showInfo(`Replaced ${e.path}.`);
    });
  }
  /** Replace File on the one selected entry (the command). */
  async replaceSelected() {
    const sel = this.shown.filter((r) => this.selected.has(r.key));
    if (sel.length !== 1) throw new Error("Select one imported file to replace.");
    let e = rowEntries(sel[0])[0];
    // A row with several versions: which one.
    const sides = SIDES.filter((s) => sel[0][s]);
    if (sides.length > 1) {
      const c = await this.w3.window.showInfo(`Replace which version of ${sel[0].path}?`, ...sides.map((s) => `${SIDE_NAME[s]} version`), "Cancel");
      const side = sides.find((s) => c === `${SIDE_NAME[s]} version`);
      if (!side) return;
      e = sel[0][side]!;
    }
    const f = this.fileOf(e);
    if (!f) throw new Error(`${e.path} isn't in the project's map folder.`);
    this.replace(e, f.path);
  }
  /** "Add Reforged Version…" / "Add Classic Version…" / "Add 3.0 Version…" on the one selected row (the command): `side`'s,
   *  else the likeliest (Reforged for a plain file, Classic for a Reforged one; 3.0 only when named). */
  async addVersionSelected(side?: Side) {
    const sel = this.shown.filter((r) => this.selected.has(r.key));
    if (sel.length !== 1) throw new Error("Select one imported file to add a version to.");
    if (!versionToAdd(sel[0], side)) throw new Error(`${sel[0].path} has ${side ? `a ${SIDE_NAME[side]} version` : "all of its versions"} already.`);
    await this.addVersion(sel[0], side);
  }
  /** Picks a file on disk and stores it as the row's other version: below _HD.w3mod\ for a plain import, at the plain
   *  path for a Reforged one; the same name, so the object data's one path finds the version of each graphics mode. A
   *  model's textures next to it can come along (asked). */
  private addVersion(row: ImportRow, side?: Side): Promise<boolean> {
    return this.run("Add version", async () => {
      const add = versionToAdd(row, side);
      if (!add) return;
      const mode = SIDE_NAME[add.side];
      const root = this.w3.workspace.project()?.root;
      const src = await this.w3.window.pickFile({ title: `${mode} version of ${row.path}` });
      if (!src || this.disposed || this.w3.workspace.project()?.root !== root) return;
      const ext = (p: string) => (/\.([^.\\/]+)$/.exec(p)?.[1] ?? "").toLowerCase();
      if (ext(src) !== ext(row.path) && !(await this.w3.window.confirm(`${src.split(/[\\/]/).pop()} isn't a .${ext(row.path) || "(no extension)"} file. It is stored as ${add.path} anyway, and what uses that path reads it as such.`, "Add", 60000))) return;
      // The row's other version arrived meanwhile, or a file of that name: nothing is written over.
      if (this.disposed || this.w3.workspace.project()?.root !== root || !this.list.files.includes(rowEntries(row)[0])) return;
      if (this.taken(add.path)) throw new Error(`${add.path} is already in the map.`);
      await this.w3.window.withProgress(`Adding ${add.path}`, () => this.w3.workspace.copy(src, projectPath(add.path)));
      this.list.files.push({ flags: add.flags, path: add.path });
      await this.write();
      this.select([add.path]);
      this.render();
      if (bringsTextures(add.path)) await this.bringTextures(src, add.path, add.side);
      void this.w3.window.showInfo(`Added the ${mode} version: ${add.path}.`);
    });
  }
  /** Undo (-1) or redo (1) of Replace File and Remove; pressed while a replace (or another step) is writing, it runs after that. */
  step(dir: -1 | 1) {
    this.queue.step(() => {
      const step = dir < 0 ? this.history[this.at - 1] : this.history[this.at];
      if (!step) return;
      return this.run(`${dir < 0 ? "Undo" : "Redo"} ${"remove" in step ? "Remove" : "Replace File"}`, async () => {
        if ("remove" in step) {
          await stepRemove(this.replaceFs(), this.list, step.remove, dir);
          await this.write();
        } else await stepReplace(this.replaceFs(), step.replace, dir);
        this.at += dir;
        this.preview_ = null;
      });
    });
  }

  /** `file`: the project file (its name may differ from the listed path for sounds). */
  private exportFile(path: string, file: string) {
    void this.run("Export", async () => {
      const target = await this.w3.window.pickSaveFile({ title: "Export file", defaultPath: path.split("\\").pop() });
      if (!target) return;
      await this.w3.window.withProgress(`Exporting ${path}`, () => this.w3.workspace.copy(file, target));
      void this.w3.window.showInfo(`Exported to ${target}`);
    });
  }
  /** Several files into a folder, each at its place in the map (names can repeat across folders). */
  private exportMany(files: string[]) {
    void this.run("Export", async () => {
      const dir = await this.w3.window.pickFolder({ title: "Export files to…" });
      if (!dir) return;
      const pairs = files.map((f): [string, string] => [f, `${dir}/${f.replace(/^map\//, "")}`]);
      const exists = await Promise.all(pairs.map(([, to]) => this.w3.backend.invoke<boolean>("fs_exists", { path: to })));
      const clashes = exists.filter(Boolean).length;
      if (clashes) {
        const c = await this.w3.window.showWarning(`${plural(clashes, "file")} already in ${dir}. Overwrite?`, "Overwrite", "Cancel");
        if (c !== "Overwrite") return;
      }
      const { copied, error } = await this.w3.window.withProgress(`Exporting ${plural(pairs.length, "file")}`, () => this.w3.workspace.copyMany(pairs));
      if (error) throw new Error(`${copied} of ${pairs.length} exported, then: ${error}`);
      void this.w3.window.showInfo(`Exported ${plural(copied, "file")} to ${dir}`);
    });
  }
  private openFile(path: string, file: string) {
    // Sounds play here; other files open in the viewer their type has.
    if (kindOf(path) === "Sound") {
      void this.run("Play", async () => {
        const bytes = await this.w3.workspace.readBytes(file);
        const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        await audio.play();
      });
      return;
    }
    void this.w3.editors.open(file).catch((e) => this.w3.window.showError(String(e)));
  }

  // ---- view -------------------------------------------------------------------------
  render() {
    const files = this.files();
    const q = this.query.trim().toLowerCase();
    const listed = this.rows(files).filter((r) => !q || rowEntries(r).some((e) => e.path.toLowerCase().includes(q)) || r.path.toLowerCase().includes(q));
    // Files in the map folder that the list doesn't register (and that aren't the map's own); the Problems view warns
    // of each (the same rule: lib/imports.ts unlistedFiles).
    const unlisted = unlistedFiles([...files.values()].map((f) => f.path), this.list.files, this.folder).map(archivePath)
      .filter((p) => !q || p.toLowerCase().includes(q));
    this.shown = listed;
    const shownKeys = new Set(listed.map((r) => r.key));
    for (const k of this.selected) if (!shownKeys.has(k)) this.selected.delete(k);
    const total = this.list.files.reduce((n, e) => n + (this.fileOf(e, files)?.size ?? 0), 0);

    const search = h("input.imp-search", { type: "search", placeholder: "Filter by path", value: this.query,
      oninput: () => {
        const caret = search.selectionStart ?? search.value.length;
        this.query = search.value;
        this.render();
        // The redrawn box keeps the focus and the cursor where it was.
        const box = this.el.querySelector(".imp-search") as HTMLInputElement | null;
        box?.focus();
        box?.setSelectionRange(caret, caret);
      } });
    // Which graphics modes the next imports of models and textures are for.
    const USE_IN: [UseIn, string, string][] = [
      ["both", "Both graphics modes", "Models and textures go to their plain path: Classic and Reforged both read it"],
      ["classic", "Classic only", "The plain path; Reforged reads it too until it has a Reforged version (Add Reforged Version…)"],
      ["reforged", "Reforged only", "Models and textures go below _HD.w3mod\\ (the object data names the plain path): only Reforged reads them"],
      ["de", "3.0 only", "Models and textures go below _DE.w3mod\\ (the object data names the plain path): only 3.0 reads them"]];
    const useIn = h("select.imp-use-in", { title: USE_IN.find((u) => u[0] === this.useIn)?.[2] ?? "",
      onchange: () => { this.useIn = useIn.value as UseIn; this.render(); } },
    ...USE_IN.map(([value, label, title]) => h("option", { value, title, selected: value === this.useIn }, label))) as HTMLSelectElement;
    const toolbar = h("div.imp-toolbar", {},
      ...(this.editable ? [h("button.primary", { onclick: () => this.importFiles() }, "Import files…"), h("button", { onclick: () => this.importFolder() }, "Import folder…"),
        h("label.imp-use-label", {}, "Use in", useIn)] : []),
      search, h("span.muted", {}, `${this.list.files.length} imported · ${formatBytes(total)}`));

    const rows = listed.map((r) => {
      const found = rowEntries(r).map((e) => this.fileOf(e, files));
      const shown = shownEntry(r, this.mode());
      const f = this.fileOf(shown, files);
      const active = this.selected.has(r.key);
      const size = found.reduce((n, x) => n + (x?.size ?? 0), 0);
      return h(`tr.imp-row${active ? ".active" : ""}${found.some((x) => !x) ? ".missing" : ""}`, {
        onclick: (ev: MouseEvent) => {
          const next = clickSelection(listed.map((x) => x.key), this.selected, this.anchor, r.key, { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey });
          this.selected = next.selected;
          this.anchor = next.anchor;
          this.render();
        },
        ondblclick: () => { if (f && f.size <= MAX_OPEN) this.openFile(shown.path, f.path); },
        title: found.some((x) => !x) ? "Not in the project's map folder" : "",
      }, h("td.imp-path", {}, r.classic ? this.shownPath(r.classic, found[0]) : r.path, ...this.badges(r)), h("td", {}, kindOf(r.path)),
      h("td.imp-size", {}, found.every((x) => !x) ? "missing" : formatBytes(size)), h("td.muted", {}, rowEntries(r).map((e) => String(e.flags)).join(" / ")));
    });
    const table = h("table.imp-table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Path in the map"), h("th", {}, "Type"), h("th", {}, "Size"), h("th", { title: "Import flags (war3map.imp)" }, "Flags"))),
      h("tbody", {}, ...rows));

    const sel = listed.filter((r) => this.selected.has(r.key));
    const detail = sel.length > 1 ? this.detailMany(sel, files)
      : sel.length ? this.detail(sel[0], files)
      : h("p.muted", {}, "Select a file to change its path, open, export or remove it. Ctrl and Shift select several.");

    this.el.replaceChildren(h("div.imp-main", {}, toolbar,
      listed.length ? table : h("p.muted", {}, q ? "No imported file matches." : "No imported files yet."),
      ...(unlisted.length ? [h("h3", {}, `Files in the map that aren't listed (${unlisted.length})`),
        h("p.muted", {}, "They are packed into the map, but the World Editor's Import Manager doesn't show them."),
        h("div.imp-unlisted", {}, ...unlisted.map((p) => h("div.imp-unlisted-row", {}, h("span.imp-path", {}, p),
          ...(this.editable ? [h("button", { onclick: () => this.register(p) }, "Add to list")] : []))))] : [])),
    h("div.imp-detail", {}, detail));
  }

  private detail(row: ImportRow, files: Map<string, FileInfo>): HTMLElement {
    const several = rowEntries(row).length > 1;
    // The version the graphics mode set reads (opened, previewed); a row of one version has just that.
    const e = shownEntry(row, this.mode());
    const file = this.fileOf(e, files);
    const exists = !!file;
    const versions = rowEntries(row).map((x) => ({ e: x, f: this.fileOf(x, files), mode: SIDE_NAME[SIDES.find((s) => row[s] === x)!] }));
    const path = h("input.imp-path-edit", { type: "text", value: row.classic ? this.shownPath(row.classic, versions[0].f) : row.path, readOnly: !this.editable });
    const adds = this.editable ? versionsToAdd(row) : [];
    const modes = several ? versions.map((v) => `${v.mode}: ${v.e.path}`).join(" · ")
      : row.reforged ? `Reforged only (${row.reforged.path}): Classic reads nothing at this path from the map.`
      : row.de ? `3.0 only (${row.de.path}): Classic and Reforged read nothing at this path from the map.`
      : "All graphics modes (one file at the plain path).";
    return h("div", {},
      h("h3", {}, row.path.split(/[\\/]/).pop() ?? row.path, ...this.badges(row)),
      h("div.imp-field", {}, h("label", {}, "Path in the map"), path,
        ...(this.editable ? [h("button", { title: row.reforged || row.de ? "The other versions move along, below _HD.w3mod\\ and _DE.w3mod\\" : "", onclick: () => this.changePath(row, path.value) }, "Change path")] : [])),
      h("p.muted", {}, "Models, textures and sounds are referred to by this path (object data, triggers, other models)."),
      h("div.imp-field", {}, h("label", {}, "Graphics modes"), h("span.imp-modes", {}, modes)),
      h("div.imp-field", {}, h("label", {}, "Type"), h("span", {}, `${kindOf(row.path)} · flags ${versions.map((v) => v.e.flags).join(" / ")}`)),
      versions.every((v) => v.f) ? null : h("p.imp-warn", {}, `${versions.length > 1 ? `The ${versions.filter((v) => !v.f).map((v) => v.mode).join(" and ")} version isn't` : "This file isn't"} in the project's map folder, so it isn't packed. (Blizzard's own maps list files the game provides itself.)`),
      h("div.imp-actions", {},
        // Viewers load the whole file: very large ones (maps, campaigns, movies) can only be exported.
        h("button", { disabled: !exists || (file?.size ?? 0) > MAX_OPEN, title: (file?.size ?? 0) > MAX_OPEN ? "Too large to open here" : several ? `The ${SIDE_NAME[SIDES.find((s) => row[s] === e)!]} version (the graphics mode set)` : "",
          onclick: () => file && this.openFile(e.path, file.path) }, kindOf(e.path) === "Sound" ? "▶ Play" : "Open"),
        // A row's versions are exported together, each at its place in the map.
        h("button", { disabled: !versions.some((v) => v.f), title: several ? "Every version, each at its place in the map below the chosen folder" : "",
          onclick: () => (several ? this.exportMany(versions.flatMap((v) => v.f?.path ?? [])) : file && this.exportFile(e.path, file.path)) }, "Export…"),
        ...(this.editable ? [
          ...versions.map((v) => h("button.imp-replace", { disabled: !v.f, title: "Another file's content under this path (Ctrl+Z takes it back)",
            onclick: () => v.f && this.replace(v.e, v.f.path) }, several ? `Replace ${v.mode}…` : "Replace…")),
          ...(several ? [h("button.imp-remove", { onclick: () => this.remove([row]) }, "Remove…"),
            ...versions.map((v) => h(`button.imp-remove-${SIDES.find((s) => row[s] === v.e)}`, { title: "Leaves the other versions as they are", onclick: () => this.remove([row], [SIDES.find((s) => row[s] === v.e)!]) }, `Remove ${v.mode}`))]
            : [h("button.imp-remove", { onclick: () => this.remove([row]) }, "Remove")])] : [])),
      adds.length ? h("div.imp-actions", {}, ...adds.map((add) => h("button.imp-add-version", {
        title: add.side === "reforged" ? `A file for Reforged, stored as ${add.path}: Reforged reads it instead of the plain one`
          : add.side === "de" ? `A file for 3.0, stored as ${add.path}: 3.0 reads it before the Reforged and the plain one`
          : `A file for Classic, stored as ${add.path}: Classic reads it, the other graphics modes keep their own version`,
        onclick: () => void this.addVersion(row, add.side) }, `Add ${SIDE_NAME[add.side]} Version…`))) : null,
      file ? this.preview(e.path, file, SIDES.find((s) => row[s] === e)!) : null);
  }

  /** The graphics modes of a row with a Reforged or 3.0 version ("Classic", "Reforged", "3.0"); none for a plain file
   *  alone (every mode reads it). */
  private badges(row: ImportRow): HTMLElement[] {
    if (!row.reforged && !row.de) return [];
    return [...(row.classic ? [h("span.imp-badge", { title: "Classic reads this version" }, "Classic")] : []),
      ...(row.reforged ? [h("span.imp-badge.reforged", { title: `Reforged reads ${row.reforged.path}` }, "Reforged")] : []),
      ...(row.de ? [h("span.imp-badge.de", { title: `3.0 reads ${row.de.path}` }, "3.0")] : [])];
  }

  private detailMany(rows: ImportRow[], files: Map<string, FileInfo>): HTMLElement {
    const entries = rows.flatMap(rowEntries);
    const found = entries.flatMap((e) => this.fileOf(e, files) ?? []);
    const size = found.reduce((n, f) => n + f.size, 0);
    const paths = [...new Set(found.map((f) => f.path))];
    const missing = entries.length - found.length;
    return h("div", {},
      h("h3", {}, plural(entries.length, "file") + (entries.length !== rows.length ? ` in ${rows.length.toLocaleString()} rows (Classic, Reforged and 3.0 versions)` : "")),
      h("p.muted", {}, `${formatBytes(size)}${missing ? ` · ${missing} not in the project's map folder` : ""}`),
      h("div.imp-actions", {},
        h("button", { disabled: !paths.length, title: "Keeps each file's path in the map below the chosen folder", onclick: () => this.exportMany(paths) }, "Export…"),
        ...(this.editable ? [h("button", { onclick: () => this.remove(rows) }, "Remove")] : [])));
  }

  /** The image itself, for files that are images and can be decoded here. */
  dropModelPreview() {
    this.modelPreview?.view.dispose();
    this.modelPreview = null;
  }
  /** `side`: the version the file is, whose model reads the map's and the game's files of that graphics mode first
   *  whatever the graphics mode set (Classic: the one set). */
  private preview(path: string, file: FileInfo, side: Side = "classic"): HTMLElement | null {
    const modelKey = kindOf(path) === "Model" ? previewKey(path, file, "model") : null;
    if (modelKey === null) this.dropModelPreview();
    if (modelKey !== null) {
      if (this.modelPreview?.key !== modelKey) {
        this.dropModelPreview();
        try {
          const entry = { key: modelKey, view: null as unknown as ModelPreview, failed: false };
          // A model that can't be shown says so like an image does (the preview's own message names the file).
          entry.view = new ModelPreview(this.w3, { prefer: SIDE_PREFER[side], exact: true,
            onFail: () => { entry.failed = true; entry.view.el.replaceChildren(h("small.muted", {}, "No preview for this file.")); } });
          this.modelPreview = entry;
          entry.view.show(path);
        } catch {
          this.dropModelPreview();
          return h("div.imp-preview", {}, h("small.muted", {}, "No preview for this file."));
        }
      }
      return h("div.imp-preview", {}, this.modelPreview!.view.el);
    }
    if (kindOf(path) !== "Image" || previewKey(path, file, "image") === null) return null;
    const box = h("div.imp-preview");
    const key = `${file.path}|${file.modified}`;
    if (this.preview_?.key === key) { box.append(this.preview_.canvas); return box; }
    void this.w3.workspace.readBytes(file.path).then((bytes) => {
      const image = decodeImage(bytes, file.path);
      // Each level halves the sides (and levels are decoded on demand, so only this one is).
      let level = 0;
      while (level + 1 < image.mipCount && Math.max(image.width, image.height) >> (level + 1) >= PREVIEW_SIDE) level++;
      const mip = image.mip(level);
      const canvas = h("canvas", { width: mip.width, height: mip.height, title: `${image.format}, ${image.width} × ${image.height}` }) as HTMLCanvasElement;
      canvas.getContext("2d")!.putImageData(new ImageData(mip.rgba as Uint8ClampedArray<ArrayBuffer>, mip.width, mip.height), 0, 0);
      this.preview_ = { key, canvas };
      box.replaceChildren(canvas);
    }).catch(() => box.replaceChildren(h("small.muted", {}, "No preview for this file.")));
    return box;
  }
}
