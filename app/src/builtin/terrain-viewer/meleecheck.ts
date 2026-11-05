// Tests a melee map against what ladder maps do, and says how far each answer can be trusted.
// Limits come from the same six 1v1 maps as the melee guide, with some room around what was measured.

type Point = readonly [number, number];

export interface MeleeUnit {
  id: string;
  x: number;
  y: number;
  /** From 0: 24 is Neutral Hostile, 27 Neutral Passive. */
  player: number;
  /** -1 the type's own range, -2 Camp mode, above 0 a range of its own. */
  acquisition: number;
  drops: boolean;
  /** Level of a random creep. */
  randomLevel?: number;
}

export interface MeleeFacts {
  units: readonly MeleeUnit[];
  trees: readonly Point[];
  /** A unit type's level and acquisition range; undefined for what the game data doesn't know. */
  level(id: string): number | undefined;
  sight(id: string): number | undefined;
  /** Ways units walk, as points along them. */
  routes: readonly { name: string; to?: Point; points?: readonly Point[]; problem?: string }[];
  /** War3's own numbers (Units/MiscGame.txt, MiscData.txt). */
  callForHelp: number;
  shopNotify: number;
}

export type Severity = "error" | "warning" | "info";
export interface MeleeFinding { rule: string; severity: Severity; message: string; at?: [number, number] }

const HOSTILE = 24, MINE = "ngol", START = "sloc";
/** Mines this far from a start belong to it. Measured: 771 to 781. */
const OWN_MINE = [700, 850] as const;
/** Measured: nothing nearer than 1,758. */
const NEAREST_CAMP = 1750;
/** Creeps this close form one camp, and a camp this close to a mine guards it. */
const SAME_CAMP = 450, GUARD = 750;
/** Measured over the ladder maps, with a little room. */
const TREE_NEAR = [500, 750] as const, TREES_1000 = [30, 60] as const;
/** Real maps are symmetric to within about this. */
const FAIR = 300;

const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const near = (from: Point, list: readonly Point[]) => list.reduce((best, p) => Math.min(best, dist(from, p)), Infinity);
const round = ([x, y]: Point): [number, number] => [Math.round(x), Math.round(y)];

/** Distance from a point to a path. */
function toPath(p: Point, path: readonly Point[]) {
  let best = Infinity;
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, ay] = path[i], [bx, by] = path[i + 1], dx = bx - ax, dy = by - ay, span = dx * dx + dy * dy || 1;
    const k = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / span));
    best = Math.min(best, dist(p, [ax + k * dx, ay + k * dy]));
  }
  return best;
}

interface Camp { centre: [number, number]; creeps: MeleeUnit[]; level: number; strongest: number }

/** Neutral hostile units in groups: each within reach of another of the group. */
export function campsOf(units: readonly MeleeUnit[], facts: Pick<MeleeFacts, "level">): Camp[] {
  const levelOf = (u: MeleeUnit) => u.randomLevel ?? facts.level(u.id) ?? 0;
  const left = new Set(units.filter((u) => u.player === HOSTILE && u.id !== START && u.id !== MINE));
  const camps: Camp[] = [];
  for (const first of left) {
    left.delete(first);
    const creeps = [first];
    for (let i = 0; i < creeps.length; i++) {
      for (const u of left) if (dist([u.x, u.y], [creeps[i].x, creeps[i].y]) < SAME_CAMP) { creeps.push(u); left.delete(u); }
    }
    const count = creeps.length, x = creeps.reduce((n, u) => n + u.x, 0) / count, y = creeps.reduce((n, u) => n + u.y, 0) / count;
    const levels = creeps.map(levelOf);
    camps.push({ centre: [x, y], creeps, level: levels.reduce((a, b) => a + b, 0), strongest: Math.max(...levels) });
  }
  return camps;
}

