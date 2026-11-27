// The AI Editor changes of the AI tools (MCP set_ai, get_ai), on a parsed .wai file: the General tab's name, race,
// options and workers, the heroes with their training chances and skills, the build, harvest and target priorities,
// the attack groups and waves with their delays, repeats and minimum forces. Numbers within what the AI Editor's
// fields take (numbers.ts). Conditions stay the AI Editor's: a list that has some isn't replaced by a tool.

import { AI_OPTIONS, FIRST_HERO_ONLY, NO_ID, type AiCondition, type AiFile } from "../../lib/ai/wai";
import { aiNumber, HARVEST_WORKER_LIMITS, repeatWavesLimits } from "./numbers";
import { ALL, BUILD_EXPANSION, BUILD_UNIT, BUILD_UPGRADE, CREEPS, quantityText, RACES, SPECIAL_BUILDS, TARGETS, townText, workersText } from "./labels";

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

/** A town a tool gave: "any", "main", or an expansion's number from 1; also as get_ai shows one ("Any", "Main",
 *  "Exp 2", "Mine 1": the town that many mines on from the current one). Not given: `unset`. */
function townOf(value: unknown, label: string, unset = ALL): number {
  if (value === undefined) return unset;
  const text = typeof value === "string" ? value.trim().toLowerCase() : null;
  if (text === "any") return ALL;
  if (text === "main" || value === 0) return 0;
  const named = text === null ? null : /^(exp|mine) ?(\d)$/.exec(text);
  if (named?.[1] === "mine" && Number(named[2]) <= 4) return (-3 - Number(named[2])) >>> 0;
  const n = named?.[1] === "exp" ? Number(named[2]) : value;
  if (Number.isInteger(n) && (n as number) > 0 && (n as number) <= 8) return n as number;
  throw new Error(`${label} must be "any", "main" or an expansion's number from 1 to 8.`);
}

