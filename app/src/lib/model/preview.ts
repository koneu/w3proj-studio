// A small live model view (object editor, the Problems view's model picker): a model's Stand
// animation, turning slowly; drag to turn it. The map's imported file wins (in Reforged its
// `_HD.w3mod\` version first), else the game's: through the graphics mode, or (`prefer`) the
// Classic or the Reforged (DE, then HD) files first, whatever the graphics mode is.

import type { W3Api } from "../../extensions/api";
import { importedPath, ownNames, previewMode } from "../imports";
import { decodeImage } from "../image/index.ts";
import { parseModel } from "./mdl";
import { neverStoredLast, textureCandidates } from "./texpath";
import { ModelRenderer, standClock, type Clock } from "./renderer";
import { parseAnimProps } from "./stand";

const div = (cls: string) => Object.assign(document.createElement("div"), { className: cls });

export class ModelPreview {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private note: HTMLElement;
  private renderer: ModelRenderer | null = null;
  private path: string | null = null;
  private props: string[] = [];
  private raf = 0;
  private started = performance.now();
  private drag: number | null = null;
  /** Bumped by every show and setPrefer: a load that finishes under an older number is dropped. */
  private token = 0;

  /** `exact`: the path is a file of the map, shown as it is (an imported .mdl is MDL text, not the game's .mdx). */
  constructor(private w3: W3Api, private opts: { prefer?: "classic" | "reforged" | "de" | "hd"; exact?: boolean; onFail?: (e: unknown) => void } = {}) {
    this.canvas = this.newCanvas();
    this.note = div("obj-preview-note muted");
    this.el = div("obj-preview");
    this.el.title = "Drag to turn";
    this.el.append(this.canvas, this.note);
    window.addEventListener("mousemove", this.onMove);
    window.addEventListener("mouseup", this.onUp);
    this.raf = requestAnimationFrame(this.tick);
  }

  /** Which files win from now on (a model shown stays; the next `show` uses it). */
  setPrefer(prefer: "classic" | "reforged" | "de" | "hd") {
    if (this.opts.prefer === prefer) return;
    this.opts = { ...this.opts, prefer };
    this.token++;
    this.path = null;
    this.renderer?.dispose();
    this.renderer = null;
  }

  private newCanvas(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.className = "obj-preview-canvas";
    c.addEventListener("mousedown", (e) => { this.drag = e.clientX; e.preventDefault(); });
    return c;
  }
  private onMove = (e: MouseEvent) => {
    if (this.drag === null || !this.renderer) return;
    this.renderer.yaw -= (e.clientX - this.drag) * 0.01;
    this.drag = e.clientX;
  };
  private onUp = () => { this.drag = null; };

  /** Shows a model (data path, with or without extension; .mdl names the game's .mdx unless `exact`); null: none.
   *  `animProps` is the look to show, for a model that holds several. MDX and MDL text are told apart by content. */
  show(path: string | null, animProps = "") {
    this.props = parseAnimProps(animProps);
    const mdx = !path || path === "_" ? null : this.opts.exact ? path : path.replace(/\.mdl$/i, ".mdx").replace(/^(?!.*\.\w+$)(.*)$/, "$1.mdx");
    if (mdx === this.path) return;
    this.path = mdx;
    const token = ++this.token;
    this.renderer?.dispose();
    this.renderer = null;
    this.note.textContent = mdx ? "Loading…" : "No model";
    this.note.title = mdx ?? "";
    if (!mdx) return;
    void this.load(mdx, token).catch((e) => {
      if (this.token !== token) return;
      this.note.textContent = `Can't show ${mdx.split(/[\\/]/).pop()}: ${(e as Error).message ?? e}`;
      this.opts.onFail?.(e);
    });
  }

  /** The map's import of a path, else the game's file (Reforged .tif/.blp textures ship as .dds). In Reforged (the
   *  graphics mode set, or `prefer`) the map's Reforged version (`_HD.w3mod\…`) comes first, as the game reads it. */
  private async read(path: string): Promise<Uint8Array> {
    const variants = /\.(blp|tif|tiff|tga|png)$/i.test(path) ? textureCandidates(path) : [path];
    for (const name of ownNames(variants, previewMode(this.opts.prefer, this.w3.settings.get<string>("game.graphicsMode")))) {
      // Under its name on disk, whatever the case asked for (as the game finds it).
      const own = importedPath(this.w3, name);
      if (own !== undefined) return this.w3.workspace.readBytes(own);
    }
    let last: unknown = new Error(`${path} not found`);
    // Classic: the base folder exactly; Reforged: its DE, then HD folder; then as the game resolves it.
    const layers = this.opts.prefer === "classic" ? ["War3.w3mod:"]
      : this.opts.prefer === "hd" ? ["War3.w3mod:_HD.w3mod:", "War3.w3mod:_DE.w3mod:"]
      : this.opts.prefer === "reforged" || this.opts.prefer === "de" ? ["War3.w3mod:_DE.w3mod:", "War3.w3mod:_HD.w3mod:"] : [];
    const tries = neverStoredLast(variants.flatMap((v) => [...layers.map((l) => l + v.replace(/\\/g, "/")), v]));
    for (const v of tries) {
      try { return await this.w3.game.read(v); } catch (e) { last = e; }
    }
    throw last;
  }

  private async load(mdx: string, token: number) {
    const model = parseModel(await this.read(mdx));
    if (this.token !== token) return;
    // A fresh canvas per model: a disposed renderer's WebGL context can't be used again.
    const canvas = this.newCanvas();
    this.canvas.replaceWith(canvas);
    this.canvas = canvas;
    this.renderer?.dispose();
    const r = new ModelRenderer(canvas, model);
    r.showGrid = false;
    this.renderer = r;
    this.started = performance.now();
    this.note.textContent = "";
    r.texturePaths().forEach((p, i) => {
      if (!p) return;
      this.read(p).then((buf) => { if (this.renderer === r) r.setTexture(i, decodeImage(buf, p)); }, () => {});
    });
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    const r = this.renderer;
    // Only while shown (a hidden tab or a closed pane has no size).
    if (!r || !this.canvas.isConnected || this.canvas.clientWidth === 0) return;
    if (this.drag === null) r.yaw += 0.004;
    const stand = standClock(r.model, this.props);
    const t = now - this.started, len = Math.max(1, stand.seqEnd - stand.seqStart);
    const clock: Clock = { ...stand, frame: stand.seqStart + (t % len), time: t };
    r.render(clock);
  };

  dispose() {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("mousemove", this.onMove);
    window.removeEventListener("mouseup", this.onUp);
    // A load still running must not build a renderer on a canvas nobody shows.
    this.token++;
    this.renderer?.dispose();
    this.renderer = null;
  }
}
