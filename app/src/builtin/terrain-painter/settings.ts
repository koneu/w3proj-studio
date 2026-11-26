// The Terrain Settings tab ("Edit Tileset / Terrain Settings"): what the terrain's header defines, in one place: the
// tileset (and Map Properties' entry for it), a tileset's tiles as a template, the ground tiles in their slots (draw
// order, adding, removing, cleaning up), the cliff types, and the facts that aren't changed here (canvas, w3e version,
// a split terrain's default corner). It works on the project's open terrain editor, as its palette did: every change
// is one of that editor's undo steps and is saved with the terrain (a flat project's war3map.w3e.txt, a split one's
// terrain.json alike). With only some subterrains open the lists can only be appended to (the editor refuses the rest).

import type { EditorInstance, W3Api } from "../../extensions/api";
import { TERRAIN_SERVICE, type TerrainEditorHandle, type TerrainService } from "../../extensions/services";
import { MAX_CLIFF_TYPES } from "../../lib/terrain/cliffs";
import { maxGroundTiles } from "../../lib/terrain/w3e";
import { TILESETS } from "../../lib/terrain/tilesets";
import { h } from "../../workbench/dom";

/** The tab's document. */
export const SETTINGS_DOC = "w3:terrain-settings";
/** Maps hold at most this many ground tile types (World Editor limit). */

export interface SettingsDeps {
  /** The project's open terrain editor, or null. */
  editor(): TerrainEditorHandle | null;
  /** When the terrain editors come and go. */
  onEditors(listener: () => void): { dispose(): void };
  /** Opens the project's terrain editor (behind this tab). */
  openEditor(): Promise<void>;
  /** Every ground tile type the game knows: a readable name per id. */
  tileNames(): Promise<Map<string, string>>;
}

