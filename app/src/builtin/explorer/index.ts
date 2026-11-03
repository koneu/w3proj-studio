import type { ExtensionContext, FileInfo, W3Api } from "../../extensions/api";
import { formatBytes, h } from "../../workbench/dom";

interface Node {
  name: string;
  path: string;
  children?: Map<string, Node>;
  file?: FileInfo;
}

function buildTree(files: FileInfo[]): Node {
  const root: Node = { name: "", path: "", children: new Map() };
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
  let selected: string | null = null;
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

  const newFile = async (folder: string) => {
    const input = await w3.window.inputBox({ prompt: `New file in ${folder || "the project"} (a/b.txt makes folders)`, placeholder: "name.txt" });
    if (!input) return;
    const name = cleanPath(input);
    if (!name) throw new Error(`"${input}" isn't a valid file name.`);
    const path = folder ? `${folder}/${name}` : name;
    if (w3.workspace.files().some((f) => f.path.toLowerCase() === path.toLowerCase())) throw new Error(`${path} already exists.`);
    await w3.workspace.writeText(path, "");
    await w3.workspace.refresh();
    for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) expanded.add(path.slice(0, i));
    selected = path;
    w3.views.refresh("w3.explorer.files");
    await w3.editors.open(path);
  };
  const rename = async (path: string, isDir: boolean) => {
    const files = filesUnder(path);
    const busy = unsaved(files);
    if (busy.length) throw new Error(`Save or close ${busy.join(", ")} first.`);
    const input = await w3.window.inputBox({ prompt: `Rename ${isDir ? "folder" : "file"} (a new path moves it)`, value: path });
    if (!input) return;
    const to = cleanPath(input);
    if (!to) throw new Error(`"${input}" isn't a valid path.`);
    if (to === path) return;
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
    selected = to;
    w3.views.refresh("w3.explorer.files");
    for (const f of reopen) await w3.editors.open(target(f));
  };
  const remove = async (path: string, isDir: boolean) => {
    const files = filesUnder(path);
    const busy = unsaved(files);
    const what = isDir ? `the folder ${path} (${files.length} file${files.length === 1 ? "" : "s"})` : path;
    const c = await w3.window.showWarning(`Delete ${what}?${busy.length ? ` Unsaved changes in ${busy.join(", ")} are lost.` : ""} Use git to get deleted files back.`, "Delete", "Cancel");
    if (c !== "Delete") return;
    for (const f of files) {
      await w3.editors.close(f);
      await w3.workspace.delete(f);
    }
  };
  const menu = (e: MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    selected = path;
    w3.views.refresh("w3.explorer.files");
    const folder = isDir ? path : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const act = (f: () => Promise<unknown>) => () => { f().catch(fail); };
    w3.window.showContextMenu({ x: e.clientX, y: e.clientY }, [
      ...(isDir ? [] : [
        { label: "Open", run: act(() => w3.editors.open(path)) },
        { label: "Open With…", run: act(async () => { await w3.editors.open(path); await w3.commands.execute("workbench.reopenWith"); }) },
        "-" as const,
      ]),
      { label: "New File…", run: act(() => newFile(folder)) },
      "-",
      { label: "Rename…", run: act(() => rename(path, isDir)), hint: "F2" },
      { label: "Delete", run: act(() => remove(path, isDir)), hint: "Del" },
      "-",
      { label: "Copy Path", run: act(() => navigator.clipboard.writeText(w3.workspace.resolve(path))) },
      { label: "Copy Relative Path", run: act(() => navigator.clipboard.writeText(path)) },
      { label: "Reveal in File Explorer", run: act(() => w3.backend.invoke("reveal_in_explorer", { path: w3.workspace.resolve(path) })) },
    ]);
  };
  /** Keys on the selected row: F2 renames, Del deletes. */
  const keyDown = (e: KeyboardEvent) => {
    if (!selected || !w3.workspace.project()) return;
    const isDir = !w3.workspace.files().some((f) => f.path === selected);
    if (e.key === "F2") { e.preventDefault(); rename(selected, isDir).catch(fail); }
    else if (e.key === "Delete") { e.preventDefault(); remove(selected, isDir).catch(fail); }
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
      await w3.commands.execute("w3.project.open", `${w3.workspace.project()!.root}\\${dir.replace(/\//g, "\\")}`);
      await w3.editors.open(parts.slice(inner).join("/"));
    };
    const tree = buildTree(w3.workspace.files());
    const list = h("div.tree", { tabindex: 0, onkeydown: keyDown });
    const walk = (node: Node, depth: number) => {
      for (const child of sorted(node)) {
        const isDir = !!child.children;
        const open = expanded.has(child.path);
        const icon = isDir ? (open ? "▾" : "▸") : (ICONS.find(([re]) => re.test(child.name))?.[1] ?? "·");
        const row = h(
          `div.tree-row${child.path === selected ? ".selected" : ""}`,
          {
            style: { paddingLeft: `${8 + depth * 12}px` },
            title: child.file ? `${child.path} — ${formatBytes(child.file.size)}` : child.path,
            onclick: () => {
              selected = child.path;
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
        { icon: "⊟", title: "Collapse All", command: "w3.explorer.collapseAll" },
      ],
    }),
    w3.workspace.onDidChange(() => w3.views.refresh("w3.explorer.files")),
    w3.commands.register("w3.explorer.refresh", () => w3.workspace.refresh()),
    // In the selected folder (or the selected file's), else the project's top level.
    w3.commands.register("w3.explorer.newFile", () => {
      if (!w3.workspace.project()) throw new Error("Open a project first.");
      const sel = selected ?? "";
      const isFile = w3.workspace.files().some((f) => f.path === sel);
      return newFile(isFile ? (sel.includes("/") ? sel.slice(0, sel.lastIndexOf("/")) : "") : sel);
    }),
    w3.commands.register("w3.explorer.collapseAll", () => {
      expanded.clear();
      w3.views.refresh("w3.explorer.files");
    }),
    w3.commands.register("w3.explorer.focus", () => w3.commands.execute("workbench.toggleSidebar")),
  );
}
