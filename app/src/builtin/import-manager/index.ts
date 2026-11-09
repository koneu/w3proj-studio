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
import { archivePath, CAMPAIGN_IMPORT_FOLDER, CUSTOM_PATH_FLAGS, entryCandidates, IMPORT_FOLDER, importPath, importTreePath, isJunkFile, isMapFile, kindOf, NEW_IMPORT_FLAGS, projectPath, samePath, type ImportEntry } from "./imports";
import type { FileInfo } from "../../extensions/api";
import { decodeImage } from "../../lib/image/index.ts";
import { replaceFile, stepReplace, UNDO_LIMIT, type ReplaceFs, type ReplaceStep } from "./replace";

/** The import list: the map's, or in a campaign project the campaign's. */
const lists = (campaign: boolean) => {
  const raw = campaign ? "map/war3campaign.imp" : "map/war3map.imp";
  return { RAW: raw, FILE: `${raw}.json` };
};
/** Files above this size aren't opened in a viewer (they're read whole into the window). */
const MAX_OPEN = 256 * 1024 * 1024;
/** Images above this size aren't previewed (they'd be read and decoded on every selection). */
const MAX_PREVIEW = 32 * 1024 * 1024;
/** Longest side the preview needs: the first mip level at least this large is drawn. */
const PREVIEW_SIDE = 320;
/** A folder with more files than this is confirmed first (it's easily the wrong folder). */
const CONFIRM_FOLDER = 100;

interface ImportsDoc { format?: string; version: number; files: ImportEntry[] }
/** A file to import: absolute source, and for folder imports its path inside the folder. */
interface ImportSource { src: string; relative?: string }
const entryKey = (e: ImportEntry) => e.path.toLowerCase();
const plural = (n: number, what: string) => `${n.toLocaleString()} ${what}${n === 1 ? "" : "s"}`;
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
    w3.commands.register("w3.imports.replace", async () => {
      if (!openView) throw new Error("Open the Import Manager and select a file first.");
      openView.replaceSelected();
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
        if (!doc.readOnly) openView = view;
        // Replace File is the one change here with a way back (the others act on the files at once, as there).
        return { undo: () => view.step(-1), redo: () => view.step(1), dispose: () => { view.disposed = true; stop.dispose(); if (openView === view) openView = null; } };
      },
    }),
  );
}

class ImportView {
  /** Selected entries (entryKey); render() drops what the filter hides, so that actions only
   *  ever touch rows that can be seen. */
  private selected = new Set<string>();
  private anchor: string | null = null;
  /** The rows as shown (selection ranges, Ctrl+A). */
  private shown: ImportEntry[] = [];
  private query = "";
  /** The image last previewed (the list redraws often; decoding it each time would be slow). */
  private preview_: { key: string; canvas: HTMLCanvasElement } | null = null;
  /** Replace File steps, for undo and redo; `at` of them are done. */
  private history: ReplaceStep[] = [];
  private at = 0;
  /** A replace, undo or redo is writing: another waits for it to finish (refused). */
  private busy = false;
  /** The editor closed: a replace that was waiting for a file choice stops. */
  disposed = false;

