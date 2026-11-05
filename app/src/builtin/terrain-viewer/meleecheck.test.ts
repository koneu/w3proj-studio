import assert from "node:assert/strict";
import { test } from "node:test";
import { campsOf, checkMelee, type MeleeFacts, type MeleeUnit } from "./meleecheck";

type Point = [number, number];
const unit = (id: string, x: number, y: number, more: Partial<MeleeUnit> = {}): MeleeUnit => ({ id, x, y, player: 24, acquisition: -2, drops: true, ...more });
const neutral = (id: string, x: number, y: number) => unit(id, x, y, { player: 27, acquisition: -1, drops: false });
/** A camp of three, around a place. */
const camp = (x: number, y: number, more: Partial<MeleeUnit> = {}) => [unit("nogr", x, y, more), unit("nogr", x + 100, y, { ...more, drops: false }), unit("ngno", x, y + 100, { ...more, drops: false })];

/** Forty-five trees just past 600 from a place. */
const grove = ([x, y]: Point): Point[] => Array.from({ length: 45 }, (_, i) => [x + 620 + (i % 5) * 60, y + Math.floor(i / 5) * 60]);

/** A fair map: two rotated bases with a mine, an expansion with guards, and camps by the edge. */
function map(extra: MeleeUnit[] = []): MeleeFacts {
  const half = (k: number): MeleeUnit[] => [
    unit("sloc", -5000 * k, 0, { player: 0, acquisition: 0, drops: false }), neutral("ngol", -5000 * k, 776 * k),
    neutral("ngol", 0, 3000 * k), ...camp(-100, 3300 * k, { acquisition: -1 }),
    ...Array.from({ length: 9 }, (_, i) => camp(-4400 * k + 1100 * i * k, -4800 * k)).flat(),
  ];
  return {
    units: [...half(1), ...half(-1), ...extra],
    trees: [...grove([-5000, 0]), ...grove([5000, 0])],
    level: (id) => ({ nogr: 3, ngno: 2 } as Record<string, number>)[id],
    sight: (id) => ({ nogr: 600, ngno: 500 } as Record<string, number>)[id],
    routes: [], callForHelp: 600, shopNotify: 900,
  };
}
const rules = (f: MeleeFacts, severity: string) => checkMelee(f).findings.filter((x) => x.severity === severity).map((x) => x.rule);

test("a fair map has no errors or warnings", () => {
  const r = checkMelee(map());
  assert.deepEqual(r.findings.filter((x) => x.severity !== "info"), []);
  assert.equal(r.measures?.camps, 20);
  assert.equal(r.measures?.guards, 2);
});

test("every answer says how far to trust it, the Camp range above all", () => {
  const { accuracy } = checkMelee(map());
  assert.ok(accuracy.some((n) => /Camp mode shortens/.test(n) && /worst case/.test(n)));
  assert.ok(accuracy.some((n) => /calls others within 600/.test(n)));
  assert.ok(accuracy.some((n) => /sleep at night/.test(n)));
  assert.ok(accuracy.some((n) => /fun/.test(n)));
});

test("too few starts stop it, and say why", () => {
  const r = checkMelee({ ...map(), units: [unit("sloc", 0, 0, { player: 0 })] });
  assert.equal(r.errors, 1);
  assert.match(r.findings[0].message, /at least 2 start/);
  assert.ok(r.accuracy.length > 0);
});

test("a camp close to a base is an error with its place", () => {
  const f = checkMelee(map(camp(-3900, 0)));
  const hit = f.findings.find((x) => x.rule === "camp distance");
  assert.equal(hit?.severity, "error");
  assert.match(hit!.message, /1,758/);
  assert.deepEqual(hit!.at, [-3867, 33]);
});

test("creeps not on Camp mode away from a mine are an error; guards on it a warning", () => {
  assert.ok(rules(map(camp(0, 0, { acquisition: -1 })), "error").includes("camp mode"));
  const f = map();
  const guarded = { ...f, units: f.units.map((u) => (u.id !== "sloc" && u.player === 24 ? { ...u, acquisition: -2 } : u)) };
  assert.ok(rules(guarded, "warning").includes("camp mode"));
});

test("a mine in the wrong place, or none, is an error", () => {
  const f = map();
  const moved = { ...f, units: f.units.map((u) => (u.id === "ngol" && u.x === -5000 ? { ...u, y: 1000 } : u)) };
  assert.ok(checkMelee(moved).findings.some((x) => x.rule === "mine" && /1000 away/.test(x.message)));
  const gone = { ...f, units: f.units.filter((u) => !(u.id === "ngol" && u.x === -5000)) };
  assert.ok(checkMelee(gone).findings.some((x) => x.rule === "mine" && /no mine of its own/.test(x.message)));
});

test("an expansion nobody guards, and a camp without drops, are warnings", () => {
  const f = map();
  const bare = { ...f, units: f.units.filter((u) => !(u.y >= 3300 && u.y <= 3400)) };
  assert.ok(rules(bare, "warning").includes("guard"));
  assert.ok(rules(map(camp(0, 0, { drops: false }).map((u) => ({ ...u, drops: false }))), "warning").includes("drops"));
});

