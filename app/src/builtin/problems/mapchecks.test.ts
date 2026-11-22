// Checks of mapchecks.ts on a made-up project. The trigger checks: Validate Map Triggers' findings with
// the place a click opens (trigger id, line, parameter), a trigger file that is there but can't be read
// (an error, not "no problems"), and a project without triggers (nothing). Map Properties art: a click
// opens Map Properties at the section the value is in.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { hasTriggerTextRule, mapChecks, TRIGGERS_GIT_RULE } from "./mapchecks";
import { RunScope } from "./runscope";
import { fakeReadTriggers, HEADER_FILE } from "../../lib/testhelpers/triggers";

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
      readTriggers: fakeReadTriggers((p) => files[p]),
      exists: async (p: string) => p in files,
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
  const found = await run({ "map/triggers/triggers.json": wtg([
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
  const broken = await run({ "map/triggers/triggers.json": "{ not json" }, "triggerValidate");
  assert.equal(broken.length, 1);
  assert.match(broken[0].message, /^The triggers can't be read/);
  assert.equal(broken[0].severity, "error");
  assert.deepEqual(await run({ "map/war3map.w3i.json": "{}" }, "triggerValidate"), []);
  // The other trigger checks don't report the unreadable file again.
  assert.deepEqual(await run({ "map/triggers/triggers.json": "{ not json" }, "triggerNoEvents"), []);
  assert.deepEqual(await run({ "map/triggers/triggers.json": "{ not json" }, "triggerRefs"), []);
});

test("Check Trigger Tree's findings are listed by file and line, with their fix; a check that can't run fails", async () => {
  const w3 = app({ "map/triggers/triggers.json": wtg([]) }) as unknown as { workspace: Record<string, unknown>; backend: { invoke: (cmd: string, args: unknown) => Promise<unknown> } };
  const asked: unknown[] = [];
  w3.backend.invoke = async (cmd, args) => {
    asked.push([cmd, args]);
    return [
      { severity: "warning", code: "orderMissing", file: "map/triggers/Setup/order.txt", line: 3, message: "Gone.j isn't there", fix: "order" },
      { severity: "error", code: "conflict", file: "map/triggers/Setup/A.j", line: 7, message: "an unresolved merge conflict" },
    ];
  };
  const scope = new RunScope(w3 as unknown as W3Api);
  const tree = () => mapChecks(w3 as unknown as W3Api, () => scope).find((c) => c.id === "triggerFolders")!.run();
  const found = await tree();
  assert.deepEqual(asked, [["triggers_check", { root: "/p" }]]);
  assert.deepEqual(found.map((p) => [p.severity, p.message, p.location, p.fixes?.map((f) => f.label)]), [
    ["warning", "Gone.j isn't there", "map/triggers/Setup/order.txt:3", ["Fix order.txt"]],
    ["error", "an unresolved merge conflict", "map/triggers/Setup/A.j:7", undefined],
  ]);
  assert.deepEqual(found[0].reveal, { command: "w3.text.revealLine", args: ["map/triggers/Setup/order.txt", 3] });
  w3.backend.invoke = async () => { throw new Error("map/triggers/ can't be listed"); };
  await assert.rejects(tree(), /can't be listed/, "a failed check isn't \"no problems\"");
  // Control: a project without trigger folders asks nothing.
  asked.length = 0;
  const plain = app({ "map/war3map.w3i.json": "{}" });
  assert.deepEqual(await mapChecks(plain, () => new RunScope(plain)).find((c) => c.id === "triggerFolders")!.run(), []);
});

test("a project with trigger folders and no .gitattributes rule for them is warned about", async () => {
  const tree = { "map/triggers/triggers.json": wtg([]) };
  const none = await run(tree, "triggerFoldersGit");
  assert.deepEqual(none.map((p) => p.severity), ["warning"]);
  assert.match(none[0].message, /^The project has no \.gitattributes: add the line "map\/triggers\/\*\* -text"/);
  const without = await run({ ...tree, ".gitattributes": "*.blp binary\n" }, "triggerFoldersGit");
  assert.match(without[0]?.message ?? "", /^\.gitattributes has no rule for map\/triggers\//);
  assert.deepEqual(without[0]?.reveal, { command: "w3.problems.open", args: [".gitattributes"] });
  assert.deepEqual(await run({ ...tree, ".gitattributes": `# texts\n${TRIGGERS_GIT_RULE}\n` }, "triggerFoldersGit"), []);
  // Control: no trigger folders, nothing to say.
  assert.deepEqual(await run({ "map/war3map.w3i.json": "{}" }, "triggerFoldersGit"), []);
  // The rule as Git reads it: the last matching line decides.
  assert.equal(hasTriggerTextRule("* -text\n"), true);
  assert.equal(hasTriggerTextRule("map/triggers/** -text\n* text=auto\n"), false);
  assert.equal(hasTriggerTextRule("* text=auto\nmap/triggers/** -text\n"), true);
  assert.equal(hasTriggerTextRule("# map/triggers/** -text\n"), false);
});

test("triggers nothing runs are a check of their own", async () => {
  const files = { "map/triggers/triggers.json": wtg([{ kind: 2, name: "KillUnit", enabled: true, params: [{ type: 1, value: "gg_unit_hfoo_0001" }], children: [] }]) };
  assert.deepEqual(await run(files, "triggerValidate"), []);
  const unused = await run(files, "triggerNoEvents");
  assert.deepEqual(unused.map((p) => [p.severity, p.message, p.location]), [["warning", "has no events, and no trigger or script runs it", "Doomed"]]);
  assert.equal(unused[0].about, "Doomed", "the Problems ignore names the report by its trigger");
  // Run from the map's custom script header: not unused.
  assert.deepEqual(await run({ ...files, [HEADER_FILE]: "call TriggerExecute(gg_trg_Doomed)\n" }, "triggerNoEvents"), []);
  // Control: the same header running another trigger was read, and this one is still unused.
  assert.equal((await run({ ...files, [HEADER_FILE]: "call TriggerExecute(gg_trg_Other)\n" }, "triggerNoEvents")).length, 1);
});

test("printf conversions in the custom script header: a crash is an error, garbage a warning, by line; %% is nothing", async () => {
  const files = { "map/triggers/triggers.json": wtg([]) };
  const found = await run({ ...files, [HEADER_FILE]: "// 100%% done\n// %d left\n// 100% sure\n" }, "headerPrintf");
  assert.deepEqual(found.map((p) => [p.severity, p.location]), [["warning", "triggers/header.j:2"], ["error", "triggers/header.j:3"]]);
  assert.match(found[1].message, /"% s" \(line 3\): the World Editor's save crashes on it/);
  assert.deepEqual(found[0].reveal, { command: "w3.problems.open", args: [HEADER_FILE] });
  // Control: the same header with every % doubled, and none at all.
  assert.deepEqual(await run({ ...files, [HEADER_FILE]: "// 100%% done\n// %%d left\n// 100%% sure\n" }, "headerPrintf"), []);
  assert.deepEqual(await run(files, "headerPrintf"), []);
});

test("missing Map Properties art opens Map Properties at its section", async () => {
  const found = await run({ "map/war3map.w3i.json": JSON.stringify({ loadingScreen: { model: "UI\\Made\\Screen.mdx" }, prologue: { path: "UI\\Made\\Prologue.blp" } }) }, "interfaceArt");
  assert.deepEqual(found.map((p) => [p.location, p.reveal]), [
    ["Map Properties › Loading screen", { command: "w3.mapInfo.open", args: ["loading"] }],
    ["Map Properties › Prologue", { command: "w3.mapInfo.open", args: ["prologue"] }],
  ]);
});

test("terrain tiles: a cliff type the game lacks is an error when a corner uses it, a warning when none does", async () => {
  const SLK = (id: string, rows: string[]) => `ID;P\nC;X1;Y1;K"${id}"\n${rows.map((r, i) => `C;Y${i + 2};X1;K"${r}"`).join("\n")}\nE\n`;
  const corner = (cliffTexture: number) => ({ height: 0, water: 0, texture: 0, variation: 0, cliffVariation: 0, cliffTexture, layer: 2, ramp: false, blight: false, hasWater: false, boundary: false, rawHeight: 0, rawWater: 0, texExtra: 0 });
  const files = async (cliffTexture: number, cliffTiles = ["CLdi", "CLno"]) => {
    const { writeW3e } = await import("../../lib/terrain/w3e");
    const bytes = writeW3e({ version: 11, tileset: "L", customTilesets: false, customTilesetsRaw: 0, groundTiles: ["Ldrt"], cliffTiles, width: 1, height: 1, offsetX: 0, offsetY: 0, corners: [corner(cliffTexture)], trailer: new Uint8Array(0) });
    const w3 = app({}) as unknown as { workspace: Record<string, unknown>; game: Record<string, unknown> };
    w3.workspace.files = () => [{ path: "map/war3map.w3e", size: 1, modified: 1 }];
    w3.workspace.readBytes = async () => bytes;
    w3.game.readText = async (p: string) => (p.includes("Terrain.slk") ? SLK("tileID", ["Ldrt"]) : SLK("cliffID", ["CLdi", "CLgr", "CAdi"]));
    const scope = new RunScope(w3 as unknown as W3Api);
    return mapChecks(w3 as unknown as W3Api, () => scope).find((c) => c.id === "terrainTiles")!.run();
  };
  const unused = await files(0), used = await files(1);
  assert.deepEqual(unused.map((p) => p.severity), ["warning"]);
  assert.match(unused[0].message, /Cliff type CLno isn't one of the game's/);
  assert.deepEqual(used.map((p) => p.severity), ["error"], "control: the same list with a corner using CLno");
  // A list of three or more: the game's own third (example map 29) is fine on a corner, an unknown fourth is
  // judged by its own number.
  assert.deepEqual(await files(2, ["CLdi", "CLgr", "CAdi"]), []);
  assert.deepEqual((await files(2, ["CLdi", "CLgr", "CAdi", "CLno"])).map((p) => p.severity), ["warning"]);
  assert.deepEqual((await files(3, ["CLdi", "CLgr", "CAdi", "CLno"])).map((p) => p.severity), ["error"]);
});