/** A list of objects a tool gave, each with only the keys it may have. */
function listOf(value: unknown, label: string, keys: string[], example: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list, like ${example}.`);
  value.forEach((x, i) => {
    const unknown = x && typeof x === "object" && !Array.isArray(x) ? Object.keys(x as object).filter((k) => !keys.includes(k)) : null;
    if (!unknown || unknown.length) throw new Error(`${label}[${i}] takes ${keys.join(", ").replace(/, ([^,]*)$/, " and $1")}${unknown?.length ? `, not ${unknown.join(", ")}` : ""}.`);
  });
  return value as Record<string, unknown>[];
}

/** An attack unit's quantity as a tool gave it: a number, or as get_ai shows one ("All", "All but 2", "3", "2 - All",
 *  "2 - 5"). The file's minimum and maximum. */
function quantityOf(value: unknown, label: string): { quantity: number; max: number } {
  const whole = (v: string | number, what: string, min: number) => numberOf(Number(v), `${label} (${what})`, { min });
  if (value === undefined) return { quantity: ALL, max: ALL };
  if (typeof value === "number") { const n = whole(value, "quantity", 0); return { quantity: n, max: n }; }
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "all") return { quantity: ALL, max: ALL };
  let m = /^all but (\d+)$/.exec(text);
  if (m) return { quantity: ALL, max: whole(m[1], "units kept back", 1) };
  m = /^(\d+)$/.exec(text);
  if (m) { const n = whole(m[1], "quantity", 0); return { quantity: n, max: n }; }
  m = /^(\d+) ?- ?all$/.exec(text);
  if (m) return { quantity: whole(m[1], "quantity", 0), max: ALL };
  m = /^(\d+) ?- ?(\d+)$/.exec(text);
  if (m) {
    const min = whole(m[1], "quantity", 0), max = whole(m[2], "maximum quantity", 0);
    if (max < min) throw new Error(`${label}: the maximum ${max} is below the minimum ${min}.`);
    return { quantity: min, max };
  }
  throw new Error(`${label} must be a number or one of "All", "All but 2", "2 - All", "2 - 5".`);
}

const NO_COND = (): AiCondition => ({ name: "", call: null });
const conditionsStay = (what: string) => new Error(`The ${what} of this AI have conditions, which a new list can't carry over: change them in the AI Editor.`);

/** A whole number a tool gave for an AI field, within the AI Editor's limits. */
function numberOf(value: unknown, label: string, limits: { min?: number; max?: number } = {}): number {
  if (typeof value !== "number") throw new Error(`${label} must be a number.`);
  const t = aiNumber(String(value), label, limits);
  if ("refused" in t) throw new Error(t.refused);
  return t.value;
}

/**
 * set_ai on `ai`: only what is given changes. A value the AI Editor wouldn't take refuses the call, and so does a new
 * build, harvest, target or attack group list while the old one has entries with conditions (they are function trees
 * the tool can't carry over: such a list is edited in the AI Editor). New attack groups keep the waves and the
 * minimum forces of the groups whose names stay. Whether anything changed.
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
  if (args.harvest !== undefined) {
    const list = listOf(args.harvest, "harvest", ["resource", "town", "workers"], '[{ resource: "gold", town: "main", workers: 5 }, { resource: "wood", workers: "All" }]');
    if (ai.harvest.some(hasCondition)) throw conditionsStay("harvest priorities");
    ai.harvest = list.map((p, i) => {
      if (p.resource !== "gold" && p.resource !== "wood") throw new Error(`harvest[${i}].resource must be gold or wood.`);
      const w = typeof p.workers === "string" ? p.workers.trim().toLowerCase() : p.workers;
      // All, and all that aren't attacking: -1 and -2 as the file stores them.
      const workers = w === "all" ? ALL : w === "all na" ? (-2 >>> 0) : typeof w === "number" ? numberOf(w, `harvest[${i}].workers`, HARVEST_WORKER_LIMITS) : null;
      if (workers === null) throw new Error(`harvest[${i}].workers must be a number from ${HARVEST_WORKER_LIMITS.min} to ${HARVEST_WORKER_LIMITS.max}, "All" or "All NA" (all that aren't attacking).`);
      return { type: 1, resource: p.resource === "gold" ? 0 : 1, town: townOf(p.town, `harvest[${i}].town`, 0), workers, condIndex: -1, cond: NO_COND() };
    });
  }
  if (args.targets !== undefined) {
    const list = listOf(args.targets, "targets", ["target", "creepLevels", "flyers"], '[{ target: "Enemy - Major Assault" }, { target: "Creep Camp", creepLevels: [0, 9], flyers: false }]');
    if (ai.targets.some(hasCondition)) throw conditionsStay("target priorities");
    ai.targets = list.map((t, i) => {
      const target = typeof t.target === "string" ? TARGETS.findIndex((n) => n.toLowerCase() === (t.target as string).trim().toLowerCase()) : -1;
      if (target < 0) throw new Error(`targets[${i}].target must be one of: ${TARGETS.join("; ")}.`);
      if (target !== CREEPS) {
        if (t.creepLevels !== undefined || t.flyers !== undefined) throw new Error(`targets[${i}]: creepLevels and flyers belong to a Creep Camp target only.`);
        return { type: 2, target, condIndex: -1, cond: NO_COND() };
      }
      const levels = t.creepLevels ?? [0, 9];
      if (!Array.isArray(levels) || levels.length !== 2) throw new Error(`targets[${i}].creepLevels must be two numbers: the camp's minimum and maximum strength.`);
      const min = numberOf(levels[0], `targets[${i}].creepLevels (minimum strength)`, { min: 0 }), max = numberOf(levels[1], `targets[${i}].creepLevels (maximum strength)`, { min: 0 });
      if (max < min) throw new Error(`targets[${i}].creepLevels: the maximum ${max} is below the minimum ${min}.`);
      if (t.flyers !== undefined && typeof t.flyers !== "boolean") throw new Error(`targets[${i}].flyers must be true or false.`);
      return { type: 2, target, creep: { min, max, allowFlyers: t.flyers ? 1 : 0 }, condIndex: -1, cond: NO_COND() };
    });
  }
  /** The name of the group the minimum forces are (null: First Hero Only), before the groups change. */
  const forcesName = ai.minForces === FIRST_HERO_ONLY ? null : ai.groups.find((g) => g.index === ai.minForces)?.name ?? null;
  if (args.groups !== undefined) {
    const list = listOf(args.groups, "groups", ["name", "units"], '[{ name: "Rush", units: [{ id: "hfoo", quantity: 4 }, { id: "1HIA", quantity: "All" }] }]');
    if (ai.groups.some((g) => g.units.some(hasCondition))) throw conditionsStay("attack groups' units");
    const names = new Set<string>();
    const groups = list.map((g, i) => {
      if (typeof g.name !== "string" || !g.name.trim()) throw new Error(`groups[${i}].name must be text.`);
      if (names.has(g.name)) throw new Error(`groups[${i}]: there are two groups called ${g.name}; waves name their group, so each needs its own name.`);
      names.add(g.name);
      const units = listOf(g.units ?? [], `groups[${i}].units`, ["id", "quantity"], '[{ id: "hfoo", quantity: 4 }]').map((u, k) =>
        ({ id: idOf(u.id, `groups[${i}].units[${k}].id`, false), ...quantityOf(u.quantity, `groups[${i}].units[${k}].quantity`), condIndex: -1, cond: NO_COND() }));
      return { index: i, name: g.name, units };
    });
    // The waves and the minimum forces name groups by their place: they follow the names.
    const place = new Map(groups.map((g) => [g.name, g.index]));
    const waves = ai.waves.map((w) => ({ ...w, name: ai.groups.find((g) => g.index === w.group)?.name }));
    const lost = waves.find((w) => w.name === undefined || !place.has(w.name));
    if (lost && args.waves === undefined) throw new Error(`The attack waves use the group ${lost.name ?? `#${lost.group}`}, which the new groups don't have: give waves too.`);
    ai.waves = waves.filter((w) => w.name !== undefined && place.has(w.name)).map((w) => ({ group: place.get(w.name!)!, delay: w.delay }));
    ai.groups = groups;
    ai.minForces = forcesName !== null && place.has(forcesName) ? place.get(forcesName)! : FIRST_HERO_ONLY;
  }
  const groupOf = (value: unknown, label: string): number => {
    const g = typeof value === "string" ? ai.groups.find((x) => x.name === value) : undefined;
    if (!g) throw new Error(`${label} the name of an attack group: ${ai.groups.map((x) => x.name).join(", ") || "there are none"}.`);
    return g.index;
  };
  if (args.waves !== undefined) {
    const list = listOf(args.waves, "waves", ["group", "delay"], '[{ group: "Rush", delay: 60 }]');
    ai.waves = list.map((w, i) => ({ group: groupOf(w.group, `waves[${i}].group must be`), delay: w.delay === undefined ? 0 : numberOf(w.delay, `waves[${i}].delay`, { min: 0 }) }));
  }
  if (args.minimumForces !== undefined) ai.minForces = args.minimumForces === "First Hero Only" ? FIRST_HERO_ONLY : groupOf(args.minimumForces, 'minimumForces must be "First Hero Only" or');
  if (args.initialDelay !== undefined) ai.initialDelay = numberOf(args.initialDelay, "Initial Delay", { min: 0 });
  if (args.repeatWaves !== undefined) ai.repeatWaves = numberOf(args.repeatWaves, "Repeat Waves", repeatWavesLimits(ai.waves.length));
  // Fewer waves than are repeated: said, not pulled in.
  if (ai.repeatWaves > ai.waves.length) throw new Error(`Repeat Waves is ${ai.repeatWaves}, more than the ${ai.waves.length} attack wave${ai.waves.length === 1 ? "" : "s"} there would be: give repeatWaves too (0 to ${ai.waves.length}).`);
  return JSON.stringify({ ...ai, extra: null }) !== before;
}

export { RACES };
