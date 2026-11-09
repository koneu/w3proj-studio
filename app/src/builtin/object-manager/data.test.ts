import assert from "node:assert/strict";
import { test } from "node:test";
import { ProjectGuard, buildTree, groupActions, idsInText, mapSummary, markUnused, nodeActions, objectKinds, objectRefs, type MapContents, type Node } from "./data";

const ids = new Set(["Xs01", "Y01q", "h000"]);

test("object references: lists and single values, not the object itself", () => {
  const refs = objectRefs([{ ext: "w3u", label: "Unit", objects: [
    { id: "h000", base: "hfoo", mods: [{ value: "AHbz,Y01q,Xs01" }, { value: 12 }, { value: "h000" }] },
    { base: "hpea", mods: [{ value: "Y01q" }] },
  ] }], ids, (id) => id.toUpperCase());
  assert.deepEqual([...refs.get("Y01q")!.keys()].sort(), ["Unit: H000", "Unit: HPEA"]);
  assert.deepEqual(refs.get("Y01q")!.get("Unit: H000"), { kind: "object", ext: "w3u", id: "h000" });
  assert.equal(refs.has("h000"), false);
});

test("object references in a version 3 object's sets", () => {
  const refs = objectRefs([{ ext: "w3a", label: "Ability", objects: [{ id: "Xs01", base: "AHbz", sets: [{ mods: [{ value: "Y01q" }] }] }] }], ids, (id) => id);
  assert.deepEqual([...refs.get("Y01q")!.keys()], ["Ability: Xs01"]);
});

test("ids in texts: whole words of JASS, Lua and JSON only", () => {
  assert.deepEqual(idsInText("call CreateUnit(p, 'h000', 0, 0, 0)", ids), ["h000"]);
  assert.deepEqual(idsInText('CreateItem(FourCC("Xs01"), 0, 0) "id":"Y01q"', ids).sort(), ["Xs01", "Y01q"]);
  assert.deepEqual(idsInText("xh000 h0001 h000x", ids), []);
});

test("only custom objects count, wherever they are in the tree", () => {
  const tree: Node[] = [{ label: "Custom", children: [{ label: "Units", children: [
    { label: "a", ref: "aaaa", custom: true }, { label: "b", ref: "bbbb", custom: true },
  ] }] }, { label: "Placed", ref: "cccc" }];
  assert.equal(markUnused(tree, (id) => id === "aaaa"), 1);
  const units = tree[0].children![0].children!;
  assert.equal(units[0].unused, false);
  assert.equal(units[1].unused, true);
  assert.equal(tree[1].unused, undefined);
});

test("project guard: a build for the previous project is dropped after a switch", () => {
  const g = new ProjectGuard("A");
  const slow = g.begin();
  assert.equal(g.valid(slow, "A"), true);
  assert.equal(g.switched("A"), false, "same project: no switch");
  assert.equal(g.switched("B"), true);
  assert.equal(g.valid(slow, "B"), false, "old build, even though the root now differs from its own");
  assert.equal(g.valid(slow, "A"), false);
  const fresh = g.begin();
  assert.equal(g.valid(fresh, "B"), true);
});

test("project guard: switching back and forth keeps only the last build", () => {
  const g = new ProjectGuard("A");
  const a1 = g.begin();
  g.switched("B"); const b = g.begin();
  g.switched("A"); const a2 = g.begin();
  assert.equal(g.valid(a1, "A"), false);
  assert.equal(g.valid(b, "A"), false);
  assert.equal(g.valid(a2, "A"), true);
});

test("project guard: rows of another project are not owned", () => {
  const g = new ProjectGuard("A");
  assert.equal(g.owns("A", "A"), true);
  g.switched("B");
  assert.equal(g.owns("A", "B"), false);
  assert.equal(g.owns("B", "B"), true);
});

test("project guard: rows aren't owned while another project is open but unannounced", () => {
  const g = new ProjectGuard("A");
  // Opening B failed half way: the workspace holds B, the guard was never told, A's rows still show.
  assert.equal(g.owns("A", "B"), false);
  assert.equal(g.owns("A", "A"), true);
});

