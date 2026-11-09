// Object Manager: everything the map contains and uses, by type, as a tree in
// the side bar (like the World Editor's Object Manager). Each entry shows the
// triggers that use it; double-click goes to it (object editor, terrain,
// trigger editor, sound editor, import manager).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { OBJECTS_SERVICE, type ObjectsService } from "../../extensions/services";
import { loadKind } from "../../lib/objects/metadata";
import { triggerRefs } from "../../lib/triggers/refs";
import { parseTriggerData } from "../../lib/triggers/triggerdata";
import { readWtgFile, wtgPath } from "../../lib/triggers/wtg";
import { StringTable } from "../../lib/formats/wts";
import type { MenuItem } from "../../extensions/api";
import { h } from "../../workbench/dom";
import { ProjectGuard, buildTree, groupActions, idsInText, mapSummary, markUnused, nodeActions, objectRefs, type MapContents, type Node as TreeNode, type ObjectEntry, type Target } from "./data";

const VIEW = "w3.objectManager.tree";
const KINDS: [string, string][] = [["w3u", "Units"], ["w3t", "Items"], ["w3b", "Destructables"], ["w3d", "Doodads"], ["w3a", "Abilities"], ["w3h", "Buffs"], ["w3q", "Upgrades"]];

export function activate(w3: W3Api, ctx: ExtensionContext) {
  let tree: TreeNode[] | null = null, refs = new Map<string, Set<string>>(), loading: Promise<void> | null = null, error = "";
  /** Objects using an id, and how many custom objects nothing uses. */
  let users = new Map<string, Map<string, Target>>(), unusedCount = 0;
  /** The Map Summary's rows (counts per kind), from the last build. */
  let summary: [string, string][] = [];
  /** Show only what nothing uses. */
  let unusedOnly = false;
  /** Expanded nodes by their path of labels (kept across refreshes). */
  const open = new Set<string>();
  let query = "", selected = "";

  const rootNow = () => w3.workspace.project()?.root ?? null;
  const guard = new ProjectGuard(rootNow());
  let loadingToken = 0;
  /** Drops the old project's rows and state. */
  const reset = () => {
    tree = null; refs = new Map(); users = new Map(); unusedCount = 0; summary = []; error = ""; selected = ""; query = ""; loading = null; open.clear();
    w3.views.refresh(VIEW);
  };
  /** `force`: the user asked (Refresh); then a project the guard hasn't heard of is taken as the new one. */
  const load = (force = false) => {
    if (!w3.workspace.project()) return Promise.resolve();
    if (guard.stale(rootNow())) {
      // open() sets the project before its change event: that event starts the build. Without
      // it (open failed half way) only a Refresh gets here again, and starts over.
      if (!force) return Promise.resolve();
      guard.switched(rootNow());
      reset();
    }
    loading ??= (async () => {
      const token = guard.begin(), root = rootNow();
      loadingToken = token;
      error = "";
      let failed = "", result: { tree: TreeNode[]; refs: Map<string, Set<string>>; users: typeof users; unusedCount: number; summary: [string, string][] } | null = null;
      try {
        const c = await contents(w3);
        const tree = buildTree(c);
        const refs = c.triggers ? triggerRefs(c.triggers) : new Map();
        const customIds = new Set(c.custom.flatMap((k) => k.ids.map((o) => o.id)));
        const users = objectRefs(c.objects, customIds, c.nameOf);
        const mentioned = new Set(c.texts.flatMap((t) => idsInText(t, customIds)));
        const unusedCount = markUnused(tree, (id) => mentioned.has(id) || users.has(id) || refs.has(id));
        result = { tree, refs, users, unusedCount, summary: mapSummary(c) };
      } catch (e) {
        failed = String((e as Error).message ?? e);
      }
      // The project changed meanwhile: its reset already started the next build.
      if (!guard.valid(token, root)) { if (loadingToken === token) loading = null; return; }
      error = failed;
      if (result) ({ tree, refs, users, unusedCount, summary } = result);
      loading = null;
      w3.views.refresh(VIEW);
    })();
    return loading;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reload = () => {
    clearTimeout(timer);
    if (guard.switched(rootNow())) {
      // Another project: drop the old rows at once, build the new tree without the delay.
      reset();
      void load();
      return;
    }
    timer = setTimeout(() => void load(), 1000);
  };

  const go = async (t: Target) => {
    switch (t.kind) {
      case "object": return w3.commands.execute("w3.objectEditor.open", t.ext, t.id);
      case "point": return w3.commands.execute("w3.terrain.showPoint", t.x, t.y, t.id !== undefined ? { id: t.id, editorId: t.editorId } : undefined);
      case "trigger": return w3.commands.execute("w3.triggers.reveal", t.name);
      case "variables": return w3.commands.execute("w3.triggers.variables");
      case "sounds": return w3.commands.execute("w3.sounds.open");
      case "imports": return w3.commands.execute("w3.imports.open");
    }
  };

  /** Rename Object, Delete Object and Play Sound: done by the editor that owns the entry, as it does them by hand (its
   *  questions, its undo step; the change is unsaved there). `rowsRoot`: the project the row was made for. */
  const act = async (n: TreeNode, action: "rename" | "delete" | "play", rowsRoot: string | null) => {
    const t = n.target;
    if (!guard.owns(rowsRoot, rootNow())) return;
    // A region or camera: renamed or deleted in its tab of the terrain editor.
    if (n.item && action !== "play") {
      let to: string | undefined;
      if (action === "rename") {
        to = (await w3.window.inputBox({ prompt: `Rename ${n.label}`, value: n.label }))?.trim();
        if (!to || to === n.label || !guard.owns(rowsRoot, rootNow())) return;
      }
      await w3.commands.execute("w3.terrain.groupItemAction", n.item.group, n.item.name, action, to);
      return;
    }
    if (!t) return;
    if (action === "play") { if (t.kind === "sounds" && t.file) await w3.commands.execute("w3.sounds.play", t.file); return; }
    let to: string | undefined;
    if (action === "rename") {
      to = (await w3.window.inputBox({ prompt: `Rename ${n.label}`, value: n.label }))?.trim();
      // Another project opened during the question: its rows aren't these.
      if (!to || to === n.label || !guard.owns(rowsRoot, rootNow())) return;
    }
    switch (t.kind) {
      case "object": await w3.commands.execute("w3.objectEditor.objectAction", t.ext, t.id, action, to); break;
      case "trigger": await w3.commands.execute("w3.triggers.itemAction", "trigger", t.name, action, to); break;
      case "variables": if (t.name) await w3.commands.execute("w3.triggers.itemAction", "variable", t.name, action, to); break;
      case "sounds": if (t.name) await w3.commands.execute("w3.sounds.soundAction", t.name, action, to); break;
    }
  };
  /** The entry's menu: the World Editor's Object Manager commands that fit it; a group's Expand or Collapse and the
   *  editor of its entries. `toggle` opens or closes the row. */
  const menuFor = (n: TreeNode, rowsRoot: string | null, isOpen: boolean, toggle: () => void): MenuItem[] => {
    const a = nodeActions(n);
    const run = (f: () => Promise<unknown>) => () => { f().catch((e) => w3.window.showError(String((e as Error).message ?? e))); };
    const items: MenuItem[] = [];
    for (const g of groupActions(n, isOpen)) {
      if ("toggle" in g) items.push({ label: g.label, run: toggle });
      else items.push({ label: g.label, run: run(async () => { if (guard.owns(rowsRoot, rootNow())) await w3.commands.execute(g.opens.command, ...g.opens.args); }) });
    }
    if (items.length && (a.edit || a.rename || a.remove)) items.push("-");
    if (a.edit) items.push({ label: "Edit Object Properties", run: run(async () => { if (n.target && guard.owns(rowsRoot, rootNow())) await go(n.target); }) });
    if (a.rename) items.push({ label: "Rename Object…", run: run(() => act(n, "rename", rowsRoot)) });
    if (a.remove) items.push({ label: "Delete Object", run: run(() => act(n, "delete", rowsRoot)) });
    if (a.play) items.push("-", { label: "Play Sound", run: run(() => act(n, "play", rowsRoot)) });
    return items;
  };

  ctx.subscriptions.push(
    w3.commands.register("w3.objectManager.refresh", () => load(true)),
    // The Map Summary's rows (also shown by the view's button), after a build of the open project.
    w3.commands.register("w3.objectManager.summary", async () => {
      await load(true);
      return summary;
    }),
    w3.workspace.onDidChange(reload),
    w3.workspace.onDidSave(reload),
    w3.views.register(VIEW, {
      render(el) {
        if (!w3.workspace.project()) { el.append(h("div.view-empty", {}, "Open or import a project to see its objects.")); return; }
        if (!tree && !error) { el.append(h("div.view-empty", {}, "Reading the map…"), h("button", { onclick: () => void load(true) }, "Refresh")); void load(); return; }
        const search = h("input.om-search", { type: "search", placeholder: "Filter", value: query,
          oninput: () => { query = search.value; draw(); } });
        const rows = h("div.tree.om-tree");
        const rowsRoot = rootNow();
        const info = h("div.om-info");
        const q = () => query.trim().toLowerCase();
        const matches = (n: TreeNode): boolean => (!unusedOnly || n.unused === true) && `${n.label} ${n.detail ?? ""}`.toLowerCase().includes(q()) || (n.children ?? []).some(matches);
        const filtering = () => !!q() || unusedOnly;
        const draw = () => {
          const out: HTMLElement[] = [];
          const walk = (nodes: TreeNode[], depth: number, path: string) => {
            for (const n of nodes) {
              if (filtering() && !matches(n)) continue;
              const key = `${path}/${n.label}`;
              const kids = n.children ?? [];
              // While filtering, groups open by themselves.
              const isOpen = open.has(key) || (filtering() && kids.length > 0 && depth < 2);
              const used = n.ref ? refs.get(n.ref)?.size ?? 0 : 0;
              out.push(h(`div.tree-row.om-row${selected === key ? ".active" : ""}`, {
                style: { paddingLeft: `${6 + depth * 14}px` }, title: n.detail ?? "",
                onclick: () => {
                  selected = key;
                  if (kids.length) { if (open.has(key)) open.delete(key); else open.add(key); }
                  showInfo(n);
                  draw();
                },
                ondblclick: () => { if (n.target && guard.owns(rowsRoot, rootNow())) void go(n.target).catch((e) => w3.window.showError(String(e))); },
                oncontextmenu: (e: MouseEvent) => {
                  e.preventDefault();
                  selected = key;
                  showInfo(n);
                  draw();
                  const items = menuFor(n, rowsRoot, isOpen, () => { if (open.has(key)) open.delete(key); else open.add(key); draw(); });
                  if (items.length) w3.window.showContextMenu({ x: e.clientX, y: e.clientY }, items);
                },
              },
              h("span.tree-icon", {}, kids.length ? (isOpen ? "▾" : "▸") : ""),
              h("span.tree-label", {}, n.label),
              n.detail ? h("span.om-detail", {}, n.detail) : null,
              n.unused ? h("span.om-unused", { title: "Nothing uses it: no placed object, other object, trigger or script" }, "unused") : null,
              used ? h("span.om-used", { title: "Triggers using it" }, `ϟ${used}`) : null));
              if (kids.length && isOpen) walk(kids, depth + 1, key);
            }
          };
          walk(tree ?? [], 0, "");
          rows.replaceChildren(...out);
        };
        /** The selected entry: what it is and the triggers that use it (click to open). */
        const showInfo = (n: TreeNode) => {
          const inTriggers = n.ref ? [...(refs.get(n.ref) ?? [])].sort() : [];
          const inObjects = n.ref ? [...(users.get(n.ref) ?? [])].sort((a, b) => a[0].localeCompare(b[0])) : [];
          const parts = [h("div.om-info-title", {}, n.label),
            n.detail ? h("div.muted", {}, n.detail) : null,
            ...(n.ref ? [h("div.om-info-sub", {}, inTriggers.length ? `Used in ${inTriggers.length} trigger${inTriggers.length === 1 ? "" : "s"}:` : "Not used in triggers."),
              ...inTriggers.map((t) => h("div.om-trigger", { onclick: () => void w3.commands.execute("w3.triggers.reveal", t) }, `ϟ ${t}`))] : []),
            ...(inObjects.length ? [h("div.om-info-sub", {}, `Used by ${inObjects.length} object${inObjects.length === 1 ? "" : "s"}:`),
              ...inObjects.map(([label, target]) => h("div.om-trigger", { onclick: () => void go(target).catch((e) => w3.window.showError(String(e))) }, label))] : []),
            n.target ? h("div.muted.om-hint", {}, "Double-click the entry to go to it.") : null];
          info.replaceChildren(...parts.filter((x): x is HTMLDivElement => x !== null));
        };
        /** The Map Summary in the info pane: counts per kind, as the World Editor's. */
        const showSummary = () => {
          selected = "";
          draw();
          info.replaceChildren(h("div.om-info-title", {}, "Map Summary"),
            h("table.om-summary", {}, h("tbody", {}, ...summary.map(([label, value]) => h("tr", {}, h("td", {}, label), h("td.om-summary-value", {}, value))))));
        };
        draw();
        const unusedBox = h("input", { type: "checkbox", checked: unusedOnly, onchange: () => { unusedOnly = unusedBox.checked; draw(); } });
        el.append(h("div.om-view", {}, h("div.om-toolbar", {}, search,
          h("button.icon-button.om-summary-button", { title: "Map Summary: what the map holds, counted per kind", onclick: showSummary }, "Σ"),
          h("button.icon-button", { title: "Refresh", onclick: () => void load(true) }, "⟳")),
          h("label.om-filter", { title: "Custom objects no placed object, other object, trigger or script uses" }, unusedBox, ` Unused only (${unusedCount})`),
          error ? h("div.view-empty", {}, `Couldn't read the map: ${error}`) : null, rows, info));
      },
    }),
    { dispose: () => clearTimeout(timer) },
  );
}

/** Reads the map's files (JSON forms) and the game's object data for names and kinds. */
async function contents(w3: W3Api): Promise<MapContents> {
  const root = w3.workspace.project()!.root;
  const json = async <T>(name: string): Promise<T | null> => {
    const text = await w3.workspace.readText(`map/${name}.json`).catch(() => null)
      ?? await w3.backend.invoke<string>("codec_decode", { root, path: `map/${name}` }).catch(() => null);
    return text ? JSON.parse(text) as T : null;
  };
  const objects = await w3.services.get<ObjectsService>(OBJECTS_SERVICE).catch(() => null);
  // Kinds: game ids plus the map's custom ids per object type.
  const custom: MapContents["custom"] = [];
  const objectData: MapContents["objects"] = [];
  const kindIds = new Map<string, Set<string>>();
  // Every kind's game tables asked at once, as background reads: a map opening while this view is
  // built goes first.
  const kindData = new Map(KINDS.map(([ext]) => [ext, loadKind(w3, ext, { background: true }).catch(() => null)]));
  for (const [ext, label] of KINDS) {
    const file = await json<{ custom: { id: string; base: string }[]; original?: ObjectEntry[] }>(`war3map.${ext}`);
    const ids = (file?.custom ?? []).map((o) => ({ id: o.id, base: o.base }));
    objectData.push({ ext, label: label.replace(/s$/, ""), objects: [...(file?.original ?? []), ...(file?.custom ?? [])] });
    custom.push({ ext, label, ids });
    const kd = await kindData.get(ext)!;
    kindIds.set(ext, new Set([...(kd?.baseIds ?? []), ...ids.map((o) => o.id)]));
  }
  const kindOf = (id: string) => (kindIds.get("w3t")?.has(id) ? "w3t" : kindIds.get("w3b")?.has(id) ? "w3b" : kindIds.get("w3u")?.has(id) ? "w3u" : "w3d");
  const units = (await json<{ units: MapContents["units"] }>("war3mapUnits.doo"))?.units ?? [];
  const doodads = (await json<{ doodads: MapContents["doodads"] }>("war3map.doo"))?.doodads ?? [];
  // Names of every id shown (looked up once).
  const ids = new Set<string>([...units.map((u) => u.id), ...doodads.map((d) => d.id), ...custom.flatMap((k) => k.ids.map((o) => o.id))]);
  const names = new Map<string, string>();
  await Promise.all([...ids].map(async (id) => { const n = await objects?.name(id).catch(() => undefined); if (n) names.set(id, n); }));
  const wtg = wtgPath(w3.workspace.files());
  const triggers = wtg ? await readWtgFile(w3.workspace, wtg, async () => parseTriggerData(await w3.game.readText("UI\\TriggerData.txt", { background: true }))).catch(() => null) : null;
  const imp = await json<{ files: { path: string }[] }>("war3map.imp");
  const script = await w3.workspace.readText("map/war3map.j").catch(() => w3.workspace.readText("map/war3map.lua")).catch(() => "");
  const w3i = await json<{ name?: string; playableWidth?: number; playableHeight?: number; tileset?: string }>("war3map.w3i");
  const strings = new StringTable(await w3.workspace.readText("map/war3map.wts").catch(() => ""));
  return {
    info: w3i ? { name: strings.resolve(String(w3i.name ?? "")), playableWidth: Number(w3i.playableWidth ?? 0), playableHeight: Number(w3i.playableHeight ?? 0), tileset: String(w3i.tileset ?? "") } : null,
    units, doodads, kindOf, nameOf: (id) => names.get(id) ?? id, custom,
    regions: (await json<{ regions: MapContents["regions"] }>("war3map.w3r"))?.regions ?? [],
    cameras: (await json<{ cameras: MapContents["cameras"] }>("war3map.w3c"))?.cameras ?? [],
    sounds: (await json<{ sounds: MapContents["sounds"] }>("war3map.w3s"))?.sounds ?? [],
    triggers, imports: (imp?.files ?? []).map((f) => f.path), objects: objectData,
    // Item drops of placed objects and the map's item tables and techtree name ids too.
    texts: [script, JSON.stringify(units), JSON.stringify(doodads), JSON.stringify(await json("war3map.w3i"))],
  };
}
