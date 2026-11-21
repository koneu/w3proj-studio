// The seam check of a split terrain (spec "Seam check"): separate subterrain files stop textual git conflicts, not
// semantic ones. Cliffs, ramps and water look a corner or two across a seam, so two branches editing near the same
// seam can merge cleanly into a seam no brush would leave (and an edit in a partial open is clamped to the open
// subterrains, so the brushes' fix-ups stop at the seam too). This reports every corner along a seam that the terrain
// brushes' own rules would change; it never edits.
//
// The rules are the brushes' (cliffs.ts), applied where corners of two subterrains meet:
//   cliff-height  (error) two corners side by side or diagonal more than MAX_CLIFF_STEP levels apart: the cliff slope
//                 (cliffSlope) brings one of them to within two levels of the other
//   ramp          (error) a run of ramp flags across the seam that doesn't climb one level one way (rampRunClimbs,
//                 what dropBrokenRamps takes off): it draws with holes
//   water-level   (warning) two wet corners of one tile across the seam with different water levels: a brush stroke
//                 leaves one level (setWaterLevel), so the surface steps at the seam
// Only pairs of corners in two different subterrains count; uncovered corners are defaultCorner and never edited.
//
// Measured on the 117 maps of smoketest_maps (2026-11-22), every pair of corners taken as a seam: cliff-height 144
// times (one map, made with an early Studio), ramp 16 (5 maps), water-level 1056 (12 maps: strokes from different
// heights meet in a tile, as the World Editor leaves them), so water-level is only a warning; at the seams of a 2×2
// split none of them came up. A cliff type the map's cliff list lacks (15) on a cliff tile came up 4649 times, also in
// maps the World Editor saved, so it is no rule here (matchCliffTypes doesn't make it one either).

import { cliffSlopeLevel, levelSpan, rampRunClimbs, rampRunsThrough } from "./cliffs";
import { parseW3e, type Terrain } from "./w3e";
import { w3eFromText } from "./w3etext";

/** The backend's `terrain_whole`: a split project's whole terrain (every subterrain read, closed ones too) as
 *  war3map.w3e.txt text, and its rectangles; null for a flat project. */
interface WholeTerrain { text: string; subterrains: SeamRect[] }

/** Check Terrain Seams on the project's files as they are on disk (what was saved, and merged in git): the whole
 *  terrain assembled by the backend from every subterrain, then seamIssues. Null for a flat project. Reads only. */
export async function checkSeams(invoke: <T>(cmd: string, args: Record<string, unknown>) => Promise<T>, root: string): Promise<SeamReport | null> {
  const whole = await invoke<WholeTerrain | null>("terrain_whole", { root });
  if (!whole) return null;
  return seamIssues(parseW3e(w3eFromText(whole.text)), whole.subterrains);
}

/** A subterrain's rectangle in corners ((0, 0) the south-west corner), as terrain.json has it. */
export interface SeamRect { name: string; x: number; y: number; w: number; h: number }

export type SeamRule = "cliff-height" | "ramp" | "water-level";
export const SEAM_RULES: readonly SeamRule[] = ["cliff-height", "ramp", "water-level"];
/** Errors stop `w3proj pack` (unless --allow-seam-issues); warnings are only told. */
export const SEAM_SEVERITY: Readonly<Record<SeamRule, "error" | "warning">> = { "cliff-height": "error", ramp: "error", "water-level": "warning" };

/** A corner of an issue, with the subterrain that owns it. */
export interface SeamCorner { x: number; y: number; subterrain: string }

/** One place along a seam where a rule would change corners: `corners` the ones it would change (for cliff-height and
 *  water-level the pair, either of which it moves), `message` what is wrong there. */
export interface SeamIssue { rule: SeamRule; severity: "error" | "warning"; corners: SeamCorner[]; message: string }

export interface SeamReport {
  issues: SeamIssue[];
  errors: number;
  warnings: number;
  /** How many corners lie within two corners of a seam (what was looked at). */
  seamCorners: number;
  /** The seams: pairs of subterrains that touch (side by side or at a corner). */
  seams: [string, string][];
}

/** For each corner of a `width` × `height` canvas the index of the subterrain owning it (strict corner ownership:
 *  `x <= cx < x + w`), -1 when none does. */
export function ownerGrid(width: number, height: number, subs: readonly SeamRect[]): Int32Array {
  const owner = new Int32Array(width * height).fill(-1);
  subs.forEach((s, k) => {
    for (let y = Math.max(0, s.y); y < Math.min(height, s.y + s.h); y++) for (let x = Math.max(0, s.x); x < Math.min(width, s.x + s.w); x++) owner[y * width + x] = k;
  });
  return owner;
}

/** The seam check over a whole terrain (all subterrains assembled) and its subterrains. Issues are sorted by rule, then
 *  by their first corner (south to north, west to east). */
