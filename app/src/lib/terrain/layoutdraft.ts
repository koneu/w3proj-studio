// The Terrain Layout editor's draft: the subterrains as they would be after the changes drawn so far (new, resized,
// renamed, joined, deleted), before anything is written. Every step is one of subterrainplan.ts's plans over the
// draft; the draft remembers, per subterrain, which subterrains on disk it continues, so the whole draft is one plan
// for the backend's terrain_relayout (their id ranges and folders follow, as the Subterrains commands' do). A flat
// project's draft is a grid of cuts instead: Split Terrain into those rectangles.
//
// Rectangles are in corners, (0, 0) the south-west corner; a subterrain owns corners x to x+w-1. The editor draws one
// cell per corner, so the snapping here is to whole corners, which lie on tile boundaries.

import { joinPlan, nameProblem, placePlan, renamePlan, type PlannedSubterrain, type SubRect } from "./subterrainplan";

/** A subterrain of the draft and the subterrains on disk it continues (none: new). */
export interface DraftSub extends SubRect { from: string[] }

/** The subterrains of a draft over a canvas of `canvas` corners. */
export interface Draft { canvas: [number, number]; subs: DraftSub[] }

/** The draft of a layout as it is on disk: every subterrain continues itself. */
export function draftOf(subs: readonly SubRect[], canvas: [number, number]): Draft {
  return { canvas: [canvas[0], canvas[1]], subs: subs.map(({ name, x, y, w, h }) => ({ name, x, y, w, h, from: [name] })) };
}

/** A step's plan (its `from` naming subterrains of the draft) made a draft again: `from` traced back to disk. */
function compose(d: Draft, plan: PlannedSubterrain[] | string): Draft | string {
  if (typeof plan === "string") return plan;
  const by = new Map(d.subs.map((s) => [s.name, s]));
  return {
    canvas: d.canvas,
    subs: plan.map((p) => ({
      name: p.name, x: p.x, y: p.y, w: p.w, h: p.h,
      from: (p.from ?? (by.has(p.name) ? [p.name] : [])).flatMap((n) => by.get(n)?.from ?? []),
    })),
  };
}

/** Why `r` can't be a rectangle of the canvas, or null. */
export function outsideCanvas(d: Draft, r: Omit<SubRect, "name">): string | null {
  if (![r.x, r.y, r.w, r.h].every((v) => Number.isInteger(v)) || r.w < 1 || r.h < 1 || r.x < 0 || r.y < 0) return `${r.x},${r.y} ${r.w}×${r.h} isn't a rectangle of corners.`;
  if (r.x + r.w > d.canvas[0] || r.y + r.h > d.canvas[1]) return `${r.x},${r.y} ${r.w}×${r.h} reaches past the map's ${d.canvas[0]}×${d.canvas[1]} corners.`;
  return null;
}

/** A new subterrain over `r`: it takes a whole side off the ones it covers (all of one). */
export function addSub(d: Draft, name: string, r: Omit<SubRect, "name">): Draft | string {
  const bad = nameProblem(name, d.subs) ?? outsideCanvas(d, r);
  return bad ?? compose(d, placePlan(d.subs, { name, ...r, from: [] }));
}

/** `name` resized to `r`: what it covers is taken from its neighbours (a whole side of each). */
export function resizeSub(d: Draft, name: string, r: Omit<SubRect, "name">): Draft | string {
  if (!d.subs.some((s) => s.name === name)) return `There is no subterrain "${name}".`;
  return outsideCanvas(d, r) ?? compose(d, placePlan(d.subs, { name, ...r, from: [name] }, name));
}

/** `name` renamed `to`. */
export function renameSub(d: Draft, name: string, to: string): Draft | string {
  return compose(d, renamePlan(d.subs, name, to));
}

/** `names` (side by side) joined into one subterrain `to` over the rectangle round them. */
export function joinSubs(d: Draft, names: readonly string[], to: string): Draft | string {
  return compose(d, joinPlan(d.subs, names, to));
}

/** What Delete did: joined into a neighbour (its name), or left uncovered. */
export type Deleted = { draft: Draft; into: string | null };

/** Deletes `name`: joined into the first neighbour whose rectangle and its make one rectangle (its objects and id
 *  ranges go there); without one its corners are left uncovered, which Apply allows only where they are all the
 *  default corner (the backend says so). The last subterrain can't go. */
export function deleteSub(d: Draft, name: string): Deleted | string {
  const s = d.subs.find((x) => x.name === name);
  if (!s) return `There is no subterrain "${name}".`;
  if (d.subs.length === 1) return `${name} is the only subterrain: a split terrain has one at least (Merge Subterrains goes back to the single files).`;
  for (const n of d.subs) {
    if (n === s || !sideBySide(n, s)) continue;
    const joined = joinSubs(d, [n.name, name], n.name);
    if (typeof joined !== "string") return { draft: joined, into: n.name };
  }
  return { draft: { canvas: d.canvas, subs: d.subs.filter((x) => x !== s) }, into: null };
}

