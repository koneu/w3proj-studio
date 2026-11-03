// Object Manager: everything the map contains and uses, by type, as a tree in
// the side bar (like the World Editor's Object Manager). Each entry shows the
// triggers that use it; double-click goes to it (object editor, terrain,
// trigger editor, sound editor, import manager).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { OBJECTS_SERVICE, type ObjectsService } from "../../extensions/services";
import { loadKind } from "../../lib/objects/metadata";
import { parseTriggerData } from "../../lib/triggers/triggerdata";
import { parseWtg } from "../../lib/triggers/wtg";
import { h } from "../../workbench/dom";
import { buildTree, triggerRefs, type MapContents, type Node as TreeNode, type Target } from "./data";

const VIEW = "w3.objectManager.tree";
const KINDS: [string, string][] = [["w3u", "Units"], ["w3t", "Items"], ["w3b", "Destructables"], ["w3d", "Doodads"], ["w3a", "Abilities"], ["w3h", "Buffs"], ["w3q", "Upgrades"]];

export function activate(w3: W3Api, ctx: ExtensionContext) {
  let tree: TreeNode[] | null = null, refs = new Map<string, Set<string>>(), loading: Promise<void> | null = null, error = "";
  /** Expanded nodes by their path of labels (kept across refreshes). */
  const open = new Set<string>();
  let query = "", selected = "";

  const load = () => {
    loading ??= (async () => {
      error = "";
      try {
        const c = await contents(w3);
        tree = buildTree(c);
        refs = c.triggers ? triggerRefs(c.triggers) : new Map();
      } catch (e) {
        error = String((e as Error).message ?? e);
      }
      loading = null;
      w3.views.refresh(VIEW);
    })();
    return loading;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reload = () => { clearTimeout(timer); timer = setTimeout(() => void load(), 1000); };

  const go = async (t: Target) => {
    switch (t.kind) {
      case "object": return w3.commands.execute("w3.objectEditor.open", t.ext, t.id);
      case "point": return w3.commands.execute("w3.terrain.showPoint", t.x, t.y);
      case "trigger": return w3.commands.execute("w3.triggers.reveal", t.name);
      case "variables": return w3.commands.execute("w3.triggers.variables");
      case "sounds": return w3.commands.execute("w3.sounds.open");
      case "imports": return w3.commands.execute("w3.imports.open");
    }
  };

  ctx.subscriptions.push(
    w3.commands.register("w3.objectManager.refresh", () => load()),
    w3.workspace.onDidChange(reload),
    w3.workspace.onDidSave(reload),
    w3.views.register(VIEW, {
      render(el) {
        if (!w3.workspace.project()) { el.append(h("div.view-empty", {}, "Open or import a project to see its objects.")); return; }
        if (!tree && !error) { el.append(h("div.view-empty", {}, "Reading the map…")); void load(); return; }
        const search = h("input.om-search", { type: "search", placeholder: "Filter", value: query,
          oninput: () => { query = search.value; draw(); } });
        const rows = h("div.tree.om-tree");
        const info = h("div.om-info");
        const q = () => query.trim().toLowerCase();
        const matches = (n: TreeNode): boolean => `${n.label} ${n.detail ?? ""}`.toLowerCase().includes(q()) || (n.children ?? []).some(matches);
        const draw = () => {
          const out: HTMLElement[] = [];
          const walk = (nodes: TreeNode[], depth: number, path: string) => {
            for (const n of nodes) {
              if (q() && !matches(n)) continue;
              const key = `${path}/${n.label}`;
              const kids = n.children ?? [];
              // While filtering, groups open by themselves.
              const isOpen = open.has(key) || (!!q() && kids.length > 0 && depth < 2);
              const used = n.ref ? refs.get(n.ref)?.size ?? 0 : 0;
              out.push(h(`div.tree-row.om-row${selected === key ? ".active" : ""}`, {
                style: { paddingLeft: `${6 + depth * 14}px` }, title: n.detail ?? "",
                onclick: () => {
                  selected = key;
                  if (kids.length) { if (open.has(key)) open.delete(key); else open.add(key); }
                  showInfo(n);
                  draw();
                },
                ondblclick: () => { if (n.target) void go(n.target).catch((e) => w3.window.showError(String(e))); },
              },
              h("span.tree-icon", {}, kids.length ? (isOpen ? "▾" : "▸") : ""),
              h("span.tree-label", {}, n.label),
              n.detail ? h("span.om-detail", {}, n.detail) : null,
              used ? h("span.om-used", { title: "Triggers using it" }, `ϟ${used}`) : null));
              if (kids.length && isOpen) walk(kids, depth + 1, key);
            }
          };
          walk(tree ?? [], 0, "");
          rows.replaceChildren(...out);
        };
        /** The selected entry: what it is and the triggers that use it (click to open). */
        const showInfo = (n: TreeNode) => {
          const users = n.ref ? [...(refs.get(n.ref) ?? [])].sort() : [];
          const parts = [h("div.om-info-title", {}, n.label),
            n.detail ? h("div.muted", {}, n.detail) : null,
            ...(n.ref ? [h("div.om-info-sub", {}, users.length ? `Used in ${users.length} trigger${users.length === 1 ? "" : "s"}:` : "Not used in triggers."),
              ...users.map((t) => h("div.om-trigger", { onclick: () => void w3.commands.execute("w3.triggers.reveal", t) }, `ϟ ${t}`))] : []),
            n.target ? h("div.muted.om-hint", {}, "Double-click the entry to go to it.") : null];
          info.replaceChildren(...parts.filter((x): x is HTMLDivElement => x !== null));
        };
        draw();
        el.append(h("div.om-view", {}, h("div.om-toolbar", {}, search, h("button.icon-button", { title: "Refresh", onclick: () => void load() }, "⟳")),
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
  const kindIds = new Map<string, Set<string>>();
  for (const [ext, label] of KINDS) {
    const file = await json<{ custom: { id: string; base: string }[] }>(`war3map.${ext}`);
    const ids = (file?.custom ?? []).map((o) => ({ id: o.id, base: o.base }));
    custom.push({ ext, label, ids });
    const kd = await loadKind(w3, ext).catch(() => null);
    kindIds.set(ext, new Set([...(kd?.baseIds ?? []), ...ids.map((o) => o.id)]));
  }
  const kindOf = (id: string) => (kindIds.get("w3t")?.has(id) ? "w3t" : kindIds.get("w3b")?.has(id) ? "w3b" : kindIds.get("w3u")?.has(id) ? "w3u" : "w3d");
  const units = (await json<{ units: MapContents["units"] }>("war3mapUnits.doo"))?.units ?? [];
  const doodads = (await json<{ doodads: MapContents["doodads"] }>("war3map.doo"))?.doodads ?? [];
  // Names of every id shown (looked up once).
  const ids = new Set<string>([...units.map((u) => u.id), ...doodads.map((d) => d.id), ...custom.flatMap((k) => k.ids.map((o) => o.id))]);
  const names = new Map<string, string>();
  await Promise.all([...ids].map(async (id) => { const n = await objects?.name(id).catch(() => undefined); if (n) names.set(id, n); }));
  const wtg = await w3.workspace.readBytes("map/war3map.wtg").catch(() => null);
  const triggers = wtg ? parseWtg(wtg, parseTriggerData(await w3.game.readText("UI\\TriggerData.txt"))) : null;
  const imp = await json<{ files: { path: string }[] }>("war3map.imp");
  return {
    units, doodads, kindOf, nameOf: (id) => names.get(id) ?? id, custom,
    regions: (await json<{ regions: MapContents["regions"] }>("war3map.w3r"))?.regions ?? [],
    cameras: (await json<{ cameras: MapContents["cameras"] }>("war3map.w3c"))?.cameras ?? [],
    sounds: (await json<{ sounds: MapContents["sounds"] }>("war3map.w3s"))?.sounds ?? [],
    triggers, imports: (imp?.files ?? []).map((f) => f.path),
  };
}
