// GUI triggers to JASS, as the World Editor writes them into war3map.j:
// per trigger a banner with its comment, helper functions (block bodies,
// conditions of If/Then/Else, callbacks for "Pick every …"), the Conditions and
// Actions functions and InitTrig_<name> that creates the trigger and registers
// its events. Helper functions are named after their place: "Func" and a
// three-digit position (1-based) per nesting level, parameter positions
// appended (Func002Func001001), "C" for conditions and "A" for action bodies.

import { ACTION, CALL, CONDITION, EVENT, type TriggerData } from "../triggers/triggerdata";
import type { Call, CustomTextFile, Eca, Param, TriggerFile, TriggerItem } from "../triggers/wtg";

import { CONCAT, INT_DIV, jassToLua, RAW } from "./lua";
import { ident } from "./names";

const EOL = "\r\n";
const SEP = "//===========================================================================";

export interface TriggerScriptInput {
  data: TriggerData;
  triggers: TriggerFile;
  custom?: CustomTextFile | null;
  /** For war3map.lua: the map's own code is marked RAW (it is Lua already), `..` and `//` by markers (lua.ts). */
  lua?: boolean;
}

const str = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const pad3 = (n: number) => String(n).padStart(3, "0");

/** Comparison and arithmetic functions written as operators. */
const OPERATORS = /^Operator(Compare|Int|Real|String)/;

class TriggerCompiler {
  /** Helper functions in the order they were made. */
  helpers: string[] = [];
  /** Condition expressions worked out ahead (If/Then/Else walks its children in order). */
  private pre = new Map<Eca, string>();
  private readonly name: string;

  constructor(private i: TriggerScriptInput, private t: TriggerItem) {
    this.name = ident(t.name);
  }

  private fn(kind: number, name: string) {
    return this.i.data.find(kind, name);
  }
  private argType(kind: number, name: string, index: number): string {
    return this.fn(kind, name)?.args[index] ?? "";
  }

  // ---- expressions --------------------------------------------------------------------
  expr(p: Param, type: string, path: string): string {
    const data = this.i.data;
    // A variable named as a string (TriggerRegisterVariableEvent).
    if (type.startsWith("VarAsString") && p.type === 1) return `"udg_${p.value}"`;
    let out: string;
    switch (p.type) {
      case 0: out = data.presets.get(p.value)?.script ?? p.value; break;
      case 1: out = this.i.triggers.variables.some((v) => v.name === p.value) ? `udg_${p.value}` : p.value; break;
      case 2: out = p.call ? this.callExpr(p.call, type, path) : p.value; break;
      case 3: out = this.literal(type, p.value); break;
      default: out = "null";
    }
    return p.index ? `${out}[${this.expr(p.index, "integer", path)}]` : out;
  }

  private literal(type: string, value: string): string {
    // A variable named as a string (TriggerRegisterVariableEvent).
    if (type.startsWith("VarAsString")) return `"udg_${value}"`;
    const base = this.i.data.types.get(type)?.base ?? type;
    if (base === "string") return str(value);
    if (base === "integer" && /code$/.test(type) && value.length === 4 && !/^-?\d+$/.test(value)) return `'${value}'`;
    return value;
  }

  /** A call used as a value; conditions and actions become helper functions. */
  private callExpr(c: Call, type: string, path: string): string {
    // A condition as an argument: boolcall calls its helper, boolexpr wraps it in Condition().
    if (c.kind === CONDITION) {
      const helper = this.conditionHelper([{ kind: CONDITION, name: c.name, enabled: true, params: c.params, children: [] }], path, true);
      return type === "boolcall" ? `${helper}()` : `Condition(function ${helper})`;
    }
    if (c.kind === ACTION) {
      // A single action as an argument: its helper uses the argument's own path.
      const name = `Trig_${this.name}_${path}`;
      const body = this.action({ kind: ACTION, name: c.name, enabled: true, params: c.params, children: [] }, path, "    ", 1);
      this.helpers.push([`function ${name} takes nothing returns nothing`, ...body, "endfunction", ""].join(EOL));
      return `function ${name}`;
    }
    const args = c.params.map((q, k) => this.expr(q, this.argType(CALL, c.name, k), `${path}${pad3(k + 1)}`));
    // String concatenation has no operator argument.
    if (c.name === "OperatorString") return `( ${args.join(this.i.lua ? ` ${CONCAT} ` : " + ")} )`;
    if (this.i.lua && c.name === "OperatorInt" && args[1] === "/") args[1] = INT_DIV;
    if (OPERATORS.test(c.name)) return `( ${args.join(" ")} )`;
    // These two are written with spaces inside the parentheses.
    if (c.name === "GetBooleanAnd" || c.name === "GetBooleanOr") return `${c.name}( ${args.join(", ")} )`;
    const f = this.fn(CALL, c.name);
    return `${f?.scriptName ?? c.name}(${args.join(", ")})`;
  }

