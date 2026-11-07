import { capped } from "../../lib/formats/mapdoc";
import { findGameFiles } from "./filesearch";
import type { ExtensionContext, W3Api } from "../../extensions/api";
import { copyButton, h } from "../../workbench/dom";
import { CATEGORIES, categoryOf, LAYERS } from "./filters";

interface Node {
  name: string;
  key: string;
  full?: string;
  children?: Map<string, Node>;
  /** Number of files below this node. */
  count: number;
}

/** "War3.w3mod:_HD.w3mod:Units/Human/X.mdx" → ["War3.w3mod", "_HD.w3mod", "Units", "Human", "X.mdx"] */
function segments(full: string): string[] {
  return full.split(":").flatMap((part, i, all) => (i < all.length - 1 ? [part] : part.split("/")));
}

function buildTree(paths: string[]): Node {
  const root: Node = { name: "", key: "", children: new Map(), count: 0 };
  for (const full of paths) {
    let cur = root;
    cur.count++;
    const segs = segments(full);
    segs.forEach((seg, i) => {
      const k = seg.toLowerCase();
      let next = cur.children!.get(k);
      if (!next) {
        next = { name: seg, key: `${cur.key}/${k}`, count: 0 };
        if (i < segs.length - 1) next.children = new Map();
        cur.children!.set(k, next);
      }
      next.count++;
      if (i === segs.length - 1) next.full = full;
      cur = next;
    });
  }
  return root;
}

const MAX_RESULTS = 500;

/** One read_game_file answer; `offset` gets the rest. */
const READ_LIMIT = 200_000;

