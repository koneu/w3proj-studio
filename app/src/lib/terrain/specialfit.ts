// Whether the special doodads (war3map.doo's second list: caves, cliff collapses, ruined floors, placed by tile) still
// fit the cliff layers under them, and the list a cliff brush stroke leaves, as the World Editor keeps it.

import type { Terrain } from "./w3e";

/** A pathing texture: rows from the top (north), RGBA. */
export interface SpecialTexture { width: number; height: number; rgba: ArrayLike<number> }

/** A well-formed entry of the specials list: its type and the tile its footprint's bottom left is on. */
export interface SpecialAt { id: string; x: number; y: number }

const specialAt = (e: unknown): SpecialAt | null => {
  const s = e as Partial<SpecialAt> | null;
  return s && typeof s.id === "string" && Number.isInteger(s.x) && Number.isInteger(s.y) ? s as SpecialAt : null;
};

/** Whether a special doodad at tile (x, y) fits the cliff layers under it. Its pathing texture's alpha is the cliff it is
 *  made for: 0 the low side, 127 one layer up, 255 two (YCl2 "Short" 127 | 255, YCp2 0 | 255, a ruined floor all 0;
 *  the cave LCc0 255 along its north and north-east). Its footprint is a tile per 4 cells (as specials.ts specialTiles);
 *  each of its corners (x..x + tiles, y..y + tiles) takes the texture's cell at 4 × its tile offset from the south-west
 *  (the last cell for the far edges). It fits when every corner's layer is its cell's level above one base, on any
 *  layer. The World Editor takes the specials that don't fit out of war3map.doo on every cliff brush stroke, anywhere on
 *  the map, made-up ones on flat ground included (we-drive 2026-11-23, branch fix/cliff-level-removes-specials: Level,
 *  Increase One, a lowering and a water brush on AutumnLeaves_S2 and on made-up maps: every save kept and removed just the
 *  specials this says). Undefined when it can't be told: a texture without cells, or a corner off the map or not
 *  `open` (a partial load). */
export function specialFits(t: Terrain, sp: Pick<SpecialAt, "x" | "y">, tex: SpecialTexture, open?: (corner: number) => boolean): boolean | undefined {
  const { width: w, height: h, rgba } = tex;
  if (!(w >= 1 && h >= 1) || rgba.length < w * h * 4) return undefined;
  const tw = Math.ceil(w / 4), th = Math.ceil(h / 4);
  let base: number | undefined;
  for (let j = 0; j <= th; j++) {
    for (let i = 0; i <= tw; i++) {
      const x = sp.x + i, y = sp.y + j;
      if (x < 0 || y < 0 || x >= t.width || y >= t.height) return undefined;
      const corner = y * t.width + x;
      if (open && !open(corner)) return undefined;
      // Cell row cy from the south is the texture's row h - 1 - cy.
      const cx = Math.min(4 * i, w - 1), cy = Math.min(4 * j, h - 1);
      const level = Math.round(rgba[((h - 1 - cy) * w + cx) * 4 + 3] / 127.5);
      const b = t.corners[corner].layer - level;
      if (base === undefined) base = b;
      else if (b !== base) return false;
    }
  }
  return true;
}

/** The specials list after a cliff brush stroke: those that no longer fit their cliff (specialFits) are taken out, as
 *  the World Editor does; entries that aren't well-formed specials, those whose texture `tex` doesn't give (unknown or
 *  unreadable), and those it can't tell, stay. */
export function specialsAfterCliffs(t: Terrain, specials: readonly unknown[], tex: (id: string) => SpecialTexture | null | undefined,
  open?: (corner: number) => boolean): { kept: unknown[]; removed: SpecialAt[] } {
  const kept: unknown[] = [], removed: SpecialAt[] = [];
  for (const entry of specials) {
    const sp = specialAt(entry);
    const image = sp ? tex(sp.id) : null;
    if (sp && image && specialFits(t, sp, image, open) === false) removed.push(sp);
    else kept.push(entry);
  }
  return { kept, removed };
}