  // ---- conditions ---------------------------------------------------------------------
  /** A condition as a boolean expression (comparisons without parentheses). */
  condExpr(e: Eca, path: string): string {
    if (e.name === "AndMultiple" || e.name === "OrMultiple") return `${this.conditionHelper(e.children, `${path}C`, false, e.name === "OrMultiple", path)}()`;
    const args = e.params.map((q, k) => this.expr(q, this.argType(CONDITION, e.name, k), `${path}${pad3(k + 1)}`));
    if (OPERATORS.test(e.name)) return args.join(" ");
    if (e.name === "GetBooleanAnd" || e.name === "GetBooleanOr") return `${e.name}( ${args.join(", ")} )`;
    const f = this.fn(CONDITION, e.name);
    return `${f?.scriptName ?? e.name}(${args.join(", ")})`;
  }

  /** "if ( not ( c ) ) then return false" per condition, then return true (or the Or form). */
  /** Positions count in `all` (the whole list the entries come from). */
  conditionBody(list: Eca[], path: string, or = false, all: Eca[] = list): string[] {
    const lines: string[] = [];
    list.forEach((c) => {
      if (!c.enabled) return;
      const e = this.pre.get(c) ?? this.condExpr(c, `${path}Func${pad3(all.indexOf(c) + 1)}`);
      // Comparisons get parentheses, calls don't: not ( a == b ), not GetBooleanOr(…).
      const w = OPERATORS.test(c.name) ? `( ${e} )` : e;
      lines.push(or ? `    if ( ${w} ) then` : `    if ( not ${w} ) then`, `        return ${or}`, "    endif");
    });
    lines.push(`    return ${!or}`);
    return lines;
  }

  /** A function returning a condition's value: filters return the expression itself. */
  private conditionHelper(list: Eca[], path: string, filter: boolean, or = false, childPath = path, all: Eca[] = list): string {
    const name = `Trig_${this.name}_${path}`;
    const one = list[0];
    const body = filter && list.length === 1
      ? [`    return ${OPERATORS.test(one.name) ? `( ${this.condExpr(one, path)} )` : this.condExpr(one, path)}`]
      : this.conditionBody(list, childPath, or, all);
    this.helpers.push([`function ${name} takes nothing returns boolean`, ...body, "endfunction", ""].join(EOL));
    return name;
  }

  /** `childPath` numbers the body's own helpers (a block's children count from the block). */
  private actionHelper(list: Eca[], path: string, childPath = path, all: Eca[] = list): string {
    const name = `Trig_${this.name}_${path}`;
    const body = this.actions(list, childPath, 1, all);
    this.helpers.push([`function ${name} takes nothing returns nothing`, ...body, "endfunction", ""].join(EOL));
    return name;
  }

  // ---- actions ------------------------------------------------------------------------
  /** Statements for a list of actions; `path` prefixes the helper numbering. */
  actions(list: Eca[], path: string, depth: number, all: Eca[] = list): string[] {
    const ind = "    ".repeat(depth);
    const out: string[] = [];
    list.forEach((a) => {
      if (!a.enabled) return;
      const p = `${path}Func${pad3(all.indexOf(a) + 1)}`;
      out.push(...this.action(a, p, ind, depth));
    });
    return out;
  }