export function activate(w3: W3Api, ctx: ExtensionContext) {
  ctx.subscriptions.push(
    w3.mcp.registerTool("search_game_files", async ({ filter, extension, limit }) => {
      if (typeof filter !== "string" || !filter.trim()) throw new Error("search_game_files needs a filter.");
      return capped(findGameFiles(await w3.game.list(), filter, typeof extension === "string" ? extension : undefined), limit, 80);
    }),
    w3.mcp.registerTool("read_game_file", async ({ path, offset }) => {
      if (typeof path !== "string") throw new Error("read_game_file needs a path.");
      const text = await w3.game.readText(path).catch((e) => { throw new Error(`Can't read ${path}: ${e}`); });
      const start = typeof offset === "number" && offset > 0 ? offset : 0;
      const part = text.slice(start, start + READ_LIMIT), rest = text.length - start - part.length;
      return rest > 0 ? `${part}\n\n[${rest} more characters: read on with offset ${start + part.length}]` : part;
    }),
  );
  let paths: string[] = [];
  let loadError: string | null = null;
  let loaded = false;
  let query = "";
  const categories = new Set<string>(); // empty = all types
  let layer = "all";
  const expanded = new Set<string>(["/war3.w3mod"]);
  // The tree is rebuilt only when the filters change.
  let treeCache: { key: string; tree: Node; files: string[] } | null = null;

  const load = async () => {
    try {
      paths = await w3.window.withProgress("Reading game storage", () => w3.game.list());
      loadError = null;
    } catch (e) {
      loadError = String(e);
    }
    loaded = true;
    treeCache = null;
    w3.views.refresh("w3.game.files");
  };

  const layerTest = () => LAYERS.find((l) => l.id === layer)!.test;
  const inLayer = () => {
    const test = layerTest();
    return paths.filter((p) => test(p.toLowerCase()));
  };
  const filtered = () => {
    const key = `${layer}|${[...categories].sort().join(",")}`;
    if (treeCache?.key !== key) {
      const files = inLayer().filter((p) => !categories.size || categories.has(categoryOf(p)));
      treeCache = { key, tree: buildTree(files), files };
    }
    return treeCache;
  };

  const open = (full: string) => w3.editors.open(`game:${full}`).catch((e) => w3.window.showError(String(e)));

  const fileRow = (label: string, full: string, depth: number, detail?: string) =>
    h("div.tree-row", { style: { paddingLeft: `${8 + depth * 12}px` }, title: full, onclick: () => open(full) },
      h("span.tree-icon", {}, "·"),
      h("span.tree-label", {}, label),
      detail ? h("small.muted", {}, detail) : null,
    );

  const render = (el: HTMLElement) => {
    const search = h("input.tree-search", {
      placeholder: "Search game files…",
      value: query,
      oninput: () => {
        query = search.value;
        renderBody();
      },
    });
    const layerSelect = h("select.game-layer", {
      onchange: () => {
        layer = layerSelect.value;
        renderChips();
        renderBody();
      },
    }, ...LAYERS.map((l) => h("option", { value: l.id, selected: l.id === layer }, l.label)));
    const chips = h("div.game-chips");
    const body = h("div.tree");

    const renderChips = () => {
      // Counts reflect the selected layer, so empty types are visible at a glance.
      const counts = new Map<string, number>();
      for (const p of inLayer()) {
        const c = categoryOf(p);
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
      const chip = (id: string, label: string, title: string) =>
        h(`button.chip${(id === "" ? !categories.size : categories.has(id)) ? ".on" : ""}`, {
          title,
          onclick: (e: MouseEvent) => {
            if (id === "") categories.clear();
            else if (e.ctrlKey || e.shiftKey) {
              if (categories.has(id)) categories.delete(id);
              else categories.add(id);
            } else if (categories.size === 1 && categories.has(id)) categories.clear();
            else {
              categories.clear();
              categories.add(id);
            }
            renderChips();
            renderBody();
          },
        }, label, id !== "" ? h("small", {}, String(counts.get(id) ?? 0)) : null);
      chips.replaceChildren(
        chip("", "All", "Show every file type"),
        ...CATEGORIES.map((c) => chip(c.id, c.label, `${c.exts.map((e) => `.${e}`).join(" ")} — Ctrl+click to combine`)),
        chip("other", "Other", "Everything not covered by the other types"),
      );
    };

    const renderBody = () => {
      body.replaceChildren();
      if (loadError) {
        body.append(h("div.view-error", {}, loadError, " ", copyButton(loadError)), h("div.view-empty", {}, "Check \"game.installDir\" in Preferences: Open Settings (JSON)."));
        return;
      }
      if (!loaded) {
        body.append(h("div.view-empty", {}, "Loading…"));
        return;
      }
      const { tree, files } = filtered();
      const q = query.trim().toLowerCase();
      if (q.length >= 2) {
        const hits = files.filter((p) => p.toLowerCase().includes(q));
        for (const full of hits.slice(0, MAX_RESULTS)) {
          const name = full.split(/[/:]/).pop()!;
          body.append(fileRow(name, full, 0, full.slice(0, full.length - name.length)));
        }
        body.append(h("div.view-empty", {}, hits.length > MAX_RESULTS ? `${hits.length} matches, showing ${MAX_RESULTS}` : `${hits.length} matches`));
        return;
      }
      if (!files.length) {
        body.append(h("div.view-empty", {}, "No files match these filters."));
        return;
      }
      body.append(h("div.view-empty", {}, `${files.length} files`));
      const walk = (node: Node, depth: number) => {
        const kids = [...node.children!.values()].sort((a, b) => {
          if (!!a.children !== !!b.children) return a.children ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        });
        for (const child of kids) {
          if (!child.children) {
            body.append(fileRow(child.name, child.full!, depth));
            continue;
          }
          const open = expanded.has(child.key);
          body.append(
            h("div.tree-row", {
              style: { paddingLeft: `${8 + depth * 12}px` },
              onclick: () => {
                if (open) expanded.delete(child.key);
                else expanded.add(child.key);
                renderBody();
              },
            },
              h("span.tree-icon.dir", {}, open ? "▾" : "▸"),
              h("span.tree-label", {}, child.name),
              h("small.muted", {}, String(child.count)),
            ),
          );
          if (open) walk(child, depth + 1);
        }
      };
      walk(tree, 0);
    };

    el.append(search, h("div.game-filters", {}, layerSelect), chips, body);
    if (loaded) renderChips();
    renderBody();
  };

  ctx.subscriptions.push(
    w3.views.register("w3.game.files", {
      render,
      actions: [{ icon: "⟳", title: "Reload", command: "w3.game.info" }],
    }),
    w3.commands.register("w3.game.openPath", async () => {
      const path = await w3.window.inputBox({ prompt: "Game path, e.g. Units\\Human\\Footman\\Footman.mdx or ReplaceableTextures\\CommandButtons\\BTNFootman.blp" });
      if (!path) return;
      const full = path.includes(".w3mod:") ? path : await w3.game.resolve(path);
      if (!full) throw new Error(`${path} is not in the game data (${w3.settings.get("game.graphicsMode")} mode)`);
      await open(full);
    }),
    w3.commands.register("w3.game.info", async () => {
      const i = await w3.game.info();
      w3.window.showInfo(`Warcraft III ${i.version} · locale ${i.locale} · ${i.stored} of ${i.entries} files stored locally · graphics mode ${w3.settings.get("game.graphicsMode")}`);
      if (!loaded || loadError) await load();
    }),
    w3.commands.register("w3.game.setMode", async () => {
      const pick = await w3.window.quickPick(
        [
          { label: "HD", description: "Reforged graphics", value: "hd" },
          { label: "SD", description: "Classic graphics", value: "sd" },
          { label: "DE", description: "3.0 art layer", value: "de" },
        ],
        { placeholder: `Current: ${w3.settings.get("game.graphicsMode")}` },
      );
      if (pick) await w3.settings.set("game.graphicsMode", pick.value);
    }),
  );
  load();
}
