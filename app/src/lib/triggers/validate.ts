// Validate Map Triggers: what in the GUI triggers can't become a working map script, per trigger,
// event/condition/action and parameter, like the World Editor's Validate Map Triggers. What is
// checked: functions TriggerData doesn't know (or, in a Reign of Chaos trigger file, only The Frozen
// Throne has), parameters that aren't set or don't fit their argument's type, a wrong number of
// parameters, and triggers without events that nothing runs. Disabled lines aren't in the map script,
// so they aren't judged; disabled triggers are, but only as warnings. References to things the map
// lacks (gg_ globals, variables) are the "References in triggers" check's (refs.ts).

import { ident } from "../script/names";
import { CALL, EVENT, type TriggerData, type TriggerFunction } from "./triggerdata";
import { textTriggers, type CustomTextFile, type Eca, type Param, type TriggerFile, type TriggerItem } from "./wtg";

export type IssueKind = "unknownFunction" | "frozenThrone" | "paramCount" | "unset" | "unknownPreset" | "typeMismatch" | "badValue" | "arrayIndex" | "noEvents";

export interface TriggerIssue {
  kind: IssueKind;
  severity: "error" | "warning";
  trigger: TriggerItem;
  /** The line: indices from the trigger's list through children (none for the trigger itself). */
  path?: number[];
  /** The parameter: its index in the line, then in each nested call's; -1 stands for an array index. */
  param?: number[];
  /** "Action 3" or "Action 3 › Then 1": where the line is, in the World Editor's words. */
  where?: string;
  message: string;
}

const KIND_NAMES = ["Event", "Condition", "Action"];

/** Argument types any value fits: the game's own typos and placeholders, and handle (any object). */
const ANY = new Set(["AnyGlobal", "anytype", "handle", "Null", "nothing", ""]);

/** The type a generated global stands for (gg_unit_hfoo_0001 → unit). */
const GLOBAL_TYPES: Record<string, string> = { unit: "unit", item: "item", dest: "destructable", rct: "rect", cam: "camerasetup", snd: "sound", trg: "trigger", lght: "lightning", mdl: "effect", doodad: "doodad" };

/** Whether a value of type `have` fits an argument of type `want`: the same type, one is the other's
 *  base type (unitcode/integer), or `want` takes anything. Types TriggerData doesn't list aren't judged. */
export function fits(data: TriggerData, have: string, want: string): boolean {
  if (have === want || ANY.has(want) || ANY.has(have)) return true;
  // "Value of Real Variable": a variable of the type the name says.
  if (want.startsWith("VarAsString_")) return have.toLowerCase() === want.slice(12).toLowerCase();
  // Music is a sound of the map's (gg_snd_), as the Sound Editor lists it.
  if (have === "sound" && (want === "musicfile" || want === "musictheme")) return true;
  if (!data.types.has(want) || !data.types.has(have)) return true;
  const base = (t: string) => data.types.get(t)?.base ?? t;
  if (base(have) === want || base(want) === have || base(have) === base(want) && base(have) !== have) return true;
  // Units, items and destructables are widgets in the game's script.
  if (want === "widget" && ["unit", "item", "destructable"].includes(have)) return true;
  return false;
}

/** The text for a type ("Unit", "Integer"), as the editor shows it. */
const typeName = (data: TriggerData, t: string) => data.types.get(t)?.name ?? t;

/** Where a line is: "Action 3", nested ones "Action 3 › Then 1" (counted within their branch). */
export function lineLabel(t: TriggerItem, path: number[]): string {
  const parts: string[] = [];
  let list = t.ecas;
  for (let d = 0; d < path.length; d++) {
    const e = list[path[d]];
    if (!e) break;
    if (d === 0) parts.push(`${KIND_NAMES[e.kind] ?? "Line"} ${list.slice(0, path[d] + 1).filter((x) => x.kind === e.kind).length}`);
    else {
      const parent = parentOf(t, path.slice(0, d));
      const branch = branchName(parent?.name ?? "", e.group ?? 0);
      parts.push(`${branch} ${list.slice(0, path[d] + 1).filter((x) => (x.group ?? 0) === (e.group ?? 0)).length}`);
    }
    list = e.children;
  }
  return parts.join(" › ");
}
function parentOf(t: TriggerItem, path: number[]): Eca | undefined {
  let list = t.ecas, e: Eca | undefined;
  for (const i of path) { e = list[i]; if (!e) return undefined; list = e.children; }
  return e;
}
function branchName(block: string, group: number): string {
  if (block.startsWith("IfThenElse")) return ["If", "Then", "Else"][group] ?? "Branch";
  if (block === "AndMultiple" || block === "OrMultiple") return "Condition";
  return "Loop";
}

/** Whether a gg_trg_ global of `name` is run from anywhere in the map script: GUI parameters or script text.
 *  Only what the script has counts: lines and triggers that are disabled, comments (items, Comment lines)
 *  aren't in it, so naming the trigger there runs nothing. */
