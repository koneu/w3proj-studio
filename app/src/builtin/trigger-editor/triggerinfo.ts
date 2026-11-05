// Triggers as the MCP tools tell about them: the World Editor's sentences, indented.

import { branchLabels, ecaText, type DisplayContext } from "../../lib/triggers/display";
import { ACTION, CONDITION, EVENT } from "../../lib/triggers/triggerdata";
import { allocItemId, textTriggers, type CustomTextFile, type Eca, type TriggerFile, type TriggerItem } from "../../lib/triggers/wtg";

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
  const type = file.reforged ? 32 : 8;
  const t: TriggerItem = {
    type, id: allocItemId(file, type), name, description: "", isComment: 0, enabled: true, isCustom: true, initiallyOff: false, runOnInit: false, parent: home.id, ecas: [],
  };
  const last = file.items.reduce((at, it, i) => (it.parent === home.id ? i : at), file.items.indexOf(home));
  file.items.splice(last + 1, 0, t);
  // Texts go by the triggers' order.
  scripts.texts.splice(textTriggers(file).indexOf(t), 0, script);
  return t;
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
