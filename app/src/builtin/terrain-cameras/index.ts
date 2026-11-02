// Camera Editor: camera objects (war3map.w3c, "gg_cam_<name>" in triggers) as
// a tool group of the terrain editor (service "w3.terrain"). Cameras are
// created from the current view and previewed through it; on the map each
// shows its target, its eye and the field of view. Drag the target to move a
// camera, the eye to turn it and change its distance.
// The file goes through the format engine ("cameras" definition).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { TERRAIN_SERVICE, type TerrainEditorHandle, type TerrainService, type TerrainToolGroupInstance, type TerrainView } from "../../extensions/services";
import { heightAt } from "../../lib/terrain/w3e";
import { h } from "../../workbench/dom";

const FILE = "map/war3map.w3c";
/** Overlay cell size (world units). */
const CELL = 32;
const RAD = Math.PI / 180;

interface Camera {
  targetX: number;
  targetY: number;
  zOffset: number;
  rotation: number;
  angleOfAttack: number;
  distance: number;
  roll: number;
  fieldOfView: number;
  farZ: number;
  nearZ: number;
  localPitch?: number;
  localYaw?: number;
  localRoll?: number;
  unknown?: number[];
  name: string;
  trailer?: number;
}
interface CamerasDoc { format?: string; version: number; cameras: Camera[] }

/** The editable values, in panel order. */
const FIELDS: [keyof Camera, string, string][] = [
  ["targetX", "X", "Target X"], ["targetY", "Y", "Target Y"], ["zOffset", "Z", "Height offset above the ground"],
  ["rotation", "Rot", "Rotation (degrees; 90 looks north)"], ["angleOfAttack", "AoA", "Angle of attack (degrees; 304 is the game camera)"],
  ["distance", "Dist", "Distance to the target"], ["roll", "Roll", "Roll (degrees; not shown in the preview)"],
  ["fieldOfView", "FoV", "Field of view (degrees)"], ["farZ", "Far", "Far clipping"], ["nearZ", "Near", "Near clipping"],
];
/** The game's field of view is horizontal at 4:3; the editor's is vertical. */
const ASPECT = 4 / 3;

const wrap = (a: number) => ((a % 360) + 360) % 360;

export function activate(w3: W3Api, ctx: ExtensionContext) {
  void w3.services.get<TerrainService>(TERRAIN_SERVICE).then((s) => {
    ctx.subscriptions.push(s.registerToolGroup({ id: "cameras", title: "Cameras", order: 30, create: (ed) => cameraEditor(w3, ed) }));
  });
}

