// Map Size and Camera Bounds: a tab of the terrain editor (service
// "w3.terrain"). Per side, tiles to add or remove and the width of the
// unplayable border; the map shows what stays playable (clear), the border
// (shaded) and what would be cut off (red). Applying goes through the
// terrain editor host (handle.resizeMap), which rewrites the map's files and
// reopens the editor.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { TERRAIN_SERVICE, type TerrainEditorHandle, type TerrainService, type TerrainToolGroupInstance } from "../../extensions/services";
import { playableSize, resizedSize, resizeProblem, SIZE_STEP, type Sides } from "../../lib/terrain/resize";
import { h } from "../../workbench/dom";

const SIDES = ["Left", "Right", "Bottom", "Top"] as const;

export function activate(w3: W3Api, ctx: ExtensionContext) {
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
    const c = await w3.window.showWarning(
      `${grow || shrink ? `Resize the map${shrink ? " (objects in the red area are removed)" : ""}` : "Change the camera bounds"}? The map is saved first; this can't be undone with Ctrl+Z.`,
      "Apply", "Cancel");
    if (c !== "Apply") return;
    try {
      const r = await w3.window.withProgress("Changing the map size", () => ed.resizeMap([...change], [...complements]));
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
