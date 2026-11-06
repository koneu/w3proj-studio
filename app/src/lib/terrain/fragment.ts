// A piece of a map on its own: what the clipboard holds, and meant for anything else that moves part
// of a map around, like the split map files in the open points. It's plain JSON with positions
// relative to its centre, and refers to nothing in an open map, so it can be saved, pasted into another
// map, or turned. Objects for now; ground would be a section next to them.

export const FRAGMENT_FORMAT = "w3proj.fragment/1";

export interface FragmentObject {
  list: "doodads" | "units";
  /** From the fragment's centre, the height from the ground under it. */
  at: [number, number, number];
  /** Radians. */
  angle: number;
  /** The rest of the placed object, as its file has it. */
  entry: Record<string, unknown>;
}

export interface Fragment {
  format: typeof FRAGMENT_FORMAT;
  objects: FragmentObject[];
}

export type Turn = "mirrorX" | "mirrorY" | "cw" | "ccw";

/** The World Editor's pathing cell: what's on it stays on it after a move. */
const CELL = 32;

export const snapped = (v: number) => Math.round(v / CELL) * CELL;

/** The middle of what's given, on a cell. */
export function centreOf(points: readonly (readonly number[])[]): [number, number] {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return [snapped((Math.min(...xs) + Math.max(...xs)) / 2), snapped((Math.min(...ys) + Math.max(...ys)) / 2)];
}

interface Source { position: readonly number[]; angle: number }

export function fragmentOf(items: readonly { list: FragmentObject["list"]; entry: Source }[], groundAt: (x: number, y: number) => number): Fragment {
  const [cx, cy] = centreOf(items.map((i) => i.entry.position));
  return {
    format: FRAGMENT_FORMAT,
    objects: items.map(({ list, entry }) => {
      const { position, angle, ...rest } = structuredClone(entry) as Source & Record<string, unknown>;
      const [x, y, z] = position;
      return { list, at: [x - cx, y - cy, z - groundAt(x, y)], angle, entry: rest };
    }),
  };
}

/** A point from the centre, after a turn. */
export function turnOffset(turn: Turn, x: number, y: number): [number, number] {
  switch (turn) {
    // Not -x: that makes -0 of 0, which isn't the same number after JSON.
    case "mirrorX": return [0 - x, y];
    case "mirrorY": return [x, 0 - y];
    case "cw": return [y, 0 - x];
    case "ccw": return [0 - y, x];
  }
}

const FULL = Math.PI * 2;

/** A facing after a turn. */
export function turnAngle(turn: Turn, angle: number): number {
  const turned = { mirrorX: Math.PI - angle, mirrorY: -angle, cw: angle - Math.PI / 2, ccw: angle + Math.PI / 2 }[turn];
  return ((turned % FULL) + FULL) % FULL;
}

export function turnFragment(f: Fragment, turn: Turn): Fragment {
  return {
    ...f,
    objects: f.objects.map((o) => {
      const [x, y] = turnOffset(turn, o.at[0], o.at[1]);
      return { ...o, at: [x, y, o.at[2]], angle: turnAngle(turn, o.angle) };
    }),
  };
}
