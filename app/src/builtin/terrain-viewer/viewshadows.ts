// Shadows in the terrain view (View > Shadows), as the World Editor's classic view draws them:
//
// - The ground's shadow map, one value per 32 × 32 cell (four per tile): the map's baked war3map.shd (doodads and
//   the terrain itself; Studio predicts the cells unsaved edits change, as saving writes them: shadows.ts), with
//   the shadow images of buildings (UnitSkin.txt `buildingShadow`) and destructables (`shadow`: trees, gates,
//   barrels) put in where they stand. Those images (ReplaceableTextures\Shadows) are a texel per cell too, with
//   one red texel where the object stands. The ground takes it filtered between cells.
// - Units' shadow textures (`unitShadow`, mostly the round Shadow.blp), over the rectangle shadowX, shadowY,
//   shadowW, shadowH gives, draped over the ground.
//
// How dark each is was measured against the World Editor (we-drive, SHADOW_LOOK).

import type { DecodedImage } from "../../lib/image/index";
import type { Terrain } from "../../lib/terrain/w3e";
import type { Placed, Skin } from "./objects";
import { updateShadows } from "./shadows";

/**
 * How the World Editor's classic view draws shadows (we-drive, SD, 2026-11-09; the ground with View > Shadows on over
 * off, the same with game view on; Studio's pictures, also on over off, fitted to them by shift and scale):
 * - a cell of war3map.shd in full shadow keeps 0.65 of the ground's colour (cliff.w3m's own cells; TwistedMeadows'
 *   0.63), in the same place and with the same soft edge as Studio's cells filtered between texels (cliff.w3m's
 *   profile across the edge within 0.03);
 * - the objects' shadow images keep 0.59 (the barrel ShadowCrates and four trees' BuildingShadowSmall on a test map)
 *   and lie north-east of their cells: the barrel's 29 and 39 units east and north of the anchor cell's middle, the
 *   trees' 31 and 6 (`stampShift` is their mean);
 * - a footman's Shadow.blp, alpha 0.75 in the middle, keeps 0.51 there (map 03, the same by channel): its alpha
 *   darkens by 0.57 with the soft edge counted (fitted scale over the whole shadow: footmen 1.07, a gryphon 0.90).
 */
export const SHADOW_LOOK = { baked: 0.35, stamp: 0.41, unit: 0.57, stampShift: [30, 22] as [number, number] };

/**
 * The shadows of a graphics mode (tone.ts: 1 classic, 2 HD). The World Editor's HD view casts real shadows of the
 * models instead (a footman's shape, keeping about 0.66 under map 03's light; lighter than the lit ground under
 * cliff.w3m's shadow intensity 5.85), and draws no war3map.shd at all (cliff.w3m's cells: the same picture with View >
 * Shadows on and off). Studio casts those too (the terrain renderer's sun shadow map, lib/model/sunshadow.ts); HD keeps
 * the classic objects' shadows here only for a GPU that can't draw the shadow map, and leaves the baked map out.
 */
export function shadowLookFor(tone: number): typeof SHADOW_LOOK {
  return tone === 2 ? { ...SHADOW_LOOK, baked: 0 } : SHADOW_LOOK;
}

/** A shadow image: its alpha (rows from the north), and the texel the object stands on. */
export interface ShadowImage {
  width: number;
  height: number;
  alpha: Uint8Array;
  anchor: [number, number];
}

/** The game's file of a shadow image by its table name ("ShadowCrates" or "ShadowCrates.blp"). */
export function shadowImagePath(name: string): string {
  return `ReplaceableTextures\\Shadows\\${name.replace(/\.(blp|dds|tga)$/i, "")}.blp`;
}

/** A shadow image from its decoded pixels (RGBA, rows from the top): the anchor is the red texel (a red channel
 *  over half, which nothing else in these black images has), else the middle. */
export function shadowImage(width: number, height: number, rgba: ArrayLike<number>): ShadowImage {
  const alpha = new Uint8Array(width * height);
  let anchor: [number, number] | null = null;
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = rgba[i * 4 + 3];
    if (!anchor && rgba[i * 4] > 127) anchor = [i % width, Math.floor(i / width)];
  }
  return { width, height, alpha, anchor: anchor ?? [Math.floor(width / 2), Math.floor(height / 2)] };
}

/** The shadow grid's size for a terrain: four cells per tile each way. */
export function shadowGridSize(t: Pick<Terrain, "width" | "height">): [number, number] {
  return [(t.width - 1) * 4, (t.height - 1) * 4];
}

/** A shadow image put into the grid where an object stands: its anchor texel on the cell holding (x, y), each
 *  texel taking the darker of the two. */
