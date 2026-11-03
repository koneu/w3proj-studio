// Import Manager: the map's imported files (war3map.imp) like the World
// Editor's Import Manager. Imported files are ordinary files in the project's
// map folder; the list says which of them the map registers and under which
// archive path. Changes apply at once: the files on disk move, and the list is
// written right after (so the two never disagree).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { h } from "../../workbench/dom";
import { archivePath, candidates, importPath, isMapFile, kindOf, NEW_IMPORT_FLAGS, projectPath, samePath, type ImportEntry } from "./imports";
import type { FileInfo } from "../../extensions/api";

const RAW = "map/war3map.imp", FILE = `${RAW}.json`;

interface ImportsDoc { format?: string; version: number; files: ImportEntry[] }

export function activate(w3: W3Api, ctx: ExtensionContext) {
  ctx.subscriptions.push(
    w3.commands.register("w3.imports.open", async () => {
      const p = w3.workspace.project();
      if (!p) throw new Error("Open or import a project first.");
      const files = new Set(w3.workspace.files().map((f) => f.path.replace(/\\/g, "/").toLowerCase()));
      if (!files.has(FILE) && files.has(RAW)) { await w3.editors.open(RAW, "w3.importManager"); return; }
      // A map without imports gets an empty list.
      if (!files.has(FILE)) {
        const text = await w3.backend.invoke<string>("codec_canonicalize", { root: p.root, path: FILE, text: JSON.stringify({ format: "w3proj.imports/1", version: 1, files: [] }) });
        await w3.workspace.writeText(FILE, text);
        await w3.workspace.refresh();
      }
      await w3.editors.open(FILE, "w3.importManager");
    }),
    w3.editors.registerProvider("w3.importManager", {
      async resolve(el, doc) {
        const raw = !doc.path.toLowerCase().endsWith(".json");
        const root = w3.workspace.project()!.root;
        const list: ImportsDoc = JSON.parse(raw ? await w3.backend.invoke<string>("codec_decode", { root, path: doc.path }) : await doc.readText());
        list.files ??= [];
        // Written after every change (the files on disk have changed already).
        const write = async () => {
          if (raw) await w3.backend.invoke("codec_write", { root, path: doc.path, text: JSON.stringify({ format: "w3proj.imports/1", ...list }) });
          else await doc.writeText(await w3.backend.invoke<string>("codec_canonicalize", { root, path: doc.path, text: JSON.stringify(list) }));
          doc.setDirty(false);
        };
        const view = new ImportView(w3, el, list, write, !doc.readOnly);
        const stop = w3.workspace.onDidChange(() => view.render());
        return { dispose: () => stop.dispose() };
      },
    }),
  );
}

class ImportView {
  private selected: string | null = null;
  private query = "";

  constructor(private w3: W3Api, private el: HTMLElement, private list: ImportsDoc, private write: () => Promise<void>, private editable: boolean) {
    el.classList.add("imp-editor");
    this.render();
  }

  /** Project files by lower-case project path, with sizes. */
  private files() {
    return new Map(this.w3.workspace.files().map((f) => [f.path.replace(/\\/g, "/").toLowerCase(), f]));
  }
  /** The project file an entry stands for (sounds may be stored under another extension). */
  private fileOf(path: string, files = this.files()): FileInfo | undefined {
    for (const c of candidates(path)) { const f = files.get(c.toLowerCase()); if (f) return f; }
    return undefined;
  }
  private taken(path: string) {
    return this.list.files.some((f) => samePath(f.path, path)) || this.files().has(projectPath(path).toLowerCase());
  }
  private async run(label: string, f: () => Promise<void>) {
    try { await f(); } catch (e) { void this.w3.window.showError(`${label}: ${(e as Error).message ?? e}`); }
    this.render();
  }

