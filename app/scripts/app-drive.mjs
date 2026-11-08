// Drives the real app (the smoke build, hidden; Xvfb on Linux) through a list of steps given on the command
// line, for looking at something or asking the app something without writing a new script each time:
// pictures of the terrain view from a set camera, an MCP tool's answer, a command, an expression in the page.
// The steps run in the order given. Results go to stdout as one JSON line per step; problems the page
// reported (uncaught errors, console.error) are listed at the end.
//
//   node scripts/app-drive.mjs [options] <steps>
//
// Options:
//   --no-build          use the app as last built (otherwise it's built first; incremental, cheap if unchanged)
//   --game DIR          the game's folder (default: W3PROJ_GAME, .game-path, or the folder above the checkout)
//   --work DIR          scratch folder (default: target/app-drive); projects are copied or unpacked into it
//   --set KEY=JSON      a setting for this run (repeatable), e.g. --set terrain.grid=true
//   --strict            exit 1 if the page reported a problem
//
// Steps:
//   --map FILE.w3x      unpack a map into the scratch folder and open it as the project
//   --project DIR       copy a project folder into the scratch folder and open the copy (the original isn't touched)
//   --open PATH         open a project file in its editor (e.g. map/war3map.w3i.json)
//   --terrain           open the terrain view (map/war3map.w3e.txt) and wait until its game files are read
//   --camera SPEC       terrain camera: "game" (the game's default: 1650 away, 56° down, 70° wide at 4:3),
//                       "top", or key=value pairs: x, y (target), distance, pitch, yaw (degrees), fov (degrees, vertical);
//                       "we" is the World Editor's opening view (the terrain's centre), "we:X,Y[,distance[,aoa[,fov[,
//                       rotation]]]]" (or "we:center,…") what the editor shows for we-drive's --look with the same
//                       values, fitted at the editor view's 1184:844 (use --view-size 1184x844; we-camera.mjs)
//   --view-size WxH     give the terrain view's canvas this size in pixels (over the rest of the window), so its
//                       pictures line up with another's, e.g. 1184x844 for the World Editor's view; "off" undoes it
//   --compare-ready MODE  the terrain view's lighting for comparing with the World Editor: "lit" (the map's lighting
//                       at 06:00, the pair of we-drive's --compare-ready) or "unlit" (even light, the pair of
//                       --compare-ready-unlit); sets terrain.lighting.* and waits for the view (TESTING.md)
//   --look X,Y          point the terrain camera at a map position (keeps its angle and distance)
//   --settle            wait until the game's files are read and the terrain view's layers are done
//   --sleep MS          wait
//   --frame-cost MS     CPU time of the terrain view's frames drawn during MS (by performance.now): the frames, and
//                       per frame the whole frame, posing the placed models, the particles. Animated objects
//                       redraw about 30 times a second by themselves
//   --shot FILE.png     picture of the active editor's canvas (the terrain or model view), else of the window
//   --shot-window FILE  picture of the whole window
//   --mcp NAME[=JSON]   call an MCP tool with JSON arguments; prints its text answer
//   --command ID        run a command (as the palette does); prints its error if it fails
//   --eval EXPR         evaluate in the page (statements or an expression; a promise is awaited); prints the value:
//                       an expression's, else the last statement's, or what statements `return` (with or without
//                       a top-level `await`)
//
// Examples:
//   node scripts/app-drive.mjs --map ../openpoints/example-maps/02c_Fog_Linear_Near.w3x --terrain --camera game --shot /tmp/02c.png
//   node scripts/app-drive.mjs --no-build --project tests/fixtures/mini-map --mcp list_problems --mcp project_info
//   node scripts/app-drive.mjs --project P --terrain --camera "pitch=30,distance=3000" --look 0,-1500 --shot a.png
//   node scripts/app-drive.mjs --map m.w3x --terrain --view-size 1184x844 --camera we --shot studio.png
//
// Never starts the game or the World Editor (their programs are set to files that don't exist), and uses its own
// identifier and settings folder (W3_SMOKE_ID, else one per checkout), so your own app's settings aren't touched.

import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Script } from "node:vm";
import { problems, sleep, until } from "./cdp.mjs";
import { buildApp, mcpCall, repo, smokeId, startApp } from "./appctl.mjs";
import { chosenGamePath, gamePath } from "../../tests/gamepath.mjs";
import { parseLook, resolveLook, studioCamera, studioLighting } from "./we-camera.mjs";