export function stampShadow(grid: Uint8Array, t: Pick<Terrain, "width" | "height" | "offsetX" | "offsetY">, x: number, y: number, img: ShadowImage) {
  const [w, h] = shadowGridSize(t);
  const ax = Math.floor((x - t.offsetX) / 32), ay = Math.floor((y - t.offsetY) / 32);
  for (let j = 0; j < img.height; j++) {
    const cy = ay + (img.anchor[1] - j);
    if (cy < 0 || cy >= h) continue;
    for (let i = 0; i < img.width; i++) {
      const cx = ax + (i - img.anchor[0]);
      if (cx < 0 || cx >= w) continue;
      const a = img.alpha[j * img.width + i];
      if (a > grid[cy * w + cx]) grid[cy * w + cx] = a;
    }
  }
}

/** The skin of a placed object, its type's own or its base's. */
type SkinOf = (p: Placed) => Skin | undefined;

/** Where each building's and destructable's shadow image goes: the placed objects whose type names one. */
export function shadowStamps(objects: readonly Placed[], skinOf: SkinOf): { x: number; y: number; name: string }[] {
  const out: { x: number; y: number; name: string }[] = [];
  for (const p of objects) {
    const name = skinOf(p)?.buildingShadow;
    if (name) out.push({ x: p.position[0], y: p.position[1], name });
  }
  return out;
}

/** The ground's shadow map, two bytes per cell: the baked map (or none), and the objects' shadow images put in where
 *  they stand (the World Editor draws those darker and half a cell over: SHADOW_LOOK). A baked map of another size
 *  than the terrain's grid (a damaged file) is left out rather than drawn shifted. */
export function groundShadows(t: Pick<Terrain, "width" | "height" | "offsetX" | "offsetY">, baked: Uint8Array | null,
  stamps: readonly { x: number; y: number; image: ShadowImage }[]): Uint8Array {
  const [w, h] = shadowGridSize(t);
  const stamped = new Uint8Array(w * h);
  for (const s of stamps) stampShadow(stamped, t, s.x, s.y, s.image);
  const out = new Uint8Array(w * h * 2);
  const useBaked = baked && baked.length === w * h ? baked : null;
  for (let i = 0; i < w * h; i++) {
    out[i * 2] = useBaked ? useBaked[i] : 0;
    out[i * 2 + 1] = stamped[i];
  }
  return out;
}

/** A unit's shadow texture over the ground: its south-west corner, size and texture. */
export interface UnitShadow { x0: number; y0: number; w: number; h: number; texture: string }

/** The units' shadow textures: units whose type has one (not buildings: theirs is a shadow image), at
 *  (x - shadowX, y - shadowY), shadowW × shadowH. */
export function unitShadows(units: readonly Placed[], skinOf: SkinOf): UnitShadow[] {
  const out: UnitShadow[] = [];
  for (const p of units) {
    const s = skinOf(p);
    if (!s?.unitShadow || s.buildingShadow) continue;
    const w = s.shadowW ?? 0, h = s.shadowH ?? 0;
    if (!(w > 0 && h > 0)) continue;
    out.push({ x0: p.position[0] - (s.shadowX ?? 0), y0: p.position[1] - (s.shadowY ?? 0), w, h, texture: shadowImagePath(s.unitShadow) });
  }
  return out;
}

/** What the view's shadows draw into: the terrain renderer's part. */
export interface ShadowTarget {
  setShadowMap(values: Uint8Array | null, width?: number, height?: number): void;
  setUnitShadows(list: UnitShadow[]): void;
  setSplatTexture(path: string, img: DecodedImage): void;
}

/** The stored shadow map: its bytes, absent (no file) or unreadable (there, but it couldn't be read). */
export type Baked = { bytes: Uint8Array } | "absent" | "unreadable";

export interface ShadowSources {
  terrain: Terrain;
  target: ShadowTarget;
  /** war3map.shd as the project has it now. */
  readBaked: () => Promise<Baked>;
  /** A game file (or the map's import of it), decoded. */
  readImage: (path: string) => Promise<DecodedImage>;
  /** The shadow prediction of a terrain and its doodads (shadowmap.ts predictShadows, which awaits `pause` between
   *  steps and stops when it returns false), null where nothing's edited. */
  predict: ((t: Terrain, doodads: Placed[], pause: () => Promise<boolean>) => Promise<Uint8Array>) | null;
  /** Something changed in the picture. */
  redraw: () => void;
}

/**
 * The terrain view's shadows: keeps the ground's shadow map and the units' shadow textures up to date as the
 * objects, the stored war3map.shd and unsaved edits change. Every step that waits takes a number: one overtaken by
 * a later one drops its result, so an old prediction or image never lands over a newer state, and nothing is drawn
 * after dispose.
 */
export class ViewShadows {
  private baked: Baked = "absent";
  /** The stored map with the cells unsaved edits change predicted, as saving would write them (null: as stored). */
  private edited: Uint8Array | null = null;
  private stamps: { x: number; y: number; name: string }[] = [];
  private images = new Map<string, Promise<ShadowImage | null>>();
  private textures = new Set<string>();
  /** The prediction of the state last saved, by what it was made from (it's the same until the next save). */
  private before: { key: unknown; doodads: Placed[]; value: Promise<Uint8Array> } | null = null;
  private composeGen = 0;
  private editGen = 0;
  private bakedGen = 0;
  private disposed = false;

