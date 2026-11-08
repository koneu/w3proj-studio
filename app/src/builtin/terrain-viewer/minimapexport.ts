// Export Minimap: a picture of the map as the minimap draws it, as a PNG file anywhere on disk, with the World
// Editor's options (WESTRING_EXPORTMINIMAP_*, MINIMAPOPT_*): what it includes (terrain, water, the pathing map,
// doodads, units, regions, preview icons), the playable area or the whole map, the image size and smoothing. It is
// made from the terrain editor's state as it is now, unsaved edits included (regions: as saved).

import type { W3Api } from "../../extensions/api";
import { encodePng } from "../../lib/image/png";
import { TEAM_COLORS } from "../../lib/model/renderer";
import { NO_BUILD, NO_WALK, NO_WATER } from "../../lib/terrain/pathing";
import { startColor } from "../../lib/terrain/minimapicons";
import type { Terrain } from "../../lib/terrain/w3e";
import { h } from "../../workbench/dom";
import { renderMinimap, type MinimapInput, type Rgb } from "./minimap";
import type { Placed } from "./objects";

export interface ExportOptions {
  terrain: boolean;
  water: boolean;
  pathing: boolean;
  doodads: boolean;
  units: boolean;
  regions: boolean;
  icons: boolean;
  /** Only the playable area (else the whole map, its border too). */
  playableOnly: boolean;
  /** Side of the square picture in pixels. */
  size: number;
  smooth: boolean;
}

export const EXPORT_SIZES = [128, 256, 512, 1024, 2048];
export const DEFAULT_EXPORT: ExportOptions = { terrain: true, water: true, pathing: false, doodads: true, units: true, regions: false, icons: true, playableOnly: true, size: 256, smooth: true };

/** What the picture is made of, from the open terrain editor. */
export interface ExportSource {
  /** The margins, the ground's and water's colours, the doodads with a minimap colour (minimapgen's minimapBase). */
  base: Omit<MinimapInput, "params">;
  terrain: Terrain;
  units: Placed[];
  /** The pathing map as generated (cells over the whole map, rows from the south). */
  pathing(): Promise<{ cells: Uint8Array; width: number; height: number }>;
  regions(): Promise<{ left: number; bottom: number; right: number; top: number; color?: { red: number; green: number; blue: number } }[]>;
  /** Which icon a unit gets: 0 gold mine, 1 neutral building, null none (start locations by their id). */
  iconKind(): Promise<(u: { id: string; player?: number }) => 0 | 1 | null>;
  /** The icon pictures (WorldEditData's MinimapIconGold, …NeutralBuilding, …StartLoc), null when unreadable. */
  iconImage(type: 0 | 1 | 2): Promise<{ width: number; height: number; rgba: Uint8Array } | null>;
  /** The look of the minimap (settings terrain.minimap.*). */
  params: MinimapInput["params"];
}

/** The pathing map's colours: unwalkable ground red, deep water blue, shallow water light blue, unbuildable yellow. */
export function pathingOverlay(cells: Uint8Array): Uint8Array {
  const rgba = new Uint8Array(cells.length * 4);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (c & NO_WALK) rgba.set(c & NO_WATER ? [230, 30, 30, 170] : [30, 90, 240, 170], i * 4);
    else if (!(c & NO_WATER)) rgba.set([60, 150, 255, 110], i * 4);
    else if (c & NO_BUILD) rgba.set([230, 200, 40, 110], i * 4);
  }
  return rgba;
}

const NEUTRAL_RGB: Rgb = [46, 45, 46];
const ownerRgb = (player: number | undefined): Rgb => (player !== undefined && player < TEAM_COLORS.length ? TEAM_COLORS[player][1] as Rgb : NEUTRAL_RGB);

/** The picture's pixels (RGBA, rows from the top) with these options. */
export async function exportPicture(src: ExportSource, o: ExportOptions): Promise<Uint8ClampedArray> {
  const input: MinimapInput = {
    ...src.base,
    objects: o.doodads ? src.base.objects : [],
    params: { ...src.params, ...(o.smooth ? {} : { blurPasses: 0 }) },
    size: o.size,
    show: { terrain: o.terrain, water: o.water },
    wholeMap: !o.playableOnly,
  };
  if (o.pathing) {
    const p = await src.pathing();
    input.overlay = { rgba: pathingOverlay(p.cells), width: p.width, height: p.height };
  }
  if (o.units) input.units = src.units.filter((u) => u.id !== "sloc").map((u) => ({ x: u.position[0], y: u.position[1], rgb: ownerRgb(u.player) }));
  if (o.regions) {
    input.regions = (await src.regions()).map((r) => ({ left: r.left, bottom: r.bottom, right: r.right, top: r.top, rgb: r.color ? [r.color.red, r.color.green, r.color.blue] as Rgb : [255, 255, 255] }));
  }
  if (o.icons) {
    const kindOf = await src.iconKind();
    const images = await Promise.all(([0, 1, 2] as const).map((t) => src.iconImage(t)));
    input.icons = src.units.flatMap((u) => {
      const type = u.id === "sloc" ? 2 : kindOf(u);
      const image = type === null ? null : images[type];
      if (!image) return [];
      const c = type === 2 ? startColor(u.player ?? 0) : null;
      return [{ x: u.position[0], y: u.position[1], image, tint: c ? [c.red, c.green, c.blue] as Rgb : undefined }];
    });
  }
  return renderMinimap(input);
}

