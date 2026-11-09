// Parameters of GUI trigger functions: what fits an argument type and the
// defaults new events/conditions/actions start with. Stored as the World
// Editor stores them (checked on the game's maps): a call keeps its own name
// as the value, a condition used as a parameter (boolexpr) an empty value,
// an action used as one (code) "DoNothing"; an unset parameter is type -1.

import { ACTION, CALL, CONDITION, type TriggerData, type TriggerFunction } from "../../lib/triggers/triggerdata";
import type { Eca, Param, TriggerFile, Variable } from "../../lib/triggers/wtg";

export const PRESET = 0, VARIABLE = 1, FUNCTION = 2, VALUE = 3, UNSET = -1;

/** A parameter nothing was chosen for, as Validate Map Triggers counts it (lib/triggers/validate.ts): none, type
 *  -1, a preset or variable without a name, a call without a function. Shown as its argument's name in red. */
export function isUnsetParam(p: Param | undefined): boolean {
  if (!p || p.type < 0) return true;
  if (p.type === PRESET || p.type === VARIABLE) return !p.value;
  if (p.type === FUNCTION) return !p.call?.name;
  return false;
}

/** Which function list a parameter of `type` takes its calls from. */
export function callKind(type: string): number {
  if (type === "boolexpr" || type === "boolcall") return CONDITION;
  if (type === "code") return ACTION;
  return CALL;
}

const sameType = (data: TriggerData, a: string, b: string) =>
  a === b || data.types.get(a)?.base === b || data.types.get(b)?.base === a;

export function presetsFor(data: TriggerData, type: string): [string, string][] {
  return [...data.presets].filter(([, p]) => p.type === type).map(([k, p]) => [k, p.name]);
}

export function variablesFor(data: TriggerData, file: TriggerFile, type: string): Variable[] {
  if (type === "AnyGlobal") return file.variables;
  return file.variables.filter((v) => sameType(data, v.type, type));
}

export function functionsFor(data: TriggerData, type: string): TriggerFunction[] {
  const kind = callKind(type);
  const list = [...data.functions[kind].values()];
  if (kind !== CALL) return list;
  return list.filter((f) => f.returns && sameType(data, f.returns, type));
}

/** Types that take a typed value (number, text, object id). */
export function takesValue(data: TriggerData, type: string): boolean {
  const base = data.types.get(type)?.base ?? type;
  return ["integer", "real", "string", "StringExt", "boolean"].includes(base) || /code$/.test(type) || /file$/.test(type);
}

/** A call parameter with the function's default arguments. */
export function callParam(data: TriggerData, f: TriggerFunction, vars: TriggerFile): Param {
  const value = f.kind === CALL ? f.name : f.kind === ACTION ? "DoNothing" : "";
  return { type: FUNCTION, value, call: { kind: f.kind, name: f.name, hasParams: true, params: defaultParams(data, f, vars), trailer: 0 } };
}

/** The parameter for a _Defaults entry (preset, call, variable or value); "_" or none leaves it unset. */
export function defaultParam(data: TriggerData, type: string, def: string | undefined, file: TriggerFile): Param {
  if (def && def !== "_") {
    if (data.presets.has(def)) return { type: PRESET, value: def };
    const call = data.functions[CALL].get(def) ?? data.functions[callKind(type)].get(def);
    if (call) return callParam(data, call, file);
    if (file.variables.some((v) => v.name === def)) return { type: VARIABLE, value: def };
    return { type: VALUE, value: def.replace(/^"(.*)"$/, "$1") };
  }
  return { type: UNSET, value: "" };
}

export function defaultParams(data: TriggerData, f: TriggerFunction, file: TriggerFile): Param[] {
  return f.args.map((a, i) => defaultParam(data, a, f.defaults[i], file));
}

export function newEca(data: TriggerData, f: TriggerFunction, file: TriggerFile, group?: number): Eca {
  return { kind: f.kind, ...(group !== undefined ? { group } : {}), name: f.name, enabled: true, params: defaultParams(data, f, file), children: [] };
}

/** The type of argument `i` of a function; SetVariable's value takes its variable's type. */
export function argType(data: TriggerData, file: TriggerFile, kind: number, name: string, params: Param[], i: number): string {
  const f = data.find(kind, name);
  const t = f?.args[i] ?? "";
  if (name === "SetVariable" && i === 1) {
    const v = file.variables.find((x) => x.name === params[0]?.value);
    return v?.type ?? t;
  }
  return t;
}
