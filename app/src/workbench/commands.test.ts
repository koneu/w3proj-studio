import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CommandService } from "./commands";
import { defaultBindings, isViewBinding, resolve, targetContext } from "../lib/keybindings";

test("a chord WebKitGTK gives as key Unidentified is read from the physical key", () => {
  const ev = (key: string, code: string, shift: boolean) => ({ key, code, ctrlKey: true, metaKey: false, altKey: false, shiftKey: shift }) as KeyboardEvent;
  assert.equal(CommandService.chord(ev("Unidentified", "Tab", true)), "ctrl+shift+tab");
  assert.equal(CommandService.chord(ev("Unidentified", "KeyZ", true)), "ctrl+shift+z");
  // Control: a key the webview names stays its own.
  assert.equal(CommandService.chord(ev("Tab", "Tab", false)), "ctrl+tab");
  assert.equal(CommandService.chord(ev("P", "KeyP", true)), "ctrl+shift+p");
});

test("the terrain view's keys stay with it while it has the keyboard; elsewhere Ctrl+R is the workbench's", () => {
  // The workbench's own Ctrl+R and Ctrl+S, then the terrain viewer's bindings, as the workbench has them.
  const svc = new CommandService();
  svc.contribute("core", { id: "workbench.reload", title: "Reload Window", keybinding: "ctrl+r" });
  svc.contribute("core", { id: "workbench.save", title: "Save", keybinding: "ctrl+s" });
  const manifest = JSON.parse(readFileSync("src/builtin/terrain-viewer/extension.json", "utf8")) as { contributes: { keybindings: { key: string; command: string; when?: string }[] } };
  const bindings = defaultBindings(svc.contributions(), manifest.contributes.keybindings);
  // The canvas says whose keys they are; the workbench asks the element the key went to.
  const canvas = { tagName: "CANVAS", getAttribute: (n: string) => (n === "data-key-context" ? "terrainFocus" : null), closest: (s: string) => (s === "[data-key-context]" ? canvas : null) };
  const inView = targetContext(canvas as unknown as EventTarget);
  const ctx = Object.fromEntries([...inView.own].map((k) => [k, true]));
  const ctrlR = resolve(bindings, ["ctrl+r"], ctx);
  assert.ok(ctrlR && "binding" in ctrlR && ctrlR.binding.command === "w3.terrain.toggleRegions");
  assert.equal(isViewBinding(ctrlR.binding, inView.own), true, "left to the view, not reloading the window");
  const ctrlS = resolve(bindings, ["ctrl+s"], ctx);
  assert.ok(ctrlS && "binding" in ctrlS && ctrlS.binding.command === "workbench.save" && !isViewBinding(ctrlS.binding, inView.own), "Ctrl+S still saves");
  const v = resolve(bindings, ["v"], ctx);
  assert.ok(v && "binding" in v && isViewBinding(v.binding, inView.own), "plain keys are the view's");
  // Elsewhere: no view's context.
  const out = targetContext({ closest: () => null } as unknown as EventTarget);
  const away = resolve(bindings, ["ctrl+r"], {});
  assert.ok(away && "binding" in away && away.binding.command === "workbench.reload" && !isViewBinding(away.binding, out.own));
  assert.equal(resolve(bindings, ["v"], {}), null, "plain keys aren't bound in the workbench");
});
