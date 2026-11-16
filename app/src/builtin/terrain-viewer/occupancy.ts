// Where new objects fit: a grid of pathing cells (32×32) marking the ground
// that is already blocked (unwalkable terrain, cliffs, deep water, the map
// edge) and every placed object's footprint, the walk-blocking (red) part of
// its pathing texture or, for units, a circle of its collision size.

import { forEachStampCell, generatePathing, NO_WALK } from "../../lib/terrain/pathing";
import type { PathImage, PathingData } from "./pathmap";
import type { Placed } from "./objects";
import type { Terrain } from "../../lib/terrain/w3e";

/** Cells an object blocks, as an image (rows top to bottom), placed like a
 *  pathing texture: centred on the object, turned with its facing. */
export interface Footprint {
  width: number;
  height: number;
  mask: Uint8Array;
}

function fromImage(img: PathImage, noBuild = false): Footprint {
  const mask = new Uint8Array(img.width * img.height);
  for (let i = 0; i < mask.length; i++) mask[i] = img.rgba[i * 4] > 127 || (noBuild && img.rgba[i * 4 + 2] > 127) ? 1 : 0;
  return { width: img.width, height: img.height, mask };
}

/** A filled circle of `radius` world units. */
function circle(radius: number): Footprint {
  const n = Math.max(1, Math.round((radius * 2) / 32));
  const mask = new Uint8Array(n * n), c = (n - 1) / 2, r = Math.max(0.5, radius / 32);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) mask[y * n + x] = Math.hypot(x - c, y - c) <= r ? 1 : 0;
  return { width: n, height: n, mask };
}

/** What a placed object takes up for Replace Doodads (replace.ts roomCells): the blocking part of its pathing texture
 *  (doodads, destructables, buildings), a circle of its collision size (other units, items), or nothing (doodads
 *  without a texture, walkable destructables, start locations). */
export type RoomShape = Footprint | { radius: number } | null;

/** The RoomShape of an object type ("w3u" units, "w3t" items, else doodads and destructables). Items take 16 (the
 *  World Editor's isn't measured: one on a crate's quarter stops it). */
export async function roomShape(data: PathingData, id: string, kind: string): Promise<RoomShape> {
  if (kind === "w3t") return { radius: 16 };
  if (kind === "w3u") {
    if (id === "sloc") return null;
    const shape = data.unitShape(id);
    if (!shape) return { radius: 16 };
    const img = shape.path ? await data.texture(shape.path).catch(() => null) : null;
    // A building's footprint for Replace Units takes in the ground round it that nothing may be built on (the texture's
    // blue part: a barracks' 12x12 over its 8x8 of red; tests/we-compare/replace-units-overlap.json).
    return img ? fromImage(img, true) : { radius: shape.collision };
  }
  const info = data.placedTex(id);
  if (!info?.path || info.walkable) return null;
  const { image } = await data.placedImage(info);
  // The no-build (blue) cells count as well: a large rock's rounded corners stop a crate beside them
  // (tests/we-compare/replace-doodads-hillsbrad.json).
  return image ? fromImage(image, true) : null;
}

export class Occupancy {
  readonly w: number;
  readonly h: number;
  /** 1 = blocked. */
  readonly blocked: Uint8Array;
  private footprints = new Map<string, Promise<Footprint | null>>();

  private constructor(private terrain: Terrain, private data: PathingData) {
    this.w = (terrain.width - 1) * 4;
    this.h = (terrain.height - 1) * 4;
    // Painted Boundary doesn't count: doodads stand there (units and items are refused by onBoundary instead).
    const pathing = generatePathing({ terrain, margins: data.margins, tileRules: data.tileRules, ownTiles: data.ownTiles(terrain.tileset), waterOffset: data.waterOffset(terrain.tileset), boundary: false }).subarray(16);
    this.blocked = new Uint8Array(this.w * this.h);
    for (let i = 0; i < this.blocked.length; i++) if (pathing[i] & NO_WALK) this.blocked[i] = 1;
  }

  /** The grid for a terrain with the given placed objects on it. */
  static async build(terrain: Terrain, data: PathingData, placed: { entry: Placed; kind: string }[]): Promise<Occupancy> {
    const o = new Occupancy(terrain, data);
    for (const { entry, kind } of placed) {
      const fp = await o.footprint(entry.id, kind);
      if (fp) o.mark(fp, entry.position[0], entry.position[1], entry.angle);
    }
    return o;
  }

  /** Only the cells these placed objects cover, without the ground. */
  static async mask(terrain: Terrain, data: PathingData, placed: { entry: Placed; kind: string }[]): Promise<Uint8Array> {
    const o = new Occupancy(terrain, data);
    o.blocked.fill(0);
    for (const { entry, kind } of placed) {
      const fp = await o.footprint(entry.id, kind);
      if (fp) o.mark(fp, entry.position[0], entry.position[1], entry.angle);
    }
    return o.blocked;
  }

  /** Footprint of an object type ("w3u" units, "w3t" items, "w3b"/"w3d"). */
  footprint(id: string, kind: string): Promise<Footprint | null> {
    const key = `${kind}:${id}`;
    let f = this.footprints.get(key);
    if (!f) {
      f = (async () => {
        if (kind === "w3t") return circle(16);
        if (kind === "w3u") {
          if (id === "sloc") return null;
          const shape = this.data.unitShape(id);
          if (!shape) return circle(16);
          const img = shape.path ? await this.data.texture(shape.path) : null;
          return img ? fromImage(img) : circle(shape.collision);
        }
        const info = this.data.placedTex(id);
        // Walkable destructables (bridges) and texture-less doodads take no room.
        if (!info?.path || info.walkable) return null;
        // As the pathing map has it: the type's own texture when the map's isn't found.
        const { image: img } = await this.data.placedImage(info);
        return img ? fromImage(img) : null;
      })();
      this.footprints.set(key, f);
    }
    return f;
  }

  private cells(fp: Footprint, x: number, y: number, angle: number, fn: (i: number) => void) {
    forEachStampCell(this.terrain, this.w, this.h, { x, y, angle, width: fp.width, height: fp.height }, (cx, cy, pixel) => {
      if (fp.mask[pixel]) fn(cy * this.w + cx);
    });
  }

  /** Whether the footprint at (x, y) covers only free cells (and stays on the map). */
  fits(fp: Footprint, x: number, y: number, angle: number): boolean {
    const cx = (x - this.terrain.offsetX) / 32, cy = (y - this.terrain.offsetY) / 32;
    if (cx < 0 || cy < 0 || cx >= this.w || cy >= this.h) return false;
    let ok = true;
    this.cells(fp, x, y, angle, (i) => { if (this.blocked[i]) ok = false; });
    return ok;
  }

  mark(fp: Footprint, x: number, y: number, angle: number) {
    this.cells(fp, x, y, angle, (i) => { this.blocked[i] = 1; });
  }

  /** A copy to mark on without changing this one (a dry run's own objects), sharing the footprints. */
  copy(): Occupancy {
    const o = Object.create(Occupancy.prototype) as Occupancy;
    Object.assign(o, this, { blocked: this.blocked.slice() });
    return o;
  }
}
