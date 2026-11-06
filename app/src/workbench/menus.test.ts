import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { CommandContribution } from "../extensions/api";
import { menuTree, shortcutText } from "./menus";

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
});
