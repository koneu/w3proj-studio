// war3mapMap.blp: the 256×256 minimap picture. The World Editor draws the
// playable area (inside the camera margins), scaled to fit with its aspect
// ratio kept, centred on black. The rules, measured on its pictures of
// cliff.w3m (2026-11-11: Export Minimap's TGA and the war3mapMap.blp of its
// saves; heights, slopes and texture variations change nothing):
// - every tile point colours the tile to its north-east, in one flat colour:
//   its ground texture's smallest mip level (1×1 in the game's files, which
//   differs from the full-size picture's plain average);
// - a tile point next to a cliff (the layers around it differ) takes its cliff
//   type's texture's smallest mip instead: cliffs and the ground just around
//   them show lighter than grass;
// - every pixel's brightness is scattered by up to ±10 % (the editor's grain,
//   white noise, uniform, the same factor on all three channels).
// Water and doodads, measured on HillsbradCreek's and SnowareBay's own
// war3mapMap.blp (2026-11-12; the World Editor's SD save writes the same picture):
// - water lays the tileset's minimap water colour (Water.slk mmRed/Green/Blue)
//   over the ground at mmAlpha (64: a quarter), and deep water, too deep to walk
//   (pathing's DEEP_WATER), a second time;
// - a doodad or destructable shown on the minimap (showInMM) is a dot in its
//   minimap colour (useMMColor), else in its model's texture's smallest mip
//   colour (the Lordaeron rocks grey, the Ruins rocks green), as big as its
//   pathing texture (a 4×4 one, trees: about a tile; rock spires 12×12: three);
// - a gate, a wall or a rock spire (a pathing texture that isn't one full square) is drawn as its texture's cells
//   (non-black ones, 4 per tile), turned by its angle (the textures are drawn for 270°): SnowareBay's gates are strips
//   5 tiles by 1 and 22×22 diagonals in the editor's export (we-drive 2026-11-13, and on a probe map of isolated
//   objects), in the colour of the gate model's wall texture, not a grey disc.
// Where and how sharp, measured on the editor's Export Minimap of seven maps (2026-11-13: HillsbradCreek, TurtleRock,
// MurgulOasis, Deadlock, SnowareBay, NorthernIsles, cliff.w3m; we-drive --export-minimap):
// - the drawn area is whole pixels: the larger side fills the picture, the other is rounded down and centred;
// - a pixel shows what lies under its bottom-left corner (a centre-sampled picture is half a pixel off wherever a
//   tile isn't a whole number of pixels);
// - one 3×3 tent pass softens it, inside the drawn area (the black bands keep a sharp edge);
// - values are cut to whole numbers, not rounded.

import { DEEP_WATER } from "../../lib/terrain/pathing";
import type { Terrain } from "../../lib/terrain/w3e";

export type Rgb = [number, number, number];

export interface MinimapInput {
  terrain: Terrain;
  /** Unplayable border in tiles: left, right, bottom, top (w3i). */
  margins: [number, number, number, number];
  /** Colour of a ground tile type: its texture's smallest mip level. */
  tileColor: (tileId: string) => Rgb;
  /** The ground tile each slot of the terrain's list is drawn with (w3e.ts drawnGroundTiles: the tileset's own list
   *  under "custom tilesets" 0, as the World Editor's minimap shows it); left out, the terrain's own list. */
  drawnTiles?: readonly string[];
  /** Colour of a cliff type (CliffTypes.slk id): its texture's smallest mip level; null when it isn't known. Left
   *  out or null, cliffs show their ground's colour. */
  cliffColor?: (cliffId: string) => Rgb | null;
  /** The tileset's minimap water colour (Water.slk mmRed/Green/Blue). */
  waterColor: Rgb;
  /** How much the water colour covers the ground, 0–1 (Water.slk mmAlpha / 255); a quarter when left out. */
  waterAlpha?: number;
  /** Doodads/destructables shown on the minimap, in their minimap colour; `size`: the side of their pathing texture
   *  in tiles (1 when left out), which scales the dot. */
  objects: MinimapObject[];
  /** Look of the render (settings "terrain.minimap.*"). */
  params?: Partial<MinimapParams>;
  // Export Minimap's options; left out, the picture is war3mapMap.blp's.
  /** Side of the square picture in pixels (MINIMAP_SIZE). */
  size?: number;
  /** The ground's colours and the water (both on by default); without the ground it is black. Blight (off by default)
   *  colours blighted ground in `blightColor`. */
  show?: { terrain?: boolean; water?: boolean; blight?: boolean };
  /** The tileset's blight texture's smallest mip level (WorldEditData's [TileSets]); null when it isn't known. */
  blightColor?: Rgb | null;
  /** The whole map, unplayable border included, instead of the playable area. */
  wholeMap?: boolean;
  /** Per pathing cell over the whole map (4 per tile, rows from the south), RGBA blended over the ground. */
  overlay?: { rgba: Uint8Array; width: number; height: number };
  /** Units and items, as squares in their owner's colour. */
  units?: { x: number; y: number; rgb: Rgb }[];
  /** Regions (world rectangles), filled see-through and outlined, over the smoothed picture. */
  regions?: { left: number; bottom: number; right: number; top: number; rgb: Rgb }[];
  /** Preview icons (gold mines, neutral buildings, start locations) at world points, `tint` multiplied in. */
  icons?: { x: number; y: number; image: { width: number; height: number; rgba: ArrayLike<number> }; tint?: Rgb }[];
}

