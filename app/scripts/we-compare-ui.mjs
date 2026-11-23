// we-compare's Studio step "ui": the terrain view's brushes driven by the real mouse, at the same screen positions as
// the World Editor's own steps (we-drive's --click / --drag take positions of its 1600x1000 display; the editor's
// terrain view starts at 156,79 and is 1184x844, which the "view" action gives Studio's view too).
//
//   { "ui": [ ["view", "we"], ["tool", "Paint:"], ["texture", "Lgrs"], ["size", 2], ["click", 748, 500], ["drag", 600, 500, 900, 500] ] }
//
// Actions: tab NAME (the terrain editor's tab, "Terrain"); view SPEC (the terrain view at the editor's size, the camera "we" or "we:X,Y[,distance…]" as app-drive's
// --camera); tool PREFIX (the toolbar button whose title starts so: "Paint:", "−2:"); texture TILE (a ground tile in the
// painter's options); cliff NAME (the Cliff type choice whose text starts so: "Dirt"); shape round|square (the brush shape); size N (the brush size slider, within its range); key KEY [CODE] (pressed on the view's canvas: "d" is code KeyD, "Numpad6" key 6 code Numpad6); clickGround X,Y[,Z] (a world point where Studio's camera shows it); click X,Y and drag X,Y,X2,Y2[,MS] (the left button, at editor positions inside its view; MS the drag's time, 20 moves, else 30 ms a move); dragMod alt|shift|ctrl (held during the next drag, as we-drive's --drag-mod);
// sleep MS. Needs window.__driveEd (the "terrain" step). Positions and tool names are those of the page, not a copy.

import { Hands, sleep } from "./cdp.mjs";
import { cameraOf } from "./app-drive.mjs";
import { checkUiActions, uiKey } from "./we-compare-core.mjs";
import { lit } from "./jslit.mjs";

/** The terrain view at the World Editor's view size, looking as the editor does for `spec`. */
async function view(page, spec) {
  await page.evaluate(`(async () => {
    const stage = window.__driveEd.host.querySelector(".model-stage");
    const r = devicePixelRatio;
    Object.assign(stage.style, { position: "fixed", left: "0", top: "0", flex: "none", zIndex: "10000", width: 1184 / r + "px", height: 844 / r + "px" });
    // The editor's terrain view has no minimap on it (its minimap is a window of its own): Studio's, in the view's
    // lower left, would take the clicks the editor's view gives the ground there (a Level click at 300,800 painted
    // nothing, branch fix/level-stroke-we). Hidden for this editor; the panel's own hidden flag doesn't undo it.
    stage.querySelector(".terrain-minimap")?.style.setProperty("display", "none", "important");
    window.__driveEd.redraw();
    // Race two frames against a 300 ms fallback so a throttled/hidden window under Xvfb can never hang here.
    await Promise.race([
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      new Promise((r) => setTimeout(r, 300)),
    ]);
  })()`);
  const head = await page.evaluate(`(({ width, height, offsetX, offsetY }) => ({ width, height, offsetX, offsetY }))(window.__driveEd.terrain)`);
  const { x, y, ...v } = cameraOf(spec, head);
  await page.evaluate(`window.__driveEd.lookAt(${x}, ${y})`);
  await page.evaluate(`(() => { const t = window.__driveEd.view().target; window.__driveEd.setView({ target: t, ...${lit(v)} }); })()`);
  await page.evaluate(`w3Workbench.settled()`, { timeout: 120000 });
}

/** A position of the editor's display as one of the page (the view sits at 156,79 there, at 0,0 here). */
const at = (x, y) => ({ x: x - 156, y: y - 79 });

