// The web demo's made-up trigger definitions (src/demo/gamedata) against what the Trigger Editor, the script generator and
// the demo's own sample map need: demo-check only shows that the page loads. Loaded through the real parser.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseIni } from "../lib/formats/text";
import { ACTION, CALL, CONDITION, EVENT, parseTriggerData } from "../lib/triggers/triggerdata";
import type { Eca, Param } from "../lib/triggers/wtg";

// The test runs from a compiled copy, so the demo files are found from app/ (the working folder of `npm test`).
const read = (p: string) => readFileSync(join(process.cwd(), "src", "demo", p), "utf8");
const strings = new Map<string, string>();
for (const sec of parseIni(read("./gamedata/WorldEditStrings.txt")).values()) for (const [k, v] of sec) strings.set(k.toUpperCase(), v);
const data = parseTriggerData(read("./gamedata/TriggerData.txt"), strings, read("./gamedata/TriggerStrings.txt"));
const sample = JSON.parse(read("./sample/map/triggers/triggers.json")).file as { variables: { type: string }[]; items: { ecas?: Eca[] }[] };

/** Names the editor and the script generator look up by literal: opening and creating a trigger, comments, custom script,
 *  variables, blocks (src/builtin/trigger-gui, src/lib/triggers/validate.ts, src/lib/script/triggers.ts). */
const NEEDED: [number, string][] = [
  [EVENT, "MapInitializationEvent"],
  [CONDITION, "AndMultiple"], [CONDITION, "OrMultiple"],
  [ACTION, "DoNothing"], [ACTION, "CommentString"], [ACTION, "CustomScriptCode"], [ACTION, "SetVariable"], [ACTION, "IfThenElseMultiple"],
];

test("the demo definitions have every hard-coded name the editor needs", () => {
  for (const [kind, name] of NEEDED) assert.ok(data.functions[kind].has(name), `kind ${kind} "${name}" is missing from the demo TriggerData`);
});

test("every function the demo's sample map uses is defined, with the right kind and argument count", () => {
  const walk = (e: Eca) => {
    const f = data.functions[e.kind]?.get(e.name);
    assert.ok(f, `sample uses kind ${e.kind} "${e.name}" with no definition`);
    // Blocks (And, If) take their children, not parameters.
    if (!/Multiple$/.test(e.name)) assert.equal(e.params.length, f.args.length, `${e.name}: ${e.params.length} parameters, ${f.args.length} defined`);
    e.params.forEach(param);
    (e.children ?? []).forEach(walk); // a call used as a parameter has none
  };
  const param = (p: Param) => {
    if (p.type === 0) assert.ok(data.presets.has(p.value), `sample preset "${p.value}" is not defined`);
    if (p.call) walk(p.call as unknown as Eca);
  };
  for (const item of sample.items) item.ecas?.forEach(walk);
  for (const v of sample.variables) assert.ok(data.types.get(v.type)?.global, `sample variable type "${v.type}" is not a global type`);
});

test("types, categories, presets and defaults of the demo definitions refer only to things that exist", () => {
  assert.ok(data.types.size > 0 && data.presets.size > 0 && data.categories.size > 0);
  for (const [name, t] of data.types) if (t.base) assert.ok(data.types.has(t.base), `type ${name}: base ${t.base} is not a type`);
  for (const [name, p] of data.presets) assert.ok(data.types.has(p.type), `preset ${name}: type ${p.type} is not a type`);
  for (const map of data.functions) {
    for (const f of map.values()) {
      const where = `${f.kind}:${f.name}`;
      for (const a of f.args) assert.ok(data.types.has(a), `${where}: argument type ${a} is not a type`);
      if (f.returns) assert.ok(data.types.has(f.returns), `${where}: return type ${f.returns} is not a type`);
      assert.ok(data.categories.has(f.category), `${where}: category "${f.category}" is not defined`);
      assert.ok(!f.displayName.startsWith("WESTRING_") && f.displayName !== f.name, `${where}: no display name`);
      assert.equal(f.pattern.filter((p) => typeof p !== "string").length, f.args.length, `${where}: pattern has a different number of arguments than the definition`);
      assert.ok(f.defaults.length <= f.args.length, `${where}: more defaults than arguments`);
      f.defaults.forEach((d, i) => {
        if (d === "_" || d === "" || d.startsWith('"') || !Number.isNaN(Number(d))) return;
        const preset = data.presets.get(d), call = data.functions[CALL].get(d);
        assert.ok(preset?.type === f.args[i] || call?.returns === f.args[i], `${where}: default "${d}" is no preset or call of type ${f.args[i]}`);
      });
    }
  }
  for (const [name, c] of data.categories) assert.ok(!c.name.startsWith("WESTRING_"), `category ${name}: its name string is missing`);
  for (const [name, p] of data.presets) assert.ok(!p.name.startsWith("WESTRING_"), `preset ${name}: its name string is missing`);
  for (const [name, t] of data.types) assert.ok(!t.name.startsWith("WESTRING_"), `type ${name}: its name string is missing`);
});

test("control: a missing needed name is caught", () => {
  const cut = parseTriggerData(read("./gamedata/TriggerData.txt").replace(/^SetVariable=.*$/m, ""));
  assert.equal(cut.functions[ACTION].has("SetVariable"), false);
});