  private action(a: Eca, p: string, ind: string, depth: number): string[] {
    const arg = (k: number) => this.expr(a.params[k], this.argType(ACTION, a.name, k), `${p}${pad3(k + 1)}`);
    const branch = (g: number) => a.children.filter((c) => (c.group ?? 0) === g);
    switch (a.name) {
      case "CommentString": return [`${ind}// ${a.params[0]?.value ?? ""}`];
      case "CustomScriptCode": return [this.i.lua ? `${RAW}${a.params[0]?.value ?? ""}` : `${ind}${a.params[0]?.value ?? ""}`];
      case "SetVariable": {
        const v = a.params[0];
        const type = this.i.triggers.variables.find((x) => x.name === v?.value)?.type ?? "";
        return [`${ind}set ${this.expr(v, type, `${p}001`)} = ${this.expr(a.params[1], type, `${p}002`)}`];
      }
      case "ReturnAction": return [`${ind}return`];
      case "WaitForCondition": {
        const q = a.params[0];
        const cond = q?.call ? this.conditionHelper([{ kind: CONDITION, name: q.call.name, enabled: true, params: q.call.params, children: [] }], `${p}001`, true) : "";
        return [`${ind}loop`, `${ind}    exitwhen ( ${cond}() )`, `${ind}    call TriggerSleepAction(RMaxBJ(bj_WAIT_FOR_COND_MIN_INTERVAL, ${arg(1)}))`, `${ind}endloop`];
      }
      case "AddTriggerEvent": {
        // The event's own register call, on the given trigger.
        const ev = a.params[1]?.call;
        if (!ev) break;
        const f = this.fn(EVENT, ev.name);
        const args = ev.params.map((q, j) => this.expr(q, this.argType(EVENT, ev.name, j), `${p}002${pad3(j + 1)}`));
        return [`${ind}call ${f?.scriptName ?? ev.name}( ${[arg(0), ...args].join(", ")} )`];
      }
      case "IfThenElseMultiple": {
        // Children are walked in list order (their helpers come in that order); the
        // If's own condition function comes last.
        const then: string[] = [], els: string[] = [];
        a.children.forEach((c, k) => {
          if (!c.enabled) return;
          const cp = `${p}Func${pad3(k + 1)}`;
          if ((c.group ?? 0) === 0) this.pre.set(c, this.condExpr(c, cp));
          else (c.group === 1 ? then : els).push(...this.action(c, cp, ind + "    ", depth + 1));
        });
        const cond = this.conditionHelper(branch(0), `${p}C`, false, false, p, a.children);
        return [`${ind}if ( ${cond}() ) then`, ...then, `${ind}else`, ...els, `${ind}endif`];
      }
      case "IfThenElse": {
        const cond = a.params[0]?.call ? this.conditionHelper([{ kind: CONDITION, name: a.params[0].call.name, enabled: true, params: a.params[0].call.params, children: [] }], `${p}001`, true) : "";
        const body = (q: Param | undefined, path: string) => (q?.call
          ? this.action({ kind: ACTION, name: q.call.name, enabled: true, params: q.call.params, children: [] }, path, ind + "    ", depth + 1) : []);
        return [`${ind}if ( ${cond}() ) then`, ...body(a.params[1], `${p}002`), `${ind}else`, ...body(a.params[2], `${p}003`), `${ind}endif`];
      }
      case "ForLoopA": case "ForLoopB": case "ForLoopVar": {
        // One action as the last argument, written as a loop like the Multiple forms.
        const last = a.params.length - 1, q = a.params[last];
        const body = q?.call ? this.action({ kind: ACTION, name: q.call.name, enabled: true, params: q.call.params, children: [] }, `${p}${pad3(last + 1)}`, ind + "    ", depth + 1) : [];
        if (a.name === "ForLoopVar") {
          const v = this.expr(a.params[0], "integer", `${p}001`);
          return [`${ind}set ${v} = ${arg(1)}`, `${ind}loop`, `${ind}    exitwhen ${v} > ${arg(2)}`, ...body, `${ind}    set ${v} = ${v} + 1`, `${ind}endloop`];
        }
        const v = a.name === "ForLoopA" ? "bj_forLoopAIndex" : "bj_forLoopBIndex";
        return [`${ind}set ${v} = ${arg(0)}`, `${ind}set ${v}End = ${arg(1)}`, `${ind}loop`, `${ind}    exitwhen ${v} > ${v}End`, ...body, `${ind}    set ${v} = ${v} + 1`, `${ind}endloop`];
      }
      case "ForLoopAMultiple": case "ForLoopBMultiple": {
        const v = a.name === "ForLoopAMultiple" ? "bj_forLoopAIndex" : "bj_forLoopBIndex";
        return [`${ind}set ${v} = ${arg(0)}`, `${ind}set ${v}End = ${arg(1)}`, `${ind}loop`, `${ind}    exitwhen ${v} > ${v}End`,
          ...this.actions(branch(0), p, depth + 1, a.children), `${ind}    set ${v} = ${v} + 1`, `${ind}endloop`];
      }
      case "ForLoopVarMultiple": {
        const v = this.expr(a.params[0], "integer", `${p}001`);
        return [`${ind}set ${v} = ${arg(1)}`, `${ind}loop`, `${ind}    exitwhen ${v} > ${arg(2)}`,
          ...this.actions(branch(0), p, depth + 1, a.children), `${ind}    set ${v} = ${v} + 1`, `${ind}endloop`];
      }
    }
    if (/Multiple$/.test(a.name)) {
      // Enumerations (Pick every …): the body becomes a callback after the other arguments.
      const f = this.fn(ACTION, a.name);
      const args = a.params.map((_, k) => arg(k));
      const cb = this.actionHelper(branch(0), `${p}A`, p, a.children);
      return [`${ind}call ${f?.scriptName.replace(/Multiple$/, "") ?? a.name}( ${[...args, `function ${cb}`].join(", ")} )`];
    }
    const f = this.fn(ACTION, a.name);
    const args = a.params.map((_, k) => arg(k));
    // Children left on a plain action (older edits) aren't compiled, but the World Editor
    // still writes the helpers they would need.
    a.children.forEach((c, k) => {
      if (!c.enabled) return;
      const cp = `${p}Func${pad3(k + 1)}`;
      if (c.kind === CONDITION) this.condExpr(c, cp);
      else this.action(c, cp, ind + "    ", depth + 1);
    });
    return [`${ind}call ${f?.scriptName ?? a.name}(${args.length ? ` ${args.join(", ")} ` : "  "})`];
  }

