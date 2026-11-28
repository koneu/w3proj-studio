// map_layout: the whole map as a flat-colour plan, for judging a layout at a glance: where units walk, forest,
// cliffs and other walls, water, the starts, mines and shops, the camps with how far their creeps see, and the
// routes players walk. A 3D screenshot of a whole map is too small to read structure from.

type Point = readonly [number, number];
export interface LayoutFacts {
  /** Pathing cells, row 0 in the south. */
  width: number; height: number; offsetX: number; offsetY: number;
  /** Per cell: nothing walks here (cliffs, deep water, boundary). */
  noWalk: (i: number) => boolean;
  /** Per cell: water shows here. */
  water: (i: number) => boolean;
  /** Per cell: a tree or another destructable stands here. */
  trees: Uint8Array;
  /** Per cell: a doodad or building stands here for good. */
  standing: Uint8Array;
  /** Per cell: past the playable map. */
  border?: (i: number) => boolean;
  starts: readonly Point[]; mines: readonly Point[]; shops: readonly Point[];
  camps: readonly { centre: Point; level: number; sight: number; guard: boolean }[];
  routes: readonly (readonly Point[])[];
}

export const LAYOUT_COLOURS = {
  ground: [214, 200, 160], forest: [40, 110, 50], wall: [110, 100, 95], water: [70, 130, 210], shallows: [150, 190, 230], object: [150, 120, 90],
  border: [40, 40, 40], route: [255, 255, 255], start: [255, 230, 0], mine: [255, 170, 0], shop: [230, 60, 220], camp: [220, 30, 30], guard: [140, 20, 20], sight: [255, 90, 90],
} as const;
export const LAYOUT_LEGEND = "sand: walkable ground · dark green: trees · grey: cliffs and other ground nothing walks on · blue: water (light: shallows units wade) · brown: doodads and buildings in the way · "
  + "black: past the playable map · white lines: the routes between the starts and to the nearest mines · yellow squares: start locations · orange squares: gold mines · "
  + "magenta squares: shops and other neutral buildings · red dots: creep camps (dark red: a mine's guards), the ring round each how far its creeps see";

/** The plan as pixels, north up, `scale` pixels a pathing cell (32 world units). */
export function layoutPicture(f: LayoutFacts, scale: number): { width: number; height: number; rgba: Uint8Array } {
  const W = f.width * scale, H = f.height * scale, rgba = new Uint8Array(W * H * 4);
  const put = (px: number, py: number, c: readonly number[]) => {
    if (px < 0 || py < 0 || px >= W || py >= H) return;
    const i = (py * W + px) * 4;
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
  };
  const C = LAYOUT_COLOURS;
  for (let cy = 0; cy < f.height; cy++) for (let cx = 0; cx < f.width; cx++) {
    const i = cy * f.width + cx;
    const c = f.border?.(i) ? C.border : f.trees[i] ? C.forest : f.noWalk(i) ? (f.water(i) ? C.water : C.wall) : f.standing[i] ? C.object : f.water(i) ? C.shallows : C.ground;
    for (let b = 0; b < scale; b++) for (let a = 0; a < scale; a++) put(cx * scale + a, (f.height - 1 - cy) * scale + b, c);
  }
  const px = ([x, y]: Point): [number, number] => [((x - f.offsetX) / 32) * scale, H - ((y - f.offsetY) / 32) * scale];
  const line = (a: Point, b: Point, c: readonly number[]) => {
    const [x0, y0] = px(a), [x1, y1] = px(b), steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let k = 0; k <= steps; k++) put(Math.round(x0 + ((x1 - x0) * k) / steps), Math.round(y0 + ((y1 - y0) * k) / steps), c);
  };
  const ring = (at: Point, radius: number, c: readonly number[]) => {
    const [x, y] = px(at), r = (radius / 32) * scale, steps = Math.max(24, Math.ceil(2 * Math.PI * r));
    for (let k = 0; k < steps; k++) put(Math.round(x + r * Math.cos((k * 2 * Math.PI) / steps)), Math.round(y + r * Math.sin((k * 2 * Math.PI) / steps)), c);
  };
  const square = (at: Point, half: number, c: readonly number[]) => {
    const [x, y] = px(at);
    for (let b = -half; b <= half; b++) for (let a = -half; a <= half; a++) put(Math.round(x) + a, Math.round(y) + b, c);
  };
  const dot = (at: Point, r: number, c: readonly number[]) => {
    const [x, y] = px(at);
    for (let b = -r; b <= r; b++) for (let a = -r; a <= r; a++) if (a * a + b * b <= r * r) put(Math.round(x) + a, Math.round(y) + b, c);
  };
  for (const r of f.routes) for (let i = 0; i + 1 < r.length; i++) line(r[i], r[i + 1], C.route);
  const mark = Math.max(2, Math.round(scale * 2));
  for (const c of f.camps) { ring(c.centre, c.sight, C.sight); dot(c.centre, mark, c.guard ? C.guard : C.camp); }
  for (const m of f.mines) square(m, mark, C.mine);
  for (const s of f.shops) square(s, mark, C.shop);
  for (const s of f.starts) square(s, mark + 1, C.start);
  return { width: W, height: H, rgba };
}
