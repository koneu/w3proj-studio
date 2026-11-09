import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandService, ownsChord } from "./commands";
import { OWN_CHORDS } from "../builtin/terrain-viewer/viewmodes";

test("a chord WebKitGTK gives as key Unidentified is read from the physical key", () => {
  const ev = (key: string, code: string, shift: boolean) => ({ key, code, ctrlKey: true, metaKey: false, altKey: false, shiftKey: shift }) as KeyboardEvent;
  assert.equal(CommandService.chord(ev("Unidentified", "Tab", true)), "ctrl+shift+tab");
  assert.equal(CommandService.chord(ev("Unidentified", "KeyZ", true)), "ctrl+shift+z");
  // Control: a key the webview names stays its own.
  assert.equal(CommandService.chord(ev("Tab", "Tab", false)), "ctrl+tab");
  assert.equal(CommandService.chord(ev("P", "KeyP", true)), "ctrl+shift+p");
});

test("the terrain view's Ctrl View keys are kept from the workbench while it has the keyboard, as the workbench writes them", () => {
  // Written as the workbench's own chord of the key event, else it wouldn't let them through.
  const ev = (k: string, ctrl: boolean, shift: boolean) => ({ key: k, ctrlKey: ctrl, metaKey: false, altKey: false, shiftKey: shift }) as KeyboardEvent;
  assert.ok(OWN_CHORDS.includes(CommandService.chord(ev("r", true, false))));
  assert.ok(OWN_CHORDS.includes(CommandService.chord(ev("L", true, true))));
  assert.ok(!OWN_CHORDS.includes(CommandService.chord(ev("s", true, false))), "Ctrl+S still saves");
  assert.ok(!OWN_CHORDS.includes(CommandService.chord(ev("v", false, false))), "plain keys aren't bound in the workbench");
  // What the canvas says, through the workbench's test.
  const canvas = { dataset: { ownKeys: OWN_CHORDS.join(" ") } };
  const inView = { closest: (s: string) => (s === "[data-own-keys]" ? canvas : null) };
  assert.equal(ownsChord(inView as unknown as EventTarget, "ctrl+r"), true);
  assert.equal(ownsChord(inView as unknown as EventTarget, "ctrl+s"), false);
  assert.equal(ownsChord({ closest: () => null } as unknown as EventTarget, "ctrl+r"), false, "elsewhere Ctrl+R is the workbench's");
  assert.equal(ownsChord(null, "ctrl+r"), false);
  assert.equal(ownsChord({} as EventTarget, "ctrl+r"), false, "a target that isn't an element (the window)");
});
