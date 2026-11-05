// .wai files: the AI Editor's AI definitions (name, race, options, workers,
// conditions, heroes and skills, build/harvest/target priorities, attack
// groups and waves, test game settings). Layout from the community
// documentation of war3map.wai (version 2), checked byte-exact on the game's
// files. Conditions are function trees like trigger parameters; their
// argument counts come from TriggerData plus AIEditorData's [AIFunctions].

import { decodeLossless, encodeLossless } from "../formats/lossless";
import { CALL, CONDITION, type TriggerData, type TriggerFunction } from "../triggers/triggerdata";
import type { Param } from "../triggers/wtg";

export interface AiCall { name: string; hasParams: boolean; params: Param[]; trailer: number }
/** A condition: a boolean function tree, or none. */
export interface AiCondition { name: string; call: AiCall | null }
export interface AiNamedCondition extends AiCondition { index: number }

export interface BuildPriority { type: number; kind: number; id: string; town: number; condIndex: number; cond: AiCondition }
export interface HarvestPriority { type: number; resource: number; town: number; workers: number; condIndex: number; cond: AiCondition }
/** Creep targets (target 5) also store creep strength and whether flyers count. */
export interface TargetPriority { type: number; target: number; creep?: { min: number; max: number; allowFlyers: number }; condIndex: number; cond: AiCondition }
export interface GroupUnit { id: string; quantity: number; max: number; condIndex: number; cond: AiCondition }
export interface AttackGroup { index: number; name: string; units: GroupUnit[] }
export interface AttackWave { group: number; delay: number }
export interface TestPlayer { index: number; team: number; race: number; color: number; handicap: number; aiType: number; difficulty: number; script: string }

export interface AiFile {
  version: number;
  name: string;
  /** 0 custom, 1 human, 2 orc, 3 undead, 4 night elf. */
  race: number;
  /** Option bits (see AI_OPTIONS). */
  options: number;
  /** Gold worker, wood worker, base building, mine building. */
  workers: string[];
  conditionsUnknown: number;
  conditions: AiNamedCondition[];
  heroes: string[];
  /** Chances of the six orders the three heroes can be trained in. */
  heroChances: number[];
  /** Nine lists of ten skills: each hero as first, second and third hero. */
  skills: string[][];
  build: BuildPriority[];
  harvest: HarvestPriority[];
  targets: TargetPriority[];
  repeatWaves: number;
  minForces: number;
  initialDelay: number;
  groups: AttackGroup[];
  waves: AttackWave[];
  wavesUnknown: number;
  gameOptions: number;
  gameSpeed: number;
  mapPath: string;
  players: TestPlayer[];
  /** 1 when object data follows (the documentation's last, unexplained field). */
  trailer: number;
  /** What follows, kept as it is: the path and date of the object data (.w3o) the AI was made
   *  with, and that object data (Reforged campaign AIs). */
  extra: Uint8Array;
}

/** The object data an AI file carries after its documented end: where it came from, and when. */
export function embeddedObjectData(f: AiFile): { path: string; date: string } | null {
  const b = f.extra;
  if (f.trailer !== 1 || !b.length) return null;
  const e1 = b.indexOf(0), e2 = e1 < 0 ? -1 : b.indexOf(0, e1 + 1);
  return e2 < 0 ? null : { path: decodeLossless(b.subarray(0, e1)), date: decodeLossless(b.subarray(e1 + 1, e2)) };
}

/** Option bits of the options field. */
export const AI_OPTIONS: [number, string][] = [
  [0x0001, "Melee game"], [0x0002, "Target heroes"], [0x0004, "Repair structures"], [0x0008, "Heroes flee"],
  [0x0010, "Units flee"], [0x0020, "Groups flee"], [0x0040, "Have no mercy"], [0x0080, "Ignore injured"],
  [0x0100, "Take items"], [0x0200, "Slow harvesting"], [0x0400, "Allow home changes"], [0x0800, "Smart artillery"],
  [0x1000, "Remove injuries"], [0x2000, "Set player name"], [0x4000, "Random paths"], [0x8000, "Defend users"],
  [0x10000, "Buy items"],
];