  constructor(private w3: W3Api, private el: HTMLElement, private list: ImportsDoc, private write: () => Promise<void>, private editable: boolean,
    private folder: string) {
    el.classList.add("imp-editor");
    el.tabIndex = -1;
    el.addEventListener("keydown", (e) => {
      // The filter field keeps its own keys (Ctrl+Z there takes back what was typed).
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      const key = keyOf(e).toLowerCase(), ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
      // Replace File's undo and redo, as the title bar's buttons.
      if (ctrl && (key === "z" || key === "y")) {
        e.preventDefault();
        this.step(key === "z" && !e.shiftKey ? -1 : 1);
      } else if (key === "a" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.selected = new Set(this.shown.map(entryKey));
        this.render();
      } else if (key === "delete" && this.editable && this.selected.size) {
        this.remove(this.shown.filter((s) => this.selected.has(entryKey(s))));
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
  private async run(label: string, f: () => Promise<void>) {
    try { await f(); } catch (e) { void this.w3.window.showError(`${label}: ${(e as Error).message ?? e}`); }
    this.render();
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
    // Also against the batch itself, which isn't on disk or in the list yet.
    const taken = (p: string) => used.has(p.toLowerCase()) || existing.has(projectPath(p).toLowerCase());
    const paths = sources.map((s) => {
      const path = s.relative ? importTreePath(s.relative, taken, this.folder) : importPath(s.src, taken, this.folder);
      used.add(path.toLowerCase());
      return path;
    });
    // Copied in the backend: imports can be far larger than the webview can hold.
    const title = paths.length === 1 ? `Importing ${paths[0]}` : `Importing ${plural(paths.length, "file")}`;
    const { copied, error } = await this.w3.window.withProgress(title, () =>
      this.w3.workspace.copyMany(sources.map((s, i) => [s.src, projectPath(paths[i])])));
    const done = paths.slice(0, copied);
    // What was copied is listed even if a later file failed: the list and the disk agree.
    this.list.files.push(...done.map((path) => ({ flags: NEW_IMPORT_FLAGS, path })));
    if (done.length) await this.write();
    this.select(done);
    if (error) throw new Error(`${done.length} of ${paths.length} imported, then: ${error}`);
    if (done.length > 1) void this.w3.window.showInfo(`Imported ${plural(done.length, "file")}.`);
  }
  private select(paths: string[]) {
    this.selected = new Set(paths.map((p) => p.toLowerCase()));
    this.anchor = paths.length ? paths[paths.length - 1].toLowerCase() : null;
  }
  private register(path: string) {
    void this.run("Add", async () => {
      this.list.files.push({ flags: NEW_IMPORT_FLAGS, path });
      await this.write();
      this.select([path]);
    });
  }
  private changePath(entry: ImportEntry, to: string) {
    void this.run("Change path", async () => {
      to = to.trim().replace(/^\\+/, "");
      const f = this.fileOf(entry);
      if (!to || samePath(to, this.shownPath(entry, f))) return;
      if (to.split("\\").some((part) => part === ".." || part === "")) throw new Error("Not a valid path.");
      if (this.taken(to)) throw new Error(`${to} is already in the map.`);
      const from = this.shownPath(entry, f);
      if (f) await this.w3.workspace.rename(f.path, projectPath(to));
      // A standard-path entry (name inside the import folder) now has a path of its own.
      if (entry.path !== from) entry.flags = CUSTOM_PATH_FLAGS;
      entry.path = to;
      await this.write();
      this.select([to]);
      // What used the old path (object data, triggers, scripts, models) can follow.
      const refs = await findPathRefs(this.w3, from, projectPath(to));
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
  private remove(entries: ImportEntry[]) {
    void this.run("Remove", async () => {
      const ask = entries.length === 1 ? `Remove ${entries[0].path} from the map? The file is deleted from the project.`
        : `Remove ${plural(entries.length, "file")} from the map? They are deleted from the project.`;
      if (!(await this.w3.window.askDelete(ask, "Remove"))) return;
      const files = this.files();
      const fileOf = new Map(entries.map((e) => [e, this.fileOf(e, files)?.path]));
      // Sound entries of different extensions can stand for the same file.
      const paths = [...new Set([...fileOf.values()].filter((p): p is string => !!p))];
      const { deleted, error } = await this.w3.window.withProgress(`Removing ${plural(entries.length, "file")}`, () => this.w3.workspace.deleteMany(paths));
      const kept = new Set(paths.slice(deleted));
      const gone = new Set(entries.filter((e) => !kept.has(fileOf.get(e) ?? "")));
      this.list.files = this.list.files.filter((f) => !gone.has(f));
      await this.write();
      this.select([]);
      if (error) throw new Error(`${gone.size} of ${entries.length} removed, then: ${error}`);
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
      this.busy = true;
      try {
        const step = await this.w3.window.withProgress(`Replacing ${e.path}`, () => replaceFile(this.replaceFs(), file, src));
        this.history.splice(this.at, this.history.length, step);
        this.at = this.history.length;
      } finally { this.busy = false; }
      this.preview_ = null;
      void this.w3.window.showInfo(`Replaced ${e.path}.`);
    });
  }
  /** Replace File on the one selected entry (the command). */
  replaceSelected() {
    const sel = this.shown.filter((s) => this.selected.has(entryKey(s)));
    if (sel.length !== 1) throw new Error("Select one imported file to replace.");
    const f = this.fileOf(sel[0]);
    if (!f) throw new Error(`${sel[0].path} isn't in the project's map folder.`);
    this.replace(sel[0], f.path);
  }
  /** Undo (-1) or redo (1) of Replace File. */
  step(dir: -1 | 1) {
    const step = dir < 0 ? this.history[this.at - 1] : this.history[this.at];
    if (!step) return;
    void this.run(dir < 0 ? "Undo Replace File" : "Redo Replace File", async () => {
      if (this.busy) throw new Error("A replace is still being written.");
      this.busy = true;
      try {
        await stepReplace(this.replaceFs(), step, dir);
        this.at += dir;
      } finally { this.busy = false; }
      this.preview_ = null;
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
    const listed = this.list.files.filter((f) => !q || f.path.toLowerCase().includes(q));
    // Files the list stands for (with their other sound extensions), then the rest of the map folder.
    const claimed = new Set(this.list.files.map((e) => this.fileOf(e, files)?.path.replace(/\\/g, "/").toLowerCase()).filter((x): x is string => !!x));
    // Files in the map folder that the list doesn't register (and that aren't the map's own).
    const unlisted = [...files.values()].map((f) => f.path.replace(/\\/g, "/")).filter((p) => p.startsWith("map/"))
      .map(archivePath)
      .filter((p) => !isMapFile(p) && !claimed.has(projectPath(p).toLowerCase()) && (!q || p.toLowerCase().includes(q)));
    this.shown = listed;
    const shownKeys = new Set(listed.map(entryKey));
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
    const toolbar = h("div.imp-toolbar", {},
      ...(this.editable ? [h("button.primary", { onclick: () => this.importFiles() }, "Import files…"), h("button", { onclick: () => this.importFolder() }, "Import folder…")] : []),
      search, h("span.muted", {}, `${this.list.files.length} imported · ${formatBytes(total)}`));

    const rows = listed.map((e) => {
      const f = this.fileOf(e, files);
      const active = this.selected.has(entryKey(e));
      return h(`tr.imp-row${active ? ".active" : ""}${f ? "" : ".missing"}`, {
        onclick: (ev: MouseEvent) => {
          const next = clickSelection(listed.map(entryKey), this.selected, this.anchor, entryKey(e), { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey });
          this.selected = next.selected;
          this.anchor = next.anchor;
          this.render();
        },
        ondblclick: () => { if (f && f.size <= MAX_OPEN) this.openFile(e.path, f.path); },
        title: f ? "" : "Not in the project's map folder",
      }, h("td.imp-path", {}, this.shownPath(e, f)), h("td", {}, kindOf(e.path)), h("td.imp-size", {}, f ? formatBytes(f.size) : "missing"), h("td.muted", {}, String(e.flags)));
    });
    const table = h("table.imp-table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Path in the map"), h("th", {}, "Type"), h("th", {}, "Size"), h("th", { title: "Import flags (war3map.imp)" }, "Flags"))),
      h("tbody", {}, ...rows));

    const sel = listed.filter((e) => this.selected.has(entryKey(e)));
    const detail = sel.length > 1 ? this.detailMany(sel, files)
      : sel.length ? this.detail(sel[0], this.fileOf(sel[0], files))
      : h("p.muted", {}, "Select a file to change its path, open, export or remove it. Ctrl and Shift select several.");

    this.el.replaceChildren(h("div.imp-main", {}, toolbar,
      listed.length ? table : h("p.muted", {}, q ? "No imported file matches." : "No imported files yet."),
      ...(unlisted.length ? [h("h3", {}, `Files in the map that aren't listed (${unlisted.length})`),
        h("p.muted", {}, "They are packed into the map, but the World Editor's Import Manager doesn't show them."),
        h("div.imp-unlisted", {}, ...unlisted.map((p) => h("div.imp-unlisted-row", {}, h("span.imp-path", {}, p),
          ...(this.editable ? [h("button", { onclick: () => this.register(p) }, "Add to list")] : []))))] : [])),
    h("div.imp-detail", {}, detail));
  }

  private detail(e: ImportEntry, file: FileInfo | undefined): HTMLElement {
    const exists = !!file;
    const path = h("input.imp-path-edit", { type: "text", value: this.shownPath(e, file), readOnly: !this.editable });
    return h("div", {},
      h("h3", {}, e.path.split(/[\\/]/).pop() ?? e.path),
      h("div.imp-field", {}, h("label", {}, "Path in the map"), path,
        ...(this.editable ? [h("button", { onclick: () => this.changePath(e, path.value) }, "Change path")] : [])),
      h("p.muted", {}, "Models, textures and sounds are referred to by this path (object data, triggers, other models)."),
      h("div.imp-field", {}, h("label", {}, "Type"), h("span", {}, `${kindOf(e.path)} · flags ${e.flags}`)),
      exists ? null : h("p.imp-warn", {}, "This file isn't in the project's map folder, so it isn't packed. (Blizzard's own maps list files the game provides itself.)"),
      h("div.imp-actions", {},
        // Viewers load the whole file: very large ones (maps, campaigns, movies) can only be exported.
        h("button", { disabled: !exists || (file?.size ?? 0) > MAX_OPEN, title: (file?.size ?? 0) > MAX_OPEN ? "Too large to open here" : "",
          onclick: () => file && this.openFile(e.path, file.path) }, kindOf(e.path) === "Sound" ? "▶ Play" : "Open"),
        h("button", { disabled: !exists, onclick: () => file && this.exportFile(e.path, file.path) }, "Export…"),
        ...(this.editable ? [
          h("button.imp-replace", { disabled: !exists, title: "Another file's content under this path (Ctrl+Z takes it back)", onclick: () => file && this.replace(e, file.path) }, "Replace…"),
          h("button", { onclick: () => this.remove([e]) }, "Remove")] : [])),
      file ? this.preview(e.path, file) : null);
  }

  private detailMany(entries: ImportEntry[], files: Map<string, FileInfo>): HTMLElement {
    const found = entries.flatMap((e) => this.fileOf(e, files) ?? []);
    const size = found.reduce((n, f) => n + f.size, 0);
    const paths = [...new Set(found.map((f) => f.path))];
    const missing = entries.length - found.length;
    return h("div", {},
      h("h3", {}, plural(entries.length, "file")),
      h("p.muted", {}, `${formatBytes(size)}${missing ? ` · ${missing} not in the project's map folder` : ""}`),
      h("div.imp-actions", {},
        h("button", { disabled: !paths.length, title: "Keeps each file's path in the map below the chosen folder", onclick: () => this.exportMany(paths) }, "Export…"),
        ...(this.editable ? [h("button", { onclick: () => this.remove(entries) }, "Remove")] : [])));
  }

  /** The image itself, for files that are images and can be decoded here. */
  private preview(path: string, file: FileInfo): HTMLElement | null {
    if (kindOf(path) !== "Image" || file.size > MAX_PREVIEW) return null;
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
