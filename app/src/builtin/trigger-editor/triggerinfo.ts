// Triggers as the MCP tools tell about them: the World Editor's sentences, indented.

import { branchLabels, ecaText, type DisplayContext } from "../../lib/triggers/display";
import { ident as triggerIdent } from "../../lib/script/jass";
import { ACTION, CONDITION, EVENT } from "../../lib/triggers/triggerdata";
import { allocItemId, textTriggers, TYPE_INDEX, type CustomTextFile, type Eca, type TriggerFile, type TriggerItem, type Variable } from "../../lib/triggers/wtg";

const INDENT = "    ";

function lines(ecas: Eca[], ctx: DisplayContext, depth: number): string[] {
  return ecas.flatMap((e) => {
    let text: string;
    // A function the game's TriggerData doesn't list still shows, by its name.
    try { text = ecaText(e, ctx); } catch { text = e.name; }
    const head = `${INDENT.repeat(depth)}${e.enabled ? "" : "(disabled) "}${text}`;
    if (!e.children.length) return [head];
    const labels = branchLabels(e.name);
    const groups = [...new Set(e.children.map((c) => c.group ?? 0))].sort((a, b) => a - b);
    return [head, ...groups.flatMap((g) => [
      `${INDENT.repeat(depth + 1)}${labels[g] ?? labels[0]}`,
      ...lines(e.children.filter((c) => (c.group ?? 0) === g), ctx, depth + 2),
    ])];
  });
}

export const isScript = (t: TriggerItem) => t.type === 32 || t.isCustom;

/** A trigger in script, last in its category (the first one by default); its text goes with it. */
export function addScriptTrigger(file: TriggerFile, scripts: CustomTextFile, name: string, script: string, category?: string) {
  if (file.items.some((i) => i.name.toLowerCase() === name.toLowerCase())) throw new Error(`There's already something named "${name}".`);
  const categories = file.items.filter((i) => i.type === 4);
  const home = category === undefined ? categories[0] : categories.find((c) => c.name.toLowerCase() === category.toLowerCase());
  if (!home) throw new Error(category === undefined ? "This map has no trigger category to put it in." : `There's no category "${category}".`);
  // Type 8 in every format: a Reforged script item (32) is code without a trigger, never started.
  const t: TriggerItem = {
    type: 8, id: allocItemId(file, 8), name, description: "", isComment: 0, enabled: true, isCustom: true, initiallyOff: false, runOnInit: false, parent: home.id, ecas: [],
  };
  const last = file.items.reduce((at, it, i) => (it.parent === home.id ? i : at), file.items.indexOf(home));
  file.items.splice(last + 1, 0, t);
  // Texts go by the triggers' order.
  scripts.texts.splice(textTriggers(file).indexOf(t), 0, script);
  return t;
}

/** What the game needs for a script to run at all. Null when it's there. */
export function scriptWarning(name: string, script: string): string | null {
  const init = `InitTrig_${triggerIdent(name)}`;
  return script.includes(init) ? null : `It defines no ${init}, so it's only a library: nothing starts it at map start.`;
}

/** A trigger and its text. */
export function removeTrigger(file: TriggerFile, scripts: CustomTextFile, t: TriggerItem) {
  scripts.texts.splice(textTriggers(file).indexOf(t), 1);
  file.items.splice(file.items.indexOf(t), 1);
  if (file.reforged) file.counts[TYPE_INDEX[t.type]]?.deleted.push(t.id);
}

/** A global variable. Reforged files also list it as an item of a category. */
export function addVariable(file: TriggerFile, v: Pick<Variable, "name" | "type" | "isArray" | "arraySize" | "initialValue">) {
  if (file.variables.some((x) => x.name.toLowerCase() === v.name.toLowerCase())) throw new Error(`There's already a variable "${v.name}".`);
  const made: Variable = { ...v, unknown: 1, initialized: v.initialValue !== "", id: file.variables.length, parent: -1 };
  if (file.reforged) {
    const home = file.items.find((i) => i.type === 4) ?? file.items.find((i) => i.type === 1);
    if (!home) throw new Error("This map has no trigger category to put it in.");
    made.id = allocItemId(file, 64);
    made.parent = home.id;
    file.items.splice(file.items.indexOf(home) + 1, 0, { type: 64, id: made.id, name: v.name, parent: home.id });
  }
  file.variables.push(made);
}

