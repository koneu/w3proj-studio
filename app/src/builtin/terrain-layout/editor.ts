// The Terrain Layout editor (a tab, "Edit Terrain Layout"): the subterrains as rectangles over a picture of the map's
// ground, drawn, resized, renamed, joined and deleted with the mouse as a draft (lib/terrain/layoutdraft.ts), with a
// live preview of what Apply would do (the backend's terrain_relayout_preview: files, objects that change subterrain,
// its refusal in its own words); Apply writes the draft through the backend's relayout in one step, which Undo takes
// back as one step. A flat project gets Split Terrain with a grid of cuts to drag instead. Pan and zoom as in the
// terrain viewer: the wheel zooms at the pointer, the middle (or right) button held pans, the arrow keys pan (Shift:
// faster), Ctrl+Up and Ctrl+Down zoom.

import type { EditorInstance, W3Api } from "../../extensions/api";
import { keyOf } from "../../lib/keys";
import { errorText } from "../../lib/oserror";
import { addSub, cellAt, cutAt, deleteSub, describe, dragHandle, dragRect, draftOf, evenCuts, freeName, gridRects, handleAt, joinSubs, moveCut, normalGrid, planOf, renameSub, resizeSub, unchanged, type Draft, type Handle, type SplitGrid } from "../../lib/terrain/layoutdraft";
import type { PlannedSubterrain, SubRect } from "../../lib/terrain/subterrainplan";
import { h } from "../../workbench/dom";

/** The editor's document. */
export const LAYOUT_DOC = "w3:terrain-layout";

/** A subterrain as the layout on disk has it. */
export interface LayoutSub extends SubRect { open: boolean; halo: boolean; idRanges: [number, number][]; bytes: number }

/** The layout on disk (index.ts readLayoutState). */
export interface LayoutState { layout: "flat" | "split"; canvas: [number, number]; subterrains: LayoutSub[]; partial: boolean; error: string | null }

/** What a change would do (the backend's Preview). */
export interface LayoutPreview {
  written: string[];
  removed: string[];
  subterrains: { name: string; folder: string; x: number; y: number; w: number; h: number; idRanges: [number, number][]; from: string[]; doodads: number; units: number; regions: number }[];
  moves: { kind: string; from: string; to: string; count: number }[];
}

/** The picture under the rectangles: RGBA, one pixel per corner, rows from the north. */
export interface LayoutPicture { width: number; height: number; rgba: Uint8ClampedArray }

/** What the editor asks of the extension (index.ts): the backend's commands through the Subterrains commands' code. */
export interface LayoutOps {
  readState(): Promise<LayoutState>;
  picture(): Promise<LayoutPicture | null>;
  preview(plan: PlannedSubterrain[]): Promise<LayoutPreview>;
  /** What Split Terrain into `rects` would do; none: one subterrain main over the canvas. */
  previewSplit(rects: SubRect[]): Promise<LayoutPreview>;
  /** Applies the plan; the number to take it back with. */
  apply(plan: PlannedSubterrain[]): Promise<number>;
  /** Takes an applied change back (`redo`: makes it again). */
  undo(id: number, redo: boolean): Promise<void>;
  /** Split Terrain into `rects`; none: one subterrain main over the canvas. */
  split(rects: SubRect[]): Promise<void>;
  merge(): Promise<void>;
  seams(): Promise<{ x: number; y: number; error: boolean; text: string }[]>;
}

/** What the editor shows, for the MCP tool get_subterrains and app-smoke. */
export interface LayoutEditorState {
  mode: "flat" | "split";
  tool: "select" | "draw";
  selected: string[];
  draft: (SubRect & { from: string[] })[];
  pending: boolean;
  changes: string[];
  preview: LayoutPreview | null;
  refusal: string | null;
  grid: { xs: number[]; ys: number[] } | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Where corner (x, y) is on the page: left + width / 2 + (x − cx) · scale, top + height / 2 − (y − cy) · scale. */
  view: { scale: number; cx: number; cy: number; left: number; top: number; width: number; height: number };
}

/** An undo step: a draft change, an applied change (its backend number), a grid change, or a split. */
type Step =
  | { kind: "draft"; before: Draft; after: Draft }
  | { kind: "apply"; id: number; label: string }
  | { kind: "grid"; before: SplitGrid; after: SplitGrid }
  | { kind: "split"; rects: SubRect[] };

