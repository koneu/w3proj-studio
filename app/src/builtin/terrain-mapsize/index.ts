// Map Size and Camera Bounds: a tab of the terrain editor (service
// "w3.terrain"). Per side, tiles to add or remove and the width of the
// unplayable border; the map shows what stays playable (clear), the border
// (shaded) and what would be cut off (red). Applying goes through the
// terrain editor host (handle.resizeMap), which rewrites the map's files and
// reopens the editor. The files a resize rewrites are kept for the session
// (lib/terrain/resizeundo), so Ctrl+Z in the reopened editor, or Undo Resize,
// puts them back, and Redo Resize does it again.

import type { EditorInstance, ExtensionContext, W3Api } from "../../extensions/api";
import { TERRAIN_SERVICE, type TerrainEditorHandle, type TerrainService, type TerrainToolGroupInstance } from "../../extensions/services";
import { COORD_LIMIT, playableSize, resizedSize, resizeProblem, SIZE_STEP, type Sides } from "../../lib/terrain/resize";
import { resizeHistory, resizeLoss, settleWithin, warnsAboutUnsaved, workspaceIO } from "../../lib/terrain/resizeundo";
import { h } from "../../workbench/dom";
import { errorText } from "../../lib/oserror";
import { KEPT_SCRIPT_WORDS } from "../../lib/script/guard";
import { checkpointOrStop } from "../../lib/checkpoint";

const SIDES = ["Left", "Right", "Bottom", "Top"] as const;

/** Warnings about the map script that the resize caused, which an undo makes stale: answered as "Keep it", which does
 *  nothing. Only those that came after the resize started: one about an earlier edit is still the person's to answer. */
function withdrawScriptWarnings(shownBefore: ReadonlySet<unknown> | undefined) {
  if (!shownBefore) return;
  for (const toast of document.querySelectorAll(".toast")) {
    if (shownBefore.has(toast) || !(toast.textContent ?? "").includes(KEPT_SCRIPT_WORDS)) continue;
    for (const b of toast.querySelectorAll("button")) if (b.textContent === "Keep it") { (b as HTMLButtonElement).click(); break; }
  }
}

/** Undo or redo the last map resize: the kept files are written back and the editor opens again on them.
 *  It runs after every resize, undo and redo before it (one lock), and after the derived files
 *  (pathing, shadows, minimap, script) of the last edit are written, which would land on the old files otherwise. */
