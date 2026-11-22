// Working on part of a split map (spec "Working on Part of the Map"): which subterrains are open, as the backend tells it
// (`terrain_open_state`, crates/w3proj terrain_open.rs), and what the terrain editor makes of it: corners of closed
// subterrains are default-filled and not drawn, the halo (two corners around the open ones, from their neighbours) is
// drawn but locked, and nothing outside the open subterrains is edited.

/** The key of `.w3proj/derived-from.json` saying the derived files were made with this many subterrains closed
 *  (crates/w3proj derived.rs CLOSED_KEY): they follow part of the map only. */
export const DERIVED_CLOSED_KEY = "?closed-subterrains";

/** A corner in no open subterrain nor its halo. */
export const CLOSED = 0;
/** A corner within the halo of an open subterrain (read-only). */
export const HALO = 1;
/** A corner in an open subterrain. */
export const OPEN = 2;

export interface SubterrainState {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  open: boolean;
  /** Not open, read for the halo. */
  halo: boolean;
  /** Its files' bytes on disk. */
  bytes: number;
}

/** terrain_open.rs State. */
export interface OpenState {
  partial: boolean;
  source: "default" | "file" | "env" | "override";
  corners: [number, number];
  halo: number;
  subterrains: SubterrainState[];
  /** Per corner, rows from the south: "0" closed, "1" halo, "2" open; "" when everything is open. */
  mask: string;
  /** Why the choice can't be used (a damaged .w3proj/open-subterrains.json, a name terrain.json doesn't have). */
  error: string | null;
}

/** The project's open state, null for a flat project. */
export async function loadOpenState(invoke: <T>(cmd: string, args: Record<string, unknown>) => Promise<T>, root: string): Promise<OpenState | null> {
  return invoke<OpenState | null>("terrain_open_state", { root });
}

/** The editor's view of a partial load: per corner its state, per tile whether it is drawn (no corner of it closed) and
 *  editable (all of its corners open). */
export interface PartialMask {
  width: number;
  height: number;
  corners: Uint8Array;
  /** Per tile ((width - 1) × (height - 1), rows from the south): 1 when a corner of it is closed (not drawn). */
  hiddenTiles: Uint8Array;
  /** Per tile: 1 when it is drawn but a corner of it is in the halo (locked, drawn dimmed). */
  haloTiles: Uint8Array;
  /** Indices of the corners that aren't open (never changed by an edit). */
  locked: number[];
}

/** The mask of a partial load for a terrain of `width` × `height` corners; null when everything is open. Throws when
 *  the mask doesn't fit the terrain (the layout changed meanwhile). */
export function partialMask(state: OpenState | null, width: number, height: number): PartialMask | null {
  if (!state?.partial) return null;
  if (state.mask.length !== width * height) throw new Error(`the subterrains' mask is for ${state.mask.length} corners, the terrain has ${width * height}`);
  const corners = new Uint8Array(width * height);
  const locked: number[] = [];
  for (let i = 0; i < corners.length; i++) {
    const m = state.mask.charCodeAt(i) - 48;
    if (m !== CLOSED && m !== HALO && m !== OPEN) throw new Error(`the subterrains' mask holds "${state.mask[i]}"`);
    corners[i] = m;
    if (m !== OPEN) locked.push(i);
  }
  const tw = width - 1, th = height - 1, hiddenTiles = new Uint8Array(Math.max(0, tw * th)), haloTiles = new Uint8Array(hiddenTiles.length);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const four = [corners[y * width + x], corners[y * width + x + 1], corners[(y + 1) * width + x], corners[(y + 1) * width + x + 1]];
    if (four.includes(CLOSED)) hiddenTiles[y * tw + x] = 1;
    else if (four.includes(HALO)) haloTiles[y * tw + x] = 1;
  }
  return { width, height, corners, hiddenTiles, haloTiles, locked };
}

/** The state of the corner nearest to world point (x, y) on a terrain at (offsetX, offsetY). */
export function cornerStateAt(m: PartialMask, offsetX: number, offsetY: number, x: number, y: number): number {
  const cx = Math.round((x - offsetX) / 128), cy = Math.round((y - offsetY) / 128);
  if (cx < 0 || cy < 0 || cx >= m.width || cy >= m.height) return CLOSED;
  return m.corners[cy * m.width + cx];
}

/** Whether an object at world (x, y) may be placed or moved there: it lies in an open subterrain (by ownership: the
 *  corner at or south-west of it is open, as the backend's owner rule measures rectangles from their corners). */
export function editableAt(m: PartialMask | null, offsetX: number, offsetY: number, x: number, y: number): boolean {
  if (!m) return true;
  const cx = Math.floor((x - offsetX) / 128), cy = Math.floor((y - offsetY) / 128);
  if (cx < 0 || cy < 0 || cx >= m.width || cy >= m.height) return false;
  return m.corners[cy * m.width + cx] === OPEN;
}

/** Whether every corner of the box (corner coordinates, inclusive) is open; corners off the map don't count (an edit
 *  never reaches them). */
export function cornersOpen(m: PartialMask | null, x0: number, y0: number, x1: number, y1: number): boolean {
  if (!m) return true;
  for (let y = Math.max(0, y0); y <= Math.min(m.height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(m.width - 1, x1); x++) if (m.corners[y * m.width + x] !== OPEN) return false;
  }
  return true;
}

/** What a refused placement, paste or move of objects says when a spot lies outside the open subterrains. */
export function notOpenText(what: string, x: number, y: number): string {
  return `${what} ${Math.round(x)}, ${Math.round(y)} isn't in an open subterrain (the dimmed strip and the closed area are read-only). Open Subterrains… opens it.`;
}

/** The open subterrains' cells of a new pathing map `made` (war3map.wpm: 16 bytes of header, width and height at 8 and
 *  12, then the cells, rows from the south) over the stored one `stored`: a cell keeps the stored value unless its tile's
 *  south-west corner is open (the tile's owner). Nothing stored, or another size: `made` as it is. */
export function mergeOpenPathing(made: Uint8Array, stored: Uint8Array | null, partial: PartialMask): Uint8Array {
  const v = new DataView(made.buffer, made.byteOffset), w = v.getUint32(8, true), h = v.getUint32(12, true);
  if (!stored || stored.length !== made.length) return made;
  const sv = new DataView(stored.buffer, stored.byteOffset);
  if (sv.getUint32(8, true) !== w || sv.getUint32(12, true) !== h) return made;
  const out = made.slice();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const tx = x >> 2, ty = y >> 2;
    if (partial.corners[ty * partial.width + tx] !== OPEN) out[16 + y * w + x] = stored[16 + y * w + x];
  }
  return out;
}

/** "3 of 16 subterrains open" for a status line. */
export function openSummary(state: OpenState): string {
  const open = state.subterrains.filter((s) => s.open).length;
  return `${open} of ${state.subterrains.length} subterrain${state.subterrains.length === 1 ? "" : "s"} open`;
}
