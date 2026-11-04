// Shoreline foam: where the water surface meets the ground, the game places the tileset's
// shoreline models (TerrainArt\Water.slk: shoreDir, shoreSFile / shoreOCFile / shoreICFile),
// which are only flat particle emitters. A corner is underwater when it has water above its
// ground; a tile with both kinds of corners gets one model at its centre, at the water level:
//   two land corners side by side → the straight piece (made for land at −X),
//   one land corner → the outside corner (made for land at −X +Y),
//   one underwater corner → the inside corner (made for water at −X +Y),
// turned so its made-for side points at the tile's. Two diagonal land corners get nothing.
// The orientations are read off the models' emitters: their waves roll from the water toward
// the land (Shoreline0: from x = 80 toward −X). Not compared with the game.

import type { Terrain } from "../../lib/terrain/w3e";
import type { ModelRequest } from "./objects";

export interface ShoreModels { straight: string; outside: string; inside: string }

/** Corner offsets from a tile's centre, in the order bottom-left, bottom-right, top-right, top-left. */
const CORNERS: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

/** `cliffShores`/`rollingShores`: the map's "Show water waves on cliff / rolling shores" flags
 *  (a shore tile on a cliff — corners on different layers — or not). */
export function planShoreline(t: Terrain, models: ShoreModels, waves = { cliffShores: true, rollingShores: true }): ModelRequest[] {
  const req = (path: string): ModelRequest => ({ path, replaceable: {}, instances: [] });
  const straight = req(models.straight), outside = req(models.outside), inside = req(models.inside);
  const place = (r: ModelRequest, x: number, y: number, z: number, angle: number) => {
    const c = Math.cos(angle), s = Math.sin(angle);
    r.instances.push({ world: new Float32Array([c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, x, y, z, 1]), team: 0 });
  };
  for (let y = 0; y < t.height - 1; y++) {
    for (let x = 0; x < t.width - 1; x++) {
      const cs = [t.corners[y * t.width + x], t.corners[y * t.width + x + 1], t.corners[(y + 1) * t.width + x + 1], t.corners[(y + 1) * t.width + x]];
      if (!cs.some((c) => c.hasWater)) continue;
      const under = cs.map((c) => c.hasWater && c.water > c.height);
      const n = under.filter(Boolean).length;
      if (n === 0 || n === 4) continue;
      const cliff = !cs.every((c) => c.layer === cs[0].layer);
      if (cliff ? !waves.cliffShores : !waves.rollingShores) continue;
      const level = Math.max(...cs.filter((c) => c.hasWater).map((c) => c.water));
      const cx = t.offsetX + (x + 0.5) * 128, cy = t.offsetY + (y + 0.5) * 128;
      const land = CORNERS.filter((_, i) => !under[i]), water = CORNERS.filter((_, i) => under[i]);
      if (n === 2) {
        // Side by side (not diagonal): the land side's direction.
        const dx = land[0][0] + land[1][0], dy = land[0][1] + land[1][1];
        if (dx === 0 && dy === 0) continue;
        place(straight, cx, cy, level, Math.atan2(dy, dx) - Math.PI);
      } else if (n === 3) {
        place(outside, cx, cy, level, Math.atan2(land[0][1], land[0][0]) - Math.atan2(1, -1));
      } else {
        place(inside, cx, cy, level, Math.atan2(water[0][1], water[0][0]) - Math.atan2(1, -1));
      }
    }
  }
  return [straight, outside, inside].filter((r) => r.instances.length);
}
