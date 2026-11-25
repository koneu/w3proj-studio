// The start building the World Editor shows, see-through, inside each start location's ring: the
// town hall of the player's race (war3map.w3i). A player of selectable race gets one of the four
// at random in the editor, picked anew each time the map opens (seen 2026-11-08: Night Elf,
// Human and Undead for the same map); here it is one of them by player number instead, so the
// view doesn't change from one opening to the next. The previews are only drawn: not placed,
// not saved, not selectable.

import type { Placed } from "./objects";
import { MINE_CLEARANCE, MINES, START_SQUARE, startVerdicts, type StartSurroundings } from "../../lib/terrain/meleesave";
import { waterSurfaceAt, type Terrain } from "../../lib/terrain/w3e";
import type { TileRect } from "./specials";

/** Whether a start location's preview is left out, as the World Editor does where a start can't be built on: water
 *  of any depth under any cell of the town hall's square (START_SQUARE cells each way from the start rounded to the
 *  32 grid, the square the melee save tests), or a special doodad on the start's tile. The editor's rule is its melee
 *  save's "start location in an invalid position" (we-drive 2026-11-25, make-start-preview.mjs: every depth from
 *  0.15 to 100.15 hid it and a surface under the ground didn't; water from 128 or 256 east of the start hid it, from
 *  384 not; the stored war3map.wpm doesn't count). This is the immediate answer, checked on every frame; the rest of the
 *  rule needs the game's pathing textures (trees, doodads and pathing blockers in the square, Lrok, cliffs, another start
 *  too close) and comes later from StartJudge; gold mines are in startPreviews. */
export function startPreviewHidden(t: Terrain, specials: readonly TileRect[], x: number, y: number): boolean {
  const cx = Math.round((x - t.offsetX) / 32), cy = Math.round((y - t.offsetY) / 32);
  // Checked on every drawn frame: the cells only where a corner of the square's tiles has water.
  // (past the edge waterSurfaceAt takes the nearest tile, whose corners these bounds keep)
  const lo = (v: number, n: number) => Math.min(Math.max(v, 0), n - 2), hi = (v: number, n: number) => Math.min(Math.max(v, 1), n - 1);
  let wet = false;
  for (let j = lo(Math.floor((cy - START_SQUARE) / 4), t.height); !wet && j <= hi(Math.ceil((cy + START_SQUARE) / 4), t.height); j++) {
    for (let i = lo(Math.floor((cx - START_SQUARE) / 4), t.width); i <= hi(Math.ceil((cx + START_SQUARE) / 4), t.width); i++) {
      if (t.corners[j * t.width + i]?.hasWater) { wet = true; break; }
    }
  }
  for (let j = cy - START_SQUARE; wet && j < cy + START_SQUARE; j++) {
    for (let i = cx - START_SQUARE; i < cx + START_SQUARE; i++) {
      if (waterSurfaceAt(t, t.offsetX + (i + 0.5) * 32, t.offsetY + (j + 0.5) * 32) !== null) return true;
    }
  }
  const tx = Math.floor((x - t.offsetX) / 128), ty = Math.floor((y - t.offsetY) / 128);
  return specials.some((r) => tx >= r.x0 && tx <= r.x1 && ty >= r.y0 && ty <= r.y1);
}

/** A start location's place as a key of judgedHidden's set. */
export const startSpot = (x: number, y: number) => `${x},${y}`;

/** Where the start locations stand that the melee save surely calls invalid (meleesave.ts startVerdicts) on the
 *  surroundings `around`: their previews are left out (we-drive 2026-11-25, make-start-preview.mjs: trees, rock doodads,
 *  pathing blockers, specials, Lrok and cliffs in the square, both of two starts 488 apart; not a footman on a start).
 *  A start whose verdict can't be told ("unknown") keeps its preview. */
export function judgedHidden(t: Terrain, placed: readonly Placed[], around: StartSurroundings): Set<string> {
  const out = new Set<string>();
  for (const [s, v] of startVerdicts(t, placed, around)) if (v === "invalid") out.add(startSpot(s.position![0], s.position![1]));
  return out;
}

/** What the judged previews depend on besides the edits: the start locations' places. */
export function startsKey(units: readonly Placed[]): string {
  return JSON.stringify(units.filter((u) => u.id === "sloc").map((u) => [u.position[0], u.position[1]]));
}

/** Timers as StartJudge uses them (tests pass their own). */
export interface JudgeTimers { set(f: () => void, ms: number): unknown; clear(handle: unknown): void }

/**
 * The slow half of the preview rule (judgedHidden, which needs the game's pathing textures), kept off the frame: `changed`
 * with a key of what it depends on starts a judgement `delay` ms after the last change; while one runs, the next waits
 * for it. A result counts only when nothing changed since its judgement began (a generation check): an older one never
 * shows. Until the new one is there the last result stays, so a preview doesn't flicker on and off; a start moved
 * since keeps its preview meanwhile (the set is by place). `judge` gives null when it can't tell: then nothing is hidden
 * by it.
 */
