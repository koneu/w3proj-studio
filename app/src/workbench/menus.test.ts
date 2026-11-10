import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { CommandContribution } from "../extensions/api";
import { menuFor, menuTree, nextEnabled, shortcutText, whyBlocked } from "./menus";

const cmd = (id: string, menu?: string, keybinding?: string): CommandContribution => ({ id, title: id, ...(menu ? { menu } : {}), ...(keybinding ? { keybinding } : {}) });

test("menus come in the World Editor's order, and only those in use", () => {
  const tree = menuTree([cmd("a", "Help"), cmd("b", "Tools"), cmd("c", "File"), cmd("d")]);
  assert.deepEqual(tree.map((m) => m.name), ["File", "Tools", "Help"]);
});

test("a command without a menu stays out of them", () => {
  assert.deepEqual(menuTree([cmd("a")]), []);
});

test("groups and places order a menu, whichever order commands came in", () => {
  const [file] = menuTree([cmd("save", "File:3:1"), cmd("open", "File:2:1"), cmd("new", "File:1:1"), cmd("close", "File:2:3"), cmd("import", "File:2:2")]);
  assert.deepEqual(file.groups.map((g) => g.map((e) => e.id)), [["new"], ["open", "import", "close"], ["save"]]);
});

test("without a place, commands keep the order they came in", () => {
  const [file] = menuTree([cmd("b", "File"), cmd("a", "File")]);
  assert.deepEqual(file.groups[0].map((e) => e.id), ["b", "a"]);
});

test("an extension's own menu goes before Help", () => {
  assert.deepEqual(menuTree([cmd("a", "Help"), cmd("b", "Stats"), cmd("c", "Tools")]).map((m) => m.name), ["Tools", "Stats", "Help"]);
});

test("shortcuts read as people write them", () => {
  assert.equal(shortcutText("ctrl+shift+b"), "Ctrl+Shift+B");
  assert.equal(shortcutText("f5"), "F5");
  assert.equal(shortcutText("ctrl+,"), "Ctrl+,");
  assert.equal(shortcutText("ctrl+k ctrl+s"), "Ctrl+K Ctrl+S");
  assert.equal(menuTree([cmd("a", "File", "ctrl+f5")])[0].groups[0][0].shortcut, "Ctrl+F5");
});

test("what a user looks for first is in the menus of the built-in extensions", () => {
  const builtin = "src/builtin";
  const placed = new Map(readdirSync(builtin, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => {
    const m = JSON.parse(readFileSync(join(builtin, d.name, "extension.json"), "utf8")) as { contributes?: { commands?: CommandContribution[] } };
    return (m.contributes?.commands ?? []).filter((c) => c.menu).map((c) => [c.id, c.menu as string] as const);
  }));
  for (const [id, menu] of [["w3.map.new", "File"], ["w3.project.testMap", "File"], ["w3.terrain.open", "Module"], ["w3.objectEditor.open", "Module"], ["w3.triggers.open", "Module"], ["w3.mapInfo.open", "Scenario"], ["w3.problems.run", "Tools"]]) {
    assert.ok(placed.get(id)?.startsWith(menu), id);
  }
  assert.ok(placed.size >= 30);
  // Item tables (unit drops) aren't only a section deep in Map Properties: their own entry, right after it.
  const scenario = menuTree(readdirSync(builtin, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) =>
    (JSON.parse(readFileSync(join(builtin, d.name, "extension.json"), "utf8")) as { contributes?: { commands?: CommandContribution[] } }).contributes?.commands ?? []))
    .find((m) => m.name === "Scenario")!.groups.flat().map((e) => e.id);
  assert.equal(scenario.indexOf("w3.mapInfo.itemTables"), scenario.indexOf("w3.mapInfo.open") + 1, scenario.join(", "));
});

test("a menu entry says why it can't run, and only then", () => {
  const none = { project: false, editor: false, save: false, undo: false };
  assert.equal(whyBlocked(undefined, none), undefined);
  assert.equal(whyBlocked("project", { ...none, project: true }), undefined);
  assert.equal(whyBlocked("editor", { ...none, editor: true }), undefined);
  assert.equal(whyBlocked("save", { ...none, save: true }), undefined);
  assert.equal(whyBlocked("undo", { ...none, undo: true }), undefined);
  assert.match(whyBlocked("project", { ...none, editor: true }) ?? "", /project/);
  for (const when of ["editor", "save", "undo"] as const) assert.ok(whyBlocked(when, { ...none, project: true }), when);
  const [file] = menuTree([{ ...cmd("a", "File"), when: "project" }]);
  assert.equal(file.groups[0][0].when, "project");
});

test("the keys step past what's switched off, and round the ends", () => {
  const on = [true, false, true, false];
  assert.equal(nextEnabled(on, -1, 1), 0, "down from nothing is the first");
  assert.equal(nextEnabled(on, -1, -1), 2, "up from nothing is the last");
  assert.equal(nextEnabled(on, 0, 1), 2);
  assert.equal(nextEnabled(on, 2, 1), 0);
  assert.equal(nextEnabled(on, 0, -1), 2);
  assert.equal(nextEnabled([false, false], -1, 1), -1);
  assert.equal(nextEnabled([], -1, 1), -1);
});

test("Alt and a letter finds its menu", () => {
  const names = ["File", "Edit", "Module"];
  assert.equal(menuFor(names, "f"), "File");
  assert.equal(menuFor(names, "M"), "Module");
  assert.equal(menuFor(names, "x"), undefined);
});