function stepResize(w3: W3Api, which: "undo" | "redo", quiet: boolean): () => Promise<boolean> {
  const word = which === "undo" ? "Undo" : "Redo";
  return () => resizeHistory.exclusive(async () => {
    const project = w3.workspace.project();
    if (!project) return false;
    // Work still due from the last edit belongs to the files as they are now.
    try {
      await settleWithin(() => w3.commands.execute("w3.terrain.settle"), 5 * 60_000);
    } catch (e) {
      void w3.window.showError(`${word} Resize: ${errorText(e)}`);
      return false;
    }
    await w3.commands.execute("w3.script.settle").catch(() => {});
    const next = which === "undo" ? resizeHistory.nextUndo(project.root) : resizeHistory.nextRedo(project.root);
    if (!next) {
      if (!quiet) void w3.window.showInfo(`There is no map resize to ${which}.`);
      return false;
    }
    const unsaved = w3.editors.unsavedPaths();
    if (unsaved.length) {
      // Ctrl+Z in an editor with changes of its own: those are for the editor, not a message.
      if (warnsAboutUnsaved(unsaved, next.editor, quiet)) void w3.window.showWarning(`${word} Resize: save or discard the changes in ${unsaved.join(", ")} first; the resize's files would replace them.`);
      return false;
    }
    try {
      const ask = async (changed: string[]) =>
        (await w3.window.showWarning(`${word} the map resize? ${changed.length} file${changed.length === 1 ? " has" : "s have"} changed since (${changed.slice(0, 4).join(", ")}${changed.length > 4 ? ", …" : ""}); those changes are lost.`, `${word} anyway`, "Cancel")) === `${word} anyway`;
      const done = await resizeHistory[which](workspaceIO(w3.workspace), project.root, ask);
      if (!done) return false;
      await w3.workspace.refresh();
      await w3.editors.close(done.editor);
      // What was still due was for the terrain that was just replaced.
      await w3.commands.execute("w3.terrain.dropRebuild").catch(() => {});
      await w3.commands.execute("w3.script.settle").catch(() => {});
      withdrawScriptWarnings(done.shownBefore);
      await w3.editors.open(done.editor, "w3.terrainViewer");
      void w3.window.showInfo(`Map resize ${which === "undo" ? "undone" : "redone"}.`);
      return true;
    } catch (e) {
      void w3.window.showError(`${word} Resize: ${(e as Error).message ?? e}`);
      return false;
    }
  });
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  // The terrain editor's Ctrl+Z / Ctrl+Shift+Z go on to these (quiet) when it has nothing of its own to undo or redo.
  const undo = stepResize(w3, "undo", false), redo = stepResize(w3, "redo", false);
  const undoQuiet = stepResize(w3, "undo", true), redoQuiet = stepResize(w3, "redo", true);
  ctx.subscriptions.push(
    w3.commands.register("w3.terrainMapSize.undo", (opts?: { quiet?: boolean }) => (opts?.quiet ? undoQuiet() : undo())),
    w3.commands.register("w3.terrainMapSize.redo", (opts?: { quiet?: boolean }) => (opts?.quiet ? redoQuiet() : redo())),
  );
  // A hidden tool group only tells which terrain editors are open (the tab works on the project's own); no viewer tab.
  void w3.services.get<TerrainService>(TERRAIN_SERVICE).then((s) => {
    ctx.subscriptions.push(s.registerToolGroup({ id: "mapsize", title: "Map Size", order: 40, hidden: true, create: (ed) => {
      editors.add(ed); for (const f of editorsChanged) f();
      return { toolbar: h("div"), dispose() { editors.delete(ed); for (const f of editorsChanged) f(); } };
    } }));
  });
  const projectEditor = () => {
    const path = w3.workspace.files().map((f) => f.path).find((p) => /(^|\/)war3map\.w3e(\.txt)?$/i.test(p) || /(^|\/)terrain\.json$/i.test(p));
    const all = [...editors].reverse();
    return all.find((e) => e.path === path) ?? all[0] ?? null;
  };
  const openEditor = async () => {
    if (!projectEditor()) await w3.commands.execute("w3.terrain.open");
    for (let i = 0; i < 100 && !projectEditor(); i++) await new Promise((r) => setTimeout(r, 50));
  };
  ctx.subscriptions.push(
    w3.editors.registerProvider(MAPSIZE_EDITOR, { resolve: (el) => mapSizeTab(w3, el, projectEditor, openEditor) }),
    w3.commands.register("w3.terrainMapSize.edit", async () => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      await openEditor();
      await w3.editors.open(MAPSIZE_DOC, MAPSIZE_EDITOR);
    }),
  );
}

export const MAPSIZE_DOC = "w3:terrain-mapsize";
export const MAPSIZE_EDITOR = "w3.terrainMapSize";
const editors = new Set<TerrainEditorHandle>();
const editorsChanged = new Set<() => void>();

/** The Map Size tab: the panel for the project's open terrain editor, made again when that editor is replaced (a resize
 *  reopens it). */
function mapSizeTab(w3: W3Api, el: HTMLElement, editor: () => TerrainEditorHandle | null, openEditor: () => Promise<void>): EditorInstance {
  const root = h("div.mapsize-tab", { tabindex: "-1" });
  el.append(root);
  let current: { ed: TerrainEditorHandle; panel: TerrainToolGroupInstance } | null = null;
  const sync = () => {
    const ed = editor();
    if (ed === current?.ed) return;
    current?.panel.dispose?.();
    current = null;
    if (!ed) {
      root.replaceChildren(h("div.terrain-settings-empty", {},
        h("h2", {}, "Map Size and Camera Bounds"),
        h("p.muted", {}, "The map size is the terrain's: open the terrain editor to change it here."),
        h("button", { onclick: () => void openEditor().then(sync, (e) => w3.window.showError(String((e as Error).message ?? e))) }, "Open the terrain editor")));
      return;
    }
    const panel = mapSize(w3, ed);
    panel.activate?.();
    current = { ed, panel };
    root.replaceChildren(h("h2", {}, "Map Size and Camera Bounds"), panel.toolbar);
  };
  editorsChanged.add(sync);
  sync();
  return { dispose() { editorsChanged.delete(sync); current?.panel.dispose?.(); current = null; } };
}