/** Whether `a` and `b` share a whole side (together one rectangle). */
export function sideBySide(a: SubRect, b: SubRect): boolean {
  const rows = a.y === b.y && a.h === b.h && (a.x + a.w === b.x || b.x + b.w === a.x);
  const cols = a.x === b.x && a.w === b.w && (a.y + a.h === b.y || b.y + b.h === a.y);
  return rows || cols;
}

/** The draft as the backend's plan (`NAME=OLD+OLD:x,y,w,h`, every subterrain with what it continues). */
export function planOf(d: Draft): PlannedSubterrain[] {
  return d.subs.map(({ name, x, y, w, h, from }) => ({ name, x, y, w, h, from: [...from] }));
}

/** Whether the draft is the layout on disk (`subs`) unchanged. */
export function unchanged(d: Draft, subs: readonly SubRect[]): boolean {
  return d.subs.length === subs.length && d.subs.every((s, i) => {
    const o = subs[i];
    return s.name === o.name && s.x === o.x && s.y === o.y && s.w === o.w && s.h === o.h && s.from.length === 1 && s.from[0] === o.name;
  });
}

const box = (s: Omit<SubRect, "name">) => `${s.w}×${s.h} at ${s.x},${s.y}`;

/** The draft's changes against the layout on disk, in plain words, one line each. */
export function describe(d: Draft, subs: readonly SubRect[]): string[] {
  const out: string[] = [];
  const old = new Map(subs.map((s) => [s.name, s]));
  const continued = new Set<string>();
  for (const s of d.subs) {
    for (const f of s.from) continued.add(f);
    if (!s.from.length) { out.push(`New: ${s.name}, ${box(s)} (it gets the next block of creation numbers).`); continue; }
    if (s.from.length > 1) { out.push(`Joined: ${s.from.join(" + ")} → ${s.name}, ${box(s)} (all their creation numbers).`); continue; }
    const was = old.get(s.from[0]);
    const moved = !!was && (was.x !== s.x || was.y !== s.y || was.w !== s.w || was.h !== s.h);
    const resized = was && moved ? `${box(was)} → ${box(s)}` : "";
    if (s.from[0] !== s.name) out.push(`Renamed: ${s.from[0]} → ${s.name} (its folder too)${resized ? `; resized ${resized}` : ""}.`);
    else if (resized) out.push(`Resized: ${s.name}, ${resized}.`);
  }
  for (const s of subs) if (!continued.has(s.name)) out.push(`Deleted: ${s.name} (its corners left uncovered must all be the default corner; its objects go to the nearest subterrain).`);
  return out;
}

// ---- pointer geometry ----

/** A corner cell under a point in corner units (fractions allowed), kept on the canvas. */
export function cellAt(d: Pick<Draft, "canvas">, p: [number, number]): [number, number] {
  return [Math.min(d.canvas[0] - 1, Math.max(0, Math.floor(p[0]))), Math.min(d.canvas[1] - 1, Math.max(0, Math.floor(p[1])))];
}

/** The rectangle dragged from cell `a` to cell `b` (both taken in). */
export function dragRect(a: [number, number], b: [number, number]): Omit<SubRect, "name"> {
  const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
  return { x, y, w: Math.abs(a[0] - b[0]) + 1, h: Math.abs(a[1] - b[1]) + 1 };
}

/** A handle of a rectangle: a side, a corner, or the inside. */
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "inside";

/** The handle of `r` at point `p` (corner units), `tol` corners round its sides; null when outside. North is up (+y). */
export function handleAt(r: Omit<SubRect, "name">, p: [number, number], tol: number): Handle | null {
  const [px, py] = p;
  if (px < r.x - tol || px > r.x + r.w + tol || py < r.y - tol || py > r.y + r.h + tol) return null;
  const w = Math.abs(px - r.x) <= tol, e = Math.abs(px - (r.x + r.w)) <= tol;
  const s = Math.abs(py - r.y) <= tol, n = Math.abs(py - (r.y + r.h)) <= tol;
  const ns = n ? "n" : s ? "s" : "", ew = e ? "e" : w ? "w" : "";
  if (ns || ew) return (ns + ew) as Handle;
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h ? "inside" : null;
}

/** `r` with its handle `h` dragged to point `p` (corner units): sides snap to the nearest corner line, at least one
 *  corner stays; "inside" moves it by `delta` (whole corners), kept on the canvas. */