export function checkMelee(f: MeleeFacts) {
  const findings: MeleeFinding[] = [];
  const add = (rule: string, severity: Severity, message: string, at?: Point) => findings.push({ rule, severity, message, ...(at ? { at: round(at) } : {}) });
  const place = (u: MeleeUnit): Point => [u.x, u.y];
  const starts = f.units.filter((u) => u.id === START).map(place);
  const mines = f.units.filter((u) => u.id === MINE).map(place);
  const shops = f.units.filter((u) => u.player === 27 && u.id !== MINE && u.id !== START);
  const camps = campsOf(f.units, f);
  const unknown = [...new Set(camps.flatMap((c) => c.creeps).filter((u) => u.randomLevel === undefined && f.level(u.id) === undefined).map((u) => u.id))];
  const unknownSight = [...new Set(camps.flatMap((c) => c.creeps).filter((u) => u.acquisition < 0 && f.sight(u.id) === undefined).map((u) => u.id))];
  const notes = [
    "Limits come from six ladder 1v1 maps, with room around what was measured. Team maps have fewer rules that apply: read warnings on them as questions.",
    "An error is outside everything measured, or can't work. A warning is unusual, or a matter of judgement. Neither says whether the map is fun: only playing it can.",
  ];
  if (starts.length < 2) {
    add("starts", "error", `A melee map needs at least 2 start locations (${START}); this one has ${starts.length}.`);
    return { errors: findings.length, warnings: 0, findings, measures: null, accuracy: notes };
  }

  // A start's camps. On maps for more players, creeps standing on a start guard it while it's empty,
  // and melee setup removes them when it's taken: those are no camps near a base.
  const onStart = (c: Camp) => starts.length > 2 && near(c.centre, starts) < 600;
  const field = camps.filter((c) => !onStart(c));
  const guards = field.filter((c) => mines.some((m) => dist(m, c.centre) < GUARD && near(m, starts) > OWN_MINE[1]));
  const isGuard = (c: Camp) => guards.includes(c);

  const perStart = starts.map((s) => {
    const own = mines.filter((m) => dist(m, s) <= OWN_MINE[1] + 300);
    const treeNear = Math.round(near(s, f.trees));
    return {
      start: round(s),
      mine: mines.length ? Math.round(near(s, mines)) : null,
      minesClose: own.length,
      nearestExpansion: (() => { const d = mines.map((m) => dist(m, s)).filter((v) => v > OWN_MINE[1] + 300); return d.length ? Math.round(Math.min(...d)) : null; })(),
      nearestCamp: field.length ? Math.round(near(s, field.map((c) => c.centre))) : null,
      nearestTree: f.trees.length ? treeNear : null,
      treesWithin1000: f.trees.filter((t) => dist(t, s) < 1000).length,
    };
  });

  // Gold.
  for (const m of perStart) {
    if (m.mine === null || m.mine > OWN_MINE[1] + 300) add("mine", "error", `The start has no mine of its own. On ladder maps it's 771 to 781 away.`, m.start);
    else if (m.mine < OWN_MINE[0] || m.mine > OWN_MINE[1]) add("mine", "error", `The start's mine is ${m.mine} away. On ladder maps it's 771 to 781, so a town hall sits right beside it.`, m.start);
    if (m.minesClose > 1) add("mine", "warning", `${m.minesClose} mines lie close to this start. One is usual: two hurt Night Elves.`, m.start);
    if (starts.length === 2 && m.nearestExpansion !== null && (m.nearestExpansion < 3000 || m.nearestExpansion > 6500)) add("expansion", "warning", `The nearest expansion is ${m.nearestExpansion} away. Ladder 1v1 maps have 3,800 to 5,800.`, m.start);
  }
  const expansions = mines.filter((m) => near(m, starts) > OWN_MINE[1] + 300);
  if (mines.length < starts.length + 1) add("expansion", "warning", `${mines.length} mines for ${starts.length} starts leaves nowhere to expand. Ladder 1v1 maps have 5 or 6.`);
  for (const m of expansions) if (!field.some((c) => dist(m, c.centre) < GUARD)) add("guard", "warning", "This expansion's mine has no creeps guarding it, so it's free to take.", m);

  // Camps.
  const perPlayer = field.length / starts.length;
  if (perPlayer < 7 || perPlayer > 12) add("camps", "warning", `${field.length} camps for ${starts.length} starts. Ladder 1v1 maps have 9 or 10 for each player.`);
  for (const c of field) {
    const away = near(c.centre, starts), label = `A camp of total level ${c.level}`;
    if (away < NEAREST_CAMP) add("camp distance", "error", `${label} is ${Math.round(away)} from a start. The nearest camp on any ladder map is 1,758, so this one fights the base.`, c.centre);
    if (c.level > 24) add("camp strength", "warning", `${label} is above the 24 of the strongest camps measured.`, c.centre);
    if (away < 2500 && c.strongest >= 6) add("camp strength", "warning", `This camp, ${Math.round(away)} from a start, has a level ${c.strongest} creep. First camps shouldn't.`, c.centre);
    if (!c.creeps.some((u) => u.drops)) add("drops", "warning", `${label} drops nothing, so it isn't worth fighting. Every measured camp drops something.`, c.centre);
    const camped = c.creeps.filter((u) => u.acquisition === -2).length;
    if (isGuard(c) && camped === c.creeps.length) add("camp mode", "warning", "This camp guards a mine but is all on Camp mode, so a player could expand beside it. None of the 23 measured guards is.", c.centre);
    if (!isGuard(c) && camped < c.creeps.length) add("camp mode", "error", `${c.creeps.length - camped} of ${c.creeps.length} creeps here aren't on Camp mode, and the camp guards no mine. All 92 such camps measured are.`, c.centre);
    if (c.creeps.length === 1 && c.level > 4) add("camp strength", "info", "A lone strong creep: measured camps have 2 to 6.", c.centre);
  }

  // Lumber.
  for (const m of perStart) {
    if (m.nearestTree === null) continue;
    if (m.nearestTree < TREE_NEAR[0] || m.nearestTree > TREE_NEAR[1]) add("lumber", "warning", `The nearest tree is ${m.nearestTree} from the start. Ladder maps have 547 to 692.`, m.start);
    if (m.treesWithin1000 < TREES_1000[0] || m.treesWithin1000 > TREES_1000[1]) add("lumber", "warning", `${m.treesWithin1000} trees within 1,000 of the start. Ladder maps have 36 to 54.`, m.start);
  }
  if (!f.trees.length) add("lumber", "error", "The map has no trees, so no lumber.");

  // Each start against the others.
  const spread = (values: (number | null)[]) => { const v = values.filter((n): n is number => n !== null); return v.length > 1 ? Math.max(...v) - Math.min(...v) : 0; };
  const compare = (what: string, key: "mine" | "nearestCamp" | "nearestTree" | "nearestExpansion", limit: number) => {
    const gap = spread(perStart.map((m) => m[key]));
    if (gap > limit) add("balance", "warning", `${what} differs by ${gap} between starts.`);
  };
  compare("The own mine's distance", "mine", 20);
  compare("The nearest camp's distance", "nearestCamp", FAIR);
  compare("The nearest tree's distance", "nearestTree", 150);
  compare("The nearest expansion's distance", "nearestExpansion", FAIR);
  if (spread(perStart.map((m) => m.treesWithin1000)) > 15) add("balance", "warning", `Trees near the start differ by ${spread(perStart.map((m) => m.treesWithin1000))} between starts.`);

  // Routes: who wakes.
  let camped = 0;
  for (const r of f.routes) {
    if (!r.points) { add("route", "error", `${r.name}: ${r.problem ?? "no way through"}.`); continue; }
    for (const c of field) {
      if (r.to && dist(r.to, c.centre) < GUARD) continue; // Going there means going to its guards.
      if (r.points.length && near(c.centre, [r.points[0]]) < 900) continue;
      let wakes = 0, soft = 0, closest = Infinity;
      for (const u of c.creeps) {
        const gap = toPath([u.x, u.y], r.points), sight = u.acquisition > 0 ? u.acquisition : f.sight(u.id) ?? 600;
        closest = Math.min(closest, gap);
        if (gap > sight) continue;
        if (u.acquisition === -2) soft++; else wakes++;
      }
      if (wakes) add("aggro", "error", `${r.name} passes ${Math.round(closest)} from a level ${c.level} camp with ${wakes} creep${wakes === 1 ? "" : "s"} not on Camp mode, inside their sight. They'll attack.`, c.centre);
      else if (soft) { camped++; add("aggro", "warning", `${r.name} passes ${Math.round(closest)} from a level ${c.level} camp, within the normal sight of ${soft} creep${soft === 1 ? "" : "s"}. They're on Camp mode, so they may well stay put: see accuracy.`, c.centre); }
    }
  }

  // What using a shop does.
  for (const s of shops) {
    const by = field.filter((c) => dist(c.centre, [s.x, s.y]) < f.shopNotify);
    if (by.length) add("shop", "info", `${s.id}: using it alerts ${by.length} camp${by.length === 1 ? "" : "s"} within ${f.shopNotify}. That's how a shop gets guarded.`, [s.x, s.y]);
    else add("shop", "info", `${s.id} has no camp within ${f.shopNotify}, so it's free to use. Ladder maps usually guard shops.`, [s.x, s.y]);
  }

  notes.push(
    "Normal sight comes from the game data, per creep. How far Camp mode shortens it isn't in the game's files, so a route within normal sight of a camped creep is a warning: it's the worst case, and the true range is shorter. Ladder maps pass this close too.",
    "A route inside the sight of creeps not on Camp mode is reported as a sure thing, which is true by day: creeps sleep at night, and then they don't react to this at all.",
    `One creep that wakes calls others within ${f.callForHelp} (the game's CreepCallForHelp), so a whole camp comes, even though only one saw the unit.`,
    "Routes are the shortest ways on this app's pathing grid, for one size of unit, not the paths the game picks. Players also walk elsewhere; a route passing clear says nothing about the rest of the map.",
    "Camps are worked out by distance: creeps within 450 of each other count as one, and a camp within 750 of an expansion's mine counts as its guard.",
    "Levels and ranges of map-made units come from the unit they're based on, so changes to those aren't seen.",
  );
  if (unknown.length) notes.push(`These types' levels weren't found, so they count as 0: ${unknown.join(", ")}.`);
  if (unknownSight.length) notes.push(`These types' sight wasn't found, so they count as 600: ${unknownSight.join(", ")}.`);

  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    errors: findings.filter((x) => x.severity === "error").length,
    warnings: findings.filter((x) => x.severity === "warning").length,
    measures: { starts: perStart, camps: field.length, guards: guards.length, startGuards: camps.length - field.length, mines: mines.length, trees: f.trees.length, campedRoutePasses: camped },
    findings,
    accuracy: notes,
  };
}
