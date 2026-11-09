// The minimap panel in the terrain view (the World Editor's Window > Minimap, top left of its main window): the
// map's minimap picture (made as Export Minimap makes it, from the editor's state), the part of the map the view
// shows outlined in yellow, and a click or drag that moves the camera there. A setting (terrain.minimap.panel) turns it
// on and off, for every terrain editor.

import { h } from "../../workbench/dom";

type Vec3 = [number, number, number];

/** Where the view's four corners (top left, top right, bottom right, bottom left) meet the plane at height `z`; a
 *  corner that looks above the horizon is taken `far` along its direction instead, as the World Editor draws its
 *  outline to the far edge. `ray`: the renderer's ray through a canvas point. */
export function viewOutline(ray: (px: number, py: number) => { origin: Vec3; dir: Vec3 }, width: number, height: number, z: number, far: number): [number, number][] {
  return [[0, 0], [width, 0], [width, height], [0, height]].map(([px, py]) => {
    const { origin: o, dir: d } = ray(px, py);
    const t = d[2] < -1e-6 ? (z - o[2]) / d[2] : Infinity;
    const along = t > 0 && t < far ? t : far;
    return [o[0] + d[0] * along, o[1] + d[1] * along];
  });
}

/** The panel: a square canvas of `side` CSS pixels over the view's corner. */
export class MinimapPanel {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private picture: HTMLCanvasElement | null = null;
  private outline: [number, number][] = [];
  /** Picture pixels per CSS pixel of the panel. */
  private size = 256;

  /** `moveTo`: a click or drag on the panel at a point of the picture (its pixels). */
  constructor(private side: number, moveTo: (px: number, py: number) => void) {
    this.canvas = h("canvas.terrain-minimap-canvas", { width: side, height: side }) as HTMLCanvasElement;
    this.el = h("div.terrain-minimap", { hidden: true, title: "Minimap: click or drag to move the view there" }, this.canvas);
    let dragging = false;
    const at = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect();
      moveTo(((e.clientX - r.left) / Math.max(1, r.width)) * this.size, ((e.clientY - r.top) / Math.max(1, r.height)) * this.size);
    };
    this.canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      this.canvas.setPointerCapture?.(e.pointerId);
      at(e);
    });
    this.canvas.addEventListener("pointermove", (e) => { if (dragging) at(e); });
    const end = (e: PointerEvent) => { dragging = false; this.canvas.releasePointerCapture?.(e.pointerId); };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
    // The view's own wheel and context menu stay off the panel.
    this.canvas.addEventListener("wheel", (e) => e.stopPropagation());
    this.canvas.addEventListener("contextmenu", (e) => { e.preventDefault(); e.stopPropagation(); });
  }

  get shown() { return !this.el.hidden; }
  set shown(on: boolean) { this.el.hidden = !on; if (on) this.draw(); }

  /** The minimap picture (RGBA rows from the top, `size` square). */
  setPicture(rgba: Uint8ClampedArray, size: number) {
    const c = this.picture ?? (h("canvas") as HTMLCanvasElement);
    c.width = c.height = size;
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba), size, size), 0, 0);
    this.picture = c;
    this.size = size;
    this.draw();
  }

  /** The view's outline, in picture pixels. Drawn only when it moved. */
  setOutline(points: [number, number][]) {
    const same = points.length === this.outline.length && points.every((p, i) => Math.abs(p[0] - this.outline[i][0]) < 0.25 && Math.abs(p[1] - this.outline[i][1]) < 0.25);
    if (same) return;
    this.outline = points;
    this.draw();
  }

  /** What the panel shows now, for tests: the outline in picture pixels and whether a picture is in. */
  state() { return { shown: this.shown, picture: !!this.picture, size: this.size, outline: this.outline.map((p) => [...p] as [number, number]) }; }

  private draw() {
    if (!this.shown) return;
    const g = this.canvas.getContext("2d")!, k = this.side / this.size;
    g.fillStyle = "#000";
    g.fillRect(0, 0, this.side, this.side);
    if (this.picture) g.drawImage(this.picture, 0, 0, this.side, this.side);
    if (this.outline.length) {
      g.save();
      g.beginPath();
      g.rect(0, 0, this.side, this.side);
      g.clip();
      g.strokeStyle = "#ffe14d";
      g.lineWidth = 1.5;
      g.beginPath();
      this.outline.forEach(([x, y], i) => (i ? g.lineTo(x * k, y * k) : g.moveTo(x * k, y * k)));
      g.closePath();
      g.stroke();
      g.restore();
    }
  }
}