  // ---- actions ----------------------------------------------------------------------
  private importFile() {
    void this.run("Import", async () => {
      const src = await this.w3.window.pickFile({ title: "Import a file into the map" });
      if (!src) return;
      const bytes = await this.w3.workspace.readBytes(src);
      const path = importPath(src, (p) => this.taken(p));
      await this.w3.workspace.writeBytes(projectPath(path), bytes);
      this.list.files.push({ flags: NEW_IMPORT_FLAGS, path });
      await this.write();
      await this.w3.workspace.refresh();
      this.selected = path;
    });
  }
  private register(path: string) {
    void this.run("Add", async () => {
      this.list.files.push({ flags: NEW_IMPORT_FLAGS, path });
      await this.write();
      this.selected = path;
    });
  }
  private changePath(entry: ImportEntry, to: string) {
    void this.run("Change path", async () => {
      to = to.trim().replace(/^\\+/, "");
      if (!to || samePath(to, entry.path)) return;
      if (to.split("\\").some((part) => part === ".." || part === "")) throw new Error("Not a valid path.");
      if (this.taken(to)) throw new Error(`${to} is already in the map.`);
      const f = this.fileOf(entry.path);
      if (f) await this.w3.workspace.rename(f.path, projectPath(to));
      entry.path = to;
      await this.write();
      this.selected = to;
      void this.w3.window.showInfo(`Moved. Object data, triggers or scripts that use the old path aren't changed.`);
    });
  }
  private remove(entry: ImportEntry) {
    void this.run("Remove", async () => {
      const c = await this.w3.window.showWarning(`Remove ${entry.path} from the map? The file is deleted from the project.`, "Remove", "Cancel");
      if (c !== "Remove") return;
      const f = this.fileOf(entry.path);
      if (f) await this.w3.workspace.delete(f.path);
      this.list.files = this.list.files.filter((f) => f !== entry);
      await this.write();
      this.selected = null;
    });
  }
  /** `file`: the project file (its name may differ from the listed path for sounds). */
  private exportFile(path: string, file: string) {
    void this.run("Export", async () => {
      const target = await this.w3.window.pickSaveFile({ title: "Export file", defaultPath: path.split("\\").pop() });
      if (!target) return;
      await this.w3.workspace.writeBytes(target, await this.w3.workspace.readBytes(file));
      void this.w3.window.showInfo(`Exported to ${target}`);
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
    const size = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
    const listed = this.list.files.filter((f) => !q || f.path.toLowerCase().includes(q));
    // Files the list stands for (with their other sound extensions), then the rest of the map folder.
    const claimed = new Set(this.list.files.map((e) => this.fileOf(e.path, files)?.path.replace(/\\/g, "/").toLowerCase()).filter((x): x is string => !!x));
    // Files in the map folder that the list doesn't register (and that aren't the map's own).
    const unlisted = [...files.values()].map((f) => f.path.replace(/\\/g, "/")).filter((p) => p.startsWith("map/"))
      .map(archivePath)
      .filter((p) => !isMapFile(p) && !claimed.has(projectPath(p).toLowerCase()) && (!q || p.toLowerCase().includes(q)));
    const total = this.list.files.reduce((n, e) => n + (this.fileOf(e.path, files)?.size ?? 0), 0);

    const search = h("input.imp-search", { type: "search", placeholder: "Filter by path", value: this.query,
      oninput: () => { this.query = search.value; this.render(); (this.el.querySelector(".imp-search") as HTMLInputElement | null)?.focus(); } });
    const toolbar = h("div.imp-toolbar", {},
      ...(this.editable ? [h("button.primary", { onclick: () => this.importFile() }, "Import file…")] : []),
      search, h("span.muted", {}, `${this.list.files.length} imported · ${size(total)}`));

    const rows = listed.map((e) => {
      const f = this.fileOf(e.path, files);
      const active = this.selected !== null && samePath(this.selected, e.path);
      return h(`tr.imp-row${active ? ".active" : ""}${f ? "" : ".missing"}`, {
        onclick: () => { this.selected = e.path; this.render(); },
        ondblclick: () => { if (f) this.openFile(e.path, f.path); },
        title: f ? "" : "Not in the project's map folder",
      }, h("td.imp-path", {}, e.path), h("td", {}, kindOf(e.path)), h("td.imp-size", {}, f ? size(f.size) : "missing"), h("td.muted", {}, String(e.flags)));
    });
    const table = h("table.imp-table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Path in the map"), h("th", {}, "Type"), h("th", {}, "Size"), h("th", { title: "Import flags (war3map.imp)" }, "Flags"))),
      h("tbody", {}, ...rows));

    const sel = this.selected ? this.list.files.find((e) => samePath(e.path, this.selected!)) : undefined;
    const detail = sel ? this.detail(sel, this.fileOf(sel.path, files)) : h("p.muted", {}, "Select a file to change its path, open, export or remove it.");

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
    const path = h("input.imp-path-edit", { type: "text", value: e.path, readOnly: !this.editable });
    return h("div", {},
      h("h3", {}, e.path.split(/[\\/]/).pop() ?? e.path),
      h("div.imp-field", {}, h("label", {}, "Path in the map"), path,
        ...(this.editable ? [h("button", { onclick: () => this.changePath(e, path.value) }, "Change path")] : [])),
      h("p.muted", {}, "Models, textures and sounds are referred to by this path (object data, triggers, other models)."),
      h("div.imp-field", {}, h("label", {}, "Type"), h("span", {}, `${kindOf(e.path)} · flags ${e.flags}`)),
      exists ? null : h("p.imp-warn", {}, "This file isn't in the project's map folder, so it isn't packed. (Blizzard's own maps list files the game provides itself.)"),
      h("div.imp-actions", {},
        h("button", { disabled: !exists, onclick: () => file && this.openFile(e.path, file.path) }, kindOf(e.path) === "Sound" ? "▶ Play" : "Open"),
        h("button", { disabled: !exists, onclick: () => file && this.exportFile(e.path, file.path) }, "Export…"),
        ...(this.editable ? [h("button", { onclick: () => this.remove(e) }, "Remove")] : [])));
  }
}