export function settingsEditor(w3: W3Api, el: HTMLElement, deps: SettingsDeps): EditorInstance {
  const root = h("div.terrain-settings", { tabindex: "-1" });
  el.append(root);
  let disposed = false, seq = 0;
  /** Index whose removal is being confirmed. */
  let removing: number | null = null;
  /** Clean up: the tiles ticked for removal and, for those in use, the tile each one's corners and cliffs get (by
   *  index), for the tile list it was started on. Null when not cleaning up. */
  let cleanup: { list: string; remove: Set<number>; replace: Map<number, number> } | null = null;
  /** Cliff entry whose removal is being confirmed (it is in use: its corners need another entry). */
  let removingCliff: number | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;

  /** A list edit the editor may refuse: the reason as a warning (nothing changed then). */
  const tryIt = (f: () => void) => { try { f(); } catch (e) { void w3.window.showWarning((e as Error).message ?? String(e)); } void render(); };

  async function render() {
    const my = ++seq;
    clearTimeout(retry);
    const ed = deps.editor();
    if (!ed) {
      root.replaceChildren(h("div.terrain-settings-empty", {},
        h("h2", {}, "Tileset & Terrain Settings"),
        h("p.muted", {}, "The settings are the terrain's: open the terrain editor to see and change them here."),
        h("button", { "data-settings": "open-terrain", onclick: () => void deps.openEditor().then(render, (e) => w3.window.showError(String((e as Error).message ?? e))) }, "Open the terrain editor")));
      return;
    }
    const terrain = ed.terrain;
    const [names, sets, mapSet, layout] = await Promise.all([
      deps.tileNames(),
      ed.tilesets().catch(() => [] as { id: string; name: string; tiles: string[] }[]),
      ed.mapTileset().catch(() => null),
      readLayoutFile(w3),
    ]);
    // A newer render (an edit meanwhile, the editor gone) draws its own.
    if (my !== seq || disposed || deps.editor() !== ed) return;
    const locked = ed.partial ? "Only some subterrains are open: the lists are the whole map's, so they can only be added to here" : !ed.editable ? "This terrain is read-only" : "";
    const nameOf = (id: string) => sets.find((s) => s.id === id)?.name ?? TILESETS[id] ?? id;
    const sections: HTMLElement[] = [h("h2", {}, "Tileset & Terrain Settings")];

    // ---- facts ----
    const facts: [string, string][] = [
      ["Tileset", `${nameOf(terrain.tileset)} (${terrain.tileset})`],
      ["Canvas", `${terrain.width - 1} × ${terrain.height - 1} tiles (${terrain.width} × ${terrain.height} corners), corner 0,0 at ${terrain.offsetX}, ${terrain.offsetY}. Map Size changes it.`],
      ["w3e version", `${terrain.version} (up to ${maxGroundTiles(terrain)} ground tiles, ${MAX_CLIFF_TYPES} cliff types)`],
      ["Custom tile list", terrain.customTilesetsRaw === 0 ? "no: the tileset's own tiles" : "yes"],
      ["Layout", layout ? `split into ${layout.subterrains} subterrains (map/terrain/terrain.json)${ed.partial ? ", some closed" : ""}` : "flat (map/war3map.w3e.txt)"],
    ];
    if (layout?.defaultCorner) facts.push(["Default corner", `${Object.entries(layout.defaultCorner).map(([k, v]) => `${k} ${v}`).join(", ")}: what corners outside every subterrain are (set by the split)`]);
    sections.push(h("div.terrain-settings-facts", {}, ...facts.map(([k, v]) => h("div.terrain-settings-fact", { "data-fact": k }, h("span.terrain-settings-key", {}, k), h("span", {}, v)))));
    if (locked) sections.push(h("div.terrain-settings-locked", {}, `${locked}.`));

    // ---- tileset, template, Map Properties ----
    const tilesetSelect = h("select", { title: locked || "The terrain's tileset: water, default lighting and blight follow (the ground tiles stay; see Template)", disabled: !!locked,
      onchange: () => tryIt(() => ed.setTileset(tilesetSelect.value)) },
      ...(sets.some((s) => s.id === terrain.tileset) ? [] : [h("option", { value: terrain.tileset, selected: true }, terrain.tileset)]),
      ...sets.map((s) => h("option", { value: s.id, selected: s.id === terrain.tileset }, s.name)));
    const templateSelect = h("select", { title: "A tileset's own ground tiles", disabled: !!locked },
      ...sets.map((s) => h("option", { value: s.id, selected: s.id === terrain.tileset }, s.name)));
    const applyTemplate = h("button", {
      title: locked || "Replace the map's ground tiles with this tileset's own, slot by slot (painted ground keeps its slot; cliffs follow); one undo step",
      disabled: !!locked,
      onclick: () => { const s = sets.find((x) => x.id === templateSelect.value); if (s) tryIt(() => ed.replaceGroundTiles(s.tiles)); },
    }, "Use its tiles");
    const sync = mapSet && mapSet !== terrain.tileset ? h("div.terrain-tilemgr-sync", {},
      h("span", {}, `Map Properties says ${nameOf(mapSet)}.`),
      h("button", { title: locked || "Switch the terrain to Map Properties' tileset", disabled: !!locked, onclick: () => tryIt(() => ed.setTileset(mapSet)) }, "Use it here"),
      h("button", { title: "Write the terrain's tileset into Map Properties (war3map.w3i)", onclick: () => { void ed.setMapTileset(terrain.tileset).then(() => render(), (e) => { void w3.window.showError(`Map Properties not changed: ${(e as Error).message ?? e}`); }); } }, `Set Map Properties to ${nameOf(terrain.tileset)}`)) : null;

    // ---- ground tiles ----
    const t = terrain.groundTiles;
    const usage = ed.groundTileUsage();
    const total = usage.reduce((a, b) => a + b, 0) || 1;
    // Another list (an undo, a tile added) makes the ticks point at other tiles: they go.
    if (cleanup && cleanup.list !== t.join()) cleanup = null;
    const use = ed.groundTileUse();
    const inUse = (i: number) => !use || use.ground[i] + use.cliffs[i] > 0;
    const unused = use ? t.map((_, i) => i).filter((i) => !inUse(i)) : [];
    const useText = (i: number) => use ? `${use.ground[i].toLocaleString()} corners${use.cliffs[i] ? `, ${use.cliffs[i].toLocaleString()} cliff tiles` : ""}` : `${usage[i].toLocaleString()} corners`;
    const inList = new Set(t);
    const byTileset = new Map<string, string[]>();
    for (const id of names.keys()) if (!inList.has(id)) byTileset.set(id[0], [...(byTileset.get(id[0]) ?? []), id]);
    const own = byTileset.get(terrain.tileset) ?? [];
    byTileset.delete(terrain.tileset);
    const full = t.length >= maxGroundTiles(terrain);
    const addTile = h("select", {
      "data-settings": "add-tile",
      title: full ? `This map's file holds ${maxGroundTiles(terrain)} ground tiles: remove one first` : "Add a ground tile to the end of the map's list; one undo step",
      disabled: full || !ed.editable,
      onchange: () => { const id = addTile.value; if (id) tryIt(() => ed.replaceGroundTiles([...t, id])); },
    },
    h("option", { value: "", selected: true }, `Add tile… (${t.length}/${maxGroundTiles(terrain)})`),
    ...(own.length ? [h("optgroup", { label: TILESETS[terrain.tileset] ?? terrain.tileset }, ...own.map((id) => h("option", { value: id }, `${names.get(id) ?? id} (${id})`)))] : []),
    ...[...byTileset].sort(([x], [y]) => (TILESETS[x] ?? x).localeCompare(TILESETS[y] ?? y))
      .map(([ts, ids]) => h("optgroup", { label: TILESETS[ts] ?? ts }, ...ids.map((id) => h("option", { value: id }, `${names.get(id) ?? id} (${id})`)))));
    const cleanupBar = h("div.terrain-tilemgr-row.terrain-tilemgr-cleanup", {},
      addTile,
      h("button", {
        title: locked || (use ? "Remove the tiles no corner is painted with and no cliff is made of; one undo step" : "Waiting for the game's cliff types"),
        disabled: !!locked || !use || !unused.length || unused.length === t.length,
        onclick: () => tryIt(() => ed.removeUnusedGroundTiles()),
      }, `Remove unused (${unused.length})`),
      h("button", {
        title: locked || "Choose tiles to remove, used ones too: their corners and cliffs get a tile that stays; one undo step",
        disabled: !!locked || !use || t.length < 2,
        onclick: () => { cleanup = cleanup ? null : { list: t.join(), remove: new Set(unused), replace: new Map() }; removing = null; void render(); },
      }, cleanup ? "Stop cleaning up" : "Clean up…"));
    const cleanupFooter = () => {
      if (!cleanup) return null;
      const c = cleanup, kept = t.map((_, i) => i).filter((i) => !c.remove.has(i));
      return h("div.terrain-tilemgr-row.terrain-tilemgr-cleanup", {},
        h("button", {
          disabled: !c.remove.size || !kept.length,
          title: kept.length ? "" : "A map needs at least one ground tile: keep one",
          onclick: () => {
            const replace = new Map([...c.remove].filter(inUse).map((i) => [i, c.replace.get(i) ?? kept[0]] as [number, number]));
            cleanup = null;
            tryIt(() => { ed.removeGroundTiles([...c.remove], replace); });
          },
        }, `Remove ${c.remove.size} tile${c.remove.size === 1 ? "" : "s"}`),
        h("button", { onclick: () => { cleanup = null; void render(); } }, "Cancel"));
    };
    const cleanupCells = (i: number, label: string) => {
      if (!cleanup) return [];
      const c = cleanup;
      const box = h("input", { type: "checkbox", title: `Remove ${label}`, checked: c.remove.has(i), onchange: () => {
        if (box.checked) c.remove.add(i); else c.remove.delete(i);
        // A tile ticked now can't be what replaces another.
        for (const [k, r] of c.replace) if (c.remove.has(r)) c.replace.delete(k);
        void render();
      } });
      if (!c.remove.has(i) || !inUse(i)) return [box];
      const others = t.map((o, j) => [o, j] as const).filter(([, j]) => !c.remove.has(j));
      if (!others.length) return [box];
      const chosen = c.replace.get(i) ?? others[0][1];
      const sel = h("select.terrain-tilemgr-replace", { title: `What ${label}'s ${useText(i)} get`, onchange: () => c.replace.set(i, Number(sel.value)) },
        ...others.map(([o, j]) => h("option", { value: String(j), selected: j === chosen }, `${names.get(o) ?? o} (${o})`)));
      return [box, h("span.muted", {}, " → "), sel];
    };
    const tileRows = t.map((id, i) => {
      const img = h("img", { alt: id });
      void ed.groundTileThumb(id).then((src) => { if (src) img.src = src; });
      const label = `${names.get(id) ?? id} (${id})`;
      if (cleanup) {
        const [box, ...replacement] = cleanupCells(i, label);
        return h(`div.terrain-tilemgr-row${cleanup.remove.has(i) ? ".removing" : ""}`, { title: useText(i) },
          box, img,
          h("span.terrain-tilemgr-name", {}, label),
          h("span.muted", { title: useText(i) }, inUse(i) ? `${((100 * usage[i]) / total).toFixed(1)}%` : "unused"),
          ...replacement);
      }
      if (removing === i) {
        const others = t.map((o, j) => [o, j] as const).filter(([, j]) => j !== i);
        const sel = h("select", {}, ...others.map(([o, j]) => h("option", { value: String(j) }, `${names.get(o) ?? o} (${o})`)));
        return h("div.terrain-tilemgr-row.removing", {}, img, h("span", {}, `Remove ${label}: paint its ${usage[i].toLocaleString()} corners with`), sel,
          h("button", { onclick: () => { removing = null; tryIt(() => ed.removeGroundTile(i, Number(sel.value))); } }, "Remove"),
          h("button", { onclick: () => { removing = null; void render(); } }, "Cancel"));
      }
      return h("div.terrain-tilemgr-row", {}, img,
        h("span.terrain-tilemgr-name", {}, label),
        h("span.muted", { title: `${usage[i].toLocaleString()} corners` }, `${((100 * usage[i]) / total).toFixed(1)}%`),
        h("button", { title: locked || "Move up (drawn earlier, under the others)", disabled: !!locked || i === 0, onclick: () => tryIt(() => ed.moveGroundTile(i, i - 1)) }, "↑"),
        h("button", { title: locked || "Move down (drawn later, over the others)", disabled: !!locked || i === t.length - 1, onclick: () => tryIt(() => ed.moveGroundTile(i, i + 1)) }, "↓"),
        h("button", { title: locked || "Remove from the map (its corners get another tile)", disabled: !!locked || t.length < 2, onclick: () => { removing = i; void render(); } }, "✕"));
    });
    sections.push(h("div.terrain-tilemgr.terrain-settings-tiles", {},
      h("h3", {}, "Tileset"),
      h("div.terrain-tilemgr-row", {}, h("span.terrain-tilemgr-name", {}, "Tileset"), tilesetSelect),
      h("div.terrain-tilemgr-row", {}, h("span.terrain-tilemgr-name", {}, "Template"), templateSelect, applyTemplate),
      ...(sync ? [sync] : []),
      h("h3", {}, `Ground tiles (${t.length})`),
      h("div.muted", {}, "Draw order: tiles further down are drawn over the ones above them where they meet. The terrain editor's Paint tool paints with these. Changes are one undo step each."),
      cleanupBar,
      ...(cleanup ? [h("div.muted", {}, "Tick the tiles to remove (the unused ones are ticked). A used one's corners and cliffs get the tile chosen beside it.")] : []),
      ...tileRows,
      ...(cleanup ? [cleanupFooter()!] : [])));

    // ---- cliff types ----
    sections.push(renderCliffs(ed, names, locked));
    root.replaceChildren(...sections);
  }

  function renderCliffs(ed: TerrainEditorHandle, names: Map<string, string>, locked: string): HTMLElement {
    const terrain = ed.terrain;
    const panel = h("div.terrain-tilemgr.terrain-cliffmgr", {}, h("h3", {}, "Cliff types"));
    const list = terrain.cliffTiles, game = ed.gameCliffTypes(), use = ed.cliffTypeUse();
    if (!use || !game.length) {
      panel.append(h("div.muted", {}, "Reading the game's cliff types…"));
      // Looked at again while the tab is open (dispose stops it).
      retry = setTimeout(() => void render(), 500);
      return panel;
    }
    const ground = new Map(game.map((c) => [c.id, c.groundTile]));
    const label = (id: string) => { const g = ground.get(id); return g ? `${names.get(g) ?? g} cliff (${id})` : `${id} (not one of the game's)`; };
    const useText = (i: number) => `${(use.corners[i] ?? 0).toLocaleString()} corners, ${(use.tiles[i] ?? 0).toLocaleString()} cliff tiles`;
    const inUse = (i: number) => (use.corners[i] ?? 0) + (use.tiles[i] ?? 0) > 0;
    if (removingCliff !== null && (removingCliff >= list.length || !inUse(removingCliff))) removingCliff = null;
    const paintable = Math.min(list.length, MAX_CLIFF_TYPES);
    // The game's cliff types not in the list, by the tileset their ground tile belongs to.
    const bySet = new Map<string, string[]>();
    for (const c of game) if (!list.includes(c.id)) bySet.set(c.groundTile[0], [...(bySet.get(c.groundTile[0]) ?? []), c.id]);
    const full = list.length >= MAX_CLIFF_TYPES;
    const addSelect = h("select", {
      title: full ? `A corner can name ${MAX_CLIFF_TYPES} cliff types (0 to ${MAX_CLIFF_TYPES - 1}): remove one first` : "Add one of the game's cliff types to the end of the list; one undo step",
      disabled: full || !ed.editable,
      onchange: () => { const id = addSelect.value; if (id) tryIt(() => ed.addCliffType(id)); },
    },
    h("option", { value: "", selected: true }, `Add cliff type… (${list.length}/${MAX_CLIFF_TYPES})`),
    ...[...bySet].sort(([x], [y]) => (TILESETS[x] ?? x).localeCompare(TILESETS[y] ?? y))
      .map(([ts, ids]) => h("optgroup", { label: TILESETS[ts] ?? ts }, ...ids.map((id) => h("option", { value: id }, label(id))))));
    panel.append(
      h("div.muted", {}, "The map's cliff types: a corner names one by its number in this list. The terrain editor's cliff tools pick from them. Changes are one undo step each."),
      h("div.terrain-tilemgr-row", {}, addSelect),
      ...list.map((id, i) => {
        const name = `${i}: ${label(id)}`;
        if (removingCliff === i) {
          const others = list.map((o, j) => [o, j] as const).filter(([, j]) => j !== i && j < MAX_CLIFF_TYPES);
          const sel = h("select.terrain-cliffmgr-replace", {}, ...others.map(([o, j]) => h("option", { value: String(j) }, `${j}: ${label(o)}`)));
          return h("div.terrain-tilemgr-row.removing", {},
            h("span", {}, `Remove ${label(id)}: its ${useText(i)} get`), sel,
            h("button", { onclick: () => { removingCliff = null; tryIt(() => ed.removeCliffType(i, Number(sel.value))); } }, "Remove"),
            h("button", { onclick: () => { removingCliff = null; void render(); } }, "Cancel"));
        }
        return h(`div.terrain-tilemgr-row${i >= paintable ? ".muted" : ""}`, {},
          h("span.terrain-tilemgr-name", { title: i >= paintable ? `Past ${MAX_CLIFF_TYPES - 1}: no corner can name it` : "" }, name),
          h("span.muted", { title: useText(i) }, inUse(i) ? useText(i) : "unused"),
          h("button", {
            title: locked || (inUse(i) ? "Remove from the list (its corners get another entry)" : "Remove from the list"),
            disabled: !!locked || list.length < 2,
            onclick: () => {
              if (inUse(i)) { removingCliff = i; void render(); return; }
              tryIt(() => ed.removeCliffType(i));
            },
          }, "✕"));
      }),
    );
    return panel;
  }

  // Every edit, undo and redo of the terrain editor (here or in its view) and the editors coming and going redraw it.
  const subs: { dispose(): void }[] = [deps.onEditors(() => void render())];
  void w3.services.get<TerrainService>(TERRAIN_SERVICE).then((s) => {
    const sub = s.onDidEdit((what) => { if (what.terrain) void render(); });
    if (disposed) sub.dispose(); else subs.push(sub);
  }, () => {});
  void render();
  return {
    focus: () => root.focus({ preventScroll: true }),
    // The changes are the terrain editor's edits: its undo and redo.
    undo: () => deps.editor()?.undo(),
    redo: () => deps.editor()?.redo(),
    dispose() {
      disposed = true;
      clearTimeout(retry);
      for (const s of subs) s.dispose();
    },
  };
}

/** A split terrain's terrain.json as far as the tab shows it (null: flat, or it can't be read). */
async function readLayoutFile(w3: W3Api): Promise<{ subterrains: number; defaultCorner: Record<string, unknown> | null } | null> {
  if (!w3.workspace.files().some((f) => f.path.toLowerCase() === "map/terrain/terrain.json")) return null;
  try {
    const doc = JSON.parse(await w3.workspace.readText("map/terrain/terrain.json")) as { subterrains?: unknown[]; defaultCorner?: Record<string, unknown> };
    return { subterrains: doc.subterrains?.length ?? 0, defaultCorner: doc.defaultCorner ?? null };
  } catch {
    return null;
  }
}