function mapSize(w3: W3Api, ed: TerrainEditorHandle): TerrainToolGroupInstance {
  const t = ed.terrain;
  let change: Sides = [0, 0, 0, 0];
  let complements: Sides = [0, 0, 0, 0];
  let stored: Sides = [0, 0, 0, 0];
  let active = false;

  const info = h("div.mapsize-info");
  const apply = h("button.primary", { disabled: true, onclick: () => void run() }, "Apply");
  const reset = h("button", { onclick: () => { change = [0, 0, 0, 0]; complements = [...stored]; build(); render(); } }, "Reset");
  // Taken as typed (an empty box is 0): a value that isn't a whole number, or a border below 0, is refused with a word
  // and Apply stays off (sidesProblem), never rounded or clamped.
  const typed = (e: Event) => { const v = (e.target as HTMLInputElement).value; return v.trim() === "" ? 0 : Number(v); };
  const changeInputs = SIDES.map((_, k) => h("input.mapsize-num", { type: "number", step: SIZE_STEP, value: 0, title: "Tiles to add (negative: remove)",
    oninput: (e: Event) => { change[k] = typed(e); render(); } }));
  const borderInputs = SIDES.map((_, k) => h("input.mapsize-num", { type: "number", min: 0, step: 1, value: 0, title: "Unplayable border in tiles",
    oninput: (e: Event) => { complements[k] = typed(e); render(); } }));
  const build = () => {
    changeInputs.forEach((i, k) => { (i as HTMLInputElement).value = String(change[k]); });
    borderInputs.forEach((i, k) => { (i as HTMLInputElement).value = String(complements[k]); });
  };
  const canvas = h("canvas.mapsize-preview", { title: "Playable (light), unplayable border (dark), cut off (red), added (green)" }) as HTMLCanvasElement;
  const grid = h("div.mapsize-grid", {}, h("span"), ...SIDES.map((s) => h("b", {}, s)),
    h("span", {}, "Add / remove tiles"), ...changeInputs,
    h("span", {}, "Unplayable border"), ...borderInputs);

  /** The preview: playable (clear), border (shaded), cut off (red), per tile of the current map. */
  const render = () => {
    const ch = change, co = complements;
    const [w, hgt] = resizedSize(t, ch);
    const [pw, ph] = playableSize({ ...t, width: w + 1, height: hgt + 1 }, co);
    // Growth past the coordinate limit is refused here too (resizeProblem), with Apply off.
    const problem = resizeProblem(t, ch, co);
    const same = change.every((c) => c === 0) && complements.every((c, k) => c === stored[k]);
    (apply as HTMLButtonElement).disabled = !ed.editable || !!problem || same;
    info.replaceChildren(
      h("div", {}, `Now ${t.width - 1} × ${t.height - 1} tiles (playable ${t.width - 1 - stored[0] - stored[1]} × ${t.height - 1 - stored[2] - stored[3]})`),
      h("div", {}, `After ${w} × ${hgt} tiles (playable ${pw} × ${ph})`),
      problem ? h("div.mapsize-problem", {}, problem) : h("div.muted", {}, `The whole map's size is a multiple of ${SIZE_STEP} tiles. New ground copies the edge beside it. Doodads on or past the new edge, and units and items not in the playable area, are removed; start locations off the map move inside. No edge goes past ±${COORD_LIMIT}.`));
    drawPreview(canvas, t, ch, co, w, hgt);
    if (!active) return;
    const W = t.width - 1, H = t.height - 1;
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // Tile in the resized map's coordinates.
        const nx = x + ch[0], ny = y + ch[2];
        const cut = nx < 0 || ny < 0 || nx >= w || ny >= hgt;
        const border = !cut && (nx < co[0] || nx >= w - co[1] || ny < co[2] || ny >= hgt - co[3]);
        const o = (y * W + x) * 4;
        if (cut) rgba.set([220, 40, 40, 150], o);
        else if (border) rgba.set([0, 0, 0, 120], o);
      }
    }
    ed.setGroundOverlay(rgba, W, H);
  };

  const run = async () => {
    // What is asked about is what is applied, whatever is typed in the meantime.
    const ch: Sides = [...change], co: Sides = [...complements];
    const grow = ch.filter((c) => c > 0).length, shrink = ch.filter((c) => c < 0).length;
    const removed = await ed.resizeRemovals(ch, co).catch((e: unknown) => { void w3.window.showError(`Map size: ${(e as Error).message ?? e}`); return null; });
    if (removed === null) return;
    const lost = resizeLoss(t, ch, removed);
    const undoable = "Ctrl+Z in the terrain editor or Undo Resize takes it back while Studio stays open";
    const c = await w3.window.showWarning(
      lost.length
        ? `${shrink ? "Shrink the map" : grow ? "Resize the map" : "Change the camera bounds"}? This removes ${lost.join(" and ")}. The map is saved first and a checkpoint is made (where checkpoints are on). ${undoable}; after a restart, restore the checkpoint.`
        : `${grow || shrink ? "Resize the map" : "Change the camera bounds"}? The map is saved first. ${undoable}.`,
      "Apply", "Cancel");
    if (c !== "Apply") return;
    try {
      // A restart forgets the kept files; what a shrink cuts off stays in a checkpoint. The checkpoint is part of the
      // progress shown: packing a big map takes a while, and nothing else says that something is happening.
      const r = await w3.window.withProgress(lost.length ? "Saving a checkpoint, then changing the map size" : "Changing the map size", async () => {
        // Without the Checkpoints extension it goes on, warned once a session, like the other checkpoint users.
        if (lost.length) await checkpointOrStop(w3, shrink ? "Shrinking the map" : "Resizing the map");
        return ed.resizeMap(ch, co);
      });
      void w3.window.showInfo(`Map size changed${r.removed ? `; ${r.removed} object${r.removed === 1 ? "" : "s"} removed` : ""}.`);
    } catch (e) {
      void w3.window.showError(`Map size: ${(e as Error).message ?? e}`);
    }
  };

  build();
  render();
  // The border as stored in war3map.w3i (JSON, else decoded).
  void (async () => {
    const root = w3.workspace.project()?.root;
    const text = await w3.workspace.readText("map/war3map.w3i.json").catch(() => root ? w3.backend.invoke<string>("codec_decode", { root, path: "map/war3map.w3i" }) : null);
    const c = text ? (JSON.parse(text).cameraComplements as number[] | undefined) : undefined;
    if (c?.length === 4) { stored = [c[0], c[1], c[2], c[3]]; complements = [...stored]; build(); render(); }
  })().catch(() => {});

  return {
    toolbar: h("div.terrain-group-tools.mapsize", {}, grid, h("div.mapsize-side", {}, info, h("div.mapsize-buttons", {}, apply, reset)), canvas),
    activate() { active = true; render(); },
    deactivate() { active = false; ed.setGroundOverlay(null); },
    dispose() { ed.setGroundOverlay(null); },
  };
}