/** A pathing texture's cells (4 per tile; row 0 north) that block something. */
export interface PathMask { width: number; height: number; cells: Uint8Array }

/** `mask` (the object's pathing texture) is drawn as it is, turned by `angle` (radians, as placed: the textures
 *  are drawn for 270°); without it a dot of `size` tiles stands for the object. */
export interface MinimapObject {
  x: number; y: number; rgb: Rgb;
  /** The side of its pathing texture in tiles (1 when left out), a square one; `cells` (its width and height in
   *  pathing cells, 4 a tile) wins. Its dot is the tiles it reaches, see `dotReach`. */
  size?: number;
  cells?: [number, number];
  mask?: PathMask; angle?: number;
}

/** The tiles the dot of a doodad covers along one axis, from its centre `u` (in tiles from the map's corner) and its
 *  pathing texture's `cells` across: every tile that [u - a, u + a] touches, a = (cells - 2) / 8 tiles (0 without a
 *  pathing texture: the one tile it stands in). The World Editor's minimap, measured with 4x4, 6x6, 8x8 and 12x12
 *  textures swept over a tile in steps of 4 units (we-drive 2026-11-17): a 4x4 rock reaches two tiles within a quarter
 *  tile of a tile edge and one tile otherwise, an 8x8 one two or three, a 12x12 one three or four. */
export function dotReach(u: number, cells: number): [number, number] {
  const a = Math.max(0, (cells - 2) / 8);
  return [Math.floor(u - a), Math.floor(u + a)];
}

/** The World Editor's smoothing of tile edges, as a curve on the share of the picture a colour has in the (bilinear)
 *  mix of the four tiles around a pixel: a pixel with a third or less of a colour has none of it, with two thirds or
 *  more all of it, between linear. Measured on its dots at 4 and 2 pixels a tile (a pixel on a tile's edge takes
 *  7/8 of its own tile and 1/8 of the one across; one on its corner 0.17 of its own tile when only that is the colour,
 *  0.87 when a neighbour has it too). */
export function sharpShare(b: number): number {
  return Math.min(1, Math.max(0, 0.5 + 3 * (b - 0.5)));
}

/** How big a preview icon is on a 256 pixel minimap. */
export const ICON_SIZE = 16;

export interface MinimapParams {
  /** Ground colours relative to the texture's smallest mip level. */
  groundBrightness: number;
  /** How far the grain scatters a pixel's brightness (0.1: ±10 %), 0 for flat colours. */
  groundNoise: number;
  /** Radius of the dot of an object with a 4×4 pathing texture (a tile), in tiles. */
  /** Radius of a unit's square (a 4x4 doodad's dot is in whole tiles, see `dotReach`). */
  objectRadius: number;
  /** 0: hard tile edges; else the World Editor's smoothing (`sharpShare`, once whatever the number). */
  blurPasses: number;
}

/** The World Editor's look (see the top). */
export const DEFAULT_MINIMAP: MinimapParams = {
  groundBrightness: 1,
  groundNoise: 0.1,
  objectRadius: 0.7,
  blurPasses: 1,
};

export const MINIMAP_SIZE = 256;
/** Water.slk's mmAlpha of every tileset's water (64 of 255). */
const WATER_ALPHA = 64 / 255;

/** Where world points are on a minimap picture of `size` pixels, and back (the terrain view's minimap panel: a click
 *  moves the camera there, the view's outline is drawn on it). The same mapping renderMinimap draws with. */
