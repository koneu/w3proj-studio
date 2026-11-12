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

function fromImage(img: PathImage): Footprint {
  const mask = new Uint8Array(img.width * img.height);
  for (let i = 0; i < mask.length; i++) mask[i] = img.rgba[i * 4] > 127 ? 1 : 0;
  return { width: img.width, height: img.height, mask };
}

/** A filled circle of `radius` world units. */
function circle(radius: number): Footprint {
  const n = Math.max(1, Math.round((radius * 2) / 32));
  const mask = new Uint8Array(n * n), c = (n - 1) / 2, r = Math.max(0.5, radius / 32);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) mask[y * n + x] = Math.hypot(x - c, y - c) <= r ? 1 : 0;
  return { width: n, height: n, mask };
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
    const pathing = generatePathing({ terrain, margins: data.margins, tileRules: data.tileRules }).subarray(16);
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