export async function uiStep(page, actions) {
  const hands = new Hands(page);
  const settled = () => page.evaluate(`w3Workbench.settled()`, { timeout: 120000 });
  // The kinds, the numbers, clicks and drags inside the editor's view (parseSpec checks the same before the run).
  checkUiActions(actions);
  // dragMod's key, held during the next drag only (DevTools' bits: 1 Alt, 2 Ctrl, 8 Shift).
  let dragModifiers = 0;
  /** Refuses a press that wouldn't reach the terrain view's canvas at `p` (something of Studio's on top of the view
   *  there): the editor's view would take it, so both sides would differ for a reason no spec is about. */
  const onView = async (p, what) => {
    const hit = await page.evaluate(`((x, y) => {
      const c = document.querySelector(".model-stage canvas"), e = document.elementFromPoint(x, y);
      if (!e || e === c) return null;
      return e.tagName.toLowerCase() + (typeof e.className === "string" ? e.className.split(" ").filter(Boolean).map((k) => "." + k).join("") : "");
    })(${p.x}, ${p.y})`);
    if (hit) throw new Error(`${what}: Studio's ${hit} covers the terrain view there, so the press wouldn't reach the ground`);
  };
  for (const [kind, ...a] of actions) {
    if (kind === "view") await view(page, a[0]);
    else if (kind === "tab") {
      await page.evaluate(`(() => { const b = [...document.querySelectorAll(".terrain-tab")].find((b) => b.textContent.trim() === ${lit(a[0])}); if (!b) throw new Error("no tab " + ${lit(a[0])}); b.click(); })()`);
      await settled();
    }
    else if (kind === "tool") await page.evaluate(`(() => { const b = [...document.querySelectorAll(".tool-button")].find((b) => b.title.startsWith(${lit(a[0])})); if (!b) throw new Error("no tool button " + ${lit(a[0])}); b.click(); })()`);
    else if (kind === "texture") await page.evaluate(`(() => { const b = document.querySelector('.terrain-tex-thumb[title*=${lit(a[0])}]'); if (!b) throw new Error("no tile " + ${lit(a[0])}); b.click(); })()`);
    else if (kind === "cliff") await page.evaluate(`(() => { const s = [...document.querySelectorAll(".painter-options select")].find((s) => s.closest("label")?.textContent.startsWith("Cliff type")); const o = s && [...s.options].find((o) => o.textContent.startsWith(${lit(a[0])})); if (!o) throw new Error("no cliff type " + ${lit(a[0])}); s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    else if (kind === "shape") await page.evaluate(`(() => { const s = [...document.querySelectorAll(".painter-options select")].find((s) => s.closest("label")?.textContent.startsWith("Shape")); const o = s && [...s.options].find((o) => o.value === ${lit(a[0])}); if (!o) throw new Error("no brush shape " + ${lit(a[0])}); s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    // The slider would clamp a size outside its range without a word: refused instead.
    else if (kind === "size") await page.evaluate(`(() => { const i = document.querySelector(".painter-options input[type=range]"); if (!i) throw new Error("no brush size slider"); const v = ${Number(a[0])}; if (v < Number(i.min) || v > Number(i.max)) throw new Error("brush size " + v + " is outside the slider's " + i.min + " to " + i.max); i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    else if (kind === "click") {
      const p = at(a[0], a[1]);
      await onView(p, `click ${a[0]},${a[1]}`);
      await hands.mouse("mouseMoved", p.x, p.y);
      await hands.mouse("mousePressed", p.x, p.y, 1);
      await hands.mouse("mouseReleased", p.x, p.y, 0);
      await settled();
    } else if (kind === "clickGround") {
      // The left button on the ground point (X, Y, 0), where Studio's own camera shows it (not where the editor's would).
      const p = await page.evaluate(`window.__driveEd.project([${Number(a[0])}, ${Number(a[1])}, ${Number(a[2] ?? 0)}])`);
      if (!p) throw new Error(`the ground point ${a.join(",")} is behind the camera`);
      const [x, y] = p.map(Math.round);
      if (!(x >= 0 && y >= 0 && x < 1184 && y < 844)) throw new Error(`the ground point ${a.join(",")} is at ${x},${y}, outside the view`);
      await onView({ x, y }, `clickGround ${a.join(",")}`);
      await hands.mouse("mouseMoved", x, y);
      await hands.mouse("mousePressed", x, y, 1);
      await hands.mouse("mouseReleased", x, y, 0);
      await settled();
    } else if (kind === "key") {
      // A key pressed on the terrain view's canvas: KeyboardEvent.key and .code as a real keyboard gives them
      // ("d" KeyD, "Numpad6" the key 6 with code Numpad6; a third element names the code itself: uiKey).
      const { key, code } = uiKey(a[0], a[1]);
      await page.evaluate(`(() => { const c = document.querySelector(".model-stage canvas"); c.focus(); for (const type of ["keydown", "keyup"]) c.dispatchEvent(new KeyboardEvent(type, { key: ${lit(key)}, code: ${lit(code)}, bubbles: true })); })()`);
      await settled();
    } else if (kind === "drag") {
      // a[4]: the drag's time (as the editor's --drag @MS): the painter re-applies a held brush at most every
      // HEIGHT_TICK (40 ms), so moves 30 ms apart drop some, and which ones (the stroke's end too) went by the timing.
      await onView(at(a[0], a[1]), `drag from ${a[0]},${a[1]}`);
      await hands.drag(at(a[0], a[1]), at(a[2], a[3]), 20, a[4] ? a[4] / 20 : 30, dragModifiers);
      dragModifiers = 0;
      await settled();
    } else if (kind === "dragMod") dragModifiers = { alt: 1, ctrl: 2, shift: 8 }[a[0]];
    else if (kind === "sleep") await sleep(a[0]);
    else throw new Error(`unknown ui action ${kind}`);
  }
}
