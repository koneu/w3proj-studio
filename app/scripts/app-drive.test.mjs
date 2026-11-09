// The parts of app-drive.mjs that don't need the app: what --eval sends to the page, --view-size, and the World
// Editor's camera for --camera we. The page is stood in for by node's vm, which evaluates as the page does: the
// text as a script (its completion value), a promise awaited.

import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { cameraOf, evalSource, isWeCamera, parseViewSize } from "./app-drive.mjs";
import { parseChord } from "./cdp.mjs";

/** As the page answers: the script's value, awaited. */
const page = async (source) => await runInNewContext(source, { Promise, setTimeout });

test("--eval: expressions, statements, `return` with and without `await`", async () => {
  assert.equal(await page(evalSource("1 + 2")), 3);
  assert.equal(await page(evalSource("const a = 2; a * 4")), 8, "statements give their last value");
  assert.equal(await page(evalSource("const a = 2; return a * 3")), 6, "statements that return, without await");
  assert.equal(await page(evalSource("if (true) { return 'yes' } return 'no'")), "yes");
  assert.equal(await page(evalSource("await Promise.resolve(4)")), 4, "an expression with await");
  assert.equal(await page(evalSource("await (async () => 5)()")), 5, "await before a parenthesis isn't a call of a function named await");
  assert.equal(await page(evalSource("const x = await Promise.resolve(7); return x")), 7, "statements with await that return");
  assert.equal(await page(evalSource("Promise.resolve(9)")), 9, "a promise is awaited");
  assert.equal(await page(evalSource("1 + 1 // a comment at the end")), 2);
  assert.equal(await page(evalSource("await Promise.resolve(1) // a comment at the end")), 1);
  assert.equal(evalSource("return )"), "return )", "a syntax error goes to the page as it is, which reports it");
});

test("--view-size takes WxH in pixels or off", () => {
  assert.deepEqual(parseViewSize("1184x844"), { width: 1184, height: 844 });
  assert.equal(parseViewSize("off"), null);
  for (const bad of ["1184", "1184x", "x844", "8x8", "1184X844", "-5x10"]) assert.throws(() => parseViewSize(bad), /WxH/, bad);
});

test("--camera we is the World Editor's opening view at the terrain's centre; we:… a look", () => {
  const head = { width: 5, height: 3, offsetX: -128, offsetY: -64 };
  const deg = (r) => Math.round((r * 180) / Math.PI * 1000) / 1000;
  const c = cameraOf("we", head);
  assert.deepEqual([c.x, c.y, c.distance, deg(c.pitch), deg(c.yaw), deg(c.fov)], [128, 64 - 298, 2738, 57.2, -90, 41.06]);
  const look = cameraOf("we:1000,500,1500", head);
  assert.deepEqual([look.x, look.y, look.distance], [1000, 351, 1369]);
  assert.equal(cameraOf("we:center,1500", head).y, 64 - 149);
  assert.ok(isWeCamera("we") && isWeCamera("we:1,2") && !isWeCamera("west") && !isWeCamera("game"));
  assert.throws(() => cameraOf("we"), /needs the terrain/);
  assert.throws(() => cameraOf("we:1,2,3000,300", head), /only angle of attack 304/);
  assert.equal(deg(cameraOf("game").pitch), 56, "the other presets stay");
});

test("--key: a chord as a person names it, as DevTools' key event takes it (cdp.mjs parseChord)", () => {
  assert.deepEqual(parseChord("Ctrl+Shift+Z"), { key: "Z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 10 });
  assert.deepEqual(parseChord("z"), { key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 0 });
  assert.deepEqual(parseChord("Shift+Tab"), { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 });
  assert.deepEqual(parseChord("Ctrl+Alt+F5"), { key: "F5", code: "F5", windowsVirtualKeyCode: 116, modifiers: 3 });
  assert.deepEqual(parseChord("Ctrl+Alt+NumpadAdd"), { key: "+", code: "NumpadAdd", windowsVirtualKeyCode: 107, modifiers: 3 });
  assert.deepEqual(parseChord("Ctrl++"), parseChord("Ctrl+Plus"));
  assert.deepEqual(parseChord("Space"), { key: " ", code: "Space", windowsVirtualKeyCode: 32, modifiers: 0 });
  assert.deepEqual(parseChord("Alt"), { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, modifiers: 0 });
  assert.deepEqual(parseChord("["), { key: "[", code: "BracketLeft", windowsVirtualKeyCode: 219, modifiers: 0 });
  assert.equal(parseChord("Numpad7").key, "7");
  assert.throws(() => parseChord("Hyper+A"), /isn't a modifier/);
  assert.throws(() => parseChord("Ctrl+Banana"), /no key named/);
});