export class StartJudge {
  private key: string | null = null;
  private gen = 0;
  private hidden: ReadonlySet<string> = new Set();
  private timer: unknown = null;
  private running = false;
  private disposed = false;
  constructor(private readonly judge: () => Promise<ReadonlySet<string> | null>, private readonly onResult: () => void,
    private readonly delay = 300, private readonly timers: JudgeTimers = { set: (f, ms) => setTimeout(f, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }) {}

  /** What the judgement depends on is now `key`: a new one is due when it differs from the last. */
  changed(key: string): void {
    if (this.disposed || key === this.key) return;
    this.key = key;
    this.gen++;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => { this.timer = null; void this.run(); }, this.delay);
  }

  /** Whether the last judgement hides the preview of a start at (x, y). */
  hiddenAt(x: number, y: number): boolean {
    return this.hidden.has(startSpot(x, y));
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    // One at a time: a timer that fires meanwhile leaves it to the end of this one (below).
    if (this.disposed || this.running) return;
    this.running = true;
    const gen = this.gen;
    let got: ReadonlySet<string> | null = null;
    try { got = await this.judge(); } catch { got = null; }
    this.running = false;
    if (this.disposed) return;
    if (gen === this.gen) {
      const next = got ?? new Set<string>();
      const same = next.size === this.hidden.size && [...next].every((k) => this.hidden.has(k));
      this.hidden = next;
      if (!same) this.onResult();
    } else if (this.timer === null) {
      // Changed while it ran, and that change's timer has fired: judged again now.
      void this.run();
    }
  }
}

/** Whether a gold mine (of any kind) stands nearer than MINE_CLEARANCE to (x, y): the World Editor leaves the preview
 *  out then (we-drive 2026-11-25, make-start-preview.mjs mine: 749 and (528, 528) hid it, 750 and (531, 531) not; a
 *  farm on the start didn't). */
function mineTooNear(units: readonly Placed[], x: number, y: number): boolean {
  return units.some((u) => MINES.has(u.id) && Math.hypot(u.position[0] - x, u.position[1] - y) < MINE_CLEARANCE);
}

/** Town halls by race as war3map.w3i stores it: 1 Human, 2 Orc, 3 Undead, 4 Night Elf. */
export const START_BUILDINGS = ["htow", "ogre", "unpl", "etoa"] as const;

/** The see-through look of the previews (the alpha the models are drawn with). */
export const START_PREVIEW_ALPHA = 0.5;

/** The town hall a player's start location shows: by race, else (selectable, a player the map
 *  doesn't list, a race the editor doesn't know) one by player number. */
export function startBuilding(player: number, race: number | undefined): string {
  if (race !== undefined && race >= 1 && race <= 4) return START_BUILDINGS[race - 1];
  return START_BUILDINGS[((player % 4) + 4) % 4];
}

/** One preview per start location of a player: its race's town hall where the start location
 *  stands, facing as buildings do (270°). `races`: player id → race, from war3map.w3i. Whatever
 *  the map's Melee flag: the World Editor drew them on fresh opens of maps with the flag off (also
 *  with custom forces and fixed player settings, and for a computer player) and kept them after a
 *  player's unit was pasted (we-drive, 2026-11-13; the user's decision the same day). */
export function startPreviews(units: readonly Placed[], races: ReadonlyMap<number, number>,
  hidden?: (x: number, y: number) => boolean): Placed[] {
  const out: Placed[] = [];
  for (const u of units) {
    if (u.id !== "sloc" || u.player === undefined) continue;
    if (mineTooNear(units, u.position[0], u.position[1]) || hidden?.(u.position[0], u.position[1])) continue;
    out.push({ id: startBuilding(u.player, races.get(u.player)), variation: 0, position: [...u.position], angle: (3 * Math.PI) / 2, scale: [1, 1, 1], player: u.player });
  }
  return out;
}

/** Player id → race from war3map.w3i (as its project JSON); empty without players. */
export function playerRaces(info: { players?: { id?: unknown; race?: unknown }[] } | null | undefined): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of info?.players ?? []) {
    if (typeof p?.id === "number" && typeof p.race === "number") out.set(p.id, p.race);
  }
  return out;
}

/** What the previews are made from: equal keys draw the same previews. */
export function startPreviewKey(units: readonly Placed[], races: ReadonlyMap<number, number>, hidden?: (x: number, y: number) => boolean): string {
  return JSON.stringify(startPreviews(units, races, hidden).map((p) => [p.id, p.position[0], p.position[1], p.position[2]]));
}
