// Readable text for GUI triggers, as the World Editor shows them:
// "Melee Game - Use melee time of day (for all players)",
// "Unit - Kill (Triggering unit)". Patterns and names come from TriggerData
// (see triggerdata.ts); nested calls are put in parentheses.

import { CALL, type TriggerData } from "./triggerdata";
import type { Call, Eca, Param } from "./wtg";

export interface DisplayContext {
  data: TriggerData;
  /** Resolves "TRIGSTR_n" values (war3map.wts). */
  string?: (value: string) => string;
  /** Name of a game or custom object for a raw id ("hfoo" → "Footman"), if known. */
  objectName?: (id: string) => string | undefined;
}

/** Labels of the child blocks of control-flow ECAs, by branch number. */
export function branchLabels(name: string): string[] {
  if (name.startsWith("IfThenElse")) return ["If - Conditions", "Then - Actions", "Else - Actions"];
  if (name === "AndMultiple" || name === "OrMultiple") return ["Conditions"];
  return ["Loop - Actions"];
}

/** Map objects referred to by their generated globals: gg_rct_Arena → "Arena <gen>". */
function generatedName(value: string, ctx: DisplayContext): string | null {
  const m = /^gg_(unit|item|dest|rct|cam|snd|trg|lght|mdl)_(.+)$/.exec(value);
  if (!m) return null;
  if (m[1] === "unit" || m[1] === "item" || m[1] === "dest") {
    // gg_unit_hfoo_0012: object id and the placement's creation number.
    const p = /^(.{4})_(\d+)$/.exec(m[2]);
    if (p) return `${ctx.objectName?.(p[1]) ?? p[1]} ${p[2]} <gen>`;
  }
  return `${m[2].replace(/_/g, " ")} <gen>`;
}

/** A parameter's text without its array index, and the index separately (for callers that draw it as its own link). */
export function paramParts(p: Param, ctx: DisplayContext, argType?: string): { text: string; index: Param | undefined } {
  let text: string;
  switch (p.type) {
    case 0: text = ctx.data.presets.get(p.value)?.name ?? p.value; break;
    case 1: text = generatedName(p.value, ctx) ?? p.value; break;
    case 2: text = p.call ? `(${callText(p.call, ctx)})` : p.value; break;
    case 3: {
      const v = ctx.string ? ctx.string(p.value) : p.value;
      // Raw object ids for code types (unitcode, itemcode, abilcode…).
      text = argType && /code$/.test(argType) && v.length === 4 ? ctx.objectName?.(v) ?? v : v;
      break;
    }
    default: text = p.value || "<Empty>";
  }
  return { text, index: p.index };
}

export function paramText(p: Param, ctx: DisplayContext, argType?: string): string {
  const { text, index } = paramParts(p, ctx, argType);
  return index ? `${text}[${paramText(index, ctx, "integer")}]` : text;
}

/** A function and its arguments through its _Parameters pattern. */
function render(kind: number, name: string, params: Param[], ctx: DisplayContext): string {
  const f = ctx.data.find(kind, name);
  if (!f) return `${name}(${params.map((p) => paramText(p, ctx)).join(", ")})`;
  if (!f.pattern.length) return params.length ? `${f.displayName}(${params.map((p, i) => paramText(p, ctx, f.args[i])).join(", ")})` : f.displayName;
  let i = 0;
  return f.pattern.map((part) => {
    if (typeof part === "string") return part;
    const at = i++;
    return params[at] ? paramText(params[at], ctx, f.args[at]) : `<${part.arg}>`;
  }).join("");
}

export function callText(c: Call, ctx: DisplayContext): string {
  return render(c.kind ?? CALL, c.name, c.params, ctx);
}

/** An event, condition or action line, with its category in front ("Unit - …"). */
export function ecaText(e: Eca, ctx: DisplayContext): string {
  const f = ctx.data.find(e.kind, e.name);
  const body = render(e.kind, e.name, e.params, ctx);
  const cat = f ? ctx.data.categories.get(f.category) : undefined;
  return cat && !cat.hideName ? `${cat.name} - ${body}` : body;
}