/** Asks for the options (starting from `last`); null when cancelled. */
export function askExportOptions(last: ExportOptions): Promise<ExportOptions | null> {
  return new Promise((resolve) => {
    const box = (key: keyof ExportOptions, label: string) => {
      const input = h("input", { type: "checkbox", checked: last[key] === true, "data-option": key });
      return { key, input, el: h("label.minimap-opt", {}, input, ` ${label}`) };
    };
    const boxes = [box("terrain", "Include terrain"), box("water", "Include water"), box("pathing", "Include pathing map"), box("doodads", "Include doodads"),
      box("units", "Include units"), box("regions", "Include regions"), box("icons", "Include preview icons"), box("playableOnly", "Playable area only")];
    const size = h("select.minimap-size", {}, ...EXPORT_SIZES.map((s) => h("option", { value: String(s), selected: s === last.size }, `${s} × ${s}`)));
    const smooth = h("input.minimap-smooth", { type: "checkbox", checked: last.smooth });
    const close = (v: ExportOptions | null) => { overlay.remove(); resolve(v); };
    const ok = () => {
      const o = { ...last, size: Number(size.value), smooth: smooth.checked } as ExportOptions;
      for (const b of boxes) (o as unknown as Record<string, unknown>)[b.key] = b.input.checked;
      close(o);
    };
    const overlay = h("div.picker-overlay.newmap-overlay.minimap-export-overlay", {
      tabindex: -1,
      onmousedown: (e: MouseEvent) => { if (e.target === overlay) close(null); },
      onkeydown: (e: KeyboardEvent) => { if (e.key === "Escape") close(null); if (e.key === "Enter") ok(); },
    }, h("div.picker.newmap-dialog.minimap-export-dialog", {},
      h("div.picker-header", {}, h("strong", {}, "Export Minimap"), h("button.icon-button", { title: "Close (Esc)", onclick: () => close(null) }, "×")),
      h("div.minimap-opts", {}, ...boxes.map((b) => b.el)),
      h("label.newmap-row", {}, h("span.newmap-label", {}, "Image size"), size),
      h("label.newmap-row", {}, h("span.newmap-label", {}, "Smoothing"), smooth),
      h("div.newmap-buttons", {}, h("button", { onclick: () => close(null) }, "Cancel"), h("button.primary", { onclick: ok }, "Export…"))));
    document.body.append(overlay);
    overlay.focus();
  });
}

/** What was chosen last (this session). */
let lastOptions: ExportOptions = { ...DEFAULT_EXPORT };

/** Asks for the options (unless `given`) and a file, and writes the picture there; returns the path, null when
 *  cancelled. `source` is asked for after the options, so the picture has the edits made up to then. */
export async function exportMinimap(w3: W3Api, source: () => Promise<ExportSource>, given?: Partial<ExportOptions>): Promise<string | null> {
  const project = w3.workspace.project();
  if (!project) throw new Error("Open or import a project first.");
  const options = given ? { ...DEFAULT_EXPORT, ...given } : await askExportOptions(lastOptions);
  if (!options) return null;
  if (!given) lastOptions = options;
  const size = Math.round(options.size);
  if (!(size >= 16 && size <= 4096)) throw new Error(`The image size ${options.size} isn't between 16 and 4096 pixels.`);
  const target = await w3.window.pickSaveFile({ title: "Export Minimap", defaultPath: `${project.name} minimap.png`, filters: [{ name: "PNG image", extensions: ["png"] }] });
  if (!target) return null;
  const src = await source();
  const rgba = await exportPicture(src, { ...options, size });
  const png = await encodePng(size, size, rgba);
  // The dialogs wait for the person: the picture is of the project it was asked for, or none.
  if (w3.workspace.project()?.root !== project.root) throw new Error("Another project was opened meanwhile; the minimap wasn't exported.");
  const path = /\.png$/i.test(target) ? target : `${target}.png`;
  await w3.backend.writeBytes(path, png);
  void w3.window.showInfo(`Minimap (${size}×${size}) exported to ${path}`);
  return path;
}
