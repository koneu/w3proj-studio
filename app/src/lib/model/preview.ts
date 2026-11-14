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

/** Models a preview keeps on its WebGL context at most, and the bytes of them (vertices and texture files, about
 *  what the GPU holds: a Reforged building's textures are 40 MB). */
const KEEP_MODELS = 8;
const KEEP_BYTES = 256 * 1024 * 1024;

/** A model on the preview's context: its renderer, the replaceable textures it was last given (as JSON), about how
 *  many bytes it holds, and its texture reads' round (a later one drops what an earlier one still brings). */
interface Kept { renderer: ModelRenderer; replaceable: string; bytes: number; round: number }

const div = (cls: string) => Object.assign(document.createElement("div"), { className: cls });

export class ModelPreview {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private note: HTMLElement;
  private renderer: ModelRenderer | null = null;
  /** The models shown lately, on this canvas's one WebGL context (newest last): going back to one reads, parses and
   *  uploads nothing. A context per model cost its creation and the shaders' compile on every change of model. */
  private kept = new Map<string, Kept>();
  private path: string | null = null;
  private props: string[] = [];
  private raf = 0;
  private started = performance.now();
  private drag: number | null = null;
  /** Bumped by every show and setPrefer: a load that finishes under an older number is dropped. */
  private token = 0;
  /** The player colour of the team colour / glow textures (TEAM_COLORS index), and the type's replaceable textures. */
  private team = 0;
  private replaceable: Record<number, string> = {};

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
    this.renewContext();
  }

  /** Drops every model kept and the WebGL context they are on (what was uploaded goes with it); the next model gets a
   *  fresh canvas, as a lost context can't be used again. */
  private renewContext() {
    this.renderer = null;
    this.kept.clear();
    this.canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    const canvas = this.newCanvas();
    this.canvas.replaceWith(canvas);
    this.canvas = canvas;
  }

  /** The player colour (TEAM_COLORS index) the team colour and glow textures show; applies at once. */
  setTeamColor(index: number) {
    this.team = index;
    this.renderer?.setTeamColor(index);
    this.publish();
  }

  /** The textures replaceable ids show (id → path; others as the game's table has them). A model shown has them
   *  re-read; the next `show` uses them. */
  setReplaceable(replaceable: Record<number, string>) {
    if (JSON.stringify(replaceable) === JSON.stringify(this.replaceable)) return;
    this.replaceable = { ...replaceable };
    const now = this.path === null ? undefined : this.kept.get(this.path);
    if (now) this.loadTextures(now);
    this.publish();
  }

  /** What the preview shows: for a hook to look at. `textures` are the paths being read for the model's textures. */
  state() {
    return { path: this.path, team: this.team, replaceable: { ...this.replaceable }, textures: this.renderer?.texturePaths(this.replaceable) ?? [], ready: !!this.renderer && this.note.textContent === "" };
  }

  /** Puts state() on the element (data-state) for tests and tools to read. */
  private publish() { this.el.dataset.state = JSON.stringify(this.state()); }

  private newCanvas(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.className = "obj-preview-canvas";
    c.addEventListener("mousedown", (e) => { this.drag = e.clientX; e.preventDefault(); });
    // The system took the context (the GPU process restarted, too many contexts): what was kept on it is gone.
    c.addEventListener("webglcontextlost", () => {
      if (this.disposed || this.canvas !== c) return;
      const path = this.path;
      this.token++;
      this.path = null;
      this.renewContext();
      if (path !== null) this.showPath(path);
    });
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
    this.showPath(mdx);
  }

  private showPath(mdx: string | null) {
    this.path = mdx;
    const token = ++this.token;
    this.renderer = null;
    const kept = mdx === null ? undefined : this.kept.get(mdx);
    if (kept) {
      // Shown lately: it is on the GPU still. Newest last; its textures are read again only if others are set now.
      this.kept.delete(mdx!);
      this.kept.set(mdx!, kept);
      this.use(kept);
      this.note.title = mdx!;
      if (kept.replaceable !== JSON.stringify(this.replaceable)) this.loadTextures(kept);
      this.publish();
      return;
    }
    this.note.textContent = mdx ? "Loading…" : "No model";
    this.note.title = mdx ?? "";
    this.publish();
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
    // Nothing is freed one by one: past KEEP_MODELS (or their bytes) the context goes with all that is on it.
    const own = model.geosets.reduce((n, g) => n + g.positions.byteLength * 4, 0);
    let bytes = own;
    for (const k of this.kept.values()) bytes += k.bytes;
    if (this.kept.size >= KEEP_MODELS || (this.kept.size && bytes > KEEP_BYTES)) this.renewContext();
    const r = new ModelRenderer(this.canvas, model);
    r.showGrid = false;
    const kept: Kept = { renderer: r, replaceable: "", bytes: own, round: 0 };
    this.kept.set(mdx, kept);
    this.use(kept);
    this.loadTextures(kept);
    this.publish();
  }

  /** Puts a model on the canvas, in the player colour set, from the start of its animation. */
  private use(kept: Kept) {
    kept.renderer.setTeamColor(this.team);
    this.renderer = kept.renderer;
    this.started = performance.now();
    this.note.textContent = "";
  }

  /** Reads the model's textures (replaceable ones as set); one that arrives after the textures were set again, or the
   *  model was replaced, is dropped. */
  private loadTextures(kept: Kept) {
    const replaceable = this.replaceable, round = ++kept.round, r = kept.renderer;
    kept.replaceable = JSON.stringify(replaceable);
    r.texturePaths(replaceable).forEach((p, i) => {
      if (!p) return;
      this.read(p).then((buf) => {
        // Still kept (its context is there), and no other textures asked for since.
        if (this.kept.get(this.keyOf(kept)) !== kept || kept.round !== round) return;
        kept.bytes += buf.byteLength;
        r.setTexture(i, decodeImage(buf, p));
      }, () => {});
    });
  }
  private keyOf(kept: Kept): string {
    for (const [path, k] of this.kept) if (k === kept) return path;
    return "";
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

  private disposed = false;

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("mousemove", this.onMove);
    window.removeEventListener("mouseup", this.onUp);
    // A load still running must not build a renderer on a canvas nobody shows.
    this.token++;
    this.renderer = null;
    this.kept.clear();
    this.canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
