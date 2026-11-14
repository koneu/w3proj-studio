// Variables that travel with copied trigger lines: copying records the variables the lines name (type, array, initial
// value), pasting into a map that lacks them can create them, as the World Editor's preference "Automatically create
// unknown variables while pasting trigger data" does.

import { allocItemId, type Eca, type Param, type TriggerFile, type Variable } from "./wtg";

/** Names of the variables the lines use (udg_ ones: not the generated gg_ globals), each once (without case), in order of use. */
export function usedVariableNames(ecas: readonly Eca[]): string[] {
  const out = new Map<string, string>();
  const visitP = (p: Param) => {
    if (p.type === 1 && p.value && !p.value.startsWith("gg_") && !out.has(p.value.toLowerCase())) out.set(p.value.toLowerCase(), p.value);
    p.call?.params.forEach(visitP);
    if (p.index) visitP(p.index);
  };
  const visit = (e: Eca) => { e.params.forEach(visitP); e.children.forEach(visit); };
  ecas.forEach(visit);
  return [...out.values()];
}

/** Copies of the variables of `file` that `ecas` use (a name the file lacks is left out). */
export function variablesOf(file: Pick<TriggerFile, "variables">, ecas: readonly Eca[]): Variable[] {
  const by = new Map(file.variables.map((v) => [v.name.toLowerCase(), v]));
  return usedVariableNames(ecas).flatMap((n) => { const v = by.get(n.toLowerCase()); return v ? [structuredClone(v)] : []; });
}

/** The names `ecas` use that `file` has no variable of (compared without case, as the editor does). */
export function missingVariableNames(file: Pick<TriggerFile, "variables">, ecas: readonly Eca[]): string[] {
  const have = new Set(file.variables.map((v) => v.name.toLowerCase()));
  return usedVariableNames(ecas).filter((n) => !have.has(n.toLowerCase()));
}

/** Adds the carried variables `file` lacks and `names` asks for (Reforged files also list each as an item of a category,
 *  like the Variables table does). Returns the names added; one the file got meanwhile is left alone. Throws, changing
 *  nothing, when a Reforged file has no category to put them in. */
export function createVariables(file: TriggerFile, carried: readonly Variable[], names: readonly string[]): string[] {
  const todo = names.flatMap((n) => {
    const v = carried.find((c) => c.name.toLowerCase() === n.toLowerCase());
    return v && !file.variables.some((x) => x.name.toLowerCase() === n.toLowerCase()) ? [v] : [];
  });
  if (!todo.length) return [];
  const home = file.reforged ? file.items.find((i) => i.type === 4) ?? file.items.find((i) => i.type === 1) : undefined;
  if (file.reforged && !home) throw new Error("This map has no trigger category to put the variables in.");
  for (const src of todo) {
    const made: Variable = { ...structuredClone(src), id: file.variables.length, parent: -1 };
    if (home) {
      made.id = allocItemId(file, 64);
      made.parent = home.id;
      file.items.splice(file.items.indexOf(home) + 1, 0, { type: 64, id: made.id, name: made.name, parent: home.id });
    }
    file.variables.push(made);
  }
  return todo.map((v) => v.name);
}
