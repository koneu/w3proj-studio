// Map Size and Camera Bounds: a tab of the terrain editor (service
// "w3.terrain"). Per side, tiles to add or remove and the width of the
// unplayable border; the map shows what stays playable (clear), the border
// (shaded) and what would be cut off (red). Applying goes through the
// terrain editor host (handle.resizeMap), which rewrites the map's files and
// reopens the editor. The files a resize rewrites are kept for the session
// (lib/terrain/resizeundo), so Ctrl+Z in the reopened editor, or Undo Resize,
// puts them back, and Redo Resize does it again.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { TERRAIN_SERVICE, type TerrainEditorHandle, type TerrainService, type TerrainToolGroupInstance } from "../../extensions/services";
import { playableSize, resizedSize, resizeProblem, SIZE_STEP, type Sides } from "../../lib/terrain/resize";
import { resizeHistory, resizeLoss, settleWithin, warnsAboutUnsaved, workspaceIO } from "../../lib/terrain/resizeundo";
import { h } from "../../workbench/dom";

const SIDES = ["Left", "Right", "Bottom", "Top"] as const;

/** Warnings about the map script that the resize caused, which an undo makes stale: answered as "Keep it", which does
 *  nothing. Only those that came after the resize started: one about an earlier edit is still the person's to answer. */
function withdrawScriptWarnings(shownBefore: ReadonlySet<unknown> | undefined) {
  if (!shownBefore) return;
  for (const toast of document.querySelectorAll(".toast")) {
    if (shownBefore.has(toast) || !/functions? that the map's triggers don't make/.test(toast.textContent ?? "")) continue;
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
      void w3.window.showError(`${word} Resize: ${(e as Error).message}`);
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
  void w3.services.get<TerrainService>(TERRAIN_SERVICE).then((s) => {
    ctx.subscriptions.push(s.registerToolGroup({ id: "mapsize", title: "Map Size", order: 40, create: (ed) => mapSize(w3, ed) }));
  });
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
  const changeInputs = SIDES.map((_, k) => h("input.mapsize-num", { type: "number", step: SIZE_STEP, value: 0, title: "Tiles to add (negative: remove)",
    oninput: (e: Event) => { change[k] = Math.round(Number((e.target as HTMLInputElement).value) || 0); render(); } }));
  const borderInputs = SIDES.map((_, k) => h("input.mapsize-num", { type: "number", min: 0, step: 1, value: 0, title: "Unplayable border in tiles",
    oninput: (e: Event) => { complements[k] = Math.max(0, Math.round(Number((e.target as HTMLInputElement).value) || 0)); render(); } }));
  const build = () => {
    changeInputs.forEach((i, k) => { (i as HTMLInputElement).value = String(change[k]); });
    borderInputs.forEach((i, k) => { (i as HTMLInputElement).value = String(complements[k]); });
  };
  const grid = h("div.mapsize-grid", {}, h("span"), ...SIDES.map((s) => h("b", {}, s)),
    h("span", {}, "Add / remove tiles"), ...changeInputs,
    h("span", {}, "Unplayable border"), ...borderInputs);

  /** The preview: playable (clear), border (shaded), cut off (red), per tile of the current map. */
  const render = () => {
    const [w, hgt] = resizedSize(t, change);
    const [pw, ph] = playableSize({ ...t, width: w + 1, height: hgt + 1 }, complements);
    const problem = resizeProblem(t, change, complements);
    const same = change.every((c) => c === 0) && complements.every((c, k) => c === stored[k]);
    (apply as HTMLButtonElement).disabled = !ed.editable || !!problem || same;
    info.replaceChildren(
      h("div", {}, `Now ${t.width - 1} × ${t.height - 1} tiles (playable ${t.width - 1 - stored[0] - stored[1]} × ${t.height - 1 - stored[2] - stored[3]})`),
      h("div", {}, `After ${w} × ${hgt} tiles (playable ${pw} × ${ph})`),
      problem ? h("div.mapsize-problem", {}, problem) : h("div.muted", {}, `Sizes go in steps of ${SIZE_STEP} tiles. Objects outside the new map are removed; start locations move inside.`));
    if (!active) return;
    const W = t.width - 1, H = t.height - 1;
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // Tile in the resized map's coordinates.
        const nx = x + change[0], ny = y + change[2];
        const cut = nx < 0 || ny < 0 || nx >= w || ny >= hgt;
        const border = !cut && (nx < complements[0] || nx >= w - complements[1] || ny < complements[2] || ny >= hgt - complements[3]);
        const o = (y * W + x) * 4;
        if (cut) rgba.set([220, 40, 40, 150], o);
        else if (border) rgba.set([0, 0, 0, 120], o);
      }
    }
    ed.setGroundOverlay(rgba, W, H);
  };

  const run = async () => {
    const grow = change.filter((c) => c > 0).length, shrink = change.filter((c) => c < 0).length;
    const lost = resizeLoss(t, change as Sides, ed.objects.list());
    const undoable = "Ctrl+Z in the terrain editor or Undo Resize takes it back while Studio stays open";
    const c = await w3.window.showWarning(
      lost.length
        ? `Shrink the map? This removes ${lost.join(" and ")}. The map is saved first and a checkpoint is made. ${undoable}; after a restart, restore the checkpoint.`
        : `${grow || shrink ? "Resize the map" : "Change the camera bounds"}? The map is saved first. ${undoable}.`,
      "Apply", "Cancel");
    if (c !== "Apply") return;
    try {
      // A restart forgets the kept files; what a shrink cuts off stays in a checkpoint. The checkpoint is part of the
      // progress shown: packing a big map takes a while, and nothing else says that something is happening.
      const r = await w3.window.withProgress(lost.length ? "Saving a checkpoint, then changing the map size" : "Changing the map size", async () => {
        if (lost.length) await w3.commands.execute("w3.checkpoints.create", { quiet: true }).catch((e) => { throw new Error(`Nothing changed: the checkpoint failed (${(e as Error).message ?? e}).`); });
        return ed.resizeMap([...change], [...complements]);
      });
      void w3.window.showInfo(`Map size changed${r.removed ? `; ${r.removed} object${r.removed === 1 ? "" : "s"} outside the new map removed` : ""}.`);
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
    toolbar: h("div.terrain-group-tools.mapsize", {}, grid, h("div.mapsize-side", {}, info, h("div.mapsize-buttons", {}, apply, reset))),
    activate() { active = true; render(); },
    deactivate() { active = false; ed.setGroundOverlay(null); },
    dispose() { ed.setGroundOverlay(null); },
  };
}