  // ---- the trigger --------------------------------------------------------------------
  compile(): string {
    const t = this.t, n = this.name;
    const events = t.ecas.map((e, k) => [e, k] as const).filter(([e]) => e.kind === EVENT && e.enabled);
    const conds = t.ecas.filter((e) => e.kind === CONDITION);
    const acts = t.ecas.filter((e) => e.kind === ACTION);
    // Top-level positions count events, conditions and actions together.
    // Conditions (with their helpers) come first, then the action helpers and Actions.
    const condLines = conds.some((c) => c.enabled) ? this.conditionBody(conds, "", false, t.ecas) : null;
    const parts = [...this.helpers];
    if (condLines) parts.push([`function Trig_${n}_Conditions takes nothing returns boolean`, ...condLines, "endfunction", ""].join(EOL));
    this.helpers = [];
    const actLines = this.actions(acts, "", 1, t.ecas);
    parts.push(...this.helpers);
    parts.push([`function Trig_${n}_Actions takes nothing returns nothing`, ...actLines, "endfunction", ""].join(EOL));
    const init = [SEP, `function InitTrig_${n} takes nothing returns nothing`, `    set gg_trg_${n} = CreateTrigger(  )`];
    if (t.initiallyOff) init.push(`    call DisableTrigger( gg_trg_${n} )`);
    for (const [e, k] of events) {
      if (e.name === "MapInitializationEvent") continue;
      const f = this.fn(EVENT, e.name);
      const args = e.params.map((q, j) => this.expr(q, this.argType(EVENT, e.name, j), `Func${pad3(k + 1)}${pad3(j + 1)}`));
      init.push(`    call ${f?.scriptName ?? e.name}( ${[`gg_trg_${n}`, ...args].join(", ")} )`);
    }
    if (condLines) init.push(`    call TriggerAddCondition( gg_trg_${n}, Condition( function Trig_${n}_Conditions ) )`);
    init.push(`    call TriggerAddAction( gg_trg_${n}, function Trig_${n}_Actions )`, "endfunction", "");
    return [...parts, init.join(EOL)].join(EOL);
  }
}

function banner(t: TriggerItem): string {
  const lines = [SEP, `// Trigger: ${t.name}`];
  // One "//" after the title, then the comment's lines; empty lines are dropped.
  if (t.description) lines.push("//", ...t.description.split(/\r?\n/).filter((l) => l !== "").map((l) => `// ${l}`));
  lines.push(SEP);
  return lines.join(EOL) + EOL;
}

/** Script items (wtg item type 32, Reforged): custom script that isn't a trigger. The World
 *  Editor writes them into the "Custom Script Code" section after the map's header, in tree
 *  order (disabled ones left out), each under a "//*  <name>" banner. */
export function scriptItems(i: Pick<TriggerScriptInput, "triggers" | "custom">): { name: string; text: string }[] {
  const items = i.triggers.items.filter((t): t is TriggerItem => "ecas" in t && (t.type === 8 || t.type === 32));
  return items.map((t, k) => ({ t, text: i.custom?.texts[k] ?? "" }))
    .filter(({ t }) => t.type === 32 && t.enabled && !t.isComment).map(({ t, text }) => ({ name: t.name, text: text ?? "" }));
}

/** A GUI trigger as custom text, as the World Editor's Convert to Custom Text makes it: the functions
 *  the map script would have for it (helpers, Conditions, Actions, InitTrig_<name>) without the banner,
 *  which the script adds to custom text too; for Lua maps (`lua`) translated to Lua as war3map.lua has it. */
export function triggerCustomText(i: TriggerScriptInput, t: TriggerItem): string {
  const jass = new TriggerCompiler(i, t).compile();
  return i.lua ? jassToLua(jass) : jass;
}