function runsFromElsewhere(file: TriggerFile, scripts: string[], t: TriggerItem, language: "jass" | "lua"): boolean {
  const global = `gg_trg_${ident(t.name)}`;
  const word = new RegExp(`(?<![A-Za-z0-9_])${global}(?![A-Za-z0-9_])`);
  if (scripts.some((s) => word.test(s))) return true;
  let found = false;
  const visit = (p: Param) => {
    if (found) return;
    if ((p.type === 1 && p.value === global) || (p.type === 3 && word.test(withoutComments(p.value, language)))) { found = true; return; }
    p.call?.params.forEach(visit);
    if (p.index) visit(p.index);
  };
  const walk = (e: Eca) => {
    if (!e.enabled || e.name === "CommentString") return;
    e.params.forEach(visit);
    e.children.forEach(walk);
  };
  for (const it of file.items) {
    if ("ecas" in it && it !== t && it.type !== 16 && !it.isComment && it.enabled) it.ecas.forEach(walk);
  }
  return found;
}

/** Script text without its line comments (`//` in JASS, `--` in Lua): a call commented out runs nothing. A comment
 *  mark inside a string cuts the rest of its line too, which can only make a trigger look uncalled (a warning). */
export function withoutComments(text: string, language: "jass" | "lua"): string {
  return text.replace(language === "lua" ? /--[^\n]*/g : /\/\/[^\n]*/g, "");
}

/** Whether running the trigger would do anything: an enabled condition or action that isn't a comment. A
 *  trigger without them (a heading or separator in the tree, as campaign maps have) isn't one that's missing
 *  its caller. */
function doesSomething(t: TriggerItem): boolean {
  return t.ecas.some((e) => e.enabled && e.kind !== EVENT && e.name !== "CommentString");
}

/** The script texts of `custom` that are in the map script, for ValidateOptions.scripts: the map header and the
 *  texts of enabled custom text triggers (a disabled or comment trigger's text isn't written, nor is a GUI
 *  trigger's). None without a custom text file. */
export function scriptsThatRun(file: TriggerFile, custom: CustomTextFile | null): (string | null)[] {
  if (!custom) return [];
  const tt = textTriggers(file);
  return [custom.header, ...custom.texts.filter((_, i) => { const t = tt[i]; return !!t && t.enabled && !t.isComment && t.isCustom; })];
}

export interface ValidateOptions {
  /** Script texts that can run triggers (map header, custom text triggers): a trigger they name has a
   *  caller. null: they couldn't be read, so no trigger is called one nothing runs. */
  scripts?: (string | null)[] | null;
  /** The map script's language, for the comments in script text (default JASS). */
  language?: "jass" | "lua";
}