/** What Split Terrain gets for a grid: its rectangles, none without a cut (one subterrain main, as the command's first choice). */
const splitArg = (g: SplitGrid): SubRect[] => (g.xs.length || g.ys.length ? gridRects(g) : []);

/** Fills of the rectangles, by place in the list. */
const FILLS = ["#4fc3f7", "#ffb74d", "#aed581", "#f06292", "#ba68c8", "#4db6ac", "#fff176", "#90a4ae"];

export function layoutEditor(w3: W3Api, el: HTMLElement, ops: LayoutOps, onState: (s: LayoutEditorState | null) => void): EditorInstance {
  const root = w3.workspace.project()?.root ?? null;
  let state: LayoutState | null = null;
  let draft: Draft | null = null;
  let grid: SplitGrid | null = null;
  let tool: "select" | "draw" = "select";
  let selected: string[] = [];
  const history: Step[] = [], future: Step[] = [];
  let preview: LayoutPreview | null = null, refusal: string | null = null, previewSeq = 0;
  let seamMarks: { x: number; y: number; error: boolean; text: string }[] = [];
  let showSeams = false;
  let busy = false, disposed = false, staleOnDisk = false;
  let picture: HTMLCanvasElement | null = null;
  /** Corners per pixel the other way round: pixels per corner, and the corner at the stage's centre. */
  const view = { scale: 4, cx: 0, cy: 0, fitted: false };

  const canvas = h("canvas.layout-canvas");
  const stage = h("div.layout-stage", { tabindex: "0", title: "Draw: drag a rectangle. Select: click a subterrain, drag its sides or corners, drag inside to move it. Wheel zooms, middle or right button pans." }, canvas);
  const toolbar = h("div.layout-toolbar");
  const side = h("div.layout-side");
  const status = h("div.layout-status.muted");
  const top = h("div.layout-editor", {}, toolbar, h("div.layout-body", {}, stage, side), status);
  el.append(top);
  const ctx = canvas.getContext("2d");

  const warn = (m: string) => void w3.window.showWarning(m);
  /** Whether there is something to apply: a split project's draft differing from disk; a flat project always offers
   *  Split Terrain (no cuts: one subterrain main). */
  const pending = () => (state?.layout === "split" ? !!draft && !unchanged(draft, state.subterrains) : !!grid);

  const snapshot = (): LayoutEditorState => ({
    mode: state?.layout ?? "flat",
    tool,
    selected: [...selected],
    draft: draft?.subs.map((s) => ({ ...s, from: [...s.from] })) ?? [],
    pending: pending(),
    changes: state?.layout === "split" && draft ? describe(draft, state.subterrains) : grid ? gridRects(grid).map((r) => `Split: ${r.name}, ${r.w}×${r.h} at ${r.x},${r.y}`) : [],
    preview,
    refusal,
    grid: grid ? { xs: [...grid.xs], ys: [...grid.ys] } : null,
    canUndo: history.length > 0,
    canRedo: future.length > 0,
    view: (() => { const b = stage.getBoundingClientRect(); return { scale: view.scale, cx: view.cx, cy: view.cy, left: b.left, top: b.top, width: b.width, height: b.height }; })(),
  });

  // ---- reading the layout ----

  /** Reads the layout on disk again: the draft starts over from it. */
  async function load() {
    const was = root;
    let s: LayoutState, pic: LayoutPicture | null;
    try {
      [s, pic] = await Promise.all([ops.readState(), ops.picture().catch(() => null)]);
    } catch (e) {
      if (disposed) return;
      top.replaceChildren(h("div.editor-error", {}, `Can't read the terrain's layout: ${errorText(e)}`));
      onState(null);
      return;
    }
    // Another project or the tab closed meanwhile: nothing of this one is shown there.
    if (disposed || (w3.workspace.project()?.root ?? null) !== was) return;
    state = s;
    staleOnDisk = false;
    picture = null;
    if (pic && pic.width === s.canvas[0] && pic.height === s.canvas[1]) {
      picture = document.createElement("canvas");
      picture.width = pic.width;
      picture.height = pic.height;
      picture.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(pic.rgba), pic.width, pic.height), 0, 0);
    }
    if (s.layout === "split") { draft = draftOf(s.subterrains, s.canvas); grid = null; }
    else { grid = { canvas: s.canvas, xs: [], ys: [] }; draft = null; }
    selected = selected.filter((n) => draft?.subs.some((x) => x.name === n));
    if (!view.fitted) fit();
    seamMarks = [];
    if (showSeams) void refreshSeams();
    changed();
  }

  // ---- the draft and its preview ----

  /** After every change: the side, the toolbar, the picture, the preview (soon), the state for MCP. */
  function changed() {
    renderToolbar();
    renderSide();
    draw();
    schedulePreview();
    onState(snapshot());
  }

  let previewTimer: ReturnType<typeof setTimeout> | undefined;
  function schedulePreview() {
    clearTimeout(previewTimer);
    const seq = ++previewSeq;
    preview = null;
    refusal = null;
    if (!state || !pending()) return;
    previewTimer = setTimeout(() => void runPreview(seq), 150);
  }
  async function runPreview(seq: number) {
    if (!state) return;
    let p: LayoutPreview | null = null, why: string | null = null;
    try {
      p = state.layout === "split" && draft ? await ops.preview(planOf(draft)) : grid ? await ops.previewSplit(splitArg(grid)) : null;
    } catch (e) {
      why = errorText(e);
    }
    // A newer draft (or another project, or the tab closed) has its own preview.
    if (seq !== previewSeq || disposed) return;
    preview = p;
    refusal = why;
    renderSide();
    onState(snapshot());
  }

  /** A draft step: `next` (a string: why it can't be done, said, nothing changed). */
  function step(next: Draft | string) {
    if (!draft) return;
    if (typeof next === "string") { warn(next); return; }
    history.push({ kind: "draft", before: draft, after: next });
    future.length = 0;
    draft = next;
    selected = selected.filter((n) => next.subs.some((x) => x.name === n));
    changed();
  }
  function gridStep(next: SplitGrid) {
    if (!grid) return;
    const n = normalGrid(next);
    if (n.xs.join() === grid.xs.join() && n.ys.join() === grid.ys.join()) return;
    history.push({ kind: "grid", before: grid, after: n });
    future.length = 0;
    grid = n;
    changed();
  }

  async function rename(name?: string) {
    const n = name ?? selected[0];
    if (!draft || !n) { warn("Select a subterrain to rename."); return; }
    const to = await w3.window.inputBox({ prompt: `${n}'s new name (its folder is renamed, its creation numbers stay)`, value: n });
    if (to === undefined || to === n || !draft) return;
    const next = renameSub(draft, n, to);
    if (typeof next !== "string") selected = selected.map((s) => (s === n ? to : s));
    step(next);
  }
  function join() {
    if (!draft || selected.length < 2) { warn("Select two subterrains or more side by side (Shift+click) to join them."); return; }
    step(joinSubs(draft, selected, selected[0]));
    if (draft.subs.some((s) => s.name === selected[0])) selected = [selected[0]];
    changed();
  }
  function remove() {
    if (!draft || !selected.length) { warn("Select a subterrain to delete."); return; }
    let d: Draft = draft;
    const said: string[] = [];
    for (const n of selected) {
      const r = deleteSub(d, n);
      if (typeof r === "string") { warn(r); return; }
      d = r.draft;
      said.push(r.into ? `${n} joined into ${r.into}` : `${n} left uncovered`);
    }
    selected = [];
    step(d);
    void w3.window.showInfo(`Delete: ${said.join(", ")} (in the draft; Apply writes it).`);
  }

  async function apply() {
    if (!state || busy || !pending()) return;
    busy = true;
    renderToolbar();
    try {
      if (state.layout === "split" && draft) {
        const label = describe(draft, state.subterrains).join(" ");
        const id = await ops.apply(planOf(draft));
        // The draft's steps are in the applied change now: one undo step for all of them.
        while (history.length && history[history.length - 1].kind === "draft") history.pop();
        history.push({ kind: "apply", id, label });
      } else if (grid) {
        const rects = splitArg(grid);
        await ops.split(rects);
        while (history.length && history[history.length - 1].kind === "grid") history.pop();
        history.push({ kind: "split", rects });
      }
      future.length = 0;
    } catch (e) {
      void w3.window.showError(errorText(e));
    } finally {
      busy = false;
    }
    if (!disposed) await load();
  }
  function discard() {
    if (!state) return;
    while (history.length && (history[history.length - 1].kind === "draft" || history[history.length - 1].kind === "grid")) history.pop();
    future.length = 0;
    if (state.layout === "split") draft = draftOf(state.subterrains, state.canvas);
    else grid = { canvas: state.canvas, xs: [], ys: [] };
    changed();
  }

  async function undoRedo(redo: boolean) {
    if (busy) return;
    const s = redo ? future.pop() : history.pop();
    if (!s) return;
    const done = () => (redo ? history : future).push(s);
    if (s.kind === "draft") { draft = redo ? s.after : s.before; done(); changed(); return; }
    if (s.kind === "grid") { grid = redo ? s.after : s.before; done(); changed(); return; }
    busy = true;
    renderToolbar();
    try {
      if (s.kind === "apply") await ops.undo(s.id, redo);
      else if (redo) await ops.split(s.rects);
      else await ops.merge();
      done();
    } catch (e) {
      // Refused (unsaved changes, files changed since): the step stays where it was.
      (redo ? future : history).push(s);
      void w3.window.showError(errorText(e));
    } finally {
      busy = false;
    }
    if (!disposed) await load();
  }

  async function refreshSeams() {
    if (state?.layout !== "split") { seamMarks = []; return; }
    try {
      const marks = await ops.seams();
      if (!disposed && showSeams) { seamMarks = marks; draw(); }
    } catch (e) {
      warn(`Seam hints: ${errorText(e)}`);
    }
  }

  // ---- view: pan and zoom ----

  const size = () => [stage.clientWidth || 600, stage.clientHeight || 400] as const;
  function fit() {
    if (!state) return;
    const [sw, sh] = size();
    view.scale = Math.max(0.05, Math.min((sw - 40) / state.canvas[0], (sh - 40) / state.canvas[1]));
    view.cx = state.canvas[0] / 2;
    view.cy = state.canvas[1] / 2;
    view.fitted = stage.clientWidth > 0;
  }
  /** Corner units → stage pixels (north up). */
  const toScreen = (x: number, y: number): [number, number] => { const [sw, sh] = size(); return [sw / 2 + (x - view.cx) * view.scale, sh / 2 - (y - view.cy) * view.scale]; };
  const toCorner = (px: number, py: number): [number, number] => { const [sw, sh] = size(); return [view.cx + (px - sw / 2) / view.scale, view.cy - (py - sh / 2) / view.scale]; };
  const zoomAt = (factor: number, px: number, py: number) => {
    const before = toCorner(px, py);
    view.scale = Math.max(0.05, Math.min(64, view.scale * factor));
    const after = toCorner(px, py);
    view.cx += before[0] - after[0];
    view.cy += before[1] - after[1];
    draw();
  };
  const pan = (dx: number, dy: number) => { view.cx += dx / view.scale; view.cy -= dy / view.scale; draw(); };

  // ---- drawing ----

  function draw() {
    if (!ctx || !state) return;
    const [sw, sh] = size();
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(sw * dpr) || canvas.height !== Math.round(sh * dpr)) {
      canvas.width = Math.round(sw * dpr);
      canvas.height = Math.round(sh * dpr);
      canvas.style.width = `${sw}px`;
      canvas.style.height = `${sh}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1b1b1b";
    ctx.fillRect(0, 0, sw, sh);
    const [W, H] = state.canvas;
    const [x0, y0] = toScreen(0, H);
    if (picture) {
      ctx.imageSmoothingEnabled = view.scale < 1;
      ctx.drawImage(picture, x0, y0, W * view.scale, H * view.scale);
    } else {
      ctx.fillStyle = "#3a3f35";
      ctx.fillRect(x0, y0, W * view.scale, H * view.scale);
    }
    ctx.strokeStyle = "#888";
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, W * view.scale, H * view.scale);
    if (state.layout === "split" && draft) drawSubs(draft.subs);
    else if (grid) drawGrid(grid);
    if (drag?.kind === "draw" && drag.now) drawBox(dragRect(drag.from, drag.now), "#ffffff", "new", true);
    if (drag?.kind === "handle" && drag.rect) drawBox(drag.rect, "#ffffff", drag.name, true);
    if (showSeams) {
      for (const m of seamMarks) {
        const [px, py] = toScreen(m.x + 0.5, m.y + 0.5);
        ctx.fillStyle = m.error ? "#ff3b30" : "#ffcc00";
        ctx.beginPath();
        ctx.arc(px, py, Math.max(3, view.scale * 0.6), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawBox(r: { x: number; y: number; w: number; h: number }, color: string, label: string, dashed: boolean, fill?: string, lines: string[] = []) {
    if (!ctx) return;
    const [ax, ay] = toScreen(r.x, r.y + r.h);
    const w = r.w * view.scale, hh = r.h * view.scale;
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(ax, ay, w, hh); }
    ctx.setLineDash(dashed ? [6, 4] : []);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(ax + 1, ay + 1, w - 2, hh - 2);
    ctx.setLineDash([]);
    if (w < 24 || hh < 14) return;
    ctx.font = "12px sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 3;
    ctx.fillText(label, ax + 6, ay + 16, w - 10);
    ctx.font = "11px sans-serif";
    lines.forEach((t, i) => { if (30 + i * 14 < hh) ctx.fillText(t, ax + 6, ay + 30 + i * 14, w - 10); });
    ctx.shadowBlur = 0;
  }

  function drawSubs(subs: Draft["subs"]) {
    if (!ctx || !state) return;
    const disk = new Map(state.subterrains.map((s) => [s.name, s]));
    subs.forEach((s, i) => {
      const was = s.from.length === 1 ? disk.get(s.from[0]) : undefined;
      const same = !!was && was.name === s.name && was.x === s.x && was.y === s.y && was.w === s.w && was.h === s.h;
      const closed = s.from.length > 0 && s.from.every((f) => disk.get(f) && !disk.get(f)!.open);
      const ranges = s.from.flatMap((f) => disk.get(f)?.idRanges ?? []);
      const lines = [
        `${s.w}×${s.h} at ${s.x},${s.y}${s.from.length ? (closed ? " · closed" : " · open") : " · new"}`,
        ranges.length ? `ids ${ranges.map(([a, b]) => `${a}–${b}`).join(", ")}` : "ids: next free block",
      ];
      const sel = selected.includes(s.name);
      const color = FILLS[i % FILLS.length];
      drawBox(s, sel ? "#ffffff" : color, s.name, !same, `${color}${closed ? "22" : "40"}`, lines);
      if (closed) {
        // Closed ones hatched: they aren't loaded in the terrain editor.
        const [ax, ay] = toScreen(s.x, s.y + s.h);
        ctx.save();
        ctx.beginPath();
        ctx.rect(ax, ay, s.w * view.scale, s.h * view.scale);
        ctx.clip();
        ctx.strokeStyle = "#00000055";
        for (let d = -s.h * view.scale; d < s.w * view.scale; d += 10) { ctx.beginPath(); ctx.moveTo(ax + d, ay + s.h * view.scale); ctx.lineTo(ax + d + s.h * view.scale, ay); ctx.stroke(); }
        ctx.restore();
      }
      if (sel && tool === "select") {
        ctx.fillStyle = "#ffffff";
        for (const [hx, hy] of [[s.x, s.y], [s.x + s.w, s.y], [s.x, s.y + s.h], [s.x + s.w, s.y + s.h], [s.x + s.w / 2, s.y], [s.x + s.w / 2, s.y + s.h], [s.x, s.y + s.h / 2], [s.x + s.w, s.y + s.h / 2]]) {
          const [px, py] = toScreen(hx, hy);
          ctx.fillRect(px - 4, py - 4, 8, 8);
        }
      }
    });
  }

  function drawGrid(g: SplitGrid) {
    if (!ctx) return;
    gridRects(g).forEach((r, i) => drawBox(r, FILLS[i % FILLS.length], r.name, true, `${FILLS[i % FILLS.length]}30`, [`${r.w}×${r.h} at ${r.x},${r.y}`]));
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3;
    for (const x of g.xs) { const [a, b] = toScreen(x, 0), [, c] = toScreen(x, g.canvas[1]); ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(a, c); ctx.stroke(); }
    for (const y of g.ys) { const [a, b] = toScreen(0, y), [c] = toScreen(g.canvas[0], y); ctx.beginPath(); ctx.moveTo(a, b); ctx.lineTo(c, b); ctx.stroke(); }
  }

  // ---- the pointer ----

  type Drag =
    | { kind: "pan"; last: [number, number] }
    | { kind: "draw"; from: [number, number]; now?: [number, number] }
    | { kind: "handle"; name: string; handle: Handle; start: [number, number]; base: SubRect; rect?: Omit<SubRect, "name"> }
    | { kind: "cut"; axis: "x" | "y"; index: number; base: SplitGrid; now?: SplitGrid };
  let drag: Drag | null = null;

  const pointIn = (e: PointerEvent | MouseEvent): [number, number] => { const b = stage.getBoundingClientRect(); return toCorner(e.clientX - b.left, e.clientY - b.top); };
  const tolerance = () => Math.max(0.35, 6 / view.scale);

  /** The subterrain under a point: a selected one's handle first, then the last drawn (topmost) holding it. */
  function hit(p: [number, number]): { name: string; handle: Handle } | null {
    if (!draft) return null;
    for (const n of selected) {
      const s = draft.subs.find((x) => x.name === n);
      const hd = s && handleAt(s, p, tolerance());
      if (s && hd) return { name: s.name, handle: hd };
    }
    for (let i = draft.subs.length - 1; i >= 0; i--) {
      const s = draft.subs[i];
      if (p[0] >= s.x && p[0] <= s.x + s.w && p[1] >= s.y && p[1] <= s.y + s.h) return { name: s.name, handle: "inside" };
    }
    return null;
  }

  stage.addEventListener("contextmenu", (e) => e.preventDefault());
  stage.addEventListener("pointerdown", (e) => {
    stage.focus({ preventScroll: true });
    if (!state || busy) return;
    if (e.button === 1 || e.button === 2) { drag = { kind: "pan", last: [e.clientX, e.clientY] }; stage.setPointerCapture(e.pointerId); e.preventDefault(); return; }
    if (e.button !== 0) return;
    const p = pointIn(e);
    if (state.layout === "flat" && grid) {
      const c = cutAt(grid, p, tolerance());
      if (c) { drag = { kind: "cut", ...c, base: grid }; stage.setPointerCapture(e.pointerId); }
      return;
    }
    if (!draft) return;
    if (tool === "draw") {
      drag = { kind: "draw", from: cellAt(draft, p) };
      stage.setPointerCapture(e.pointerId);
      return;
    }
    const t = hit(p);
    if (!t) { if (!e.shiftKey) { selected = []; changed(); } return; }
    if (e.shiftKey) { selected = selected.includes(t.name) ? selected.filter((n) => n !== t.name) : [...selected, t.name]; changed(); return; }
    if (!selected.includes(t.name) || selected.length > 1) { selected = [t.name]; changed(); }
    const base = draft.subs.find((s) => s.name === t.name)!;
    drag = { kind: "handle", name: t.name, handle: t.handle, start: p, base };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!state) return;
    if (!drag) {
      // The cursor says what a press would do.
      const p = pointIn(e);
      const c = state.layout === "flat" && grid ? cutAt(grid, p, tolerance()) : null;
      const t = state.layout === "split" && tool === "select" ? hit(p) : null;
      stage.style.cursor = c ? (c.axis === "x" ? "ew-resize" : "ns-resize") : tool === "draw" && state.layout === "split" ? "crosshair" : t && t.handle !== "inside" ? `${t.handle}-resize` : t ? "move" : "default";
      return;
    }
    if (drag.kind === "pan") { pan(e.clientX - drag.last[0], e.clientY - drag.last[1]); drag.last = [e.clientX, e.clientY]; return; }
    const p = pointIn(e);
    if (drag.kind === "draw" && draft) drag.now = cellAt(draft, p);
    else if (drag.kind === "handle" && draft) drag.rect = dragHandle(draft, drag.base, drag.handle, p, [p[0] - drag.start[0], p[1] - drag.start[1]]);
    else if (drag.kind === "cut") { drag.now = moveCut(drag.base, drag.axis, drag.index, p[drag.axis === "x" ? 0 : 1]); grid = drag.now; }
    draw();
  });
  const end = (e: PointerEvent) => {
    const d = drag;
    drag = null;
    if (stage.hasPointerCapture(e.pointerId)) stage.releasePointerCapture(e.pointerId);
    if (!d || !draft && d.kind !== "cut") { draw(); return; }
    if (d.kind === "draw" && draft) {
      const r = dragRect(d.from, d.now ?? d.from);
      const name = freeName(draft.subs, "new");
      const next = addSub(draft, name, r);
      if (typeof next !== "string") selected = [name];
      step(next);
    } else if (d.kind === "handle" && draft && d.rect) {
      const r = d.rect;
      if (r.x !== d.base.x || r.y !== d.base.y || r.w !== d.base.w || r.h !== d.base.h) step(resizeSub(draft, d.name, r));
      else draw();
    } else if (d.kind === "cut") {
      grid = d.base;
      gridStep(d.now ?? d.base);
      draw();
    } else draw();
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  stage.addEventListener("dblclick", (e) => { const t = state?.layout === "split" ? hit(pointIn(e)) : null; if (t) void rename(t.name); });
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const b = stage.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - b.left, e.clientY - b.top);
  }, { passive: false });
  stage.addEventListener("keydown", (e) => {
    const fast = e.shiftKey ? 4 : 1, stepPx = 40 * fast;
    const k = keyOf(e);
    if (e.ctrlKey && (k === "ArrowUp" || k === "ArrowDown")) { const [sw, sh] = size(); zoomAt(k === "ArrowUp" ? 1.25 : 0.8, sw / 2, sh / 2); }
    else if (k === "ArrowUp") pan(0, -stepPx);
    else if (k === "ArrowDown") pan(0, stepPx);
    else if (k === "ArrowLeft") pan(-stepPx, 0);
    else if (k === "ArrowRight") pan(stepPx, 0);
    else if (k === "Delete") remove();
    else if (k === "F2") void rename();
    else if (k === "Escape") { if (drag) { if (drag.kind === "cut") grid = drag.base; drag = null; draw(); } else { selected = []; changed(); } }
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  const resize = new ResizeObserver(() => { if (!view.fitted) fit(); draw(); });
  resize.observe(stage);

  // ---- toolbar and side ----

  const button = (label: string, title: string, run: () => void, opts: { on?: boolean; disabled?: boolean; prop?: string } = {}) =>
    h(`button${opts.on ? ".active" : ""}`, { title, disabled: !!opts.disabled || busy, "data-layout": opts.prop ?? label.toLowerCase(), onclick: () => { run(); stage.focus({ preventScroll: true }); } }, label);

  function renderToolbar() {
    if (!state) { toolbar.replaceChildren(); return; }
    const undoRedoButtons = [
      button("Undo", "Undo (Ctrl+Z): the last draft change, or the last Apply as one step", () => void undoRedo(false), { disabled: !history.length }),
      button("Redo", "Redo", () => void undoRedo(true), { disabled: !future.length }),
    ];
    const fitButton = button("Fit", "Show the whole map", () => { fit(); draw(); });
    if (state.layout === "flat" && grid) {
      const g = grid;
      const cols = g.xs.length + 1, rows = g.ys.length + 1;
      toolbar.replaceChildren(
        h("span.layout-label", {}, "Split Terrain:"),
        h("span.muted", {}, ` ${cols} × ${rows} `),
        button("Columns −", "One column fewer (the cuts spread evenly again)", () => gridStep({ ...g, xs: evenCuts(g.canvas[0], cols - 1) }), { disabled: cols <= 1, prop: "cols-" }),
        button("Columns +", "One column more (the cuts spread evenly again)", () => gridStep({ ...g, xs: evenCuts(g.canvas[0], cols + 1) }), { prop: "cols+" }),
        button("Rows −", "One row fewer", () => gridStep({ ...g, ys: evenCuts(g.canvas[1], rows - 1) }), { disabled: rows <= 1, prop: "rows-" }),
        button("Rows +", "One row more", () => gridStep({ ...g, ys: evenCuts(g.canvas[1], rows + 1) }), { prop: "rows+" }),
        h("span.layout-sep"), ...undoRedoButtons, fitButton);
      return;
    }
    toolbar.replaceChildren(
      button("Select", "Select: click a subterrain (Shift+click adds), drag its sides or corners to resize it, inside to move it", () => { tool = "select"; changed(); }, { on: tool === "select" }),
      button("Draw", "Draw a new subterrain: drag a rectangle; it takes a whole side off those it covers", () => { tool = "draw"; changed(); }, { on: tool === "draw" }),
      h("span.layout-sep"),
      button("Rename…", "Rename the selected subterrain (F2, or double-click it)", () => void rename(), { disabled: selected.length !== 1, prop: "rename" }),
      button("Join", "Join the selected subterrains (side by side) into the first one", join, { disabled: selected.length < 2 }),
      button("Delete", "Delete the selected subterrain (Del): it joins a neighbour that lines up with it, else its corners are left uncovered", remove, { disabled: !selected.length }),
      h("span.layout-sep"), ...undoRedoButtons, fitButton,
      h("label.layout-check", { title: "Check Terrain Seams on the saved terrain and mark the corners it reports" },
        h("input", { type: "checkbox", checked: showSeams, onchange: (e: Event) => { showSeams = (e.target as HTMLInputElement).checked; seamMarks = []; if (showSeams) void refreshSeams(); draw(); } }), " Seam hints"));
  }

  function renderSide() {
    if (!state) { side.replaceChildren(); return; }
    const rows: HTMLElement[] = [];
    if (state.layout === "flat") {
      rows.push(h("div.layout-section", {}, "The terrain is in single files (flat). Split Terrain cuts it into subterrains: drag the cuts, add columns or rows, then Split."));
    } else {
      const disk = new Map(state.subterrains.map((s) => [s.name, s]));
      rows.push(h("div.layout-section", {}, `Subterrains${state.partial ? ` (${state.subterrains.filter((s) => s.open).length} of ${state.subterrains.length} open)` : ""}`));
      for (const s of draft?.subs ?? []) {
        const closed = s.from.length > 0 && s.from.every((f) => disk.get(f) && !disk.get(f)!.open);
        const ranges = s.from.flatMap((f) => disk.get(f)?.idRanges ?? []);
        rows.push(h(`div.layout-row${selected.includes(s.name) ? ".selected" : ""}`, {
          "data-sub": s.name,
          onclick: (e: MouseEvent) => { selected = e.shiftKey ? (selected.includes(s.name) ? selected.filter((n) => n !== s.name) : [...selected, s.name]) : [s.name]; changed(); },
          ondblclick: () => void rename(s.name),
        },
        h("span.layout-name", {}, s.name),
        h("span.muted", {}, ` ${s.w}×${s.h} at ${s.x},${s.y} · ${s.from.length ? (closed ? "closed" : "open") : "new"} · ${ranges.length ? ranges.map(([a, b]) => `${a}–${b}`).join(", ") : "next block"}`)));
      }
    }
    const changes = snapshot().changes;
    rows.push(h("div.layout-section", {}, pending() ? "Draft (nothing written yet)" : "No changes"));
    if (pending()) {
      if (state.layout === "split") for (const c of changes) rows.push(h("div.layout-change", {}, c));
      if (refusal) {
        rows.push(h("div.layout-refusal", {}, `Apply would be refused: ${refusal}`));
        // Duplicate creation numbers have a fix of their own: offered here (Renumber or Delete Copies).
        if (/creation number/i.test(refusal)) rows.push(h("div.layout-actions", {},
          h("button", { "data-layout": "fix-ids", disabled: busy, onclick: () => void w3.commands.execute("w3.terrainLayout.fixIds").then(() => changed(), (e) => w3.window.showError(String((e as Error).message ?? e))) }, "Fix Duplicate Creation Numbers…")));
      }
      else if (preview) {
        const objs = preview.subterrains.reduce((n, s) => n + s.doodads + s.units + s.regions, 0);
        rows.push(h("div.layout-preview", {}, `Apply writes ${preview.written.length} file${preview.written.length === 1 ? "" : "s"} and removes ${preview.removed.length}; the map stays the same (${objs} placed object${objs === 1 ? "" : "s"} and regions in all).`));
        for (const m of preview.moves) rows.push(h("div.layout-move", {}, `${m.count} ${m.count === 1 ? m.kind.replace(/s$/, "") : m.kind} move from ${m.from} to ${m.to}.`));
        if (state.layout === "flat") for (const s of preview.subterrains) rows.push(h("div.layout-move", {}, `${s.name}: ${s.doodads} doodads, ${s.units} units, ${s.regions} regions, ids ${s.idRanges.map(([a, b]) => `${a}–${b}`).join(", ")}.`));
      } else rows.push(h("div.muted", {}, "Working out what Apply would do…"));
      rows.push(h("div.layout-actions", {},
        h("button.primary", { "data-layout": "apply", disabled: busy || !!refusal, onclick: () => void apply() }, state.layout === "flat" ? "Split Terrain" : "Apply"),
        h("button", { "data-layout": "discard", disabled: busy, onclick: discard }, "Discard")));
    }
    if (staleOnDisk) rows.push(h("div.layout-refusal", {}, "The layout changed on disk since the draft began: Discard to see it."));
    if (state.error) rows.push(h("div.layout-refusal", {}, `The open choice can't be read: ${state.error}`));
    side.replaceChildren(...rows);
  }

  // ---- the layout changed on disk ----

  const subs = [
    w3.workspace.onDidChange(() => {
      if (disposed || busy) return;
      // A draft drawn is kept (it says the layout changed under it); without one the layout on disk is shown.
      const drafted = state?.layout === "split" ? pending() : !!grid && grid.xs.length + grid.ys.length > 0;
      if (drafted) { staleOnDisk = true; renderSide(); return; }
      void load();
    }),
  ];

  void load();
  return {
    focus: () => stage.focus({ preventScroll: true }),
    undo: () => void undoRedo(false),
    redo: () => void undoRedo(true),
    dispose() {
      disposed = true;
      clearTimeout(previewTimer);
      resize.disconnect();
      for (const s of subs) s.dispose();
      onState(null);
    },
  };
}