  constructor(private readonly s: ShadowSources) {}

  /** Reads the stored shadow map again (on opening, and after it was written): unsaved edits on top of it are
   *  predicted again by the next `editsChanged`. */
  async reloadBaked() {
    const gen = ++this.bakedGen;
    const baked = await this.s.readBaked().catch((): Baked => "unreadable");
    if (gen !== this.bakedGen || this.disposed) return;
    this.baked = baked;
    this.edited = null;
    this.before = null;
    await this.compose();
  }

  /** The placed objects changed: buildings' and destructables' shadow images, units' shadow textures. */
  async objectsChanged(units: readonly Placed[], doodads: readonly Placed[], skinOf: (p: Placed) => Skin | undefined) {
    this.stamps = shadowStamps([...units, ...doodads], skinOf);
    const blobs = unitShadows(units, skinOf);
    this.s.target.setUnitShadows(blobs);
    for (const tex of new Set(blobs.map((b) => b.texture))) {
      const key = tex.toLowerCase();
      if (this.textures.has(key)) continue;
      this.textures.add(key);
      void this.s.readImage(tex).then((img) => {
        if (this.disposed) return;
        this.s.target.setSplatTexture(tex, img);
        this.s.redraw();
      }, () => { /* no texture, no shadow */ });
    }
    this.s.redraw();
    await this.compose();
  }

  /**
   * Unsaved edits changed the terrain or the doodads: the cells whose predicted shadow differs between the state
   * last saved (`saved`: its terrain named by `key`, and its doodads; the same two objects until the next save) and
   * now take the prediction, as saving will write them. An unreadable stored map isn't predicted over (its cells are
   * unknown); without one the prediction is all there is.
   */
  async editsChanged(saved: { key: unknown; terrain: () => Terrain; doodads: Placed[] }, now: Placed[]) {
    const predict = this.s.predict;
    if (!predict || this.baked === "unreadable") return;
    const gen = ++this.editGen, bakedGen = this.bakedGen;
    // The work waits for the page in between, and stops once it's no longer wanted: the saved state's prediction when
    // the stored map is read again (a save), the current one when the next edit asks for another.
    const pause = (wanted: () => boolean) => () => new Promise<boolean>((done) => setTimeout(() => done(!this.disposed && wanted()), 0));
    let cached = this.before;
    if (!cached || cached.key !== saved.key || cached.doodads !== saved.doodads) {
      const entry: NonNullable<ViewShadows["before"]> = { key: saved.key, doodads: saved.doodads, value: Promise.resolve(new Uint8Array(0)) };
      entry.value = predict(saved.terrain(), saved.doodads, pause(() => this.before === entry));
      // A failed (or stopped) prediction of the saved state isn't kept: the next edit tries again.
      entry.value.catch(() => { if (this.before === entry) this.before = null; });
      cached = this.before = entry;
    }
    const result = await Promise.all([cached.value, predict(this.s.terrain, now, pause(() => gen === this.editGen))]).catch(() => null);
    // The stored map was read again meanwhile (a save wrote it): this prediction was against the old one.
    if (gen !== this.editGen || bakedGen !== this.bakedGen || this.disposed || !result) return;
    const [before, after] = result;
    const baked = this.baked;
    this.edited = updateShadows(typeof baked === "object" ? baked.bytes : null, before, after);
    await this.compose();
  }

  /** An edit was made: a prediction under way read the terrain as it was, and is dropped (the next
   *  `editsChanged` starts over). */
  editing() {
    this.editGen++;
  }

  /** Puts the ground's shadow map together from what's known now and hands it to the renderer. */
  private async compose() {
    const gen = ++this.composeGen;
    const names = [...new Set(this.stamps.map((s) => s.name))];
    const imgs = new Map(await Promise.all(names.map(async (n) => [n, await this.image(n)] as const)));
    if (gen !== this.composeGen || this.disposed) return;
    const base = this.edited ?? (typeof this.baked === "object" ? this.baked.bytes : null);
    const stamps = this.stamps.flatMap((s) => { const image = imgs.get(s.name); return image ? [{ x: s.x, y: s.y, image }] : []; });
    const [w, h] = shadowGridSize(this.s.terrain);
    this.s.target.setShadowMap(base || stamps.length ? groundShadows(this.s.terrain, base, stamps) : null, w, h);
    this.s.redraw();
  }

  /** How many objects put a shadow image on the ground (those last given to `objectsChanged` whose skin has one). */
  get stampCount(): number {
    return this.stamps.length;
  }

  private image(name: string): Promise<ShadowImage | null> {
    const key = name.toLowerCase();
    let p = this.images.get(key);
    if (!p) {
      const path = shadowImagePath(name);
      p = this.s.readImage(path).then((img) => { const m = img.mip(0); return shadowImage(m.width, m.height, m.rgba); }, () => null);
      this.images.set(key, p);
    }
    return p;
  }

  dispose() {
    this.disposed = true;
  }
}
