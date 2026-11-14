// we-compare's Studio step "ui": the terrain view's brushes driven by the real mouse, at the same screen positions as
// the World Editor's own steps (we-drive's --click / --drag take positions of its 1600x1000 display; the editor's
// terrain view starts at 156,79 and is 1184x844, which the "view" action gives Studio's view too).
//
//   { "ui": [ ["view", "we"], ["tool", "Paint:"], ["texture", "Lgrs"], ["size", 2], ["click", 748, 500], ["drag", 600, 500, 900, 500] ] }
//
// Actions: tab NAME (the terrain editor's tab, "Terrain"); view SPEC (the terrain view at the editor's size, the camera "we" or "we:X,Y[,distance…]" as app-drive's
// --camera); tool PREFIX (the toolbar button whose title starts so: "Paint:", "−2:"); texture TILE (a ground tile in the
// painter's options); cliff NAME (the Cliff type choice whose text starts so: "Dirt"); size N (the brush size slider); click X,Y and drag X,Y,X2,Y2 (the left button, at editor positions);
// sleep MS. Needs window.__driveEd (the "terrain" step). Positions and tool names are those of the page, not a copy.

import { Hands, sleep } from "./cdp.mjs";
import { cameraOf } from "./app-drive.mjs";

/** The terrain view at the World Editor's view size, looking as the editor does for `spec`. */
async function view(page, spec) {
  await page.evaluate(`(async () => {
    const stage = window.__driveEd.host.querySelector(".model-stage");
    const r = devicePixelRatio;
    Object.assign(stage.style, { position: "fixed", left: "0", top: "0", flex: "none", zIndex: "10000", width: 1184 / r + "px", height: 844 / r + "px" });
    window.__driveEd.redraw(); await new Promise((r) => setTimeout(r, 300));
  })()`);
  const head = await page.evaluate(`(({ width, height, offsetX, offsetY }) => ({ width, height, offsetX, offsetY }))(window.__driveEd.terrain)`);
  const { x, y, ...v } = cameraOf(spec, head);
  await page.evaluate(`window.__driveEd.lookAt(${x}, ${y})`);
  await page.evaluate(`(() => { const t = window.__driveEd.view().target; window.__driveEd.setView({ target: t, ...${JSON.stringify(v)} }); })()`);
  await sleep(600);
  await page.evaluate(`w3Workbench.settled()`, { timeout: 120000 });
}

/** A position of the editor's display as one of the page (the view sits at 156,79 there, at 0,0 here). */
const at = (x, y) => ({ x: x - 156, y: y - 79 });

export async function uiStep(page, actions) {
  const hands = new Hands(page);
  const settled = () => page.evaluate(`w3Workbench.settled()`, { timeout: 120000 });
  for (const [kind, ...a] of actions) {
    if (kind === "view") await view(page, a[0]);
    else if (kind === "tab") {
      await page.evaluate(`(() => { const b = [...document.querySelectorAll(".terrain-tab")].find((b) => b.textContent.trim() === ${JSON.stringify(a[0])}); if (!b) throw new Error("no tab " + ${JSON.stringify(a[0])}); b.click(); })()`);
      await settled();
    }
    else if (kind === "tool") await page.evaluate(`(() => { const b = [...document.querySelectorAll(".tool-button")].find((b) => b.title.startsWith(${JSON.stringify(a[0])})); if (!b) throw new Error("no tool button " + ${JSON.stringify(a[0])}); b.click(); })()`);
    else if (kind === "texture") await page.evaluate(`(() => { const b = document.querySelector('.terrain-tex-thumb[title*=${JSON.stringify(a[0])}]'); if (!b) throw new Error("no tile " + ${JSON.stringify(a[0])}); b.click(); })()`);
    else if (kind === "cliff") await page.evaluate(`(() => { const s = [...document.querySelectorAll(".painter-options select")].find((s) => s.closest("label")?.textContent.startsWith("Cliff type")); const o = s && [...s.options].find((o) => o.textContent.startsWith(${JSON.stringify(a[0])})); if (!o) throw new Error("no cliff type " + ${JSON.stringify(a[0])}); s.value = o.value; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    else if (kind === "size") await page.evaluate(`(() => { const i = document.querySelector(".painter-options input[type=range]"); i.value = ${Number(a[0])}; i.dispatchEvent(new Event("input", { bubbles: true })); i.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    else if (kind === "click") {
      const p = at(a[0], a[1]);
      await hands.mouse("mouseMoved", p.x, p.y);
      await hands.mouse("mousePressed", p.x, p.y, 1);
      await hands.mouse("mouseReleased", p.x, p.y, 0);
      await sleep(500);
      await settled();
    } else if (kind === "drag") {
      await hands.drag(at(a[0], a[1]), at(a[2], a[3]), 20);
      await sleep(500);
      await settled();
    } else if (kind === "sleep") await sleep(a[0]);
    else throw new Error(`unknown ui action ${kind}`);
  }
}