const VALUE_STEPS = new Set(["--map", "--project", "--open", "--camera", "--view-size", "--compare-ready", "--look", "--sleep", "--frame-cost", "--shot", "--shot-window", "--mcp", "--command", "--eval"]);
const FLAG_STEPS = new Set(["--terrain", "--settle"]);

function parseArgs(argv) {
  const opts = { build: true, game: null, work: join(repo, "target", "app-drive"), settings: {}, strict: false };
  const steps = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--no-build") opts.build = false;
    else if (a === "--strict") opts.strict = true;
    else if (a === "--game") opts.game = resolve(value());
    else if (a === "--work") opts.work = resolve(value());
    else if (a === "--set") {
      const v = value(), eq = v.indexOf("=");
      if (eq < 1) throw new Error(`--set wants KEY=JSON, got ${v}`);
      const raw = v.slice(eq + 1);
      try { opts.settings[v.slice(0, eq)] = JSON.parse(raw); } catch { opts.settings[v.slice(0, eq)] = raw; }
    } else if (VALUE_STEPS.has(a)) steps.push([a, value()]);
    else if (FLAG_STEPS.has(a)) steps.push([a, null]);
    else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown argument ${a} (see the top of app-drive.mjs)`);
  }
  return { opts, steps };
}

const deg = (d) => (d * Math.PI) / 180;
/** The game's default camera: 1650 from its target, angle of attack 304° (56° down), a 70° field of view
 *  across a 4:3 screen (the renderer's fov is vertical). */
const GAME_FOV = 2 * Math.atan(Math.tan(deg(35)) / (4 / 3));

/** Whether a camera spec is the World Editor's view ("we", "we:…"), which needs the terrain's size (head). */
export const isWeCamera = (spec) => spec === "we" || spec.startsWith("we:");

/**
 * A camera spec as setView takes it (radians), with an optional target x/y. `head` is the terrain's size and corner
 * ({ width, height, offsetX, offsetY }), for the World Editor's view.
 */
export function cameraOf(spec, head = null) {
  if (spec === "game") return { yaw: -Math.PI / 2, pitch: deg(56), distance: 1650, fov: GAME_FOV };
  if (spec === "top") return { yaw: -Math.PI / 2, pitch: deg(89), distance: 4000 };
  if (isWeCamera(spec)) {
    if (!head) throw new Error("--camera we needs the terrain");
    const c = studioCamera(resolveLook(parseLook(spec === "we" ? "center" : spec.slice(3)), head));
    return { x: c.x, y: c.y, distance: c.distance, pitch: deg(c.pitch), yaw: deg(c.yaw), fov: deg(c.fov) };
  }
  const v = {};
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [k, raw] = part.split("=");
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`--camera: ${part} isn't key=number`);
    if (k === "x" || k === "y" || k === "distance") v[k] = n;
    else if (k === "pitch" || k === "yaw" || k === "fov") v[k] = deg(n);
    else throw new Error(`--camera: unknown key ${k} (x, y, distance, pitch, yaw, fov)`);
  }
  return v;
}