export function seamIssues(t: Terrain, subs: readonly SeamRect[]): SeamReport {
  const W = t.width, H = t.height;
  const owner = ownerGrid(W, H, subs);
  const corner = (i: number): SeamCorner => ({ x: i % W, y: Math.floor(i / W), subterrain: subs[owner[i]]?.name ?? "" });
  const at = (c: SeamCorner) => `${c.x},${c.y} (${c.subterrain})`;
  /** Two corners in two different subterrains. */
  const across = (a: number, b: number) => owner[a] >= 0 && owner[b] >= 0 && owner[a] !== owner[b];
  const issues: SeamIssue[] = [];
  const seams = new Map<string, [string, string]>();
  const band = new Set<number>();

  // Pairs side by side or diagonal, each once: east, north, north-east, south-east.
  const steps: [number, number][] = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = y * W + x;
    for (const [dx, dy] of steps) {
      const nx = x + dx, ny = y + dy;
      if (nx >= W || ny < 0 || ny >= H) continue;
      const b = ny * W + nx;
      if (!across(a, b)) continue;
      const [p, q] = [subs[owner[a]].name, subs[owner[b]].name].sort();
      seams.set(`${p}\n${q}`, [p, q]);
      for (let by = Math.max(0, y - 2); by <= Math.min(H - 1, y + 2); by++) for (let bx = Math.max(0, x - 2); bx <= Math.min(W - 1, x + 2); bx++) band.add(by * W + bx);
      const la = t.corners[a].layer, lb = t.corners[b].layer;
      if (cliffSlopeLevel(la, lb) !== lb) {
        const ca = corner(a), cb = corner(b);
        issues.push(issue("cliff-height", [ca, cb], `a cliff of ${Math.abs(la - lb)} levels between ${at(ca)} on level ${la} and ${at(cb)} on level ${lb}: the cliff brushes keep cliffs to two levels, so one of them would move`));
      }
    }
  }

  // Ramp runs that cross a seam.
  const seenRuns = new Set<string>();
  for (const i of band) {
    for (const { key, run } of rampRunsThrough(t, i)) {
      if (seenRuns.has(key)) continue;
      seenRuns.add(key);
      if (!run.some((k) => run.some((m) => across(k, m)))) continue;
      const levels = run.map((k) => t.corners[k].layer);
      // A level run is a row across a wide ramp; one that climbs one level one way is a ramp's line down the cliff.
      if (levelSpan(levels) === 0 || rampRunClimbs(levels)) continue;
      const cs = run.map(corner);
      issues.push(issue("ramp", cs, `the ramp flags ${at(cs[0])} to ${at(cs[cs.length - 1])} run over levels ${levels.join(", ")} across the seam, not one level up: the brushes take such flags off (it draws with holes)`));
    }
  }

  // Water in tiles across a seam.
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
    const q = [y * W + x, y * W + x + 1, (y + 1) * W + x, (y + 1) * W + x + 1];
    const wet = q.filter((i) => t.corners[i].hasWater);
    if (wet.length < 2) continue;
    for (let m = 0; m < wet.length; m++) for (let n = m + 1; n < wet.length; n++) {
      const a = wet[m], b = wet[n];
      const wa = t.corners[a].rawWater & 0x3fff, wb = t.corners[b].rawWater & 0x3fff;
      if (!across(a, b) || wa === wb) continue;
      // Each pair once: the tile to the south-west of a pair holding both owns it.
      const ax = a % W, ay = Math.floor(a / W), bx = b % W, by = Math.floor(b / W);
      if (Math.min(ax, bx) !== x || Math.min(ay, by) !== y) continue;
      const ca = corner(a), cb = corner(b);
      issues.push(issue("water-level", [ca, cb], `the water at ${at(ca)} (level ${wa}) and at ${at(cb)} (level ${wb}) meet in one tile at different levels: a brush stroke leaves one level, so the surface steps at the seam`));
    }
  }

  const first = (s: SeamIssue) => s.corners[0].y * W + s.corners[0].x;
  issues.sort((a, b) => SEAM_RULES.indexOf(a.rule) - SEAM_RULES.indexOf(b.rule) || first(a) - first(b));
  const errors = issues.filter((s) => s.severity === "error").length;
  return { issues, errors, warnings: issues.length - errors, seamCorners: band.size, seams: [...seams.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])) };
}

const issue = (rule: SeamRule, corners: SeamCorner[], message: string): SeamIssue => ({ rule, severity: SEAM_SEVERITY[rule], corners, message });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The report's last line: what was found. */
export function seamSummary(r: SeamReport): string {
  if (!r.issues.length) return `no seam issues: ${plural(r.seams.length, "seam")}, ${r.seamCorners} corners checked`;
  return `${plural(r.errors, "error")} and ${plural(r.warnings, "warning")} along ${plural(r.seams.length, "seam")} (${r.seamCorners} corners checked); nothing was changed`;
}

/** The report as lines of text (as `w3proj terrain seams` prints it). */
export function seamLines(r: SeamReport): string[] {
  return [...r.issues.map((s) => `${s.severity} ${s.rule}: ${s.message}`), seamSummary(r)];
}
