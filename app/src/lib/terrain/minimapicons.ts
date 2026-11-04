// war3map.mmp: the icons the game draws over the minimap (gold mines, neutral buildings, start
// locations), as the World Editor writes them on save. Rules read off the game's 466 maps
// (463 give the same icons, up to a pixel; the others are campaign chapters with a custom
// shop or an off-map start location the World Editor placed differently):
// - gold mine (0): the unit type's default abilities (game data, not the map's changes) include
//   a gold mine ability (Agld; Haunted Gold Mine Abgm; Entangled Gold Mine Aegm);
// - neutral building (1): "Neutral building - shows minimap icon" (unbm) set and a race that
//   isn't a playable one (both with the map's changes), owned by Neutral Passive;
// - start location (2): every start location, in its player's colour.
// The order isn't reproducible (it follows neither placement nor position); the World Editor
// writes start locations last, so do we: gold mines, neutral buildings, start locations.

export interface MinimapIcon {
  type: number;
  /** Minimap pixels (256×256 over the playable area), stored as u32: off-map ones wrap. */
  x: number;
  y: number;
  color: { blue: number; green: number; red: number; alpha: number };
}

/** The terrain's corner grid and the camera margins (tiles: left, right, bottom, top). */
export interface IconArea {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
  margins: readonly number[];
}

/** The minimap's player colours (BGR as stored; read off the game maps' start icons, which
 *  vary by a step between World Editor versions). Neutral players get 24's. */
const START_COLORS: [number, number, number][] = [
  [3, 3, 255], [255, 66, 0], [186, 231, 27], [129, 0, 85], [0, 252, 255], [13, 138, 255],
  [0, 192, 33], [176, 92, 228], [151, 150, 148], [242, 192, 126], [71, 98, 16], [5, 43, 79],
  [0, 0, 156], [195, 0, 0], [255, 235, 0], [255, 0, 189], [135, 206, 236], [140, 165, 247],
  [129, 255, 192], [236, 185, 220], [85, 80, 79], [255, 240, 236], [30, 120, 0], [52, 112, 165],
  [46, 45, 46],
];
const WHITE = { blue: 255, green: 255, red: 255, alpha: 255 };

/** A world position's minimap pixel: the playable area scaled to fit 256×256, centred.
 *  x truncated, y rounded up: 8,399 of 8,998 game map icons exact, the rest 1 pixel off. */
export function iconPixel(a: IconArea, x: number, y: number): [number, number] {
  const [ml, mr, mb, mt] = a.margins;
  const pw = a.width - 1 - ml - mr, ph = a.height - 1 - mb - mt, s = 256 / Math.max(pw, ph);
  const px = (256 - pw * s) / 2 + ((x - a.offsetX) / 128 - ml) * s;
  const py = 256 - ((256 - ph * s) / 2 + ((y - a.offsetY) / 128 - mb) * s);
  return [Math.trunc(px) >>> 0, Math.ceil(py) >>> 0];
}

export function startColor(player: number): MinimapIcon["color"] {
  const [blue, green, red] = START_COLORS[Math.min(player, 24)] ?? START_COLORS[24];
  return { blue, green, red, alpha: 255 };
}

export interface IconUnit { id: string; player?: number; position: readonly number[] }

/** The icons of placed units. `kindOf`: 0 gold mine, 1 neutral building (owner checked by the
 *  caller's rule), null none; start locations (sloc) are recognised here. */
export function minimapIcons(a: IconArea, units: readonly IconUnit[], kindOf: (u: IconUnit) => 0 | 1 | null): MinimapIcon[] {
  const out: MinimapIcon[][] = [[], [], []];
  for (const u of units) {
    const type = u.id === "sloc" ? 2 : kindOf(u);
    if (type === null) continue;
    const [x, y] = iconPixel(a, u.position[0], u.position[1]);
    out[type].push({ type, x, y, color: type === 2 ? startColor(u.player ?? 0) : { ...WHITE } });
  }
  return out.flat();
}

/** Same icons, in any order, up to a pixel apart (the World Editor rounds some the other way)
 *  and colours up to 2 apart (its palette varies by version): a map whose icons only differ
 *  like that keeps its file. */
export function sameIcons(a: readonly MinimapIcon[], b: readonly MinimapIcon[]): boolean {
  if (a.length !== b.length) return false;
  const near = (p: number, q: number) => Math.min((p - q) >>> 0, (q - p) >>> 0) <= 1;
  const left = [...b];
  for (const i of a) {
    const k = left.findIndex((j) => j.type === i.type && near(i.x, j.x) && near(i.y, j.y)
      && Math.abs(j.color.red - i.color.red) <= 2 && Math.abs(j.color.green - i.color.green) <= 2 && Math.abs(j.color.blue - i.color.blue) <= 2);
    if (k < 0) return false;
    left.splice(k, 1);
  }
  return true;
}