/** The preview as a picture, north up: the resized map over the current one. */
function drawPreview(canvas: HTMLCanvasElement, t: TerrainEditorHandle["terrain"], ch: Sides, co: Sides, w: number, hgt: number) {
  const W = t.width - 1, H = t.height - 1;
  // Typed sides that aren't whole numbers have no picture (the refusal in the panel says why); a fractional size would index past the image.
  if (!ch.every(Number.isInteger) || !Number.isFinite(w) || !Number.isFinite(hgt) || w <= 0 || hgt <= 0 || w * hgt > 1_000_000) { canvas.width = canvas.height = 0; return; }
  const x0 = Math.min(0, ch[0]), x1 = Math.max(w, ch[0] + W), y0 = Math.min(0, ch[2]), y1 = Math.max(hgt, ch[2] + H);
  const cw = x1 - x0, chh = y1 - y0;
  if (cw * chh > 1_000_000) { canvas.width = canvas.height = 0; return; }
  canvas.width = cw; canvas.height = chh;
  const scale = Math.max(1, Math.floor(320 / Math.max(cw, chh)));
  canvas.style.width = `${cw * scale}px`; canvas.style.height = `${chh * scale}px`;
  const c = canvas.getContext("2d");
  if (!c) return;
  const img = c.createImageData(cw, chh);
  for (let ny = y0; ny < y1; ny++) {
    for (let nx = x0; nx < x1; nx++) {
      const inNew = nx >= 0 && ny >= 0 && nx < w && ny < hgt;
      const inOld = nx >= ch[0] && ny >= ch[2] && nx < ch[0] + W && ny < ch[2] + H;
      const border = inNew && (nx < co[0] || nx >= w - co[1] || ny < co[2] || ny >= hgt - co[3]);
      const rgb = !inNew ? [220, 40, 40] : !inOld ? [60, 170, 80] : border ? [60, 60, 60] : [200, 200, 200];
      const o = ((chh - 1 - (ny - y0)) * cw + (nx - x0)) * 4;
      img.data.set([rgb[0], rgb[1], rgb[2], inNew || inOld ? 255 : 0], o);
    }
  }
  c.putImageData(img, 0, 0);
}