class Reader {
  o = 0;
  private v: DataView;
  constructor(private b: Uint8Array) { this.v = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  u32() { const x = this.v.getUint32(this.o, true); this.o += 4; return x; }
  i32() { const x = this.v.getInt32(this.o, true); this.o += 4; return x; }
  id() { const s = decodeLossless(this.b.subarray(this.o, this.o + 4)); this.o += 4; return s; }
  str() { const e = this.b.indexOf(0, this.o); if (e < 0) throw new Error("unterminated string"); const s = decodeLossless(this.b.subarray(this.o, e)); this.o = e + 1; return s; }
  get done() { return this.o >= this.b.length; }
}

class Writer {
  private parts: number[] = [];
  u32(x: number) { this.parts.push(x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255); return this; }
  i32(x: number) { return this.u32(x >>> 0); }
  id(s: string) { this.parts.push(...encodeLossless(s.padEnd(4, "\0")).subarray(0, 4)); return this; }
  str(s: string) { this.parts.push(...encodeLossless(s), 0); return this; }
  done() { return new Uint8Array(this.parts); }
}

/** Argument counts by function name. */
export type ArgCount = (name: string) => number;

/** The functions AI conditions are made of: AIEditorData.txt's [AIFunctions] (written like
 *  TriggerData's [TriggerCalls]) and the TriggerData calls marked _UseWithAI, which take their
 *  _AIDefaults there. Types, presets and categories are TriggerData's. `parse` is parseTriggerData
 *  with the game's strings. */
export function aiTriggerData(data: TriggerData, aiEditorData: string, parse: (text: string) => TriggerData): TriggerData {
  // Conditions (comparisons, And, Or) at the top of a condition; calls inside them.
  const [conditions, calls] = [CONDITION, CALL].map((kind) => {
    const m = new Map<string, TriggerFunction>();
    for (const f of data.functions[kind].values()) if (f.useWithAI) m.set(f.name, { ...f, defaults: f.aiDefaults ?? f.defaults });
    return m;
  });
  for (const f of parse(aiEditorData.replace(/^\[AIFunctions\]/m, "[TriggerCalls]")).functions[CALL].values()) calls.set(f.name, f);
  const functions = [new Map(), conditions, new Map(), calls];
  return { ...data, functions, find: (kind, name) => functions[kind]?.get(name) ?? conditions.get(name) ?? calls.get(name) };
}

/** Argument counts from AI trigger data (see aiTriggerData). */
export function aiArgCount(data: TriggerData): ArgCount {
  return (name) => {
    const f = data.find(CONDITION, name);
    if (!f) throw new Error(`unknown AI function ${name}`);
    return f.args.length;
  };
}

function readParam(r: Reader, n: ArgCount): Param {
  const p: Param = { type: r.i32(), value: r.str() };
  if (r.u32()) {
    const kind = r.u32(), name = r.str(), hasParams = r.u32() !== 0;
    const params = hasParams ? Array.from({ length: n(name) }, () => readParam(r, n)) : [];
    p.call = { kind, name, hasParams, params, trailer: r.u32() };
  }
  if (r.u32()) p.index = readParam(r, n);
  return p;
}
function writeParam(w: Writer, p: Param) {
  w.i32(p.type).str(p.value).u32(p.call ? 1 : 0);
  if (p.call) {
    w.u32(p.call.kind).str(p.call.name).u32(p.call.hasParams ? 1 : 0);
    if (p.call.hasParams) for (const q of p.call.params) writeParam(w, q);
    w.u32(p.call.trailer ?? 0);
  }
  w.u32(p.index ? 1 : 0);
  if (p.index) writeParam(w, p.index);
}

function readCondition(r: Reader, n: ArgCount): AiCondition {
  const name = r.str();
  if (!r.u32()) return { name, call: null };
  const fn = r.str(), hasParams = r.u32() !== 0;
  const params = hasParams ? Array.from({ length: n(fn) }, () => readParam(r, n)) : [];
  return { name, call: { name: fn, hasParams, params, trailer: r.u32() } };
}
function writeCondition(w: Writer, c: AiCondition) {
  w.str(c.name).u32(c.call ? 1 : 0);
  if (!c.call) return;
  w.str(c.call.name).u32(c.call.hasParams ? 1 : 0);
  if (c.call.hasParams) for (const p of c.call.params) writeParam(w, p);
  w.u32(c.call.trailer);
}

/** `trace` (optional) learns where each section starts. */
export function parseWai(buf: Uint8Array, n: ArgCount, trace?: (section: string, offset: number) => void): AiFile {
  const r = new Reader(buf);
  try {
    return readWai(r, buf, n, trace ?? (() => {}));
  } catch (e) {
    throw new Error(`${(e as Error).message} (at byte ${r.o})`);
  }
}

function readWai(r: Reader, buf: Uint8Array, n: ArgCount, trace: (section: string, offset: number) => void): AiFile {
  const version = r.u32();
  if (version !== 2) throw new Error(`unsupported AI file version ${version}`);
  const name = r.str(), race = r.u32(), options = r.u32();
  const workers = Array.from({ length: r.u32() }, () => r.id());
  const condCount = r.u32(), conditionsUnknown = r.u32();
  const conditions = Array.from({ length: condCount }, (): AiNamedCondition => { const index = r.u32(); return { index, ...readCondition(r, n) }; });
  trace("heroes", r.o);
  const heroes = [r.id(), r.id(), r.id()];
  const heroChances = Array.from({ length: 6 }, () => r.u32());
  const skills = Array.from({ length: 9 }, () => Array.from({ length: 10 }, () => r.id()));
  trace("build", r.o);
  const build = Array.from({ length: r.u32() }, (): BuildPriority => {
    const type = r.u32(), kind = r.u32(), id = r.id(), town = r.u32(), condIndex = r.i32();
    return { type, kind, id, town, condIndex, cond: readCondition(r, n) };
  });
  trace("harvest", r.o);
  const harvest = Array.from({ length: r.u32() }, (): HarvestPriority => {
    const type = r.u32(), resource = r.u32(), town = r.u32(), workers = r.u32(), condIndex = r.i32();
    return { type, resource, town, workers, condIndex, cond: readCondition(r, n) };
  });
  trace("targets", r.o);
  const targets = Array.from({ length: r.u32() }, (): TargetPriority => {
    const type = r.u32(), target = r.u32();
    const creep = target === 5 ? { min: r.u32(), max: r.u32(), allowFlyers: r.u32() } : undefined;
    const condIndex = r.i32();
    return { type, target, ...(creep ? { creep } : {}), condIndex, cond: readCondition(r, n) };
  });
  trace("attack", r.o);
  const repeatWaves = r.u32(), minForces = r.u32(), initialDelay = r.u32();
  const groups = Array.from({ length: r.u32() }, (): AttackGroup => {
    const index = r.u32(), gname = r.str();
    const units = Array.from({ length: r.u32() }, (): GroupUnit => {
      const id = r.id(), quantity = r.u32(), max = r.u32(), condIndex = r.i32();
      return { id, quantity, max, condIndex, cond: readCondition(r, n) };
    });
    return { index, name: gname, units };
  });
  trace("waves", r.o);
  const waves = Array.from({ length: r.u32() }, (): AttackWave => ({ group: r.u32(), delay: r.u32() }));
  const wavesUnknown = r.u32();
  trace("game", r.o);
  const gameOptions = r.u32(), gameSpeed = r.u32(), mapPath = r.str();
  const players = Array.from({ length: r.u32() }, (): TestPlayer => ({
    index: r.u32(), team: r.u32(), race: r.u32(), color: r.u32(), handicap: r.u32(), aiType: r.u32(), difficulty: r.u32(), script: r.str(),
  }));
  const trailer = r.u32();
  const extra = buf.slice(r.o);
  return {
    version, name, race, options, workers, conditionsUnknown, conditions, heroes, heroChances, skills, build, harvest, targets,
    repeatWaves, minForces, initialDelay, groups, waves, wavesUnknown, gameOptions, gameSpeed, mapPath, players, trailer, extra,
  };
}

export function writeWai(f: AiFile): Uint8Array {
  const w = new Writer();
  w.u32(f.version).str(f.name).u32(f.race).u32(f.options).u32(f.workers.length);
  for (const id of f.workers) w.id(id);
  w.u32(f.conditions.length).u32(f.conditionsUnknown);
  for (const c of f.conditions) { w.u32(c.index); writeCondition(w, c); }
  for (const id of f.heroes) w.id(id);
  for (const c of f.heroChances) w.u32(c);
  for (const list of f.skills) for (const id of list) w.id(id);
  w.u32(f.build.length);
  for (const b of f.build) { w.u32(b.type).u32(b.kind).id(b.id).u32(b.town).i32(b.condIndex); writeCondition(w, b.cond); }
  w.u32(f.harvest.length);
  for (const b of f.harvest) { w.u32(b.type).u32(b.resource).u32(b.town).u32(b.workers).i32(b.condIndex); writeCondition(w, b.cond); }
  w.u32(f.targets.length);
  for (const t of f.targets) {
    w.u32(t.type).u32(t.target);
    if (t.target === 5) w.u32(t.creep?.min ?? 0).u32(t.creep?.max ?? 0).u32(t.creep?.allowFlyers ?? 0);
    w.i32(t.condIndex);
    writeCondition(w, t.cond);
  }
  w.u32(f.repeatWaves).u32(f.minForces).u32(f.initialDelay).u32(f.groups.length);
  for (const g of f.groups) {
    w.u32(g.index).str(g.name).u32(g.units.length);
    for (const u of g.units) { w.id(u.id).u32(u.quantity).u32(u.max).i32(u.condIndex); writeCondition(w, u.cond); }
  }
  w.u32(f.waves.length);
  for (const x of f.waves) w.u32(x.group).u32(x.delay);
  w.u32(f.wavesUnknown).u32(f.gameOptions).u32(f.gameSpeed).str(f.mapPath).u32(f.players.length);
  for (const p of f.players) w.u32(p.index).u32(p.team).u32(p.race).u32(p.color).u32(p.handicap).u32(p.aiType).u32(p.difficulty).str(p.script);
  w.u32(f.trailer);
  const head = w.done();
  const out = new Uint8Array(head.length + f.extra.length);
  out.set(head);
  out.set(f.extra, head.length);
  return out;
}

/** No object (unset hero, skill or worker). */
export const NO_ID = "\0\0\0\0";

/** A new, empty AI like the AI Editor starts with. */
export function newWai(): AiFile {
  return {
    version: 2, name: "Untitled AI", race: 1, options: 0x3e, workers: ["hpea", "hpea", "htow", "htow"], conditionsUnknown: 0, conditions: [],
    heroes: [NO_ID, NO_ID, NO_ID], heroChances: [100, 0, 0, 0, 0, 0], skills: Array.from({ length: 9 }, () => Array(10).fill(NO_ID)),
    build: [], harvest: [], targets: [], repeatWaves: 1, minForces: 0, initialDelay: 0,
    groups: [{ index: 0, name: "All Units", units: [] }], waves: [], wavesUnknown: 1,
    gameOptions: 0, gameSpeed: 3, mapPath: "", players: [], trailer: 0, extra: new Uint8Array(),
  };
}
