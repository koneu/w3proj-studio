import type { ExtensionContext, FileInfo, W3Api } from "../../extensions/api";
import { keyOf } from "../../lib/keys";
import { joinPath } from "../../lib/paths";
import { clickSelection } from "../../lib/selection";
import { projectWithFiles } from "../../lib/formats/mapdoc";
import { formatBytes, h } from "../../workbench/dom";
import { planMoves } from "./moves";

interface Node {
  name: string;
  path: string;
  children?: Map<string, Node>;
  file?: FileInfo;
}

function buildTree(files: FileInfo[], folders: string[]): Node {
  const root: Node = { name: "", path: "", children: new Map() };
  for (const folder of folders) {
    let cur = root;
    folder.split("/").forEach((part, i, parts) => {
      const key = part.toLowerCase();
      if (!cur.children!.has(key)) cur.children!.set(key, { name: part, path: parts.slice(0, i + 1).join("/"), children: new Map() });
      cur = cur.children!.get(key)!;
    });
  }
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join("/");
      if (i === parts.length - 1) cur.children!.set(part.toLowerCase(), { name: part, path, file: f });
      else {
        const key = part.toLowerCase();
        if (!cur.children!.has(key)) cur.children!.set(key, { name: part, path, children: new Map() });
        cur = cur.children!.get(key)!;
      }
    });
  }
  return root;
}

