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

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const expanded = new Set<string>(["map"]);
  let selected: string | null = null;

  const render = (el: HTMLElement) => {
    const project = w3.workspace.project();
    if (!project) {
      el.append(
        h("div.view-empty", {},
          h("p", {}, "No project is open."),
          h("button.primary", { onclick: () => w3.commands.execute("w3.project.open") }, "Open Project Folder"),
          h("button.primary", { onclick: () => w3.commands.execute("w3.project.importMap") }, "Import .w3x Map…"),
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
    const list = h("div.tree", { tabindex: 0 });
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
              if (isDir) {
                if (open) expanded.delete(child.path);
                else expanded.add(child.path);
              } else {
                openFile(child.path).catch((e) => w3.window.showError(String(e)));
              }
              w3.views.refresh("w3.explorer.files");
            },
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
  };

  ctx.subscriptions.push(
    w3.views.register("w3.explorer.files", {
      render,
      actions: [
        { icon: "⟳", title: "Refresh", command: "w3.explorer.refresh" },
        { icon: "⊟", title: "Collapse All", command: "w3.explorer.collapseAll" },
      ],
    }),
    w3.workspace.onDidChange(() => w3.views.refresh("w3.explorer.files")),
    w3.commands.register("w3.explorer.refresh", () => w3.workspace.refresh()),
    w3.commands.register("w3.explorer.collapseAll", () => {
      expanded.clear();
      w3.views.refresh("w3.explorer.files");
    }),
    w3.commands.register("w3.explorer.focus", () => w3.commands.execute("workbench.toggleSidebar")),
  );
}
