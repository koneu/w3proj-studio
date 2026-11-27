// The AI Editor changes of the AI tools (MCP set_ai, get_ai), on a parsed .wai file: the General tab's name, race,
// options and workers, the heroes with their training chances and skills, the build priorities, and the attack
// waves' delay and repeats. Numbers within what the AI Editor's fields take (numbers.ts).

import { AI_OPTIONS, FIRST_HERO_ONLY, NO_ID, type AiCondition, type AiFile } from "../../lib/ai/wai";
import { aiNumber, repeatWavesLimits } from "./numbers";
import { ALL, BUILD_EXPANSION, BUILD_UNIT, BUILD_UPGRADE, quantityText, RACES, SPECIAL_BUILDS, TARGETS, townText, workersText } from "./labels";

/** The races, as the tools name them, by the number the file stores. */
export const AI_RACES = ["custom", "human", "orc", "undead", "nightelf"] as const;
const BUILD_KINDS = ["unit", "upgrade", "expansion"] as const;
/** An option's name as the tools take it: the editor's label in camelCase ("Melee game" → meleeGame). */
const optionKey = (label: string) => label.replace(/ (\w)/g, (_, c: string) => c.toUpperCase()).replace(/^\w/, (c) => c.toLowerCase());
export const AI_OPTION_KEYS: [number, string][] = AI_OPTIONS.map(([bit, label]) => [bit, optionKey(label)]);

const shown = (id: string) => (id === NO_ID ? "" : id);
const hasCondition = (c: { condIndex: number; cond: AiCondition }) => c.condIndex !== -1 || !!c.cond.call;
const conditionOf = (ai: AiFile, c: { condIndex: number; cond: AiCondition }) =>
  (c.condIndex !== -1 ? { condition: ai.conditions.find((x) => x.index === c.condIndex)?.name ?? `#${c.condIndex}` } : c.cond.call ? { condition: c.cond.name || "(custom)" } : {});

/** An AI as get_ai and set_ai's answer show it. */
export function describeAi(ai: AiFile) {
  return {
    name: ai.name, race: AI_RACES[ai.race] ?? ai.race,
    options: Object.fromEntries(AI_OPTION_KEYS.map(([bit, key]) => [key, !!(ai.options & bit)])),
    workers: { gold: shown(ai.workers[0]), wood: shown(ai.workers[1]), baseBuilding: shown(ai.workers[2]), mineBuilding: shown(ai.workers[3]) },
    conditions: ai.conditions.map((c) => c.name),
    heroes: ai.heroes.map(shown), heroChances: ai.heroChances,
    skills: ai.skills.map((list) => list.map(shown)),
    build: ai.build.map((b) => ({ id: b.id, kind: BUILD_KINDS[b.kind] ?? b.kind, town: townText(b.town), ...conditionOf(ai, b) })),
    harvest: ai.harvest.map((p) => ({ resource: p.resource === 0 ? "gold" : "wood", town: townText(p.town), workers: workersText(p.workers), ...conditionOf(ai, p) })),
    targets: ai.targets.map((t) => ({ target: TARGETS[t.target] ?? t.target, ...(t.creep ? { creepLevels: [t.creep.min, t.creep.max], flyers: !!t.creep.allowFlyers } : {}), ...conditionOf(ai, t) })),
    groups: ai.groups.map((g) => ({ name: g.name, units: g.units.map((u) => ({ id: u.id, quantity: quantityText(u.quantity, u.max), ...conditionOf(ai, u) })) })),
    waves: ai.waves.map((w) => ({ group: ai.groups.find((g) => g.index === w.group)?.name ?? w.group, delay: w.delay })),
    initialDelay: ai.initialDelay, repeatWaves: ai.repeatWaves,
    minimumForces: ai.minForces === FIRST_HERO_ONLY ? "First Hero Only" : ai.groups.find((g) => g.index === ai.minForces)?.name ?? ai.minForces,
  };
}

/** An object id a tool gave for `label`: four characters, or "" for none where that is allowed. */
function idOf(value: unknown, label: string, none = true): string {
  if (value === "" && none) return NO_ID;
  // A byte each, as the file stores it.
  if (typeof value !== "string" || value.length !== 4 || /[^\x20-\x7e]/.test(value)) throw new Error(`${label} must be an object id of four characters, like hpea${none ? ', or "" for none' : ""}.`);
  return value;
}

/** A town a tool gave: "any", "main", or an expansion's number from 1. */
function townOf(value: unknown, label: string): number {
  if (value === undefined || value === "any") return ALL;
  if (value === "main" || value === 0) return 0;
  if (Number.isInteger(value) && (value as number) > 0 && (value as number) <= 8) return value as number;
  throw new Error(`${label} must be "any", "main" or an expansion's number from 1 to 8.`);
}

/** A whole number a tool gave for an AI field, within the AI Editor's limits. */
function numberOf(value: unknown, label: string, limits: { min?: number; max?: number } = {}): number {
  if (typeof value !== "number") throw new Error(`${label} must be a number.`);
  const t = aiNumber(String(value), label, limits);
  if ("refused" in t) throw new Error(t.refused);
  return t.value;
}