/** Lines of the GUI trigger `t` as script (Copy As Script on lines): the functions a trigger of the same name
 *  holding only these lines would have. A line from inside a block stands at the top level, as what it is
 *  (an event registers in InitTrig_, a condition goes into Conditions, an action into Actions). */
export function linesCustomText(i: TriggerScriptInput, t: TriggerItem, lines: readonly Eca[]): string {
  const ecas = lines.map((e) => { const c = structuredClone(e); delete c.group; return c; });
  return triggerCustomText(i, { ...t, ecas });
}

/** Globals of placed units, items and destructibles (gg_unit_…, gg_item_…, gg_dest_…) that `t` uses and the
 *  map script has only for it. The map script declares such a global for what GUI triggers mention (disabled
 *  ones too) and creates the object into it for what compiled triggers use; the World Editor doesn't read
 *  custom text for them, so converting `t` changes these in war3map.j. */
export function placedGlobalsOnlyIn(file: TriggerFile, t: TriggerItem): string[] {
  const triggers = file.items.filter((i): i is TriggerItem => "ecas" in i && i.type !== 16 && i.type !== 32);
  const used = (item: TriggerItem, compiled: boolean) => {
    const out = new Set<string>();
    if (compiled && (!item.enabled || item.isComment)) return out;
    const visitP = (p: Param) => { if (p.type === 1 && /^gg_(?:unit|item|dest)_/.test(p.value)) out.add(p.value); p.call?.params.forEach(visitP); if (p.index) visitP(p.index); };
    const visit = (e: Eca) => { if (compiled && !e.enabled) return; e.params.forEach(visitP); e.children.forEach(visit); };
    item.ecas.forEach(visit);
    return out;
  };
  const others = (compiled: boolean) => new Set(triggers.filter((o) => o !== t).flatMap((o) => [...used(o, compiled)]));
  const declared = others(false), created = others(true), mineCompiled = used(t, true);
  return [...used(t, false)].filter((g) => !declared.has(g) || (mineCompiled.has(g) && !created.has(g))).sort();
}

/** Turns a GUI trigger into a custom text trigger with `text` (from triggerCustomText): its events,
 *  conditions and actions go. A map initialization event becomes Run on Map Initialization, so the map
 *  script still runs it at the start. */
export function convertToCustom(t: TriggerItem) {
  if (t.ecas.some((e) => e.enabled && e.kind === EVENT && e.name === "MapInitializationEvent")) t.runOnInit = true;
  t.isCustom = true;
  t.ecas = [];
}

/** The trigger part of war3map.j (after the "Triggers" banner). */
export function triggersSection(i: TriggerScriptInput): string {
  const items = i.triggers.items.filter((t): t is TriggerItem => "ecas" in t && t.type !== 16);
  const textOf = new Map<TriggerItem, string | null>();
  items.filter((t) => t.type === 8 || t.type === 32).forEach((t, k) => textOf.set(t, i.custom?.texts[k] ?? null));
  const out: string[] = [];
  const included: TriggerItem[] = [];
  for (const t of items) {
    // Disabled triggers and comment items (separators) aren't compiled; script items (type 32)
    // are in the "Custom Script Code" section.
    if (!t.enabled || t.isComment || t.type === 32) continue;
    included.push(t);
    // GUI triggers end with a blank line; custom text gets one line break after it (even when it ends with one).
    if (t.isCustom) {
      let text = (textOf.get(t) ?? "").replace(/\r?\n/g, EOL);
      if (i.lua && text) text = text.split(EOL).map((l, k, all) => (k === all.length - 1 && l === "" ? l : RAW + l)).join(EOL);
      out.push(banner(t) + text + EOL);
    } else out.push(banner(t) + new TriggerCompiler(i, t).compile() + EOL);
  }
  // Custom text that defines no InitTrig_<name> (a code library) isn't initialized.
  const initialized = included.filter((t) => !t.isCustom || (textOf.get(t) ?? "").includes(`InitTrig_${ident(t.name)}`));
  const init = [SEP, "function InitCustomTriggers takes nothing returns nothing",
    ...initialized.map((t) => `    call InitTrig_${ident(t.name)}(  )`), "endfunction", ""];
  const onInit = included.filter((t) => t.runOnInit || t.ecas.some((e) => e.enabled && e.kind === EVENT && e.name === "MapInitializationEvent"));
  const run = [SEP, "function RunInitializationTriggers takes nothing returns nothing",
    ...onInit.map((t) => `    call ConditionalTriggerExecute( gg_trg_${ident(t.name)} )`), "endfunction", ""];
  return out.join("") + [init.join(EOL), ...(onInit.length ? [run.join(EOL)] : [])].join(EOL);
}