function sorted(n: Node): Node[] {
  return [...n.children!.values()].sort((a, b) => {
    if (!!a.children !== !!b.children) return a.children ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

const ICONS: [RegExp, string][] = [
  [/\.(j|lua|ai)$/i, "ƒ"],
  [/\.json$/i, "{}"],
  [/\.(txt|wts|toml|md|fdf|toc|slk)$/i, "≡"],
  [/\.(blp|tga|dds|png)$/i, "▣"],
  [/\.(mdx|mdl)$/i, "◆"],
  [/\.(wav|mp3|flac|ogg)$/i, "♪"],
];

/** A file name typed by the user: no drive, no "..", forward slashes, nothing empty. */
function cleanPath(input: string): string | null {
  const parts = input.trim().replace(/\\/g, "/").split("/").map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts.some((p) => p === "." || p === ".." || /[<>:"|?*\x00-\x1f]/.test(p))) return null;
  return parts.join("/");
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const expanded = new Set<string>(["map"]);
  /** The selected rows; the anchor is where Shift ranges start. */
  let selected = new Set<string>();
  let anchor: string | null = null;
  /** The rows as shown, top to bottom (for Shift ranges). */
  let shown: string[] = [];
  /** What's being dragged. */
  let dragging: string[] = [];
  const selectOnly = (path: string) => { selected = new Set([path]); anchor = path; };
  const single = () => (selected.size === 1 ? [...selected][0] : null);
  /** Clicking a folder redraws the tree: the new one gets the keyboard focus back (F2, Del).
   *  A clicked file opens, and its editor takes the focus. */
  let refocus = false;
  const fail = (e: unknown) => void w3.window.showError(String(e instanceof Error ? e.message : e));
  /** The files at or under `path` (a file, or a folder of the tree). */
  const filesUnder = (path: string) => {
    const p = path.toLowerCase();
    return w3.workspace.files().map((f) => f.path).filter((f) => f.toLowerCase() === p || f.toLowerCase().startsWith(p + "/"));
  };
  const unsaved = (files: string[]) => files.filter((f) => w3.editors.isDirty(f));

  /** The project asked about (`root`), once its whole file list is read: "already exists" is told from it, and a
   *  file not listed yet (right after an open) would be written over. */
  const listedProject = (root: string | undefined) => projectWithFiles(w3, root);
  const newFile = async (folder: string) => {
    const root = w3.workspace.project()?.root;
    const input = await w3.window.inputBox({ prompt: `New file in ${folder || "the project"} (a/b.txt makes folders)`, placeholder: "name.txt" });
    if (!input) return;
    const name = cleanPath(input);
    if (!name) throw new Error(`"${input}" isn't a valid file name.`);
    const path = folder ? `${folder}/${name}` : name;
    await listedProject(root);
    if (w3.workspace.files().some((f) => f.path.toLowerCase() === path.toLowerCase())) throw new Error(`${path} already exists.`);
    await w3.workspace.writeText(path, "");
    await w3.workspace.refresh();
    for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) expanded.add(path.slice(0, i));
    selectOnly(path);
    w3.views.refresh("w3.explorer.files");
    await w3.editors.open(path);
  };
  const newFolder = async (folder: string) => {
    const root = w3.workspace.project()?.root;
    const input = await w3.window.inputBox({ prompt: `New folder in ${folder || "the project"} (a/b makes both)`, placeholder: "name" });
    if (!input) return;
    const name = cleanPath(input);
    if (!name) throw new Error(`"${input}" isn't a valid folder name.`);
    const path = folder ? `${folder}/${name}` : name;
    await listedProject(root);
    if (isFolder(path) || w3.workspace.files().some((f) => f.path.toLowerCase() === path.toLowerCase())) throw new Error(`${path} already exists.`);
    await w3.workspace.createFolder(path);
    for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) expanded.add(path.slice(0, i));
    selectOnly(path);
    w3.views.refresh("w3.explorer.files");
  };
  const isFolder = (path: string) => w3.workspace.folders().some((f) => f.toLowerCase() === path.toLowerCase());
  /** Moves what's dragged into a folder. Folders move whole, empty ones too. */
  const moveInto = async (paths: string[], folder: string) => {
    const exists = (p: string) => isFolder(p) || w3.workspace.files().some((f) => f.path.toLowerCase() === p.toLowerCase());
    const { moves, problem } = planMoves(paths, folder, exists);
    if (problem) throw new Error(problem);
    if (!moves.length) return;
    const files = moves.flatMap(([from]) => filesUnder(from));
    const busy = unsaved(files);
    if (busy.length) throw new Error(`Save or close ${busy.join(", ")} first.`);
    // A file's place in map/ is its path inside the map: what refers to it doesn't follow.
    if (moves.some(([from, to]) => /^map\//i.test(from) || /^map\//i.test(to))) {
      const c = await w3.window.showWarning(`Move ${moves.length === 1 ? moves[0][0] : `${moves.length} items`} to ${folder || "the project's top"}? Inside map/ this changes the path in the map, and what refers to it doesn't follow (the Import Manager's Change path does).`, "Move", "Cancel");
      if (c !== "Move") return;
    }
    const reopen = files.filter((f) => w3.editors.activePath() === f);
    for (const f of files) await w3.editors.close(f);
    for (const [from, to] of moves) await w3.workspace.rename(from, to);
    if (folder) expanded.add(folder);
    selected = new Set(moves.map(([, to]) => to));
    anchor = null;
    w3.views.refresh("w3.explorer.files");
    for (const f of reopen) {
      const m = moves.find(([from]) => f === from || f.toLowerCase().startsWith(`${from.toLowerCase()}/`));
      if (m) await w3.editors.open(m[1] + f.slice(m[0].length));
    }
  };
  const rename = async (path: string, isDir: boolean) => {
    const files = filesUnder(path);
    const busy = unsaved(files);
    if (busy.length) throw new Error(`Save or close ${busy.join(", ")} first.`);
    // An empty folder has no files to carry it along.
    const empty = isDir && !files.length;
    const input = await w3.window.inputBox({ prompt: `Rename ${isDir ? "folder" : "file"} (a new path moves it)`, value: path });
    if (!input) return;
    const to = cleanPath(input);
    if (!to) throw new Error(`"${input}" isn't a valid path.`);
    if (to === path) return;
    if (empty) { await w3.workspace.rename(path, to); selectOnly(to); w3.views.refresh("w3.explorer.files"); return; }
    const target = (f: string) => to + f.slice(path.length);
    // Only the case changes: through a temporary name (the file system sees the same file).
    const caseOnly = to.toLowerCase() === path.toLowerCase();
    const reopen = files.filter((f) => w3.editors.activePath() === f);
    for (const f of files) {
      await w3.editors.close(f);
      if (caseOnly) await w3.workspace.rename(f, `${f}.renaming`);
      await w3.workspace.rename(caseOnly ? `${f}.renaming` : f, target(f));
    }
    if (isDir && expanded.has(path)) expanded.add(to);
    selectOnly(to);
    w3.views.refresh("w3.explorer.files");
    for (const f of reopen) await w3.editors.open(target(f));
  };
  /** Deletes files and folders (with what's inside). */
  const remove = async (paths: string[]) => {
    const roots = paths.filter((p) => !paths.some((q) => q !== p && p.toLowerCase().startsWith(`${q.toLowerCase()}/`)));
    const files = roots.flatMap(filesUnder);
    const busy = unsaved(files);
    const only = roots.length === 1 ? roots[0] : null;
    const what = only ? (isFolder(only) ? `the folder ${only} (${files.length} file${files.length === 1 ? "" : "s"})` : only) : `${roots.length} items (${files.length} file${files.length === 1 ? "" : "s"})`;
    if (!(await w3.window.askDelete(`Delete ${what}?${busy.length ? ` Unsaved changes in ${busy.join(", ")} are lost.` : ""} Use git to get deleted files back.`, "Delete"))) return;
    for (const f of files) await w3.editors.close(f);
    const { error } = await w3.workspace.deleteMany(files);
    if (error) throw new Error(error);
    // Folders that are left: empty ones, deepest first.
    const left = roots.flatMap((r) => w3.workspace.folders().filter((f) => f.toLowerCase() === r.toLowerCase() || f.toLowerCase().startsWith(`${r.toLowerCase()}/`)));
    for (const f of left.sort((a, b) => b.length - a.length)) await w3.workspace.removeFolder(f);
    selected = new Set();
    anchor = null;
    w3.views.refresh("w3.explorer.files");
  };
  const menu = (e: MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    if (!selected.has(path)) selectOnly(path);
    w3.views.refresh("w3.explorer.files");
    if (selected.size > 1) {
      const paths = [...selected];
      w3.window.showContextMenu({ x: e.clientX, y: e.clientY }, [{ label: `Delete ${paths.length} items`, run: () => { remove(paths).catch(fail); }, hint: "Del" }]);
      return;
    }
    const folder = isDir ? path : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const act = (f: () => Promise<unknown>) => () => { f().catch(fail); };
    w3.window.showContextMenu({ x: e.clientX, y: e.clientY }, [
      ...(isDir ? [] : [
        { label: "Open", run: act(() => w3.editors.open(path)) },
        { label: "Open With…", run: act(async () => { await w3.editors.open(path); await w3.commands.execute("workbench.reopenWith"); }) },
        "-" as const,
      ]),
      { label: "New File…", run: act(() => newFile(folder)) },
      { label: "New Folder…", run: act(() => newFolder(folder)) },
      "-",
      { label: "Rename…", run: act(() => rename(path, isDir)), hint: "F2" },
      { label: "Delete", run: act(() => remove([path])), hint: "Del" },
      "-",
      { label: "Copy Path", run: act(() => navigator.clipboard.writeText(w3.workspace.resolve(path))) },
      { label: "Copy Relative Path", run: act(() => navigator.clipboard.writeText(path)) },
      { label: "Reveal in File Explorer", run: act(() => w3.backend.invoke("reveal_in_explorer", { path: w3.workspace.resolve(path) })) },
    ]);
  };
  /** Keys on the selected row: F2 renames, Del deletes. */
  const keyDown = (e: KeyboardEvent) => {
    if (!selected.size || !w3.workspace.project()) return;
    const one = single();
    const key = keyOf(e);
    if (key === "F2" && one) { e.preventDefault(); rename(one, !w3.workspace.files().some((f) => f.path === one)).catch(fail); }
    else if (key === "Delete") { e.preventDefault(); remove([...selected]).catch(fail); }
  };

  /** The selected folder, or the selected file's; the project's top without a selection. */
  const selectedFolder = () => {
    const sel = single() ?? "";
    const isFile = w3.workspace.files().some((f) => f.path === sel);
    return isFile ? (sel.includes("/") ? sel.slice(0, sel.lastIndexOf("/")) : "") : sel;
  };

  const render = (el: HTMLElement) => {
    const project = w3.workspace.project();
    if (!project) {
      el.append(
        h("div.view-empty", {},
          h("p", {}, "No project is open."),
          h("button.primary", { onclick: () => w3.commands.execute("w3.project.open") }, "Open Project Folder"),
          h("button.primary", { onclick: () => w3.commands.execute("w3.project.importMap") }, "Import Map or Campaign…"),
          h("button.primary", { onclick: () => w3.commands.execute("w3.map.new") }, "New Map…"),
        ),
      );
      return;
    }
    /** Files of a project inside this one (a campaign's chapter maps under maps/<file>/) need that
     *  project open: their editors find the map's other files relative to the project. */
    const openFile = async (path: string) => {
      const files = new Set(w3.workspace.files().map((f) => f.path.replace(/\\/g, "/").toLowerCase()));
      const parts = path.split("/");
      let inner = -1;
      for (let i = parts.length - 1; i > 0; i--) {
        if (files.has(`${parts.slice(0, i).join("/")}/w3proj.toml`.toLowerCase())) { inner = i; break; }
      }
      if (inner < 0) return w3.editors.open(path);
      const dir = parts.slice(0, inner).join("/");
      const c = await w3.window.showWarning(`${parts.slice(inner).join("/")} belongs to the map project ${dir}. Its editors (terrain objects, object data, triggers…) need that project open.`,
        "Open map project", "Open here anyway", "Cancel");
      if (c === "Open here anyway") return w3.editors.open(path);
      if (c !== "Open map project") return;
      await w3.commands.execute("w3.project.open", joinPath(w3.workspace.project()!.root, dir));
      await w3.editors.open(parts.slice(inner).join("/"));
    };
    const tree = buildTree(w3.workspace.files(), w3.workspace.folders());
    shown = [];
    const clearDrop = () => { for (const x of list.querySelectorAll(".drop-target")) x.classList.remove("drop-target"); list.classList.remove("drop-target"); };
    const drop = (e: DragEvent, folder: string) => {
      e.preventDefault();
      e.stopPropagation();
      clearDrop();
      const paths = dragging;
      dragging = [];
      if (paths.length) moveInto(paths, folder).catch(fail);
    };
    const list: HTMLElement = h("div.tree", { tabindex: 0, onkeydown: keyDown,
      // Between the rows: the project's top.
      ondragover: (e: DragEvent) => { if (!dragging.length) return; e.preventDefault(); clearDrop(); list.classList.add("drop-target"); },
      ondragleave: (e: DragEvent) => { if (e.target === list) list.classList.remove("drop-target"); },
      ondrop: (e: DragEvent) => drop(e, ""),
    });
    const walk = (node: Node, depth: number) => {
      for (const child of sorted(node)) {
        const isDir = !!child.children;
        const open = expanded.has(child.path);
        const icon = isDir ? (open ? "▾" : "▸") : (ICONS.find(([re]) => re.test(child.name))?.[1] ?? "·");
        shown.push(child.path);
        // Dropped on a file, things go where the file is.
        const dropFolder = isDir ? child.path : child.path.includes("/") ? child.path.slice(0, child.path.lastIndexOf("/")) : "";
        const row = h(
          `div.tree-row${selected.has(child.path) ? ".selected" : ""}`,
          {
            style: { paddingLeft: `${8 + depth * 12}px` },
            title: child.file ? `${child.path} — ${formatBytes(child.file.size)}` : child.path,
            draggable: true,
            ondragstart: (e: DragEvent) => {
              if (!selected.has(child.path)) selectOnly(child.path);
              dragging = [...selected];
              e.dataTransfer?.setData("text/plain", child.path);
            },
            ondragend: () => { dragging = []; clearDrop(); },
            ondragover: (e: DragEvent) => {
              if (!dragging.length) return;
              e.preventDefault();
              e.stopPropagation();
              clearDrop();
              row.classList.add("drop-target");
            },
            ondrop: (e: DragEvent) => drop(e, dropFolder),
            onclick: (e: MouseEvent) => {
              // With Ctrl or Shift a click only selects.
              if (e.ctrlKey || e.metaKey || e.shiftKey) {
                const next = clickSelection(shown, selected, anchor, child.path, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
                selected = next.selected;
                anchor = next.anchor;
                refocus = true;
                w3.views.refresh("w3.explorer.files");
                return;
              }
              selectOnly(child.path);
              refocus = isDir;
              if (isDir) {
                if (open) expanded.delete(child.path);
                else expanded.add(child.path);
              } else {
                openFile(child.path).catch((e) => w3.window.showError(String(e)));
              }
              w3.views.refresh("w3.explorer.files");
            },
            oncontextmenu: (e: MouseEvent) => menu(e, child.path, isDir),
          },
          h(`span.tree-icon${isDir ? ".dir" : ""}`, {}, icon),
          h("span.tree-label", {}, child.name),
        );
        list.append(row);
        if (isDir && open) walk(child, depth + 1);
      }
    };
    walk(tree, 0);
    el.append(list);
    if (refocus) { refocus = false; requestAnimationFrame(() => list.focus({ preventScroll: true })); }
  };

  ctx.subscriptions.push(
    w3.views.register("w3.explorer.files", {
      render,
      actions: [
        { icon: "⟳", title: "Refresh", command: "w3.explorer.refresh" },
        { icon: "+", title: "New File…", command: "w3.explorer.newFile" },
        { icon: "▣", title: "New Folder…", command: "w3.explorer.newFolder" },
        { icon: "⊟", title: "Collapse All", command: "w3.explorer.collapseAll" },
      ],
    }),
    w3.workspace.onDidChange(() => w3.views.refresh("w3.explorer.files")),
    w3.commands.register("w3.explorer.refresh", () => w3.workspace.refresh()),
    // In the selected folder (or the selected file's), else the project's top level.
    w3.commands.register("w3.explorer.newFile", () => {
      if (!w3.workspace.project()) throw new Error("Open a project first.");
      return newFile(selectedFolder());
    }),
    w3.commands.register("w3.explorer.newFolder", () => {
      if (!w3.workspace.project()) throw new Error("Open a project first.");
      return newFolder(selectedFolder());
    }),
    w3.commands.register("w3.explorer.collapseAll", () => {
      expanded.clear();
      w3.views.refresh("w3.explorer.files");
    }),
    w3.commands.register("w3.explorer.focus", () => w3.commands.execute("workbench.toggleSidebar")),
  );
}
