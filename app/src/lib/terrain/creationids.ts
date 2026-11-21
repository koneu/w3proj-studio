// Creation numbers: what a placed unit, item, doodad or destructable (editorId; a version-13 doodad's first trailer
// value) and a region (index) is called by in scripts (gg_unit_hfoo_0012, gg_dest_…, a waygate's target region).
// Every new one comes from allocateNumber; an existing one never changes.
//
// Kind namespaces as the flat files keep them: units and items one (war3mapUnits.doo), doodads and destructables one
// (war3map.doo), regions one (war3map.w3r). The allocator is given every number of one namespace.
//
// Flat project: one past the highest (as before subterrains). Split project (map/terrain/, crates/w3proj
// terrain_ids.rs): the lowest number of the owning subterrain's idRange that no object of the namespace uses map-wide,
// never 0 or 4294967295; with its ranges full, the lowest free one of the next block above every range (nextRange).
// That range is put into the layout held here at once (so the other files' allocations see it) and recorded in
// terrain.json by the backend when the object is saved (terrain_ids.rs record_new).

import type { W3Api } from "../../extensions/api";

/** An unset number (every version-13 doodad's editorId): not an assignment. */
export const UNSET = 0xffffffff;
/** An id range's size, and what a range added later starts on (terrain_ids.rs BLOCK). */
export const BLOCK = 10000;
/** The split layout's file (terrain_layout.rs LAYOUT_FILE under map/). */
export const LAYOUT_FILE = "map/terrain/terrain.json";

export type Namespace = "units" | "doodads" | "regions";

/** A subterrain as the allocator needs it: its rectangle in corners, its id ranges ([min, max], lowest first). */
export interface IdSubterrain { name: string; x: number; y: number; w: number; h: number; idRanges: [number, number][] }
/** A split project's subterrains and the world position of corner (0, 0) (backend terrain_id_layout). */
export interface IdLayout { offset: [number, number]; subterrains: IdSubterrain[] }

/** Numbers handed out and not necessarily in the list (made before being put in, or taken out again by an undo): the
 *  flat rule keeps above `max`, the split one skips `all`. */
export interface IssuedNumbers { max?: number; all?: Set<number> }

/** A tile in world units. */
const TILE = 128;
/** f64::max: NaN gives the other value. */
const fmax = (a: number, b: number) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b));

/** The subterrain an object at world (x, y) belongs to, as terrain_objects.rs owner decides it (positions as the file
 *  stores them, f32): the one whose rectangle holds it, else the nearest (ties to the first); NaN lands in the first. */
export function ownerOf(layout: IdLayout, x: number, y: number): number {
  const [ox, oy] = layout.offset;
  x = Math.fround(x);
  y = Math.fround(y);
  let best = 0, bestD = Infinity;
  layout.subterrains.forEach((s, i) => {
    if (best < 0) return;
    const left = ox + s.x * TILE, right = ox + (s.x + s.w) * TILE, bottom = oy + s.y * TILE, top = oy + (s.y + s.h) * TILE;
    if (left <= x && x < right && bottom <= y && y < top) { best = -1 - i; return; }
    const dx = fmax(fmax(left - x, x - right), 0), dy = fmax(fmax(bottom - y, y - top), 0);
    const d = dx * dx + dy * dy;
    if (d < bestD) { best = i; bestD = d; }
  });
  return best < 0 ? -1 - best : best;
}

/** The range added once a subterrain's ranges are full: from one past the highest range of all to the end of that
 *  block of BLOCK; null when none is left below 4294967295. */
export function nextRange(layout: IdLayout): [number, number] | null {
  const top = Math.max(-1, ...layout.subterrains.flatMap((s) => s.idRanges.map((r) => r[1])));
  const lo = top + 1;
  if (lo >= UNSET) return null;
  return [lo, Math.min(Math.floor(lo / BLOCK) * BLOCK + BLOCK - 1, UNSET - 1)];
}

/** The number a new object gets. `values`: the number field of every object of its namespace (as the file has it);
 *  `issued`: the numbers handed out before (updated); `layout`: null in a flat project; `at`: the new object's world
 *  (x, y), a region's minimum corner. Flat: one past the highest (placed objects read a value that isn't a number as
 *  0 and leave 4294967295 out; regions take theirs as they are, so a region numbered 4294967295 gives a number past
 *  it, which the caller refuses). Split: see the file's comment; null when no number is left. */
export function allocateNumber(ns: Namespace, values: Iterable<unknown>, issued: IssuedNumbers, layout: IdLayout | null, at: readonly [number, number]): number | null {
  if (!layout) {
    let max = Math.max(-1, issued.max ?? -1);
    for (const v of values) {
      if (ns === "regions") { max = Math.max(max, v as number); continue; }
      const n = Number(v) || 0;
      if (n < UNSET) max = Math.max(max, n);
    }
    const n = 1 + max;
    issued.max = n;
    return n;
  }
  const used = new Set<number>(issued.all);
  for (const v of values) {
    const n = Number(v);
    if (Number.isInteger(n)) used.add(n);
  }
  const sub = layout.subterrains[ownerOf(layout, at[0], at[1])];
  if (!sub) return null;
  const free = (r: readonly [number, number]) => {
    for (let n = Math.max(r[0], 1); n <= Math.min(r[1], UNSET - 1); n++) if (!used.has(n)) return n;
    return null;
  };
  let n: number | null = null;
  for (const r of [...sub.idRanges].sort((a, b) => a[0] - b[0])) if ((n = free(r)) !== null) break;
  while (n === null) {
    const r = nextRange(layout);
    if (!r) return null;
    sub.idRanges.push(r);
    n = free(r);
  }
  (issued.all ??= new Set()).add(n);
  issued.max = Math.max(issued.max ?? -1, n);
  return n;
}

const layouts = new WeakMap<object, { root: string; stamp: string; layout: Promise<IdLayout | null> }>();

interface WireLayout { offset: [number | null, number | null]; subterrains: IdSubterrain[] }

/** The open project's IdLayout: null when its terrain isn't split (no map/terrain/terrain.json listed). A layout file
 *  that can't be read rejects: a new object must never get the flat number in a split project. One object per state of
 *  terrain.json (its size and time in the file list), shared by everything that allocates, so a range added for one
 *  file's object is seen by the others. */
export function loadIdLayout(w3: W3Api): Promise<IdLayout | null> {
  const root = w3.workspace.project?.()?.root;
  if (!root) return Promise.resolve(null);
  const f = w3.workspace.files().find((x) => x.path.replace(/\\/g, "/").toLowerCase() === LAYOUT_FILE);
  if (!f) return Promise.resolve(null);
  const stamp = `${f.size}:${f.modified}`;
  const known = layouts.get(w3);
  if (known && known.root === root && known.stamp === stamp) return known.layout;
  const layout = w3.backend.invoke<WireLayout | null>("terrain_id_layout", { root }).then((l) =>
    l ? { offset: [l.offset[0] ?? NaN, l.offset[1] ?? NaN] as [number, number], subterrains: l.subterrains } : null);
  layouts.set(w3, { root, stamp, layout });
  layout.catch(() => { if (layouts.get(w3)?.layout === layout) layouts.delete(w3); });
  return layout;
}