function cameraEditor(w3: W3Api, ed: TerrainEditorHandle): TerrainToolGroupInstance {
  const t = ed.terrain;
  const W = (t.width - 1) * 4, H = (t.height - 1) * 4;
  let doc: CamerasDoc = { version: 3, cameras: [] };
  /** Kept as map/war3map.w3c.json (else the raw file, through the backend). */
  let asJson = true, unsaved = false, active = false;
  let selected: Camera | null = null;
  /** Looking through a camera: the markers are hidden until the next click on the map. */
  let previewing = false;

  const load = (async () => {
    const files = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
    const root = w3.workspace.project()?.root;
    if (files.has(`${FILE}.json`)) doc = JSON.parse(await w3.workspace.readText(`${FILE}.json`));
    else if (files.has(FILE) && root) { doc = JSON.parse(await w3.backend.invoke<string>("codec_decode", { root, path: FILE })); asJson = false; }
    doc.cameras ??= [];
  })().catch((e) => w3.window.showError(`Cameras: ${(e as Error).message ?? e}`));

  // ---- geometry ----------------------------------------------------------------------
  const ground = (x: number, y: number) => heightAt(t, x, y);
  /** Where the camera stands, over the ground plane (x, y). */
  const eyeOf = (c: Camera): [number, number] => {
    const d = c.distance * Math.abs(Math.cos(c.angleOfAttack * RAD));
    return [c.targetX - d * Math.cos(c.rotation * RAD), c.targetY - d * Math.sin(c.rotation * RAD)];
  };
  /** The editor view that shows what the camera sees (roll left out). */
  const toView = (c: Camera): TerrainView => {
    // The game camera looks along rotation/angle of attack; the view's yaw and
    // pitch point the other way, from the target to the eye.
    const pitch = -((wrap(c.angleOfAttack) + 180) % 360 - 180) * RAD;
    return {
      target: [c.targetX, c.targetY, ground(c.targetX, c.targetY) + c.zOffset],
      yaw: (c.rotation + 180) * RAD, pitch, distance: c.distance,
      fov: 2 * Math.atan(Math.tan((c.fieldOfView * RAD) / 2) / ASPECT),
    };
  };
  const round = (v: number, k = 100) => Math.round(v * k) / k;
  /** Camera values from the current view. */
  const fromView = (): Partial<Camera> => {
    const v = ed.view();
    return {
      targetX: round(v.target[0]), targetY: round(v.target[1]), zOffset: round(v.target[2] - ground(v.target[0], v.target[1])),
      rotation: round(wrap(v.yaw / RAD - 180)), angleOfAttack: round(wrap(-v.pitch / RAD)), distance: round(v.distance),
      fieldOfView: round((2 * Math.atan(Math.tan(v.fov / 2) * ASPECT)) / RAD),
    };
  };

  // ---- overlay -----------------------------------------------------------------------
  const render = () => {
    if (!active) return;
    count.textContent = `${doc.cameras.length} cameras`;
    if (previewing) { ed.setGroundOverlay(null); return; }
    const rgba = new Uint8Array(W * H * 4);
    const cell = (x: number, y: number) => [Math.floor((x - t.offsetX) / CELL), Math.floor((y - t.offsetY) / CELL)];
    const dot = (x: number, y: number, r: number, c: number[]) => {
      const [cx, cy] = cell(x, y);
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        const px = cx + i, py = cy + j;
        if (i * i + j * j <= r * r + r && px >= 0 && py >= 0 && px < W && py < H) rgba.set(c, (py * W + px) * 4);
      }
    };
    const line = (x0: number, y0: number, x1: number, y1: number, c: number[]) => {
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CELL / 2));
      for (let k = 0; k <= n; k++) dot(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, 0, c);
    };
    for (const c of [...doc.cameras].sort((a, b) => Number(a === selected) - Number(b === selected))) {
      const sel = c === selected;
      const col = sel ? [255, 230, 90, 255] : [110, 200, 255, 220];
      const [ex, ey] = eyeOf(c);
      // Field of view: two edges from the eye, as long as the eye-to-target line.
      const len = Math.hypot(c.targetX - ex, c.targetY - ey);
      const half = Math.min(80, Math.max(1, c.fieldOfView / 2)) * RAD;
      for (const s of [-1, 1]) {
        const a = c.rotation * RAD + s * half;
        line(ex, ey, ex + (len / Math.cos(half)) * Math.cos(a), ey + (len / Math.cos(half)) * Math.sin(a), sel ? [255, 230, 90, 150] : [110, 200, 255, 110]);
      }
      line(ex, ey, c.targetX, c.targetY, col);
      dot(c.targetX, c.targetY, sel ? 3 : 2, col);
      dot(ex, ey, sel ? 2 : 1, sel ? [255, 255, 255, 255] : col);
    }
    ed.setGroundOverlay(rgba, W, H);
  };

  // ---- undo --------------------------------------------------------------------------
  const commit = (before: Camera[], after: Camera[], select: Camera | null) => {
    const set = (v: Camera[], sel: Camera | null) => { doc.cameras = v; selected = sel; unsaved = true; renderPanel(); render(); };
    set(after, select);
    const at = select ? after.indexOf(select) : -1;
    ed.pushEdit({ undo: () => set(before, before[at] ?? null), redo: () => set(after, after[at] ?? null), terrain: false, objects: false });
  };
  /** Changes one camera (by copy) as an undo step. */
  const update = (c: Camera, change: Partial<Camera>) => {
    const copy = { ...structuredClone(c), ...change };
    commit(doc.cameras, doc.cameras.map((x) => (x === c ? copy : x)), copy);
  };
  const uniqueName = () => {
    const names = new Set(doc.cameras.map((c) => c.name));
    let i = doc.cameras.length + 1;
    while (names.has(`Camera ${String(i).padStart(3, "0")}`)) i++;
    return `Camera ${String(i).padStart(3, "0")}`;
  };
  const create = () => {
    const v = fromView();
    const c: Camera = {
      targetX: 0, targetY: 0, zOffset: 0, rotation: 90, angleOfAttack: 304, distance: 1650, roll: 0, fieldOfView: 70, nearZ: 100,
      ...v, farZ: Math.max(5000, Math.round((v.distance ?? 0) + 3000)), name: uniqueName(),
    };
    commit(doc.cameras, [...doc.cameras, c], c);
  };
  const preview = (c: Camera) => { previewing = true; render(); ed.setView(toView(c)); ed.focus(); };

  // ---- pointer -----------------------------------------------------------------------
  /** The camera handle under a point: its eye or its target. */
  const hit = (x: number, y: number): { cam: Camera; part: "eye" | "target" } | null => {
    let best: { cam: Camera; part: "eye" | "target"; d: number } | null = null;
    const reach = Math.max(96, ed.view().distance / 60);
    for (const cam of doc.cameras) {
      const [ex, ey] = eyeOf(cam);
      for (const [part, px, py] of [["target", cam.targetX, cam.targetY], ["eye", ex, ey]] as const) {
        const d = Math.hypot(x - px, y - py);
        if (d < reach && (!best || d < best.d || (d === best.d && cam === selected))) best = { cam, part, d };
      }
    }
    return best;
  };
  let drag: { part: "eye" | "target"; start: [number, number]; orig: Camera; moved: boolean } | null = null;

  // ---- toolbar -----------------------------------------------------------------------
  const count = h("span.muted");
  const hover = h("span.terrain-place-hint");
  const jump = h("select", { title: "Go to a camera", onchange: () => {
    const c = doc.cameras[Number(jump.value)];
    if (c) { selected = c; ed.lookAt(c.targetX, c.targetY); renderPanel(); render(); }
    jump.value = "";
  } });
  const panel = h("div.terrain-region-panel");
  const renderPanel = () => {
    jump.replaceChildren(h("option", { value: "" }, "Go to camera…"),
      ...doc.cameras.map((c, i) => [c, i] as const).sort(([a], [b]) => a.name.localeCompare(b.name)).map(([c, i]) => h("option", { value: String(i) }, c.name)));
    const c = selected;
    if (!c) {
      panel.replaceChildren(h("span.muted", {}, "Click a camera's target or eye to select it · drag the target to move it, the eye to aim it · Del deletes"));
      return;
    }
    const name = h("input.terrain-region-name", { type: "text", value: c.name, title: "Name (triggers use gg_cam_<name>)", onchange: () => {
      const v = name.value.trim();
      if (v && v !== c.name) update(c, { name: v });
    } });
    const fields = FIELDS.map(([key, label, title]) => {
      const input = h("input.terrain-camera-value", { type: "number", step: "any", value: String(round(c[key] as number)), title, onchange: () => {
        const v = Number(input.value);
        if (Number.isFinite(v) && v !== c[key]) update(c, { [key]: v });
      } });
      return h("label.terrain-camera-field", { title }, label, input);
    });
    panel.replaceChildren(name,
      h("button", { title: "Look through this camera", onclick: () => preview(c) }, "View"),
      h("button", { title: "Take target, angles, distance and field of view from the current view", onclick: () => update(c, fromView()) }, "Set from view"),
      h("button", { title: "Delete this camera (Del)", onclick: () => deleteSelected() }, "Delete"),
      ...fields);
  };
  const deleteSelected = () => {
    const c = selected;
    if (c) commit(doc.cameras, doc.cameras.filter((x) => x !== c), null);
  };
  const toolbar = h("div.terrain-group-tools", {},
    h("button", { title: "New camera from the current view", onclick: () => { if (ed.editable) create(); } }, "Create from view"),
    jump, count, hover, panel);

  return {
    toolbar,
    activate() { active = true; previewing = false; void load.then(() => { renderPanel(); render(); }); },
    deactivate() { active = false; drag = null; ed.setGroundOverlay(null); ed.host.style.cursor = ""; },
    pointerDown(p) {
      if (!ed.editable || !p.ground) return false;
      previewing = false;
      const [x, y] = p.ground;
      const g = hit(x, y);
      selected = g?.cam ?? null;
      drag = g ? { part: g.part, start: [x, y], orig: structuredClone(g.cam), moved: false } : null;
      renderPanel();
      render();
      return !!g;
    },
    pointerMove(p) {
      if (!p.ground) return;
      const [x, y] = p.ground;
      if (!p.down || !drag || !selected) {
        const g = hit(x, y);
        hover.textContent = g ? `${g.cam.name} (${g.part})` : "";
        ed.host.style.cursor = g ? (g.cam === selected ? "grab" : "pointer") : "";
        return;
      }
      drag.moved = true;
      const o = drag.orig, c = selected;
      if (drag.part === "target") {
        c.targetX = round(o.targetX + x - drag.start[0]);
        c.targetY = round(o.targetY + y - drag.start[1]);
      } else {
        // The eye turns around the target; its ground distance sets the distance.
        const dx = o.targetX - x, dy = o.targetY - y;
        c.rotation = round(wrap(Math.atan2(dy, dx) / RAD));
        c.distance = round(Math.max(CELL, Math.hypot(dx, dy) / Math.max(0.05, Math.abs(Math.cos(o.angleOfAttack * RAD)))));
      }
      render();
    },
    pointerUp() {
      const d = drag;
      drag = null;
      if (!d || !d.moved || !selected) return;
      // The live edit becomes one undo step: restore, then apply as an update.
      const now = { targetX: selected.targetX, targetY: selected.targetY, rotation: selected.rotation, distance: selected.distance };
      Object.assign(selected, { targetX: d.orig.targetX, targetY: d.orig.targetY, rotation: d.orig.rotation, distance: d.orig.distance });
      update(selected, now);
    },
    pointerLeave() { hover.textContent = ""; ed.host.style.cursor = ""; },
    keyDown(e) {
      if ((e.key === "Delete" || e.key === "Backspace") && selected) { deleteSelected(); return true; }
      if (e.key === "Escape" && selected) { selected = null; renderPanel(); render(); return true; }
      return false;
    },
    async save() {
      if (!unsaved) return;
      // Version 0 files (classic, or written empty) take the Reforged layout once they have cameras.
      if (doc.version < 3 && doc.cameras.length) doc.version = 3;
      if (doc.version >= 3) {
        for (const c of doc.cameras) Object.assign(c, { localPitch: c.localPitch ?? 0, localYaw: c.localYaw ?? 0, localRoll: c.localRoll ?? 0, unknown: c.unknown ?? [0, 0, 0], trailer: c.trailer ?? 0 });
      }
      const root = w3.workspace.project()!.root;
      const text = JSON.stringify({ format: "w3proj.cameras/1", ...doc });
      if (asJson) {
        const canonical = await w3.backend.invoke<string>("codec_canonicalize", { root, path: `${FILE}.json`, text });
        await w3.workspace.writeText(`${FILE}.json`, canonical);
      } else {
        await w3.backend.invoke("codec_write", { root, path: FILE, text });
      }
      unsaved = false;
    },
    dispose() { ed.setGroundOverlay(null); ed.host.style.cursor = ""; },
  };
}