/** "WxH" in pixels, or null for "off". */
export function parseViewSize(spec) {
  if (spec === "off") return null;
  const m = /^(\d+)x(\d+)$/.exec(spec);
  if (!m || Number(m[1]) < 16 || Number(m[2]) < 16) throw new Error(`--view-size wants WxH in pixels (at least 16x16) or off, not ${spec}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * What --eval sends to the page for `source`: the source itself if it is a script (an expression or statements:
 * the page answers with its completion value and awaits a promise), else an async function around it, as an
 * expression when it is one with a top-level `await`, else as statements, which `return` their value (`return` is
 * no script's statement, with or without `await`). Which form it is is found by parsing here (the first that is a
 * script as sent): nothing runs twice. Source with the word `await` is never sent as is: `await (f)()` parses as a
 * script too, calling a function named await.
 */
export function evalSource(source) {
  const forms = [`(async () => (${source}\n))()`, `(async () => {\n${source}\n})()`];
  if (!/\bawait\b/.test(source)) forms.unshift(source);
  // None parses: a syntax error, which the page reports.
  return forms.find((f) => { try { new Script(f); return true; } catch { return false; } }) ?? source;
}

async function main() {
  const { opts, steps } = parseArgs(process.argv.slice(2));
  if (opts.help || !steps.length) {
    console.log("usage: node scripts/app-drive.mjs [options] <steps>; the steps and options are listed at the top of the file");
    return 0;
  }
  const id = smokeId();
  const game = opts.game ?? chosenGamePath() ?? gamePath(repo);
  rmSync(opts.work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  mkdirSync(opts.work, { recursive: true });
  if (opts.build) buildApp(id, opts.work);

  const { page, stop } = await startApp({ id, work: opts.work, game, settings: opts.settings });
  const out = (o) => console.log(JSON.stringify(o));
  let failed = false;
  try {
    // The extensions activate on demand; commands and tools need them.
    await page.evaluate(`(async () => { const h = w3Workbench.host; await Promise.all(h.extensions.filter((e) => !e.disabled).map((e) => h.activate(e))); })()`);
    // The terrain editor's handle (camera, view), as a tool group of another extension would get it.
    await page.evaluate(`(async () => {
      const s = await w3.services.get("w3.terrain");
      s.registerToolGroup({ id: "app-drive", title: "app-drive", order: 999, create: (ed) => { window.__driveEd = ed; return { toolbar: document.createElement("div") }; } });
    })()`);
    const editor = async () => {
      if (!(await page.evaluate(`!!window.__driveEd`))) throw new Error("no terrain view is open: add --terrain first");
    };
    const settle = async () => {
      // The game's files read (none running or queued) for a second, and the view's layers done.
      let quietSince = 0;
      await until("the game's files and the view's layers", async () => {
        const busy = await page.evaluate(`w3Workbench.game.readsPending > 0 || [...document.querySelectorAll(".terrain-view span.muted, span.muted")].some((e) => !e.hidden && e.textContent === "Working…")`);
        if (busy) { quietSince = 0; return false; }
        quietSince ||= Date.now();
        return Date.now() - quietSince > 1000;
      }, 180000);
      await sleep(500);
    };
    const open = async (dir) => {
      await page.evaluate(`(async () => { window.__driveEd = null; await w3.editors.closeAll(); await w3.workspace.open(${JSON.stringify(dir)}); })()`);
      await until("the project", () => page.evaluate(`w3.workspace.project()?.root === ${JSON.stringify(dir)}`));
    };
    const canvasClip = () => page.evaluate(`(() => {
      const area = document.querySelector(".editor-area, .editors, main") ?? document;
      const c = [...area.querySelectorAll("canvas")].find((x) => x.offsetParent !== null && x.clientWidth > 50);
      if (!c) return null;
      const b = c.getBoundingClientRect();
      return { x: b.left, y: b.top, width: b.width, height: b.height, scale: 1 };
    })()`);
    const shot = async (file, clip) => {
      const r = await page.send("Page.captureScreenshot", clip ? { format: "png", clip } : { format: "png" });
      mkdirSync(dirname(resolve(file)), { recursive: true });
      writeFileSync(resolve(file), Buffer.from(r.data, "base64"));
      return resolve(file);
    };

    for (const [step, arg] of steps) {
      try {
        if (step === "--map") {
          const map = resolve(arg), dir = join(opts.work, basename(map).replace(/\.(w3x|w3m)$/i, ""));
          await page.evaluate(`w3.backend.invoke("project_unpack", { map: ${JSON.stringify(map)}, dir: ${JSON.stringify(dir)}, allowIncomplete: false, install: ${JSON.stringify(game)} })`);
          await open(dir);
          out({ step, project: dir });
        } else if (step === "--project") {
          const src = resolve(arg), dir = join(opts.work, basename(src));
          cpSync(src, dir, { recursive: true, filter: (p) => !/[\\/](build|\.git)$/.test(p) });
          await open(dir);
          out({ step, project: dir });
        } else if (step === "--open") {
          await page.evaluate(`w3.editors.open(${JSON.stringify(arg)})`);
          await sleep(300);
          out({ step, active: await page.evaluate(`w3.editors.activePath()`) });
        } else if (step === "--terrain") {
          await page.evaluate(`w3.editors.open("map/war3map.w3e.txt")`);
          await until("the terrain view", () => page.evaluate(`!!window.__driveEd && !!document.querySelector(".model-stage canvas")`), 120000);
          await settle();
          out({ step, view: await page.evaluate(`window.__driveEd.view()`) });
        } else if (step === "--camera") {
          await editor();
          const head = isWeCamera(arg) ? await page.evaluate(`(({ width, height, offsetX, offsetY }) => ({ width, height, offsetX, offsetY }))(window.__driveEd.terrain)`) : null;
          const { x, y, ...v } = cameraOf(arg, head);
          if (x !== undefined || y !== undefined) {
            const t = await page.evaluate(`window.__driveEd.view().target`);
            await page.evaluate(`window.__driveEd.lookAt(${x ?? t[0]}, ${y ?? t[1]})`);
          }
          await page.evaluate(`(() => { const t = window.__driveEd.view().target; window.__driveEd.setView({ target: t, ...${JSON.stringify(v)} }); })()`);
          await sleep(500);
          out({ step, view: await page.evaluate(`window.__driveEd.view()`) });
        } else if (step === "--compare-ready") {
          await editor();
          const settings = studioLighting(arg);
          for (const [k, v] of Object.entries(settings)) await page.evaluate(`w3.settings.set(${JSON.stringify(k)}, ${JSON.stringify(v)})`);
          await settle();
          out({ step, mode: arg, settings });
        } else if (step === "--view-size") {
          await editor();
          const size = parseViewSize(arg);
          // The canvas fills .model-stage (absolute, inset 0) and takes its drawing size from its own size each
          // frame: the stage is put over the window's top-left corner at that size in pixels (CSS pixels times the
          // display's ratio), then the view redrawn.
          const got = await page.evaluate(`(async () => {
            const stage = window.__driveEd.host.querySelector(".model-stage");
            if (!stage) throw new Error("no .model-stage in the terrain view");
            const size = ${JSON.stringify(size)};
            if (size) {
              const r = devicePixelRatio;
              Object.assign(stage.style, { position: "fixed", left: "0", top: "0", flex: "none", zIndex: "10000",
                width: size.width / r + "px", height: size.height / r + "px" });
              if (size.width / r > innerWidth || size.height / r > innerHeight) throw new Error("the window is smaller than " + size.width + "x" + size.height);
            } else for (const k of ["position", "left", "top", "flex", "zIndex", "width", "height"]) stage.style[k] = "";
            window.__driveEd.redraw();
            await new Promise((r) => setTimeout(r, 300));
            const c = stage.querySelector("canvas");
            return { width: c.width, height: c.height };
          })()`);
          if (size && (got.width !== size.width || got.height !== size.height)) throw new Error(`the canvas draws ${got.width}x${got.height}, not ${arg}`);
          await sleep(300);
          out({ step, canvas: got });
        } else if (step === "--look") {
          await editor();
          const [x, y] = arg.split(",").map(Number);
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("--look wants X,Y");
          await page.evaluate(`window.__driveEd.lookAt(${x}, ${y})`);
          await sleep(500);
          out({ step, view: await page.evaluate(`window.__driveEd.view()`) });
        } else if (step === "--settle") {
          await settle();
          out({ step });
        } else if (step === "--sleep") {
          await sleep(Number(arg));
          out({ step });
        } else if (step === "--frame-cost") {
          await editor();
          const ms = Number(arg);
          if (!(ms > 0)) throw new Error("--frame-cost wants a time in ms");
          await page.evaluate(`window.__driveEd.frameCost()`);
          await sleep(ms);
          const c = await page.evaluate(`window.__driveEd.frameCost()`);
          const per = (v) => (c.frames ? Math.round((v / c.frames) * 100) / 100 : null);
          out({ step, ms, frames: c.frames, perFrame: { frameMs: per(c.frameMs), poseMs: per(c.poseMs), particleMs: per(c.particleMs) } });
        } else if (step === "--shot") {
          out({ step, file: await shot(arg, await canvasClip()) });
        } else if (step === "--shot-window") {
          out({ step, file: await shot(arg, null) });
        } else if (step === "--mcp") {
          const eq = arg.indexOf("=");
          const name = eq < 0 ? arg : arg.slice(0, eq);
          const args = eq < 0 ? {} : JSON.parse(arg.slice(eq + 1));
          out({ step, tool: name, text: await mcpCall(page, name, args) });
        } else if (step === "--command") {
          // Not awaited to the end: a command can wait for its toast's buttons.
          const r = await page.evaluate(`Promise.race([w3.commands.execute(${JSON.stringify(arg)}).then(() => null, (e) => String(e)), new Promise((r) => setTimeout(() => r("still running after 10 s (waiting for an answer?)"), 10000))])`);
          out({ step, command: arg, error: r });
        } else if (step === "--eval") {
          out({ step, value: await page.evaluate(evalSource(arg)) });
        }
      } catch (e) {
        failed = true;
        out({ step, arg, error: e.message });
        break;
      }
    }
    const found = problems(page.events);
    for (const p of found) console.error(`page: ${p}`);
    return failed || (opts.strict && found.length) ? 1 : 0;
  } finally {
    await stop();
  }
}

// Run as a program, not imported (a test bundles this file, so import.meta.url can't tell).
if (process.argv[1] && basename(process.argv[1]) === "app-drive.mjs") {
  try {
    process.exit(await main());
  } catch (e) {
    console.error(`app-drive: ${e.message}`);
    process.exit(1);
  }
}