/** Where a variable is used: names of triggers, and the map's custom script. */
export function variableUses(file: TriggerFile, scripts: CustomTextFile, name: string) {
  const inScript = new RegExp(`\\budg_${name}\\b`);
  const texts = textTriggers(file);
  const uses = file.items.filter((i): i is TriggerItem => i.type !== 64 && "ecas" in i).filter((t) => {
    const k = texts.indexOf(t);
    return (k >= 0 && inScript.test(scripts.texts[k] ?? "")) || JSON.stringify({ ...t, name: "", description: "" }).includes(`"${name}"`);
  }).map((t) => t.name);
  for (const [k, t] of texts.entries()) if (inScript.test(scripts.texts[k] ?? "") && !uses.includes(t.name)) uses.push(t.name);
  return inScript.test(scripts.header ?? "") ? [...uses, "the map's custom script"] : uses;
}

/** A global variable, if nothing uses it: a script that names a lost one doesn't compile. */
export function removeVariable(file: TriggerFile, scripts: CustomTextFile, name: string) {
  const at = file.variables.findIndex((v) => v.name.toLowerCase() === name.toLowerCase());
  if (at < 0) throw new Error(`There's no variable "${name}".`);
  const v = file.variables[at], uses = variableUses(file, scripts, v.name);
  if (uses.length) throw new Error(`${v.name} is still used by: ${uses.join(", ")}. Change those first.`);
  file.variables.splice(at, 1);
  if (file.reforged) {
    const item = file.items.findIndex((i) => i.type === 64 && i.id === v.id);
    if (item >= 0) file.items.splice(item, 1);
    file.counts[TYPE_INDEX[64]]?.deleted.push(v.id);
  } else file.variables.forEach((x, i) => { x.id = i; });
  return v.name;
}

/** Categories with their triggers, and the variables if asked for. */
export function triggerList(file: TriggerFile, withVariables: boolean) {
  const categories = file.items.filter((i) => i.type === 4);
  const triggers = file.items.filter((i): i is TriggerItem => i.type === 8 || i.type === 32);
  const line = (t: TriggerItem) => ({ name: t.name, enabled: t.enabled, form: isScript(t) ? "script" : "gui" });
  const grouped = categories.map((c) => ({ category: c.name, triggers: triggers.filter((t) => t.parent === c.id).map(line) }));
  const elsewhere = triggers.filter((t) => !categories.some((c) => c.id === t.parent)).map(line);
  return {
    triggers: triggers.length,
    categories: elsewhere.length ? [...grouped, { category: "", triggers: elsewhere }] : grouped,
    ...(withVariables ? { variables: file.variables.map((v) => ({ name: v.name, type: v.type, isArray: v.isArray, initialValue: v.initialValue })) } : {}),
  };
}

export function findTrigger(file: TriggerFile, name: string) {
  const wanted = name.toLowerCase();
  return textTriggers(file).find((t) => t.name.toLowerCase() === wanted) ?? null;
}

export interface TriggerDetail {
  name: string; description: string; enabled: boolean; initiallyOn: boolean; runOnInit: boolean;
  /** GUI triggers. */
  events?: string[]; conditions?: string[]; actions?: string[];
  /** Triggers in script. */
  script?: string;
}

/** One trigger in full. `text`: its script, for a trigger written in script. */
export function triggerDetail(t: TriggerItem, text: string | null, ctx: DisplayContext, resolve: (v: string) => string): TriggerDetail {
  const of = (kind: number) => lines(t.ecas.filter((e) => e.kind === kind), ctx, 0);
  const common = {
    name: t.name, description: resolve(t.description), enabled: t.enabled, initiallyOn: !t.initiallyOff, runOnInit: t.runOnInit,
  };
  if (isScript(t)) return { ...common, script: text ?? "" };
  return { ...common, events: of(EVENT), conditions: of(CONDITION), actions: of(ACTION) };
}
