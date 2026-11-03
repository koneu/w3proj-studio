// UI\TriggerData.txt: what the trigger editor knows about GUI functions.
// Sections used here:
//   [TriggerEvents] / [TriggerConditions] / [TriggerActions]
//       Name=version,argType,argType…        ("nothing" = no arguments)
//   [TriggerCalls]  Name=version,usableInEvents,returnType,argType…
//       _Name_DisplayName="…", _Name_Parameters="text",~Arg,"text"…, _Name_Category=TC_…
//   [TriggerCategories] TC_…=display string,icon[,hide category name]
//   [TriggerTypes]  type=version,global,comparable,display string[,base type]
//   [TriggerParams] preset=version,type,script text,display string
// Display strings may be WESTRING_ keys (resolved through `strings`).

/** ECA kinds as stored in war3map.wtg; 3 is a call used as a parameter. */
export const EVENT = 0, CONDITION = 1, ACTION = 2, CALL = 3;
const SECTIONS = ["TriggerEvents", "TriggerConditions", "TriggerActions", "TriggerCalls"];

export interface TriggerFunction {
  name: string;
  kind: number;
  args: string[];
  /** Calls only. */
  returns?: string;
  displayName: string;
  /** Text and argument placeholders ("~Name" entries), as in _Parameters. */
  pattern: (string | { arg: string })[];
  category: string;
  /** Default per argument from _Defaults: a preset, call or value; "_" for none. */
  defaults: string[];
  /** Explanation shown under the function list (TriggerStrings.txt: <Name>Hint=…). */
  hint: string;
  /** The JASS function it compiles to (_ScriptName), else its own name. */
  scriptName: string;
}

export interface TriggerData {
  functions: Map<string, TriggerFunction>[];
  /** Any kind, for calls stored with a kind that doesn't list them. */
  find(kind: number, name: string): TriggerFunction | undefined;
  categories: Map<string, { name: string; icon: string; hideName: boolean }>;
  /** In file order (the Variables dialog's order); `global`: can be a variable's type. */
  types: Map<string, { name: string; base?: string; global: boolean }>;
  /** Preset parameter → script text and display name. */
  presets: Map<string, { type: string; script: string; name: string }>;
}

/** Splits a comma list, keeping quoted parts (which may contain commas) whole. */
function splitList(v: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (const ch of v) {
    if (ch === '"') { quoted = !quoted; cur += ch; } else if (ch === "," && !quoted) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
/** Strips surrounding quotes (some game lines lack the closing one). */
const unquote = (s: string) => (s.startsWith('"') ? s.slice(1, s.length > 1 && s.endsWith('"') ? -1 : undefined) : s);

/** `hints`: UI\TriggerStrings.txt, whose <Name>Hint= entries explain functions. */
export function parseTriggerData(text: string, strings: Map<string, string> = new Map(), hints = ""): TriggerData {
  const str = (s: string) => { const u = unquote(s); return strings.get(u.toUpperCase()) ?? u; };
  const functions = SECTIONS.map(() => new Map<string, TriggerFunction>());
  const categories = new Map<string, { name: string; icon: string; hideName: boolean }>();
  const types = new Map<string, { name: string; base?: string; global: boolean }>();
  const presets = new Map<string, { type: string; script: string; name: string }>();
  // _Name_Field entries come after their function; keyed per section.
  const extra = SECTIONS.map(() => new Map<string, Map<string, string>>());
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) { section = line.slice(1, line.indexOf("]")); continue; }
    if (!line || line.startsWith("//")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq), value = line.slice(eq + 1);
    const si = SECTIONS.indexOf(section);
    if (si >= 0) {
      const m = /^_(.+)_(DisplayName|Parameters|Category|Defaults|Limits|ScriptName|AIDefaults|UseWithAI)$/.exec(key);
      if (m) {
        let e = extra[si].get(m[1]);
        if (!e) extra[si].set(m[1], (e = new Map()));
        e.set(m[2], value);
        continue;
      }
      if (key.startsWith("_")) continue;
      const vals = splitList(value);
      const call = si === CALL;
      const args = (call ? vals.slice(3) : vals.slice(1)).filter((a) => a && a !== "nothing");
      functions[si].set(key, { name: key, kind: si, args, returns: call ? vals[2] : undefined, displayName: key, pattern: [], category: "", defaults: [], hint: "", scriptName: key });
    } else if (section === "TriggerCategories") {
      const v = splitList(value);
      categories.set(key, { name: str(v[0] ?? key), icon: v[1] ?? "", hideName: v[2] === "1" });
    } else if (section === "TriggerTypes") {
      const v = splitList(value);
      types.set(key, { name: str(v[3] ?? key), base: v[4] || undefined, global: v[1] === "1" });
    } else if (section === "TriggerParams") {
      const v = splitList(value);
      presets.set(key, { type: v[1] ?? "", script: unquote(v[2] ?? "").replace(/`/g, '"'), name: str(v[3] ?? key) });
    }
  }
  const hintOf = new Map<string, string>();
  for (const m of hints.matchAll(/^(\w+)Hint=(.*)$/gm)) hintOf.set(m[1], unquote(m[2].trim()));
  functions.forEach((map, si) => {
    for (const f of map.values()) {
      f.hint = hintOf.get(f.name) ?? "";
      const e = extra[si].get(f.name);
      if (!e) continue;
      if (e.has("DisplayName")) f.displayName = str(e.get("DisplayName")!);
      if (e.has("Category")) f.category = e.get("Category")!;
      if (e.get("ScriptName")) f.scriptName = e.get("ScriptName")!;
      if (e.get("Defaults")) f.defaults = splitList(e.get("Defaults")!);
      if (e.has("Parameters")) {
        f.pattern = splitList(e.get("Parameters")!).filter((p) => p !== "").map((p) => (p.startsWith("~") ? { arg: p.slice(1) } : str(p)));
        // SetVariable's pattern repeats the display name in front ("Set Variable","Set ",~Variable…).
        if (f.pattern.length > 1 && f.pattern[0] === f.displayName && f.pattern.some((p) => typeof p !== "string")) f.pattern.shift();
      }
    }
  });
  return {
    functions, categories, types, presets,
    find: (kind, name) => functions[kind]?.get(name) ?? functions.find((m) => m.has(name))?.get(name),
  };
}