let editorId = 0;
const placed = (id: string, player?: number) => ({ id, position: [64 * editorId, 0], editorId: editorId++, ...(player === undefined ? {} : { player }) });
const contents = (extra: Partial<MapContents> = {}): MapContents => ({
  units: [placed("hfoo", 0), placed("hfoo", 0), placed("hkni", 1), placed("nwlf", 24), placed("sloc", 0), placed("ratc", 27)],
  doodads: [placed("LTlt"), placed("LTlt"), placed("ARrk")],
  kindOf: (id) => (id === "ratc" ? "w3t" : id === "LTlt" ? "w3b" : id === "ARrk" ? "w3d" : "w3u"),
  nameOf: (id) => id,
  custom: [{ ext: "w3u", label: "Units", ids: [{ id: "h000", base: "hfoo" }] }, { ext: "w3a", label: "Abilities", ids: [{ id: "A000", base: "AHbz" }, { id: "A001", base: "AHbz" }] }],
  regions: [{ name: "Gate", left: 0, right: 1, bottom: 0, top: 1 }], cameras: [], sounds: [{ name: "gg_snd_Boom", file: "Boom.wav", flags: 0 }],
  triggers: { reforged: false, version: 7, counts: [], unknown: 2, variables: [{ name: "Count", type: "integer" } as never], items: [
    { type: 4, id: 0, name: "Cat", isComment: 0, expanded: 1, parent: -1 } as never,
    { type: 8, name: "Init", description: "", isComment: 0, id: 0, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent: 0, ecas: [] },
    { type: 16, name: "Note", description: "", isComment: 1, id: 1, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent: 0, ecas: [] },
  ] },
  imports: [], objects: [], texts: [],
  info: { name: "Smoke", playableWidth: 84, playableHeight: 76, tileset: "L" },
  ...extra,
});

test("Map Summary: what the map holds, counted per kind as the World Editor's rows", () => {
  const rows = new Map(mapSummary(contents()));
  assert.equal(rows.get("Map Name"), "Smoke");
  assert.equal(rows.get("Playable Map Size"), "84 × 76");
  // Start locations and items aren't units; units are counted per owner too.
  assert.equal(rows.get("Total Units"), "4");
  assert.equal(rows.get("Units (Player 1)"), "2");
  assert.equal(rows.get("Units (Player 2)"), "1");
  assert.equal(rows.get("Units (Neutral Hostile)"), "1");
  assert.equal(rows.get("Items"), "1");
  assert.equal(rows.get("Doodads (Trees/Destructibles)"), "2");
  assert.equal(rows.get("Doodads (Other)"), "1");
  assert.equal(rows.get("Regions"), "1");
  assert.equal(rows.get("Cameras"), "0");
  // Comments aren't triggers.
  assert.equal(rows.get("Triggers"), "1");
  assert.equal(rows.get("Variables"), "1");
  assert.equal(rows.get("Sounds"), "1");
  assert.equal(rows.get("Custom Objects (Total)"), "3");
  assert.equal(rows.get("Custom Units"), "1");
  assert.equal(rows.get("Custom Abilities"), "2");
  assert.equal(rows.get("Custom Upgrades"), "0");
  // Without war3map.w3i: no name rows, the counts still.
  assert.equal(new Map(mapSummary(contents({ info: null }))).has("Map Name"), false);
});

test("Object Manager actions: rename and delete where the owning editor can, play for sounds", () => {
  const tree = buildTree(contents());
  const find = (label: RegExp): Node => {
    const walk = (ns: Node[]): Node | undefined => { for (const n of ns) { if (label.test(n.label)) return n; const k = walk(n.children ?? []); if (k) return k; } return undefined; };
    return walk(tree)!;
  };
  const custom = find(/^h000$/), placedType = find(/^hfoo \(2\)$/), trigger = find(/^Init$/), sound = find(/^Boom$/), variable = find(/^Count$/), region = find(/^Gate$/);
  assert.deepEqual(nodeActions(custom), { edit: true, rename: true, remove: true, play: false });
  // A standard object's type: only going to it. A region: renamed and deleted in the terrain editor's Regions tab.
  assert.deepEqual(nodeActions(placedType), { edit: true, rename: false, remove: false, play: false });
  assert.deepEqual(nodeActions(region), { edit: true, rename: true, remove: true, play: false });
  assert.deepEqual(region.item, { group: "regions", name: "Gate" });
  assert.deepEqual(nodeActions(trigger), { edit: true, rename: true, remove: true, play: false });
  assert.deepEqual(nodeActions(sound), { edit: true, rename: true, remove: true, play: true });
  assert.deepEqual(sound.target, { kind: "sounds", name: "gg_snd_Boom", file: "Boom.wav" });
  assert.deepEqual(nodeActions(variable), { edit: true, rename: true, remove: true, play: false });
  // A group has nothing to go to.
  assert.deepEqual(nodeActions(tree[0]), { edit: false, rename: false, remove: false, play: false });
});

