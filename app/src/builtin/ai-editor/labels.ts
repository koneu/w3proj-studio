// What the AI Editor shows for the numbers a .wai file stores: towns, worker
// counts, attack quantities, targets, special build entries. The encodings
// were read off the game's AI files and the scripts generated from them
// (Scripts/reforged_u08_*.ai): town 0 is the main town (HarvestGold(0, …)),
// -3 - k the town k mines on from the current one (the conditions of
// WyrmMonger.wai use "Town with a gold mine + 1" in the same places).

import type { AiFile } from "../../lib/ai/wai";

export const RACES = ["Custom", "Human", "Orc", "Undead", "Night Elf"];

/** Build entries that aren't object ids: the AI's heroes and an expansion. */
export const SPECIAL_BUILDS: [string, string][] = [["1HIA", "Hero - First"], ["2HIA", "Hero - Second"], ["3HIA", "Hero - Third"], ["XEIA", "Expansion Town"]];
export const BUILD_UNIT = 0, BUILD_UPGRADE = 1, BUILD_EXPANSION = 2;

export const TARGETS = ["Common Alliance Target", "New Expansion Location", "Enemy - Major Assault", "Enemy - Expansion", "Enemy - Any Town",
  "Creep Camp", "Purchase Goblin Zeppelin"];
export const CREEPS = 5;

/** Unsigned "all"/"any" (-1) as the files store it. */
export const ALL = 0xffffffff;
const signed = (n: number) => n | 0;

/** Town: -1 any, 0 main, n expansion n, -3 - k the k-th mine from the current one. */
export function townText(town: number): string {
  const t = signed(town);
  if (t === -1) return "Any";
  if (t === 0) return "Main";
  if (t > 0) return `Exp ${t}`;
  if (t <= -3) return `Mine ${-3 - t}`;
  return String(t);
}
/** Choices of the town menu (the current value is kept if it's beyond them). */
export function townChoices(current: number): [number, string][] {
  const list: number[] = [ALL, 0, 1, 2, 3, 4, 5, 6, 7, 8, (-3 >>> 0), (-4 >>> 0), (-5 >>> 0), (-6 >>> 0), (-7 >>> 0)];
  if (!list.includes(current)) list.push(current);
  return list.map((t) => [t, townText(t)]);
}

/** Harvest workers: -1 all, -2 all not attacking, else a number. */
export function workersText(n: number): string {
  const v = signed(n);
  return v === -1 ? "All" : v === -2 ? "All NA" : String(v);
}

/** Attack group quantities: minimum and maximum, -1 = all. */
export function quantityText(min: number, max: number): string {
  if (signed(min) === -1) return "All";
  if (signed(max) === -1) return `${min} - All`;
  return min === max ? String(min) : `${min} - ${max}`;
}

/** "Total" of the build list: how many of the entry's unit or upgrade the list asks for up to there. */
export function buildTotals(ai: AiFile): number[] {
  const seen = new Map<string, number>();
  return ai.build.map((b) => {
    const k = `${b.kind}:${b.id}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n;
  });
}

/** The orders the three heroes can be trained in, as the six chances are stored. */
export const HERO_ORDERS = ["1, 2, 3", "1, 3, 2", "2, 1, 3", "2, 3, 1", "3, 1, 2", "3, 2, 1"];

/** Removes a named condition: references to it go, later ones move down. */
export function removeCondition(ai: AiFile, index: number) {
  ai.conditions = ai.conditions.filter((c) => c.index !== index);
  ai.conditions.forEach((c, i) => { c.index = i; });
  const fix = (x: { condIndex: number }) => {
    if (x.condIndex === index) x.condIndex = -1;
    else if (x.condIndex > index) x.condIndex--;
  };
  [...ai.build, ...ai.harvest, ...ai.targets, ...ai.groups.flatMap((g) => g.units)].forEach(fix);
}

/** Uses of a named condition by priorities and attack units. */
export function conditionUses(ai: AiFile, index: number): number {
  return [...ai.build, ...ai.harvest, ...ai.targets, ...ai.groups.flatMap((g) => g.units)].filter((x) => x.condIndex === index).length;
}

/** Removes an attack group: its waves go, later groups move down (waves, minimum forces). */
export function removeGroup(ai: AiFile, index: number) {
  ai.groups = ai.groups.filter((g) => g.index !== index);
  ai.groups.forEach((g, i) => { g.index = i; });
  ai.waves = ai.waves.filter((w) => w.group !== index).map((w) => ({ ...w, group: w.group > index ? w.group - 1 : w.group }));
  if (ai.minForces === index) ai.minForces = 0;
  else if (ai.minForces > index) ai.minForces--;
}
