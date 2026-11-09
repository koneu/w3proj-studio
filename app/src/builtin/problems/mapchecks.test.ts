// Checks of mapchecks.ts on a made-up project. The trigger checks: Validate Map Triggers' findings with
// the place a click opens (trigger id, line, parameter), a trigger file that is there but can't be read
// (an error, not "no problems"), and a project without triggers (nothing). Map Properties art: a click
// opens Map Properties at the section the value is in.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { mapChecks } from "./mapchecks";
import { RunScope } from "./runscope";

const TRIGGER_DATA = `
[TriggerTypes]
unit=0,1,1,Unit
player=0,1,1,Player
[TriggerParams]
PlayerRed=0,player,Player(0),Red
[TriggerEvents]
UnitDies=0,unit
[TriggerActions]
KillUnit=0,unit
_KillUnit_DisplayName="Kill Unit"
`;

const wtg = (ecas: unknown[]) => JSON.stringify({
  reforged: true, version: 7, counts: [], unknown: 2, variables: [],
  items: [
    { type: 8, name: "Doomed", description: "", isComment: 0, id: 50331649, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent: 0, ecas },
  ],
});

function app(files: Record<string, string>): W3Api {
  return {
    workspace: {
      project: () => ({ root: "/p", name: "p" }),
      files: () => Object.keys(files).map((path) => ({ path, size: 1, modified: 1 })),
      readText: async (p: string) => { if (p in files) return files[p]; throw new Error(`no ${p}`); },
      readBytes: async (p: string) => { if (p in files) return new TextEncoder().encode(files[p]); throw new Error(`no ${p}`); },
    },
    game: {
      readText: async (p: string) => { if (p === "UI\\TriggerData.txt") return TRIGGER_DATA; throw new Error(`no ${p}`); },
      resolveMany: async (paths: string[]) => paths.map(() => null),
    },
    backend: { invoke: async () => { throw new Error("not here"); } },
  } as unknown as W3Api;
}

async function run(files: Record<string, string>, id: string) {
  const w3 = app(files), scope = new RunScope(w3);
  const check = mapChecks(w3, () => scope).find((c) => c.id === id)!;
  return check.run();
}

test("findings of Validate Map Triggers open the trigger at the line and parameter", async () => {
  const found = await run({ "map/war3map.wtg.json": wtg([
    { kind: 0, name: "UnitDies", enabled: true, params: [{ type: 1, value: "gg_unit_hfoo_0001" }], children: [] },
    { kind: 2, name: "KillUnit", enabled: true, params: [{ type: 0, value: "PlayerRed" }], children: [] },
  ]) }, "triggerValidate");
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "error");
  assert.equal(found[0].message, "Action 1: Kill Unit, parameter 1 (Unit): Red is Player, not Unit");
  assert.equal(found[0].location, "Doomed");
  assert.deepEqual(found[0].reveal, { command: "w3.triggers.reveal", args: ["Doomed", { id: 50331649, path: [1], param: [0] }] });
});

test("a trigger file that can't be read is an error; no trigger file is nothing", async () => {
  const broken = await run({ "map/war3map.wtg.json": "{ not json" }, "triggerValidate");
  assert.equal(broken.length, 1);
  assert.match(broken[0].message, /^The triggers can't be read/);
  assert.equal(broken[0].severity, "error");
  assert.deepEqual(await run({ "map/war3map.w3i.json": "{}" }, "triggerValidate"), []);
  // The other trigger checks don't report the unreadable file again.
  assert.deepEqual(await run({ "map/war3map.wtg.json": "{ not json" }, "triggerNoEvents"), []);
  assert.deepEqual(await run({ "map/war3map.wtg.json": "{ not json" }, "triggerRefs"), []);
});

test("triggers nothing runs are a check of their own", async () => {
  const files = { "map/war3map.wtg.json": wtg([{ kind: 2, name: "KillUnit", enabled: true, params: [{ type: 1, value: "gg_unit_hfoo_0001" }], children: [] }]) };
  assert.deepEqual(await run(files, "triggerValidate"), []);
  const unused = await run(files, "triggerNoEvents");
  assert.deepEqual(unused.map((p) => [p.severity, p.message, p.location]), [["warning", "has no events, and no trigger or script runs it", "Doomed"]]);
  // Run from the map's custom script: not unused.
  const wct = (code: string) => `//== war3map.wct: version 1, reforged, comment "" ==\n//== header ==\n${code}\n//== trigger 0 (no text): Doomed ==\n`;
  assert.deepEqual(await run({ ...files, "map/war3map.wct.txt": wct("call TriggerExecute(gg_trg_Doomed)") }, "triggerNoEvents"), []);
  // Control: the same file running another trigger was read, and this one is still unused.
  assert.equal((await run({ ...files, "map/war3map.wct.txt": wct("call TriggerExecute(gg_trg_Other)") }, "triggerNoEvents")).length, 1);
  // A script file that can't be read: which triggers it runs isn't known, so none is called unused.
  assert.deepEqual(await run({ ...files, "map/war3map.wct.txt": "not a wct" }, "triggerNoEvents"), []);
});

test("missing Map Properties art opens Map Properties at its section", async () => {
  const found = await run({ "map/war3map.w3i.json": JSON.stringify({ loadingScreen: { model: "UI\\Made\\Screen.mdx" }, prologue: { path: "UI\\Made\\Prologue.blp" } }) }, "interfaceArt");
  assert.deepEqual(found.map((p) => [p.location, p.reveal]), [
    ["Map Properties › Loading screen", { command: "w3.mapInfo.open", args: ["loading"] }],
    ["Map Properties › Prologue", { command: "w3.mapInfo.open", args: ["prologue"] }],
  ]);
});