export function minimapFrame(t: Pick<Terrain, "width" | "height" | "offsetX" | "offsetY">, margins: [number, number, number, number], size: number, wholeMap = false) {
  const [ml, mr, mb, mt] = wholeMap ? [0, 0, 0, 0] : margins;
  const N = Math.max(1, Math.round(size));
  const pw = Math.max(1, t.width - 1 - ml - mr), ph = Math.max(1, t.height - 1 - mb - mt);
  const scale = N / Math.max(pw, ph);
  // The World Editor's box (measured on its exports of 130×136 and 108×86 playable areas): whole pixels, the larger
  // side filling the picture, the other rounded down and centred, the odd pixel to the right or below.
  const w = Math.min(N, Math.floor(pw * scale + 1e-6)), h = Math.min(N, Math.floor(ph * scale + 1e-6));
  const left = Math.floor((N - w) / 2), top = Math.floor((N - h) / 2);
  const sx = w / pw, sy = h / ph;
  return {
    /** The drawn area in pixels: left, top, width, height. */
    box: [left, top, w, h] as [number, number, number, number],
    /** Pixels per tile across and down. */
    scale: [sx, sy] as [number, number],
    toPixel: (wx: number, wy: number): [number, number] => [left + ((wx - t.offsetX) / 128 - ml) * sx, top + h - ((wy - t.offsetY) / 128 - mb) * sy],
    toWorld: (px: number, py: number): [number, number] => [((px - left) / sx + ml) * 128 + t.offsetX, ((top + h - py) / sy + mb) * 128 + t.offsetY],
  };
}

/** The flat colour every tile point gives the tile to its north-east (RGB per point, rows from the south): its ground
 *  texture's, or next to a cliff (the layers of the points around it differ) its cliff type's, where it has one. A
 *  blighted point not coloured by a cliff takes `blight` when given (Export Minimap's Include Blight). `drawn`: the
 *  tile each ground slot is drawn with (MinimapInput.drawnTiles), by default the terrain's list. */
export function groundColors(t: Pick<Terrain, "width" | "height" | "corners" | "groundTiles" | "cliffTiles">,
  tileColor: (tileId: string) => Rgb, cliffColor?: (cliffId: string) => Rgb | null, blight?: Rgb | null,
  drawn: readonly string[] = t.groundTiles): Float32Array {
  const { width, height, corners } = t;
  const out = new Float32Array(width * height * 3);
  const layer = (x: number, y: number) => corners[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))].layer;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = corners[y * width + x];
      let nearCliff = false;
      for (let j = -1; j <= 1 && !nearCliff; j++) for (let i = -1; i <= 1; i++) if (layer(x + i, y + j) !== c.layer) { nearCliff = true; break; }
      const cliff = nearCliff ? t.cliffTiles?.[c.cliffTexture] : undefined;
      const color = cliff !== undefined ? cliffColor?.(cliff) : null;
      out.set(color ?? (blight && c.blight ? blight : tileColor(drawn[c.texture])), (y * width + x) * 3);
    }
  }
  return out;
}

/** The grain of pixel (x, y): 0–1, evenly spread, the same on every drawing (a saved minimap doesn't change by
 *  itself). */
