// Key bindings (keybindings.ts): keys written one way, what a key event is, `when`, which binding wins, the user's
// rules (and their removals), conflicts, the edits the Keyboard Shortcuts editor makes, and keybindings.json on a
// made-up disk: absent is no keys yet, there-but-unreadable is never written over, writes go one after the other.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  addKey, changeKey, changeWhen, commandsFor, conflictsOf, defaultBindings, effectiveBindings, eventChord, isViewBinding, keyLabel,
  KeybindingService, normalizeKey, parseKeybindingsFile, parseWhen, evalWhen, primaryKey, removeBinding, resetCommand, resolve,
  targetContext, userRules, type Binding, isMouseKey, mouseChord, mouseCommandsFor, UNDO_BINDINGS, UNDO_CONTEXT, undoStepOf,
} from "./keybindings";

const ev = (key: string, mods: Partial<{ code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key, code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

test("keys are written one way: modifiers ctrl, alt, shift, lower case, VS Code's names", () => {
  assert.equal(normalizeKey("Ctrl+Shift+P"), "ctrl+shift+p");
  assert.equal(normalizeKey("shift+ctrl+p"), "ctrl+shift+p");
  assert.equal(normalizeKey("cmd+s"), "ctrl+s");
  assert.equal(normalizeKey("ArrowUp"), "up");
  assert.equal(normalizeKey("ctrl+alt++"), "ctrl+alt++");
  assert.equal(normalizeKey("ctrl+plus"), "ctrl++");
  assert.equal(normalizeKey("shift+/"), "/", "Shift made the character");
  assert.equal(normalizeKey("ctrl+k  ctrl+s"), "ctrl+k ctrl+s");
  assert.equal(normalizeKey("Space"), "space");
  assert.equal(normalizeKey("NumPad8"), "numpad8");
  for (const bad of ["", "ctrl+", "hyper+a", "ctrl+foo", "a b c", 5, null]) assert.equal(normalizeKey(bad), null, String(bad));
});

test("a key event's chord: Cmd is Ctrl, the number pad's digits, the arrows, WebKitGTK's unnamed keys, modifiers alone none", () => {
  assert.equal(eventChord(ev("P", { ctrlKey: true, shiftKey: true })), "ctrl+shift+p");
  assert.equal(eventChord(ev("V")), "v", "caps lock");
  assert.equal(eventChord(ev("d", { metaKey: true })), "ctrl+d");
  assert.equal(eventChord(ev("8", { code: "Numpad8" })), "numpad8");
  assert.equal(eventChord(ev("8", { code: "Digit8" })), "8");
  assert.equal(eventChord(ev("ArrowUp", { code: "Numpad8" })), "up", "Num Lock off");
  assert.equal(eventChord(ev("+", { code: "NumpadAdd", shiftKey: true })), "+");
  assert.equal(eventChord(ev(" ", { code: "Space" })), "space");
  assert.equal(eventChord(ev("Unidentified", { code: "Tab", ctrlKey: true, shiftKey: true })), "ctrl+shift+tab");
  assert.equal(eventChord(ev("Unidentified", { code: "NumpadAdd", ctrlKey: true, altKey: true })), "ctrl+alt++");
  assert.equal(eventChord(ev("Control", { code: "ControlLeft", ctrlKey: true })), null);
  assert.equal(eventChord(ev("Unidentified", { code: "ShiftLeft", shiftKey: true })), null);
  // What a key event gives is what the bindings write.
  for (const spec of ["ctrl+shift+p", "f5", "ctrl+,", "ctrl+alt++", "pageup", "shift+home"]) {
    const k = normalizeKey(spec)!;
    assert.equal(normalizeKey(k), k, spec);
  }
});

test("keys read as people write them", () => {
  assert.equal(keyLabel("ctrl+k ctrl+s"), "Ctrl+K Ctrl+S");
  assert.equal(keyLabel("ctrl+alt++"), "Ctrl+Alt++");
  assert.equal(keyLabel("shift+pageup"), "Shift+Page Up");
  assert.equal(keyLabel("numpad8"), "NumPad 8");
  assert.equal(keyLabel("f5"), "F5");
  assert.equal(keyLabel("ctrl+,"), "Ctrl+,");
});

test("when: keys, !, &&, ||, ==, != and brackets; mistakes are told", () => {
  const ctx = { terrainFocus: true, project: true, inputFocus: false, activeEditor: "w3.terrainViewer" };
  const yes = (s: string) => evalWhen(parseWhen(s), ctx);
  assert.equal(yes("terrainFocus"), true);
  assert.equal(yes("!terrainFocus"), false);
  assert.equal(yes("terrainFocus && !inputFocus"), true);
  assert.equal(yes("inputFocus || project"), true);
  assert.equal(yes("!(terrainFocus && project)"), false);
  assert.equal(yes("activeEditor == 'w3.terrainViewer'"), true);
  assert.equal(yes("activeEditor != w3.terrainViewer"), false);
  assert.equal(yes("unknownKey"), false);
  for (const bad of ["", "a &&", "(a", "a == ", "&& b", "a b"]) assert.throws(() => parseWhen(bad), Error, bad);
});

const defaults: Binding[] = [
  { key: "ctrl+r", command: "workbench.reload", source: "default", extensionId: "core" },
  { key: "ctrl+s", command: "workbench.save", source: "default", extensionId: "core" },
  { key: "ctrl+k ctrl+s", command: "w3.keybindings.open", source: "default" },
  { key: "ctrl+r", command: "w3.terrain.toggleRegions", when: "terrainFocus", source: "default" },
  { key: "h", command: "w3.terrain.toggleBlight", when: "terrainFocus", source: "default" },
  { key: "h", command: "w3.terrain.selection.mirrorX", when: "terrainFocus", source: "default" },
];

test("the last binding whose when holds wins; a view's own binding stays with the view", () => {
  const inView = { terrainFocus: true }, elsewhere = {};
  const r1 = resolve(defaults, ["ctrl+r"], inView);
  assert.ok(r1 && "binding" in r1 && r1.binding.command === "w3.terrain.toggleRegions");
  assert.equal(isViewBinding((r1 as { binding: Binding }).binding, new Set(["terrainFocus"])), true, "the workbench leaves it to the view");
  const r2 = resolve(defaults, ["ctrl+r"], elsewhere);
  assert.ok(r2 && "binding" in r2 && r2.binding.command === "workbench.reload", "elsewhere Ctrl+R reloads");
  assert.equal(isViewBinding({ when: "terrainFocus" }, new Set()), false, "with no view's context, it's no view's");
  assert.equal(isViewBinding({}, new Set(["terrainFocus"])), false);
  assert.equal(resolve(defaults, ["q"], inView), null);
  // Every command a key has where it applies, the winner first: the view keeps its own order.
  assert.deepEqual(commandsFor(defaults, "h", inView), ["w3.terrain.selection.mirrorX", "w3.terrain.toggleBlight"]);
  assert.deepEqual(commandsFor(defaults, "h", elsewhere), []);
});

test("two chords: the first waits for the second, the pair runs its command", () => {
  const first = resolve(defaults, ["ctrl+k"], {});
  assert.deepEqual(first, { pending: true });
  const both = resolve(defaults, ["ctrl+k", "ctrl+s"], {});
  assert.ok(both && "binding" in both && both.binding.command === "w3.keybindings.open");
  assert.equal(resolve(defaults, ["ctrl+k", "x"], {}), null);
  // A chord that starts a longer key waits even if it has a binding of its own (as in VS Code).
  const withOwn = [...defaults, { key: "ctrl+k", command: "x", source: "default" as const }];
  assert.deepEqual(resolve(withOwn, ["ctrl+k"], {}), { pending: true });
});

test("the user's rules: their own come after the defaults, a removal takes a default away", () => {
  const { rules, ignored } = userRules([
    { key: "g", command: "w3.terrain.toggleBlight", when: "terrainFocus" },
    { key: "h", command: "-w3.terrain.toggleBlight", when: "terrainFocus" },
    { key: "ctrl+r", command: "-workbench.reload" },
    { command: "-w3.keybindings.open" },
    "not a rule", { key: "nonsense+x", command: "a" }, { key: "x" }, { key: "y", command: "b", when: "a &&" }, { key: "z", command: "c", when: 3 },
  ]);
  assert.equal(rules.length, 4);
  assert.equal(ignored.length, 5, ignored.join("; "));
  const all = effectiveBindings(defaults, rules);
  assert.deepEqual(commandsFor(all, "h", { terrainFocus: true }), ["w3.terrain.selection.mirrorX"], "H no longer toggles blight");
  assert.deepEqual(commandsFor(all, "g", { terrainFocus: true }), ["w3.terrain.toggleBlight"]);
  const r = resolve(all, ["ctrl+r"], {});
  assert.equal(r, null, "Ctrl+R reloads no more");
  assert.equal(resolve(all, ["ctrl+k"], {}), null, "a removal without a key takes all the command's keys");
  assert.equal(all.find((b) => b.command === "w3.terrain.toggleBlight")?.source, "user");
  // A removal for another when leaves the default alone.
  const other = effectiveBindings(defaults, userRules([{ key: "h", command: "-w3.terrain.toggleBlight", when: "inputFocus" }]).rules);
  assert.ok(other.some((b) => b.command === "w3.terrain.toggleBlight"));
});

test("conflicts: the other bindings with the same key; the menu shows the user's key first", () => {
  assert.deepEqual(conflictsOf(defaults, defaults[4]).map((b) => b.command), ["w3.terrain.selection.mirrorX"]);
  assert.deepEqual(conflictsOf(defaults, defaults[1]), []);
  const all = effectiveBindings(defaults, [{ key: "ctrl+alt+s", command: "workbench.save" }]);
  assert.equal(primaryKey(all, "workbench.save"), "ctrl+alt+s");
  assert.equal(primaryKey(defaults, "workbench.save"), "ctrl+s");
  assert.equal(primaryKey(defaults, "nothing"), undefined);
});

test("edits: a default's key changed is removed and bound anew; a user's changes in place; reset takes the user's rules away", () => {
  const blight = defaults[4];
  let raw: unknown[] = [{ key: "f9", command: "other", comment: "kept as it is" }, "junk"];
  raw = changeKey(raw, blight, "j");
  assert.deepEqual(raw.slice(2), [{ key: "h", command: "-w3.terrain.toggleBlight", when: "terrainFocus" }, { key: "j", command: "w3.terrain.toggleBlight", when: "terrainFocus" }]);
  let all = effectiveBindings(defaults, userRules(raw).rules);
  const mine = all.find((b) => b.command === "w3.terrain.toggleBlight")!;
  assert.equal(mine.key, "j");
  raw = changeKey(raw, mine, "k");
  assert.equal(raw.length, 4, "changed in place");
  all = effectiveBindings(defaults, userRules(raw).rules);
  raw = changeWhen(raw, all.find((b) => b.command === "w3.terrain.toggleBlight")!, "");
  assert.deepEqual(raw[3], { key: "k", command: "w3.terrain.toggleBlight" });
  raw = removeBinding(raw, effectiveBindings(defaults, userRules(raw).rules).find((b) => b.command === "w3.terrain.toggleBlight")!);
  assert.equal(raw.length, 3);
  raw = removeBinding(raw, defaults[1]);
  assert.deepEqual(raw[3], { key: "ctrl+s", command: "-workbench.save" });
  raw = addKey(raw, "w3.terrain.toggleBlight", "u", "terrainFocus");
  raw = resetCommand(raw, "w3.terrain.toggleBlight");
  assert.deepEqual(raw, [{ key: "f9", command: "other", comment: "kept as it is" }, "junk", { key: "ctrl+s", command: "-workbench.save" }], "entries it didn't touch stay as they were");
});

test("keybindings.json's text: empty is no rules, a byte order mark is fine, not JSON or not a list is a problem", () => {
  assert.deepEqual(parseKeybindingsFile(""), { raw: [], problem: null });
  assert.deepEqual(parseKeybindingsFile("﻿[]"), { raw: [], problem: null });
  assert.match(parseKeybindingsFile("[{").problem ?? "", /isn't valid JSON/);
  assert.match(parseKeybindingsFile("{}").problem ?? "", /JSON array/);
});

test("the element a key went to: its view's context keys, a typing field, a field that takes every key", () => {
  const el = (tag: string, attrs: Record<string, string> = {}, type?: string) => ({
    tagName: tag, type, isContentEditable: false, getAttribute: (n: string) => attrs[n] ?? null,
    closest: (s: string) => (s === "[data-key-context]" && attrs["data-key-context"] !== undefined) || (s === "[data-all-keys]" && attrs["data-all-keys"] !== undefined) ? el(tag, attrs, type) : null,
  });
  assert.deepEqual([...targetContext(el("CANVAS", { "data-key-context": "terrainFocus" }) as unknown as EventTarget).own], ["terrainFocus"]);
  assert.equal(targetContext(el("INPUT", {}, "text") as unknown as EventTarget).inputFocus, true);
  assert.equal(targetContext(el("INPUT", {}, "checkbox") as unknown as EventTarget).inputFocus, false);
  assert.equal(targetContext(el("INPUT", { "data-all-keys": "" }, "text") as unknown as EventTarget).allKeys, true);
  assert.deepEqual(targetContext(null), { own: new Set(), inputFocus: false, allKeys: false });
  assert.equal(targetContext({} as EventTarget).inputFocus, false, "the window");
});

test("the context keys of every element around the target count: the terrain canvas in an editor with undo keys", () => {
  type El = { tagName: string; attrs: Record<string, string>; parentElement: El | null; getAttribute(n: string): string | null; closest(s: string): El | null };
  const node = (tag: string, attrs: Record<string, string>, parent: El | null): El => {
    const me: El = {
      tagName: tag, attrs, parentElement: parent,
      getAttribute: (n) => attrs[n] ?? null,
      closest: (s) => {
        for (let at: El | null = me; at; at = at.parentElement) if (s === "[data-key-context]" && at.attrs["data-key-context"] !== undefined) return at;
        return null;
      },
    };
    return me;
  };
  const editor = node("DIV", { "data-key-context": "undoKeys" }, node("BODY", {}, null));
  const canvas = node("CANVAS", { "data-key-context": "terrainFocus" }, node("DIV", {}, editor));
  assert.deepEqual([...targetContext(canvas as unknown as EventTarget).own].sort(), ["terrainFocus", "undoKeys"]);
  assert.deepEqual([...targetContext(node("BUTTON", {}, editor) as unknown as EventTarget).own], ["undoKeys"]);
});

test("mouse keys: the World Editor's buttons and wheel, written one way, read from events, a key of their own", () => {
  assert.equal(normalizeKey("Alt+LeftButton"), "alt+leftbutton");
  assert.equal(normalizeKey("shift+ctrl+rightbutton"), "ctrl+shift+rightbutton");
  assert.equal(normalizeKey("wheelup"), "wheelup");
  assert.equal(normalizeKey("ctrl+k leftbutton"), null, "no second chord with the mouse");
  assert.equal(normalizeKey("middlebutton ctrl+s"), null);
  assert.equal(keyLabel("ctrl+middlebutton"), "Ctrl+Middle Button");
  assert.equal(keyLabel("wheeldown"), "Wheel Down");
  assert.equal(isMouseKey("alt+leftbutton"), true);
  assert.equal(isMouseKey("ctrl+l"), false);
  const m = (button: number, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) =>
    ({ type: "mousedown", button, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(mouseChord(m(0)), "leftbutton");
  assert.equal(mouseChord(m(1, { ctrlKey: true })), "ctrl+middlebutton");
  assert.equal(mouseChord(m(2, { metaKey: true, shiftKey: true })), "ctrl+shift+rightbutton", "Cmd counts as Ctrl");
  assert.equal(mouseChord(m(3)), null, "back and forward aren't keys");
  // A wheel event is a mouse event with button 0: its type tells.
  const w = (deltaY: number, mods = {}) => ({ type: "wheel", button: 0, deltaY, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(mouseChord(w(100)), "wheeldown");
  assert.equal(mouseChord(w(-3, { altKey: true })), "alt+wheelup");
  assert.equal(mouseChord(w(0)), null, "sideways only");
});

test("a mouse button matches the bindings whose modifiers it holds, those naming most first, then the later", () => {
  const bindings = defaultBindings([], [
    { key: "middlebutton", command: "pan", when: "view" },
    { key: "rightbutton", command: "turn", when: "view" },
    { key: "ctrl+leftbutton", command: "face", when: "view" },
    { key: "alt+leftbutton", command: "move", when: "view" },
    { key: "wheelup", command: "zoomIn", when: "view" },
    { key: "g", command: "grid", when: "view" },
  ]);
  const ctx = { view: true };
  assert.deepEqual(mouseCommandsFor(bindings, "middlebutton", ctx), ["pan"]);
  assert.deepEqual(mouseCommandsFor(bindings, "ctrl+shift+middlebutton", ctx), ["pan"], "more modifiers held still pan");
  assert.deepEqual(mouseCommandsFor(bindings, "ctrl+alt+leftbutton", ctx), ["move", "face"], "a tie: the later binding first");
  assert.deepEqual(mouseCommandsFor(bindings, "shift+leftbutton", ctx), [], "nothing is bound to the left button alone");
  assert.deepEqual(mouseCommandsFor(bindings, "ctrl+wheelup", ctx), ["zoomIn"]);
  assert.deepEqual(mouseCommandsFor(bindings, "middlebutton", {}), [], "when");
  assert.deepEqual(mouseCommandsFor(bindings, "g", ctx), [], "keys aren't the mouse's");
  // The user's own binding naming more modifiers comes first; one of the button alone still matches after it.
  const mine = effectiveBindings(bindings, [{ key: "shift+middlebutton", command: "grid", when: "view" }]);
  assert.deepEqual(mouseCommandsFor(mine, "ctrl+shift+middlebutton", ctx), ["grid", "pan"]);
  // Taken away, a default matches nothing.
  assert.deepEqual(mouseCommandsFor(effectiveBindings(bindings, [{ key: "rightbutton", command: "-turn" }]), "rightbutton", ctx), []);
});

test("undo and redo: the editors' keys are the Edit commands' bindings under undoKeys, left to the editor", () => {
  const bindings = defaultBindings([], UNDO_BINDINGS);
  const step = (e: ReturnType<typeof ev>, ctx: Record<string, unknown> = { [UNDO_CONTEXT]: true }) => {
    const c = eventChord(e);
    return c ? undoStepOf(commandsFor(bindings, c, ctx)) : null;
  };
  assert.equal(step(ev("z", { ctrlKey: true })), "undo");
  assert.equal(step(ev("Z", { ctrlKey: true, shiftKey: true })), "redo");
  assert.equal(step(ev("y", { ctrlKey: true })), "redo");
  assert.equal(step(ev("z", { metaKey: true })), "undo", "Cmd counts as Ctrl");
  assert.equal(step(ev("z")), null);
  assert.equal(step(ev("z", { ctrlKey: true }), {}), null, "outside an editor with undo keys");
  // The workbench leaves them to the editor: a view binding where the element says undoKeys.
  const r = resolve(bindings, ["ctrl+z"], { [UNDO_CONTEXT]: true });
  assert.ok(r && "binding" in r && isViewBinding(r.binding, new Set([UNDO_CONTEXT])));
  // Rebound by the user, the new key undoes and the old one doesn't.
  const mine = effectiveBindings(bindings, [{ key: "ctrl+z", command: "-workbench.undo" }, { key: "ctrl+u", command: "workbench.undo", when: UNDO_CONTEXT }]);
  assert.equal(undoStepOf(commandsFor(mine, "ctrl+u", { [UNDO_CONTEXT]: true })), "undo");
  assert.equal(undoStepOf(commandsFor(mine, "ctrl+z", { [UNDO_CONTEXT]: true })), null);
});

test("every default key of the built-in manifests can be read, and its command is declared", () => {
  type Manifest = { contributes?: { commands?: { id: string; keybinding?: string }[]; keybindings?: { key: string; command: string; when?: string }[] } };
  const manifests = readdirSync("src/builtin", { withFileTypes: true }).filter((d) => d.isDirectory())
    .map((d) => JSON.parse(readFileSync(`src/builtin/${d.name}/extension.json`, "utf8")) as Manifest);
  const ids = new Set(manifests.flatMap((m) => m.contributes?.commands ?? []).map((c) => c.id));
  for (const c of manifests.flatMap((m) => m.contributes?.commands ?? [])) if (c.keybinding) assert.ok(normalizeKey(c.keybinding), `${c.id}: ${c.keybinding}`);
  const rules = manifests.flatMap((m) => m.contributes?.keybindings ?? []);
  assert.ok(rules.length > 100, "the terrain view's keys");
  for (const k of rules) {
    assert.ok(normalizeKey(k.key), `${k.key} isn't a key`);
    assert.ok(ids.has(k.command), `${k.command} isn't declared`);
    assert.equal(k.when, "terrainFocus", `${k.key} ${k.command} applies in the terrain view only`);
  }
  assert.equal(defaultBindings([], rules).length, rules.length);
});

// ---- the file ------------------------------------------------------------------------------------------------------

const FILE = "/home/u/.config/w3proj/keybindings.json";
function disk() {
  const files = new Map<string, string>();
  const locked = new Set<string>();
  const writes: string[] = [];
  let gate: Promise<void> | null = null, readGate: Promise<void> | null = null;
  const io = {
    readText: async (p: string) => {
      if (locked.has(p)) throw new Error(`${p}: Permission denied (os error 13)`);
      if (!files.has(p)) throw new Error(`${p}: No such file or directory (os error 2)`);
      // What is there when the read starts, handed back when the read is let through.
      const text = files.get(p)!;
      if (readGate) await readGate;
      return text;
    },
    writeText: async (p: string, t: string) => { if (gate) await gate; writes.push(t); files.set(p, t); },
    exists: async (p: string) => files.has(p) || locked.has(p),
  };
  return { files, locked, writes, io, hold: (p: Promise<void> | null) => { gate = p; }, holdReads: (p: Promise<void> | null) => { readGate = p; } };
}
const commands = { contributions: () => [{ id: "workbench.save", title: "Save", keybinding: "ctrl+s" }, { id: "a", title: "A" }] };

test("no keybindings.json yet: no keys of the user's, no problem, and the first change makes it", async () => {
  const d = disk();
  const s = new KeybindingService(commands, d.io);
  const warned: string[] = [];
  s.warn = (m) => warned.push(m);
  await s.load(FILE);
  assert.equal(s.fileProblem(), null);
  assert.deepEqual(warned, []);
  await s.addKey("a", "ctrl+alt+a");
  assert.deepEqual(JSON.parse(d.files.get(FILE)!), [{ key: "ctrl+alt+a", command: "a" }]);
  assert.equal(resolve(s.bindings(), ["ctrl+alt+a"], {}) && "binding" in resolve(s.bindings(), ["ctrl+alt+a"], {})!, true);
  await assert.rejects(s.addKey("a", "nonsense+q"), /isn't a key/);
});

test("a keybindings.json that is there but can't be used is never written over, and the user is told", async () => {
  for (const setup of [(d: ReturnType<typeof disk>) => d.files.set(FILE, "[{ broken"), (d: ReturnType<typeof disk>) => d.files.set(FILE, "{}"), (d: ReturnType<typeof disk>) => d.locked.add(FILE)]) {
    const d = disk();
    setup(d);
    const before = d.files.get(FILE);
    const s = new KeybindingService(commands, d.io);
    const warned: string[] = [];
    s.warn = (m) => warned.push(m);
    await s.load(FILE);
    assert.ok(s.fileProblem());
    assert.equal(warned.length, 1);
    assert.match(warned[0], /is there, but/);
    await assert.rejects(s.addKey("a", "ctrl+alt+a"), /is there, but/);
    await assert.rejects(s.reset("workbench.save"), /is there, but/);
    assert.equal(d.files.get(FILE), before, "the file is as it was");
    assert.deepEqual(d.writes, []);
    assert.equal(primaryKey(s.bindings(), "workbench.save"), "ctrl+s", "the defaults still work");
  }
});

test("a file broken after it was read is found broken before writing, not written over", async () => {
  const d = disk();
  d.files.set(FILE, "[]");
  const s = new KeybindingService(commands, d.io);
  s.warn = () => {};
  await s.load(FILE);
  d.files.set(FILE, "[{ half written");
  await assert.rejects(s.addKey("a", "ctrl+alt+a"));
  assert.equal(d.files.get(FILE), "[{ half written");
});

test("changes go one after the other onto the file as it is, keeping what another program wrote meanwhile", async () => {
  const d = disk();
  d.files.set(FILE, "[]");
  const s = new KeybindingService(commands, d.io);
  let changes = 0;
  s.onDidChange(() => changes++);
  await s.load(FILE);
  // Written by hand meanwhile.
  d.files.set(FILE, JSON.stringify([{ key: "f2", command: "a" }]));
  let release!: () => void;
  d.hold(new Promise<void>((r) => { release = r; }));
  const one = s.addKey("a", "ctrl+1");
  const two = s.addKey("a", "ctrl+2");
  // A load asked for while the first write waits comes after it, not before.
  const reload = s.load(FILE);
  release();
  d.hold(null);
  await Promise.all([one, two, reload]);
  assert.deepEqual(JSON.parse(d.files.get(FILE)!).map((r: { key: string }) => r.key), ["f2", "ctrl+1", "ctrl+2"]);
  assert.deepEqual(s.userRules().map((r) => r.key), ["f2", "ctrl+1", "ctrl+2"], "memory is what's on disk");
  assert.ok(changes >= 3);
});

test("a read asked for while a change is being written starts after it: it can't bring the old keys back", async () => {
  const d = disk();
  d.files.set(FILE, "[]");
  const s = new KeybindingService(commands, d.io);
  await s.load(FILE);
  let releaseWrite!: () => void, releaseRead!: () => void;
  d.hold(new Promise<void>((r) => { releaseWrite = r; }));
  const write = s.addKey("a", "ctrl+1");
  await new Promise((r) => setTimeout(r, 0)); // its read is done, its write waits
  d.holdReads(new Promise<void>((r) => { releaseRead = r; }));
  const load = s.load(FILE); // saved as JSON in the app meanwhile, say
  await new Promise((r) => setTimeout(r, 0));
  releaseWrite();
  await write;
  releaseRead();
  d.holdReads(null);
  await load;
  assert.deepEqual(s.userRules().map((r) => r.key), ["ctrl+1"]);
});

test("edited outside the app: the keys apply when the window comes back; unchanged, nothing happens", async () => {
  const d = disk();
  d.files.set(FILE, "[]");
  const s = new KeybindingService(commands, d.io);
  await s.load(FILE);
  let changes = 0;
  s.onDidChange(() => changes++);
  await s.reloadIfChanged();
  assert.equal(changes, 0);
  d.files.set(FILE, JSON.stringify([{ key: "ctrl+s", command: "-workbench.save" }]));
  await s.reloadIfChanged();
  assert.equal(changes, 1);
  assert.equal(primaryKey(s.bindings(), "workbench.save"), undefined);
  // Every command is listed, with what the user touched.
  const items = s.items();
  assert.deepEqual(items.map((i) => i.command), ["workbench.save", "a"]);
  assert.equal(items[0].userTouched, true);
  assert.deepEqual(items[0].bindings, []);
});