test("strong first camps and huge camps are warnings", () => {
  const near = [unit("nbig", -2900, 0)];
  const f = { ...map(near), level: (id: string) => (id === "nbig" ? 9 : map().level(id)) };
  assert.ok(rules(f, "warning").includes("camp strength"));
});

test("lumber: none is an error, too little or uneven a warning", () => {
  assert.ok(rules({ ...map(), trees: [] }, "error").includes("lumber"));
  const few = { ...map(), trees: [...grove([-5000, 0]).slice(0, 10), ...grove([5000, 0])] };
  assert.ok(rules(few, "warning").includes("lumber"));
  assert.ok(rules(few, "warning").includes("balance"));
});

test("one base further from its mine than the other is a balance warning", () => {
  const f = map();
  const uneven = { ...f, units: f.units.map((u) => (u.id === "ngol" && u.x === 5000 ? { ...u, y: -810 } : u)) };
  assert.ok(rules(uneven, "warning").includes("balance"));
});

test("a route past creeps not on Camp mode is sure; past camped ones it's the worst case", () => {
  const sure = { ...map(camp(0, 400, { acquisition: -1 })), routes: [{ name: "Base to base", points: [[-5000, 0], [5000, 0]] as Point[] }] };
  const hit = checkMelee(sure).findings.find((x) => x.rule === "aggro")!;
  assert.equal(hit.severity, "error");
  assert.match(hit.message, /They'll attack/);
  const soft = { ...map(camp(0, 400)), routes: sure.routes };
  const maybe = checkMelee(soft).findings.find((x) => x.rule === "aggro")!;
  assert.equal(maybe.severity, "warning");
  assert.match(maybe.message, /may well stay put/);
});

test("a creep's own range counts, in both directions", () => {
  const short = { ...map(camp(0, 400, { acquisition: 100 })), routes: [{ name: "Base to base", points: [[-5000, 0], [5000, 0]] as Point[] }] };
  assert.ok(!checkMelee(short).findings.some((x) => x.rule === "aggro"));
  const long = { ...map(camp(0, 1000, { acquisition: 1200 })), routes: short.routes };
  assert.ok(checkMelee(long).findings.some((x) => x.rule === "aggro" && x.severity === "error"));
});

test("a route to a mine doesn't count its guards, and a route nobody can walk is an error", () => {
  const f = map();
  const toMine = { ...f, routes: [{ name: "To the mine", to: [0, 3000] as Point, points: [[0, 0], [0, 3000]] as Point[] }] };
  assert.ok(!checkMelee(toMine).findings.some((x) => x.rule === "aggro"));
  const stuck = { ...f, routes: [{ name: "Base to base", problem: "There's no way through." }] };
  assert.ok(checkMelee(stuck).findings.some((x) => x.rule === "route" && /no way through/.test(x.message)));
});

test("on a map for more players, creeps on a start guard it, and aren't a camp beside a base", () => {
  const four = (p: Point) => [unit("sloc", p[0], p[1], { player: 0, drops: false }), neutral("ngol", p[0], p[1] + 776)];
  const units = [...four([-5000, -5000]), ...four([5000, -5000]), ...four([-5000, 5000]), ...four([5000, 5000]), ...camp(5000, 5100, { acquisition: -1 })];
  const f = { ...map(), units, trees: [] };
  const r = checkMelee(f);
  assert.ok(!r.findings.some((x) => x.rule === "camp distance"));
  assert.equal(r.measures?.startGuards, 1);
});

test("using a shop: which camps it alerts", () => {
  const f = checkMelee(map([neutral("ngme", 0, 3200)]));
  assert.ok(f.findings.some((x) => x.rule === "shop" && /alerts 1 camp within 900/.test(x.message)));
  const free = checkMelee(map([neutral("ngme", 0, 0)]));
  assert.ok(free.findings.some((x) => x.rule === "shop" && /free to use/.test(x.message)));
});

test("camps on top of each other are found, however they overlap", () => {
  const close = checkMelee(map([...camp(0, 600), ...camp(0, 1300)]));
  assert.ok(close.findings.some((x) => x.rule === "camp overlap" && /Two camps stand/.test(x.message)));
  const merged = checkMelee(map([...camp(0, 0), ...camp(300, 0), ...camp(150, 200)]));
  assert.ok(merged.findings.some((x) => x.rule === "camp overlap" && x.severity === "error" && /run into each other/.test(x.message)));
  const stacked = checkMelee(map([unit("nogr", 0, 0), unit("nogr", 30, 0, { drops: false })]));
  assert.ok(stacked.findings.some((x) => /on top of each other/.test(x.message)));
  assert.ok(checkMelee(map([unit("nogr", 0, 0), unit("nogr", 440, 0), unit("nogr", 880, 0), unit("nogr", 1320, 0)])).findings.some((x) => /spreads/.test(x.message)));
});

test("a narrow way to a camp is an error, a tight one a warning, and guards don't count", () => {
  const at = (way: number) => ({ ...map(camp(0, 0)), widestTo: (x: number, y: number) => (Math.hypot(x, y) < 200 ? way : 480) });
  assert.ok(checkMelee(at(96)).findings.some((x) => x.rule === "camp access" && x.severity === "error"));
  assert.ok(checkMelee(at(192)).findings.some((x) => x.rule === "camp access" && x.severity === "warning"));
  assert.ok(!checkMelee(at(480)).findings.some((x) => x.rule === "camp access"));
  assert.ok(!checkMelee({ ...map(), widestTo: () => 32 }).findings.some((x) => x.rule === "camp access" && /3300/.test(x.message)));
});

test("stray narrow paths are reported only past what ladder maps have", () => {
  const strip = { cells: 60, at: [100, 200] as const };
  assert.ok(!checkMelee({ ...map(), narrow: { percent: 2, strips: [strip] } }).findings.some((x) => x.rule === "narrow path"));
  const many = checkMelee({ ...map(), narrow: { percent: 2, strips: Array(12).fill(strip) } });
  assert.ok(many.findings.some((x) => x.rule === "narrow path" && x.severity === "warning" && /12 stray/.test(x.message)));
  assert.ok(checkMelee({ ...map(), narrow: { percent: 9, strips: [strip] } }).findings.some((x) => x.rule === "narrow path" && x.at?.[0] === 100));
});

test("unequal walks show, however even the map looks", () => {
  const walk = (from: number, length: number) => ({ name: `Start ${from + 1} to a mine`, points: [] as Point[], from, length });
  const even = { ...map(), routes: [walk(0, 5000), walk(1, 5200), walk(0, 7000), walk(1, 7100)] };
  assert.ok(!checkMelee(even).findings.some((x) => x.rule === "balance"));
  const uneven = { ...map(), routes: [walk(0, 5000), walk(1, 6200)] };
  assert.ok(checkMelee(uneven).findings.some((x) => x.rule === "balance" && /differs by 1200/.test(x.message)));
});

test("the natural: on foot, on the level, forward", () => {
  const route = (from: number, to: Point, length: number) => ({ name: "To a mine", points: [] as Point[], from, to, length });
  const good = { ...map(), routes: [route(0, [-1000, 3000], 5900), route(1, [1000, -3000], 5900)] };
  assert.ok(!checkMelee(good).findings.some((x) => x.rule === "natural"));
  const winding = { ...map(), routes: [route(0, [-1000, 3000], 6900), route(1, [1000, -3000], 6900)] };
  assert.ok(checkMelee(winding).findings.some((x) => x.rule === "natural" && /winds/.test(x.message)));
  const far = { ...map(), routes: [route(0, [-1000, 3000], 7500), route(1, [1000, -3000], 7500)] };
  assert.ok(checkMelee(far).findings.some((x) => x.rule === "natural" && /7500 to walk/.test(x.message)));
  const behind = { ...map(), routes: [route(0, [-9000, 500], 4100), route(1, [9000, -500], 4100)] };
  assert.ok(checkMelee(behind).findings.some((x) => x.rule === "natural" && /behind the base/.test(x.message)));
  const high = { ...good, levelAt: (_x: number, y: number) => (y > 2000 || y < -2000 ? 3 : 2), commonLevel: 2 };
  assert.ok(checkMelee(high).findings.some((x) => x.rule === "natural" && /another cliff level/.test(x.message)));
});

test("a base above the usual ground is worth a reason", () => {
  const f = { ...map(), levelAt: () => 4, commonLevel: 2 };
  assert.ok(checkMelee(f).findings.some((x) => x.rule === "base height" && x.severity === "warning"));
  assert.ok(!checkMelee({ ...map(), levelAt: () => 2, commonLevel: 2 }).findings.some((x) => x.rule === "base height"));
});

test("findings say what to do about them", () => {
  const f = checkMelee(map(camp(-3900, 0))).findings.find((x) => x.rule === "camp distance")!;
  assert.match(f.fix ?? "", /find_spots/);
  assert.ok(checkMelee(map([neutral("ngme", 0, 0)])).findings.filter((x) => x.severity === "info").every((x) => !x.fix));
});

test("types the game doesn't know are named, not guessed at silently", () => {
  const r = checkMelee(map([unit("zzzz", 0, 0)]));
  assert.ok(r.accuracy.some((n) => /levels weren't found.*zzzz/.test(n)));
  assert.ok(r.accuracy.some((n) => /sight wasn't found.*zzzz/.test(n)));
});

test("creeps group by reach, and random ones count by their level", () => {
  const camps = campsOf([unit("nogr", 0, 0), unit("nogr", 400, 0), unit("nogr", 800, 0), unit("nogr", 3000, 0), unit("YYU3", 3100, 0, { randomLevel: 3 })], { level: (id) => (id === "nogr" ? 3 : undefined) });
  assert.deepEqual(camps.map((c) => c.level).sort((a, b) => a - b), [6, 9]);
});