export function dragHandle(d: Pick<Draft, "canvas">, r: Omit<SubRect, "name">, h: Handle, p: [number, number], delta: [number, number] = [0, 0]): Omit<SubRect, "name"> {
  const [W, H] = d.canvas;
  if (h === "inside") {
    const x = Math.min(W - r.w, Math.max(0, r.x + Math.round(delta[0]))), y = Math.min(H - r.h, Math.max(0, r.y + Math.round(delta[1])));
    return { x, y, w: r.w, h: r.h };
  }
  let x0 = r.x, x1 = r.x + r.w, y0 = r.y, y1 = r.y + r.h;
  const lx = Math.min(W, Math.max(0, Math.round(p[0]))), ly = Math.min(H, Math.max(0, Math.round(p[1])));
  if (h.includes("w")) x0 = Math.min(lx, x1 - 1);
  if (h.includes("e")) x1 = Math.max(lx, x0 + 1);
  if (h.includes("s")) y0 = Math.min(ly, y1 - 1);
  if (h.includes("n")) y1 = Math.max(ly, y0 + 1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A name not taken yet: `base`, else `base2`, `base3`… */
export function freeName(subs: readonly SubRect[], base: string): string {
  const taken = new Set(subs.map((s) => s.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`.toLowerCase())) return `${base}${i}`;
}

// ---- a flat project: Split Terrain by a grid ----

/** The cuts of a split grid: corner lines between 1 and the canvas's size − 1, west to east and south to north. */
export interface SplitGrid { canvas: [number, number]; xs: number[]; ys: number[] }

/** The cuts kept in order, inside the canvas, none twice. */
export function normalGrid(g: SplitGrid): SplitGrid {
  const clean = (v: number[], n: number) => [...new Set(v.map(Math.round).filter((c) => c > 0 && c < n))].sort((a, b) => a - b);
  return { canvas: g.canvas, xs: clean(g.xs, g.canvas[0]), ys: clean(g.ys, g.canvas[1]) };
}

/** `n` pieces across a length: the cuts between them, as even as whole corners allow. */
export function evenCuts(length: number, n: number): number[] {
  const pieces = Math.max(1, Math.min(length, Math.floor(n)));
  return Array.from({ length: pieces - 1 }, (_, i) => Math.round(((i + 1) * length) / pieces));
}

/** The grid's rectangles, rows from the south, as `Split Terrain` takes them: one `main` without cuts, `sw se nw ne`
 *  for 2×2 (as the 2×2 split names them), else `r<row>c<column>` from 1. */
export function gridRects(g: SplitGrid): SubRect[] {
  const { canvas: [W, H], xs, ys } = normalGrid(g);
  const cx = [0, ...xs, W], cy = [0, ...ys, H];
  const two = xs.length === 1 && ys.length === 1;
  const out: SubRect[] = [];
  for (let r = 0; r + 1 < cy.length; r++) {
    for (let c = 0; c + 1 < cx.length; c++) {
      const name = !xs.length && !ys.length ? "main" : two ? ["sw", "se", "nw", "ne"][r * 2 + c] : `r${r + 1}c${c + 1}`;
      out.push({ name, x: cx[c], y: cy[r], w: cx[c + 1] - cx[c], h: cy[r + 1] - cy[r] });
    }
  }
  return out;
}

/** The cut of the grid at point `p` (corner units) within `tol`: its axis and index, or null. */
export function cutAt(g: SplitGrid, p: [number, number], tol: number): { axis: "x" | "y"; index: number } | null {
  let best: { axis: "x" | "y"; index: number; d: number } | null = null;
  g.xs.forEach((c, i) => { const dd = Math.abs(p[0] - c); if (dd <= tol && (!best || dd < best.d)) best = { axis: "x", index: i, d: dd }; });
  g.ys.forEach((c, i) => { const dd = Math.abs(p[1] - c); if (dd <= tol && (!best || dd < best.d)) best = { axis: "y", index: i, d: dd }; });
  const b = best as { axis: "x" | "y"; index: number; d: number } | null;
  return b ? { axis: b.axis, index: b.index } : null;
}

/** The grid with cut `index` of `axis` moved to corner line `at` (it stays between its neighbours). */
export function moveCut(g: SplitGrid, axis: "x" | "y", index: number, at: number): SplitGrid {
  const list = [...(axis === "x" ? g.xs : g.ys)];
  const n = axis === "x" ? g.canvas[0] : g.canvas[1];
  const lo = (list[index - 1] ?? 0) + 1, hi = (list[index + 1] ?? n) - 1;
  list[index] = Math.min(hi, Math.max(lo, Math.round(at)));
  return axis === "x" ? { ...g, xs: list } : { ...g, ys: list };
}
