import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { hasTabKey, lateCancel, SELECT_TOGGLE_COMMAND, TAB_COMMANDS, TAB_KEY_COMMANDS, tabTarget } from "./tabkeys";
import { CANCEL_COMMAND, KEY_COMMANDS, runsAsCommand } from "./selectionkeys";
import { commandsFor, defaultBindings, eventChord } from "../../lib/keybindings";
import { repoPath } from "../../lib/testhelpers/testutil";

// The tab keys as the view reads them: the terrain viewer's default bindings (extension.json) under terrainFocus, the
// winner first (lib/keybindings.ts commandsFor), then where tabTarget sends them.
const manifest = JSON.parse(readFileSync(repoPath("app", "src", "builtin", "terrain-viewer", "extension.json"), "utf8")) as {
  contributes: { commands: { id: string; hidden?: boolean }[]; keybindings: { key: string; command: string; when?: string }[] };
};
const bindings = defaultBindings([], manifest.contributes.keybindings);
type Mods = Partial<{ code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>;
const bound = (key: string, m: Mods = {}) => {
  const c = eventChord({ key, code: m.code ?? "", ctrlKey: !!m.ctrlKey, metaKey: false, altKey: !!m.altKey, shiftKey: !!m.shiftKey });
  return c ? commandsFor(bindings, c, { terrainFocus: true }) : [];
};
const ALL_TABS = new Set(["terrain", "objects", "regions", "cameras", "pathing", "mapsize"]);
const has = (id: string) => ALL_TABS.has(id);
/** Where a key sends the view from tab `active` (null: Select), with `last` open before. */
const press = (key: string, active: string | null = null, last: string | null = null, m: Mods = {}) => tabTarget(bound(key, m), active, last, has);

test("T, D, U, R and M are the World Editor's Layer menu (we-drive 2026-11-20): Terrain, Objects (doodads, units), Regions, Cameras", () => {
  assert.equal(press("t"), "terrain");
  assert.equal(press("d"), "objects");
  assert.equal(press("u"), "objects");
  assert.equal(press("r"), "regions");
  assert.equal(press("m"), "cameras");
  // From another tab too.
  assert.equal(press("t", "cameras"), "terrain");
  assert.equal(press("m", "terrain"), "cameras");
});

test("O is Studio's own key for the Objects tab", () => {
  assert.equal(press("o"), "objects");
  assert.equal(press("o", "terrain"), "objects");
});

test("caps lock and WebKitGTK's unnamed keys (by their code) count; Shift, Ctrl and Alt with them don't switch, as in the editor", () => {
  assert.equal(press("T"), "terrain", "caps lock: the capital without Shift");
  assert.equal(press("Unidentified", null, null, { code: "KeyR" }), "regions");
  for (const k of ["t", "d", "u", "r", "m", "o"]) {
    for (const m of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }] as Mods[]) {
      assert.equal(press(m.shiftKey ? k.toUpperCase() : k, null, null, m), undefined, `${JSON.stringify(m)} ${k}`);
    }
  }
});

test("no other letter or digit switches a tab (the editor's sweep of a-z and 0-9)", () => {
  for (const k of "abcefghijklnpqsvwxyz0123456789") assert.equal(hasTabKey(bound(k)), false, k);
});

test("Space goes to the Select tab, and from there back to the tab before (the editor's selection brush and back)", () => {
  assert.equal(press(" ", "terrain"), null);
  assert.equal(press(" ", "objects"), null);
  assert.equal(press(" ", null, "terrain"), "terrain");
  assert.equal(press(" ", null, "regions"), "regions");
  assert.equal(press(" ", null, null), undefined, "no tab before: Space stays");
  assert.equal(tabTarget([SELECT_TOGGLE_COMMAND], null, "gone", has), undefined, "the tab before has gone (its extension off)");
  assert.equal(press("Unidentified", "cameras", null, { code: "Space" }), null);
  assert.equal(press(" ", "terrain", null, { ctrlKey: true }), undefined, "Ctrl+Space isn't it");
});

test("a tab this editor hasn't is nowhere to go", () => {
  assert.equal(tabTarget(["w3.terrain.tab.regions"], null, null, (id) => id !== "regions"), undefined);
  assert.equal(tabTarget(["w3.terrain.tab.terrain"], "objects", null, () => true), "terrain");
  assert.equal(tabTarget(["w3.terrain.selection.delete"], null, null, () => true), undefined);
});

test("the tab keys win over what else the keys did: T no longer faces the pointer, R no longer turns, Space no longer recalls", () => {
  for (const k of ["t", "r", " ", "d", "u", "m", "o"]) {
    const ids = bound(k);
    assert.ok(hasTabKey(ids), k);
    assert.deepEqual(ids.filter((c) => !TAB_KEY_COMMANDS.includes(c)), [], `${JSON.stringify(k)} is bound to nothing else: ${ids.join(", ")}`);
  }
});

test("the tab key commands are the view's own (not run as plain commands) and in the command palette", () => {
  for (const c of TAB_KEY_COMMANDS) {
    assert.ok(KEY_COMMANDS.has(c), c);
    assert.equal(runsAsCommand(c), false, c);
    const contributed = manifest.contributes.commands.find((x) => x.id === c);
    assert.ok(contributed && !contributed.hidden, `${c} is declared and shown in the palette`);
  }
  assert.deepEqual(new Set(Object.values(TAB_COMMANDS)), new Set(["terrain", "objects", "regions", "cameras"]));
});

test("Escape: facing first, then the selection, then from a tab to the Select tab; Escape is still Cancel", () => {
  assert.ok(bound("Escape", { code: "Escape" }).includes(CANCEL_COMMAND));
  assert.equal(lateCancel({ facing: true, selected: 3, tab: null }), "facing");
  assert.equal(lateCancel({ facing: false, selected: 1, tab: "terrain" }), "selection", "something selected: deselected first");
  assert.equal(lateCancel({ facing: false, selected: 0, tab: "terrain" }), "selectTab");
  assert.equal(lateCancel({ facing: false, selected: 0, tab: "objects" }), "selectTab");
  assert.equal(lateCancel({ facing: false, selected: 2, tab: null }), "selection");
  assert.equal(lateCancel({ facing: false, selected: 0, tab: null }), "none");
});