export function grainAt(x: number, y: number): number {
  let h = (Math.imul(y, 65536) + x) ^ 0x9e3779b9;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** RGBA pixels, rows top to bottom (north up). */
export function renderMinimap(input: MinimapInput): Uint8ClampedArray {
  const { terrain: t, tileColor, waterColor } = input;
  const [ml, , mb] = input.wholeMap ? [0, 0, 0, 0] : input.margins;
  const P ={ ...DEFAULT_MINIMAP, ...input.params };
  const N = Math.max(1, Math.round(input.size ?? MINIMAP_SIZE));
  const showGround = input.show?.terrain !== false, showWater = input.show?.water !== false;
  const overlay = input.overlay;
  const frame = minimapFrame(t, input.margins, N, input.wholeMap);
  const [left, top, boxW, boxH] = frame.box;
  const scale = Math.max(...frame.scale); // pixels per tile
  const clampX = (x: number) => Math.min(t.width - 1, Math.max(0, x)), clampY = (y: number) => Math.min(t.height - 1, Math.max(0, y));
  const C = (x: number, y: number) => t.corners[clampY(y) * t.width + clampX(x)];
  const waterAlpha = Math.min(1, Math.max(0, input.waterAlpha ?? WATER_ALPHA));
  const img = new Float32Array(N * N * 3);
  /** Where the ground is drawn (the grain goes there, not on the black around it or on dots and squares). */
  const grain = new Uint8Array(N * N);
  const ground = showGround ? groundColors(t, tileColor, input.cliffColor, input.show?.blight ? input.blightColor : null, input.drawnTiles) : null;
  /** Where pixel (px, py) samples the map, in tiles from the drawn area's bottom-left: the pixel's bottom-left corner
   *  (the World Editor's tile edges fall half a pixel right of and above a centre-sampled picture's). */
  const sample = (px: number, py: number): [number, number] => [(px - left) / frame.scale[0], (top + boxH - 1 - py) / frame.scale[1]];
  /** Whether a pixel is in the drawn area (the playable area, or the whole map): objects past it aren't drawn, as the
   *  World Editor's Playable Area Only cuts the trees past the playable area's edges. */
  const drawn = (px: number, py: number) => px >= left && py >= top && px < left + boxW && py < top + boxH;

  // The doodads' dots: the tiles each reaches (dotReach), in its colour (the later one over the earlier).
  const dotAt = new Int32Array(t.width * t.height).fill(-1);
  const dotRgb: Rgb[] = [];
  for (const o of input.objects) {
    if (o.mask) continue;
    let cx = o.cells?.[0] ?? (o.size ?? 1) * 4, cy = o.cells?.[1] ?? (o.size ?? 1) * 4;
    // The textures are drawn for 270 degrees: nearer 0 or 180 the footprint is turned a quarter.
    if (o.angle !== undefined && Math.abs(Math.cos(o.angle)) > Math.SQRT1_2) [cx, cy] = [cy, cx];
    const [x0, x1] = dotReach((o.x - t.offsetX) / 128, cx), [y0, y1] = dotReach((o.y - t.offsetY) / 128, cy);
    let id = dotRgb.findIndex((c) => c[0] === o.rgb[0] && c[1] === o.rgb[1] && c[2] === o.rgb[2]);
    if (id < 0) id = dotRgb.push(o.rgb) - 1;
    for (let y = Math.max(0, y0); y <= Math.min(t.height - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(t.width - 1, x1); x++) dotAt[y * t.width + x] = id;
    }
  }
  const sharp = P.blurPasses > 0;
  /** The colours (RGB triples in `buf` at the offsets `at[0..n)`) of the tiles a pixel mixes, weighted by `w`, as the
   *  World Editor smooths tile edges: each colour's share of the weights goes through `sharpShare`, then they are mixed. */
  const mixed = (out: number[], buf: Float32Array, at: number[], w: number[], n: number) => {
    const same = (a: number, b: number) => buf[at[a]] === buf[at[b]] && buf[at[a] + 1] === buf[at[b] + 1] && buf[at[a] + 2] === buf[at[b] + 2];
    let sum = 0, best = 0, bestShare = -1;
    out[0] = out[1] = out[2] = 0;
    for (let a = 0; a < n; a++) {
      let dup = false;
      for (let b = 0; b < a && !dup; b++) dup = same(a, b);
      if (dup) continue;
      let share = w[a];
      for (let b = a + 1; b < n; b++) if (same(a, b)) share += w[b];
      if (share > bestShare) { bestShare = share; best = a; }
      const s = sharpShare(share);
      sum += s;
      for (let k = 0; k < 3; k++) out[k] += s * buf[at[a] + k];
    }
    // None had a third of the weights: the one with the most.
    if (sum <= 1e-6) { for (let k = 0; k < 3; k++) out[k] = buf[at[best] + k]; return; }
    for (let k = 0; k < 3; k++) out[k] /= sum;
  };
  const colour = [0, 0, 0];
  const tileOffsets: number[] = [];
  /** The tiles (their point's index) a pixel mixes and their weights: its own, and across each tile edge it is on, a
   *  third of the weights as if it were an eighth of a tile from the edge, whatever the scale (measured at 4 and 2
   *  pixels a tile: an edge pixel is 7/8 its own tile, a corner pixel's own tile alone 0.17). */
  const tileList: number[] = [], tileWeights: number[] = [];
  let tileCount = 0;
  const tileOfX = (p: number) => Math.floor((p - left) / frame.scale[0] + ml), tileOfY = (p: number) => Math.floor((top + boxH - 1 - p) / frame.scale[1] + mb);
  /** [offset in tiles, weight] along one axis: `lo`/`hi`: whether the pixel is on the tile's edge at that side. */
  const axisTiles = (lo: boolean, hi: boolean): [number, number][] => (lo && hi ? [[0, 0.625], [-1, 0.1875], [1, 0.1875]] : lo ? [[0, 0.625], [-1, 0.375]] : hi ? [[0, 0.625], [1, 0.375]] : [[0, 1]]);

  for (let py = 0; py < N; py++) {
    for (let px = 0; px < N; px++) {
      // Tiles from the playable area's bottom-left.
      if (!drawn(px, py)) continue;
      const [fx, fy] = sample(px, py);
      const gx = fx + ml, gy = fy + mb;
      const x0 = Math.floor(gx), y0 = Math.floor(gy), u = gx - x0, v = gy - y0;
      const q = [C(x0, y0), C(x0 + 1, y0), C(x0, y0 + 1), C(x0 + 1, y0 + 1)];
      const w = [(1 - u) * (1 - v), u * (1 - v), (1 - u) * v, u * v];
      const col = [0, 0, 0];
      // The tile's south-west point colours the whole tile; smoothed, the tiles across the edges it is on count too.
      tileCount = 0;
      if (sharp) {
        const tx = tileOfX(px), ty = tileOfY(py);
        const xs = axisTiles(px > left && tileOfX(px - 1) !== tx, px < left + boxW - 1 && tileOfX(px + 1) !== tx);
        // Rows count from the south: the row below the pixel is py + 1.
        const ys = axisTiles(py < top + boxH - 1 && tileOfY(py + 1) !== ty, py > top && tileOfY(py - 1) !== ty);
        for (const [dj, wy] of ys) for (const [di, wx] of xs) { tileList[tileCount] = clampY(ty + dj) * t.width + clampX(tx + di); tileWeights[tileCount++] = wx * wy; }
      } else {
        tileList[0] = clampY(y0) * t.width + clampX(x0); tileWeights[0] = 1; tileCount = 1;
      }
      if (ground) {
        for (let n = 0; n < tileCount; n++) tileOffsets[n] = tileList[n] * 3;
        mixed(colour, ground, tileOffsets, tileWeights, tileCount);
        for (let k = 0; k < 3; k++) col[k] = colour[k] * P.groundBrightness;
      }
      grain[py * N + px] = 1;
      let depth = 0;
      q.forEach((c, i) => { depth += (c.hasWater ? c.water - c.height : -64) * w[i]; });
      // The water colour over the ground, twice over water too deep to walk.
      for (let layer = 0; showWater && layer < (depth > DEEP_WATER ? 2 : depth > 0 ? 1 : 0); layer++) {
        for (let k = 0; k < 3; k++) col[k] = col[k] * (1 - waterAlpha) + waterColor[k] * waterAlpha;
      }
      if (overlay) {
        const cx = Math.floor(gx * 4), cy = Math.floor(gy * 4);
        if (cx >= 0 && cy >= 0 && cx < overlay.width && cy < overlay.height) {
          const o = (cy * overlay.width + cx) * 4, a = overlay.rgba[o + 3] / 255;
          for (let k = 0; k < 3; k++) col[k] = col[k] * (1 - a) + overlay.rgba[o + k] * a;
        }
      }
      if (dotRgb.length) {
        // The dots over it, each colour by its share of the four tiles, as the ground's.
        let total = 0;
        const shares: number[] = [];
        for (let n = 0; n < tileCount; n++) {
          const id = dotAt[tileList[n]];
          if (id < 0 || shares[id] !== undefined) continue;
          let share = 0;
          for (let m = n; m < tileCount; m++) if (dotAt[tileList[m]] === id) share += tileWeights[m];
          shares[id] = sharp ? sharpShare(share) : 1;
          total += shares[id];
        }
        if (total > 0) {
          const scaleDown = total > 1 ? 1 / total : 1;
          for (let k = 0; k < 3; k++) col[k] *= 1 - Math.min(1, total);
          shares.forEach((s, id) => { for (let k = 0; k < 3; k++) col[k] += s * scaleDown * dotRgb[id][k]; });
        }
      }
      img.set(col, (py * N + px) * 3);
    }
  }

  /** Pixel of a world point. */
  const at = frame.toPixel;
  const rad = P.objectRadius * scale;
  for (const o of input.objects) {
    const [cx, cy] = at(o.x, o.y);
    const m = o.mask;
    if (m) {
      // The pathing texture's cells, each pixel by its sample point (its bottom-left corner), turned back by the angle.
      const turn = o.angle === undefined ? 0 : o.angle + Math.PI / 2, cos = Math.cos(turn), sin = Math.sin(turn);
      const reach = Math.hypot(m.width, m.height) / 8, rx = reach * frame.scale[0] + 1, ry = reach * frame.scale[1] + 1;
      for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          if (x < 0 || y < 0 || x >= N || y >= N || !drawn(x, y)) continue;
          const dx = (x - cx) / frame.scale[0], dy = (cy - (y + 1)) / frame.scale[1];
          const lx = dx * cos + dy * sin, ly = dy * cos - dx * sin;
          const col = Math.floor(lx * 4 + m.width / 2), row = Math.floor(m.height / 2 - ly * 4);
          if (col < 0 || row < 0 || col >= m.width || row >= m.height || !m.cells[row * m.width + col]) continue;
          img.set(o.rgb, (y * N + x) * 3);
          grain[y * N + x] = 0;
        }
      }
      continue;
    }
  }
  // Units: squares a little wider than the doodads' dots, at least a pixel.
  const half = Math.max(0.5, rad * 1.2);
  for (const u of input.units ?? []) {
    const [cx, cy] = at(u.x, u.y);
    for (let y = Math.floor(cy - half); y < Math.ceil(cy + half); y++) {
      for (let x = Math.floor(cx - half); x < Math.ceil(cx + half); x++) {
        if (x >= 0 && y >= 0 && x < N && y < N && drawn(x, y)) { img.set(u.rgb, (y * N + x) * 3); grain[y * N + x] = 0; }
      }
    }
  }

  // The grain: over the smoothed picture, as the editor's isn't softened.
  if (P.groundNoise > 0) {
    for (let i = 0; i < N * N; i++) {
      if (!grain[i]) continue;
      const f = 1 + P.groundNoise * (2 * grainAt(i % N, Math.floor(i / N)) - 1);
      for (let k = 0; k < 3; k++) img[i * 3 + k] *= f;
    }
  }

  // Regions and icons stay sharp: drawn over the smoothed picture.
  const blend = (x: number, y: number, rgb: ArrayLike<number>, a: number) => {
    if (x < 0 || y < 0 || x >= N || y >= N || a <= 0) return;
    const i = (y * N + x) * 3;
    for (let k = 0; k < 3; k++) img[i + k] = img[i + k] * (1 - a) + rgb[k] * a;
  };
  for (const r of input.regions ?? []) {
    const [x0f, y1f] = at(r.left, r.bottom), [x1f, y0f] = at(r.right, r.top);
    const x0 = Math.round(x0f), x1 = Math.max(x0 + 1, Math.round(x1f)), y0 = Math.round(y0f), y1 = Math.max(y0 + 1, Math.round(y1f));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) blend(x, y, r.rgb, x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1 ? 1 : 0.35);
    }
  }
  const iconSide = Math.max(4, Math.round((ICON_SIZE * N) / MINIMAP_SIZE));
  for (const icon of input.icons ?? []) {
    const [cx, cy] = at(icon.x, icon.y), { width: iw, height: ih, rgba } = icon.image;
    const left = Math.round(cx - iconSide / 2), top = Math.round(cy - iconSide / 2);
    for (let y = 0; y < iconSide; y++) {
      for (let x = 0; x < iconSide; x++) {
        // Nearest texel of the icon's picture.
        const s = (Math.min(ih - 1, Math.floor(((y + 0.5) * ih) / iconSide)) * iw + Math.min(iw - 1, Math.floor(((x + 0.5) * iw) / iconSide))) * 4;
        const tint = icon.tint ?? [255, 255, 255];
        blend(left + x, top + y, [rgba[s] * tint[0] / 255, rgba[s + 1] * tint[1] / 255, rgba[s + 2] * tint[2] / 255], rgba[s + 3] / 255);
      }
    }
  }

  // Cut to whole values, not rounded: the World Editor's flat ground comes out 0.5–1.5 below the texture's colour
  // (whole-tile means on seven maps, 2026-11-13).
  const out = new Uint8ClampedArray(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    out[i * 4] = Math.floor(img[i * 3]);
    out[i * 4 + 1] = Math.floor(img[i * 3 + 1]);
    out[i * 4 + 2] = Math.floor(img[i * 3 + 2]);
    out[i * 4 + 3] = 255;
  }
  return out;
}