/**
 * set_ai on `ai`: only what is given changes. A value the AI Editor wouldn't take refuses the call, and so does a new
 * build list while the old one has entries with conditions (they are function trees the tool can't carry over: such
 * a list is edited in the AI Editor). Whether anything changed.
 */
export function setAi(ai: AiFile, args: Record<string, unknown>): boolean {
  const before = JSON.stringify({ ...ai, extra: null });
  if (args.name !== undefined) {
    if (typeof args.name !== "string" || !args.name.trim()) throw new Error("name must be text.");
    ai.name = args.name;
  }
  if (args.race !== undefined) {
    const race = AI_RACES.indexOf(args.race as (typeof AI_RACES)[number]);
    if (race < 0) throw new Error(`race must be one of: ${AI_RACES.join(", ")}.`);
    ai.race = race;
  }
  if (args.options !== undefined) {
    const o = args.options;
    if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("options must be an object, like { meleeGame: true, heroesFlee: false }.");
    for (const [key, on] of Object.entries(o)) {
      const bit = AI_OPTION_KEYS.find(([, k]) => k === key)?.[0];
      if (bit === undefined) throw new Error(`"${key}" isn't an AI option. They are: ${AI_OPTION_KEYS.map(([, k]) => k).join(", ")}.`);
      if (typeof on !== "boolean") throw new Error(`options.${key} must be true or false.`);
      ai.options = (on ? ai.options | bit : ai.options & ~bit) >>> 0;
    }
  }
  if (args.workers !== undefined) {
    const w = args.workers as Record<string, unknown>;
    const keys = ["gold", "wood", "baseBuilding", "mineBuilding"];
    if (!w || typeof w !== "object" || Array.isArray(w) || Object.keys(w).some((k) => !keys.includes(k))) throw new Error(`workers takes ${keys.join(", ")}: each an object id, or "" for none.`);
    keys.forEach((k, i) => { if (w[k] !== undefined) ai.workers[i] = idOf(w[k], `workers.${k}`); });
  }
  if (args.heroes !== undefined) {
    if (!Array.isArray(args.heroes) || args.heroes.length !== 3) throw new Error('heroes must be three hero ids (first, second, third), "" for none.');
    ai.heroes = args.heroes.map((id, i) => idOf(id, `heroes[${i}]`));
  }
  if (args.heroChances !== undefined) {
    const c = args.heroChances;
    if (!Array.isArray(c) || c.length !== 6 || !c.every((n) => Number.isInteger(n) && n >= 0 && n <= 100) || c.reduce((a: number, b: number) => a + b, 0) !== 100) {
      throw new Error("heroChances must be six whole numbers from 0 to 100 that add up to 100: the chances of the training orders 1-2-3, 1-3-2, 2-1-3, 2-3-1, 3-1-2, 3-2-1.");
    }
    ai.heroChances = [...c] as number[];
  }
  if (args.skills !== undefined) {
    const s = args.skills;
    if (!Array.isArray(s) || s.length !== 9 || !s.every((list) => Array.isArray(list) && list.length === 10)) {
      throw new Error("skills must be nine lists of ten ability ids: the first hero's skill order when trained first, second and third, then the second hero's three, then the third's.");
    }
    ai.skills = (s as unknown[][]).map((list, i) => list.map((id, k) => idOf(id, `skills[${i}][${k}]`)));
  }
  if (args.build !== undefined) {
    if (!Array.isArray(args.build)) throw new Error('build must be a list, like [{ id: "htow" }, { id: "hpea" }, { id: "Rhme", kind: "upgrade" }].');
    if (ai.build.some(hasCondition)) throw new Error("The build priorities of this AI have conditions, which a new list can't carry over: change them in the AI Editor.");
    const special = new Set(SPECIAL_BUILDS.map(([id]) => id));
    ai.build = (args.build as Record<string, unknown>[]).map((b, i) => {
      const unknown = Object.keys(b ?? {}).filter((k) => !["id", "kind", "town"].includes(k));
      if (!b || typeof b !== "object" || unknown.length) throw new Error(`build[${i}] takes id, kind and town${unknown.length ? `, not ${unknown.join(", ")}` : ""}.`);
      const id = idOf(b.id, `build[${i}].id`, false);
      const kind = b.kind === undefined ? (id === "XEIA" ? BUILD_EXPANSION : BUILD_UNIT) : BUILD_KINDS.indexOf(b.kind as (typeof BUILD_KINDS)[number]);
      if (kind < 0) throw new Error(`build[${i}].kind must be unit, upgrade or expansion.`);
      if (special.has(id) && kind === BUILD_UPGRADE) throw new Error(`build[${i}]: ${id} isn't an upgrade.`);
      return { type: 0, kind, id, town: townOf(b.town, `build[${i}].town`), condIndex: -1, cond: { name: "", call: null } };
    });
  }
  if (args.initialDelay !== undefined) ai.initialDelay = numberOf(args.initialDelay, "Initial Delay", { min: 0 });
  if (args.repeatWaves !== undefined) ai.repeatWaves = numberOf(args.repeatWaves, "Repeat Waves", repeatWavesLimits(ai.waves.length));
  return JSON.stringify({ ...ai, extra: null }) !== before;
}

export { RACES };