test("Object Manager groups: Expand or Collapse, and the editor of their entries; cameras are renamed in their tab", () => {
  const tree = buildTree(contents({ cameras: [{ name: "Intro", targetX: 0, targetY: 0 }] }));
  const group = (start: string) => tree.find((n) => n.label.startsWith(start))!;
  const labels = (n: Node, open = false) => groupActions(n, open).map((a) => a.label);
  assert.deepEqual(labels(group("Units")), ["Expand", "Open Object Editor"]);
  assert.deepEqual(labels(group("Units"), true), ["Collapse", "Open Object Editor"]);
  // While a filter is on the groups open by themselves: no toggle that would do nothing, open or not.
  assert.deepEqual(groupActions(group("Units"), true, true).map((a) => a.label), ["Open Object Editor"]);
  assert.deepEqual(groupActions(group("Units"), false, true).map((a) => a.label), ["Open Object Editor"]);
  assert.deepEqual(group("Units").opens, { label: "Open Object Editor", command: "w3.objectEditor.open", args: ["w3u"] });
  assert.deepEqual(group("Regions").opens, { label: "Open Regions Tab", command: "w3.terrain.groupItemAction", args: ["regions", null, "select"] });
  assert.deepEqual(group("Cameras").opens?.args, ["cameras", null, "select"]);
  assert.equal(group("Triggers").opens?.command, "w3.triggers.open");
  assert.equal(group("Imported files").opens?.command, "w3.imports.open");
  // A group with nothing under it still opens its editor; nothing to expand.
  assert.deepEqual(labels(group("Imported files")), ["Open Import Manager"]);
  // A kind of custom objects opens that kind; the custom objects' group only expands.
  const customs = group("Custom objects");
  assert.deepEqual(labels(customs), ["Expand"]);
  assert.deepEqual(customs.children!.find((n) => n.label.startsWith("Abilities"))!.opens?.args, ["w3a"]);
  // Control: an entry without children or editor has no group menu.
  assert.deepEqual(groupActions({ label: "x" }, false), []);
  const cam = group("Cameras").children![0];
  assert.deepEqual(cam.item, { group: "cameras", name: "Intro" });
  assert.deepEqual(nodeActions(cam), { edit: true, rename: true, remove: true, play: false });
});

test("project guard: a project that is open but not yet announced is stale until switched", () => {
  const g = new ProjectGuard("A");
  assert.equal(g.stale("A"), false);
  assert.equal(g.stale("B"), true, "open() already set B, onDidChange has not fired");
  g.switched("B");
  assert.equal(g.stale("B"), false);
});

test("object kinds: an open editor's data wins over the saved file, kind by kind, with its names", () => {
  const kinds: [string, string][] = [["w3u", "Units"], ["w3a", "Abilities"], ["w3q", "Upgrades"]];
  const saved = new Map([
    ["w3u", { custom: [{ id: "h000", base: "hfoo" }, { id: "h001", base: "hkni" }], original: [{ base: "hpea", mods: [{ value: 1 }] }] }],
    ["w3a", { custom: [{ id: "A000", base: "AHbz" }] }],
    ["w3q", null],
  ]);
  // The unit editor deleted h001 (unsaved) and renamed h000; abilities have no open editor.
  const live = new Map([["w3u", { custom: [{ id: "h000", base: "hfoo" }], original: [], names: new Map([["h000", "Captain"]]) }]]);
  const k = objectKinds(kinds, saved, live);
  assert.deepEqual(k.custom.map((c) => [c.ext, c.label, c.ids.map((o) => o.id)]), [["w3u", "Units", ["h000"]], ["w3a", "Abilities", ["A000"]], ["w3q", "Upgrades", []]]);
  assert.deepEqual(k.objects.map((o) => [o.label, o.objects.length]), [["Unit", 1], ["Abilitie", 1], ["Upgrade", 0]]);
  assert.deepEqual([...k.names], [["h000", "Captain"]]);
  // Without an open editor: the saved file, standard objects' changes included.
  const s = objectKinds(kinds, saved, new Map());
  assert.deepEqual(s.custom[0].ids, [{ id: "h000", base: "hfoo" }, { id: "h001", base: "hkni" }]);
  assert.equal(s.objects[0].objects.length, 3);
});

test("placed objects: thousands of one type are grouped without copying the list per object", () => {
  const many = Array.from({ length: 40000 }, (_, i) => ({ id: "LTlt", position: [i, 0], editorId: i }));
  const t0 = performance.now();
  const tree = buildTree(contents({ units: [], doodads: many }));
  const ms = performance.now() - t0;
  const dest = tree.find((n) => n.label.startsWith("Destructables"))!;
  assert.equal(dest.label, "Destructables (40000)");
  assert.equal(dest.children![0].children!.length, 40000);
  // Copying the list for each object took seconds here; grouping by pushing takes milliseconds.
  assert.ok(ms < 1000, `buildTree took ${ms.toFixed(0)} ms`);
});