/** Every issue of the GUI triggers of `file`, in tree order. */
export function validateTriggers(file: TriggerFile, data: TriggerData, opts: ValidateOptions = {}): TriggerIssue[] {
  const out: TriggerIssue[] = [];
  const roc = !file.reforged && file.version === 4;
  // The script's names are case-sensitive (udg_UTHER and udg_Uther are two variables); a name only
  // differing in case is taken as the one meant, as the References check does.
  const exact = new Map(file.variables.map((v) => [v.name, v]));
  const loose = new Map(file.variables.map((v) => [v.name.toLowerCase(), v]));
  const variables = { get: (name: string) => exact.get(name) ?? loose.get(name.toLowerCase()) };
  const language = opts.language ?? "jass";
  const given = opts.scripts === undefined ? [] : opts.scripts;
  const scripts = given && given.filter((s): s is string => s !== null).map((s) => withoutComments(s, language));
  for (const t of file.items) {
    if (!("ecas" in t) || t.type !== 8 || t.isCustom || t.isComment) continue;
    const severity = t.enabled ? "error" as const : "warning" as const;
    const add = (issue: Omit<TriggerIssue, "trigger" | "severity" | "where"> & { severity?: "error" | "warning" }) =>
      out.push({ severity, ...issue, trigger: t, ...(issue.path ? { where: lineLabel(t, issue.path) } : {}) });
    const known = (kind: number, name: string): TriggerFunction | undefined => data.functions[kind]?.get(name) ?? data.find(kind, name);

    const checkParam = (p: Param, want: string, path: number[], param: number[], label: string) => {
      const at = { path, param };
      const unset = () => add({ kind: "unset", ...at, message: `${label} isn't set` });
      switch (p.type) {
        case 0: {
          if (!p.value) return unset();
          const preset = data.presets.get(p.value);
          if (!preset) return add({ kind: "unknownPreset", ...at, message: `${label}: ${p.value} isn't one of TriggerData's presets` });
          if (!fits(data, preset.type, want)) return add({ kind: "typeMismatch", ...at, message: `${label}: ${preset.name} is ${typeName(data, preset.type)}, not ${typeName(data, want)}` });
          return;
        }
        case 1: {
          if (!p.value) return unset();
          const gg = /^gg_([a-z]+)_/.exec(p.value);
          if (gg) {
            const have = GLOBAL_TYPES[gg[1]];
            if (have && !fits(data, have, want)) add({ kind: "typeMismatch", ...at, message: `${label}: ${p.value} is ${typeName(data, have)}, not ${typeName(data, want)}` });
            return;
          }
          const v = variables.get(p.value);
          // A variable the map lacks is the References check's.
          if (!v) return;
          if (want !== "AnyGlobal" && !fits(data, v.type, want)) add({ kind: "typeMismatch", ...at, message: `${label}: the variable ${v.name} is ${typeName(data, v.type)}, not ${typeName(data, want)}` });
          if (v.isArray && !p.index && want !== "AnyGlobal") add({ kind: "arrayIndex", ...at, message: `${label}: the array ${v.name} has no index` });
          if (p.index) {
            if (!v.isArray) add({ kind: "arrayIndex", ...at, message: `${label}: ${v.name} isn't an array but has an index` });
            checkParam(p.index, "integer", path, [...param, -1], `${label}, its index,`);
          }
          return;
        }
        case 2: {
          const c = p.call;
          if (!c || !c.name) return unset();
          const f = known(c.kind, c.name);
          if (!f) return add({ kind: "unknownFunction", ...at, message: `${label}: the function ${c.name} isn't in TriggerData` });
          if (roc && f.version > 0) add({ kind: "frozenThrone", ...at, message: `${label}: ${f.displayName} needs The Frozen Throne; this trigger file is Reign of Chaos` });
          if (c.kind === CALL && f.returns && !fits(data, f.returns, want)) {
            add({ kind: "typeMismatch", ...at, message: `${label}: ${f.displayName} gives ${typeName(data, f.returns)}, not ${typeName(data, want)}` });
          }
          checkArgs(f, c.hasParams ? c.params : [], path, param, `${label} › ${f.displayName}`, !c.hasParams && f.args.length > 0);
          return;
        }
        case 3: {
          const base = data.types.get(want)?.base ?? want;
          if (base !== "integer" && base !== "real") return;
          // Object codes ('hfoo') and other integer types with values of their own stay unjudged.
          if (want === "integer" && !/^\s*-?\d+\s*$/.test(p.value) && !/^-?0x[0-9a-f]+$/i.test(p.value)) {
            if (!p.value.trim()) return unset();
            add({ kind: "badValue", ...at, message: `${label}: "${p.value}" isn't a whole number` });
          } else if (want === "real" && !Number.isFinite(Number(p.value))) {
            if (!p.value.trim()) return unset();
            add({ kind: "badValue", ...at, message: `${label}: "${p.value}" isn't a number` });
          }
          return;
        }
        default:
          return unset();
      }
    };
    /** `missing`: the call was stored without its parameters although the function takes some. */
    const checkArgs = (f: TriggerFunction, params: Param[], path: number[], prefix: number[], label: string, missing = false) => {
      if (missing || params.length !== f.args.length) {
        add({ kind: "paramCount", path, ...(prefix.length ? { param: prefix } : {}), message: `${label} takes ${f.args.length} parameter${f.args.length === 1 ? "" : "s"}, has ${params.length}` });
        return;
      }
      params.forEach((p, i) => {
        // SetVariable's value takes its variable's type.
        let want = f.args[i];
        if (f.name === "SetVariable" && i === 1 && params[0]?.type === 1) want = variables.get(params[0].value)?.type ?? want;
        checkParam(p, want, path, [...prefix, i], `${label}, parameter ${i + 1} (${typeName(data, want)})`);
      });
    };
    const walk = (list: Eca[], prefix: number[]) => {
      list.forEach((e, i) => {
        const path = [...prefix, i];
        // Not in the map script: not judged (as in the World Editor).
        if (!e.enabled) return;
        const f = known(e.kind, e.name);
        if (!f) { add({ kind: "unknownFunction", path, message: `${e.name || "(no name)"} isn't a${KIND_NAMES[e.kind] ? `n ${KIND_NAMES[e.kind].toLowerCase()}` : " function"} in TriggerData` }); return; }
        if (roc && f.version > 0) add({ kind: "frozenThrone", path, message: `${f.displayName} needs The Frozen Throne; this trigger file is Reign of Chaos` });
        checkArgs(f, e.params, path, [], f.displayName);
        walk(e.children, path);
      });
    };
    walk(t.ecas, []);
    // A disabled event isn't in the script either.
    if (scripts && t.enabled && !t.runOnInit && !t.ecas.some((e) => e.kind === EVENT && e.enabled) && doesSomething(t) && !runsFromElsewhere(file, scripts, t, language)) {
      const off = t.ecas.some((e) => e.kind === EVENT);
      add({ kind: "noEvents", severity: "warning", message: `has no ${off ? "enabled " : ""}events, and no trigger or script runs it` });
    }
  }
  return out;
}
