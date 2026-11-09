// Camera Editor: camera objects (war3map.w3c, "gg_cam_<name>" in triggers) as
// a tool group of the terrain editor (service "w3.terrain"). Cameras are
// created from the current view and previewed through it; on the map each
// shows its target, its eye and the field of view. Drag the target to move a
// camera, the eye to turn it and change its distance. Shift+click selects several:
// the panel then edits what they share; Duplicate copies the selected. A value
// being typed shows through its camera at once, and is an edit once entered.
// The file goes through the format engine ("cameras" definition).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { TERRAIN_SERVICE, type TerrainEditorHandle, type TerrainService, type TerrainToolGroupInstance, type TerrainView } from "../../extensions/services";
import { heightAt } from "../../lib/terrain/w3e";
import { CAMERA_CELL, cameraColors, cameraEye, type CameraLook } from "../../lib/terrain/cameras";
import { readMapDoc, requireProject } from "../../lib/formats/mapdoc";
import { renameInTriggers, SavedNames } from "../../lib/triggers/renamed";
import { h } from "../../workbench/dom";

const FILE = "map/war3map.w3c";
/** Overlay cell size (world units). */
const CELL = CAMERA_CELL;
const RAD = Math.PI / 180;
/** The cameras in the editor's overlay: blue, the selected one yellow and bigger. */
const EDITOR_LOOK: CameraLook = { fov: [110, 200, 255, 110], line: [110, 200, 255, 220], target: [110, 200, 255, 220], eye: [110, 200, 255, 220], targetRadius: 2, eyeRadius: 1 };
const SELECTED_LOOK: CameraLook = { fov: [255, 230, 90, 150], line: [255, 230, 90, 255], target: [255, 230, 90, 255], eye: [255, 255, 255, 255], targetRadius: 3, eyeRadius: 2 };

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
  ctx.subscriptions.push(w3.mcp.registerTool("list_cameras", async () => {
    requireProject(w3);
    const file = await readMapDoc<{ cameras: Camera[] }>(w3, "map/war3map.w3c.json");
    return (file?.cameras ?? []).map((c) => ({
      name: c.name, target: [c.targetX, c.targetY], rotation: c.rotation, angleOfAttack: c.angleOfAttack, distance: c.distance, fieldOfView: c.fieldOfView,
    }));
  }));
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
  /** The selected cameras (Shift+click adds or takes one away); the last is the one dragged, viewed and previewed. */
  let selection: Camera[] = [];
  let selected: Camera | null = null;
  const select = (cams: Camera[]) => { selection = cams; selected = cams.at(-1) ?? null; };
  /** Looking through a camera: the markers are hidden until the next click on the map. */
  let previewing = false;

  /** The names as saved, for the gg_cam_ references in the triggers of cameras renamed since. */
  const names = new SavedNames<Camera>();
  const read = async () => {
    const files = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
    const root = w3.workspace.project()?.root;
    if (files.has(`${FILE}.json`)) doc = JSON.parse(await w3.workspace.readText(`${FILE}.json`));
    else if (files.has(FILE) && root) { doc = JSON.parse(await w3.backend.invoke<string>("codec_decode", { root, path: FILE })); asJson = false; }
    doc.cameras ??= [];
    names.saved(doc.cameras);
  };
  const load = read().catch((e) => w3.window.showError(`Cameras: ${(e as Error).message ?? e}`));

  // ---- geometry ----------------------------------------------------------------------
  const ground = (x: number, y: number) => heightAt(t, x, y);
  /** Where the camera stands, over the ground plane (x, y). */
  const eyeOf = cameraEye;
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
    if (previewing) { ed.setGroundOverlay(null); ed.setLabels(null); return; }
    // The selected cameras last, so they lie over the others.
    const picked = new Set<unknown>(selection);
    const order = [...doc.cameras].sort((a, b) => Number(picked.has(a)) - Number(picked.has(b)));
    const rgba = cameraColors(order, W, H, t.offsetX, t.offsetY, (c) => (picked.has(c) ? SELECTED_LOOK : EDITOR_LOOK));
    ed.setGroundOverlay(rgba, W, H);
    ed.setLabels(doc.cameras.map((c) => ({ x: c.targetX, y: c.targetY, text: c.name })));
  };

  // ---- undo --------------------------------------------------------------------------
  /** Puts a new list of cameras in place as one undo step, with `chosen` (cameras of `after`) selected; undo selects
   *  the same places in `before`. */
  const commit = (before: Camera[], after: Camera[], chosen: Camera[]) => {
    const set = (v: Camera[], sel: Camera[]) => { doc.cameras = v; select(sel); unsaved = true; renderPanel(); render(); };
    set(after, chosen);
    const at = chosen.map((c) => after.indexOf(c));
    const pick = (list: Camera[]) => at.map((i) => list[i]).filter((c): c is Camera => !!c);
    ed.pushEdit({ undo: () => set(before, pick(before)), redo: () => set(after, pick(after)), terrain: false, objects: false });
  };
  /** Changes cameras (by copy) as one undo step; they stay selected. */
  const updateAll = (cams: Camera[], change: Partial<Camera> | ((c: Camera) => Partial<Camera>)) => {
    const copies = new Map(cams.map((c) => [c, names.copy(c, { ...structuredClone(c), ...(typeof change === "function" ? change(c) : change) })]));
    const after = doc.cameras.map((x) => copies.get(x) ?? x);
    commit(doc.cameras, after, selection.map((c) => copies.get(c) ?? c).filter((c) => after.includes(c)));
  };
  /** Changes one camera (by copy) as an undo step, and selects it alone. */
  const update = (c: Camera, change: Partial<Camera>) => {
    const copy = names.copy(c, { ...structuredClone(c), ...change });
    commit(doc.cameras, doc.cameras.map((x) => (x === c ? copy : x)), [copy]);
  };
  const uniqueName = (taken = new Set(doc.cameras.map((c) => c.name))) => {
    let i = taken.size + 1;
    while (taken.has(`Camera ${String(i).padStart(3, "0")}`)) i++;
    return `Camera ${String(i).padStart(3, "0")}`;
  };
  const create = () => {
    const v = fromView();
    const c: Camera = {
      targetX: 0, targetY: 0, zOffset: 0, rotation: 90, angleOfAttack: 304, distance: 1650, roll: 0, fieldOfView: 70, nearZ: 100,
      ...v, farZ: Math.max(5000, Math.round((v.distance ?? 0) + 3000)), name: uniqueName(),
    };
    commit(doc.cameras, [...doc.cameras, c], [c]);
  };
  /** Duplicate: a copy of each selected camera with every value but its name (a new one, as Create gives), after the
   *  originals; the copies are selected. One undo step. */
  const duplicate = () => {
    if (!selection.length) return;
    const taken = new Set(doc.cameras.map((c) => c.name));
    const copies = selection.map((c) => {
      const name = uniqueName(taken);
      taken.add(name);
      return { ...structuredClone(c), name };
    });
    commit(doc.cameras, [...doc.cameras, ...copies], copies);
  };
  /** Looks through a camera (the markers hidden until the next click on the map); `focus` gives the map the keys, which
   *  a value being typed keeps. */
  const preview = (c: Camera, focus = true) => { previewing = true; render(); ed.setView(toView(c)); if (focus) ed.focus(); };
  /** The view before a value being typed was shown through its camera: it comes back once the value is entered, the
   *  field is left, or the panel is made again (an undo, a save's reload, another selection), so the preview of a
   *  value never stays as the user's view. View (the button) is looking through a camera on purpose and stays. */
  let viewBeforeTyping: TerrainView | null = null;
  const previewTyped = (c: Camera) => { viewBeforeTyping ??= ed.view(); preview(c, false); };
  const endTypedPreview = () => {
    const v = viewBeforeTyping;
    if (!v) return;
    viewBeforeTyping = null;
    previewing = false;
    ed.setView(v);
    render();
  };

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
  /** A drag in progress: the target of every selected camera moves along, the eye turns the grabbed one only. */
  let drag: { part: "eye" | "target"; start: [number, number]; client: [number, number]; orig: Camera; others: Map<Camera, Camera>; moved: boolean } | null = null;

  // ---- toolbar -----------------------------------------------------------------------
  const count = h("span.muted");
  const hover = h("span.terrain-place-hint");
  const jump = h("select", { title: "Go to a camera", onchange: () => {
    const c = doc.cameras[Number(jump.value)];
    if (c) { select([c]); ed.lookAt(c.targetX, c.targetY); renderPanel(); render(); }
    jump.value = "";
  } });
  const panel = h("div.terrain-region-panel");
  const renderPanel = () => {
    // The field being typed in goes (without a blur event): its preview ends with it.
    endTypedPreview();
    jump.replaceChildren(h("option", { value: "" }, "Go to camera…"),
      ...doc.cameras.map((c, i) => [c, i] as const).sort(([a], [b]) => a.name.localeCompare(b.name)).map(([c, i]) => h("option", { value: String(i) }, c.name)));
    const c = selected, many = selection.length > 1;
    if (!c) {
      panel.replaceChildren(h("span.muted", {}, "Click a camera's target or eye to select it, Shift+click for several · drag the target to move it, the eye to aim it · Del deletes"));
      return;
    }
    const name = many ? h("span.terrain-camera-count", { title: selection.map((x) => x.name).join(", ") }, `${selection.length} cameras`)
      : h("input.terrain-region-name", { type: "text", value: c.name, title: "Name (triggers use gg_cam_<name>)", onchange: () => {
        const v = (name as HTMLInputElement).value.trim();
        if (v && v !== c.name) update(c, { name: v });
      } });
    // Several selected: a field shows the value they share, or stays empty where they differ; a value typed goes to all.
    const fields = FIELDS.map(([key, label, title]) => {
      const values = new Set(selection.map((x) => x[key] as number));
      const shared = values.size === 1 ? round(c[key] as number) : null;
      const input = h("input.terrain-camera-value", {
        type: "number", step: "any", value: shared === null ? "" : String(shared), placeholder: shared === null ? "—" : "",
        title: shared === null ? `${title} (differs between the selected cameras)` : title,
        // Each value typed shows at once through the camera it's for (the last selected), before it's an edit.
        oninput: () => {
          const v = Number(input.value);
          if (input.value.trim() !== "" && Number.isFinite(v)) previewTyped({ ...c, [key]: v });
        },
        onblur: () => endTypedPreview(),
        onchange: () => {
          endTypedPreview();
          const v = Number(input.value);
          if (input.value.trim() === "" || !Number.isFinite(v)) { renderPanel(); return; }
          const changing = selection.filter((x) => x[key] !== v);
          if (changing.length) updateAll(changing, { [key]: v });
        },
      });
      return h("label.terrain-camera-field", { title }, label, input);
    });
    panel.replaceChildren(name,
      h("button", { title: "Look through this camera", onclick: () => preview(c) }, "View"),
      // Several cameras made one by the view would be nothing but copies: this is for one.
      ...(many ? [] : [h("button", { title: "Take target, angles, distance and field of view from the current view", onclick: () => update(c, fromView()) }, "Set from view")]),
      h("button", { title: many ? "A copy of each selected camera, with a new name" : "A copy of this camera, with a new name", onclick: () => { if (ed.editable) duplicate(); } }, "Duplicate"),
      h("button", { title: many ? "Delete the selected cameras (Del)" : "Delete this camera (Del)", onclick: () => deleteSelected() }, "Delete"),
      ...fields);
  };
  const deleteSelected = () => {
    if (!selection.length) return;
    const gone = new Set(selection);
    commit(doc.cameras, doc.cameras.filter((x) => !gone.has(x)), []);
  };
  const toolbar = h("div.terrain-group-tools", {},
    h("button", { title: "New camera from the current view", onclick: () => { if (ed.editable) create(); } }, "Create from view"),
    jump, count, hover, panel);

  return {
    toolbar,
    activate() { active = true; previewing = false; void load.then(() => { renderPanel(); render(); }); },
    deactivate() { endTypedPreview(); active = false; drag = null; ed.setGroundOverlay(null); ed.setLabels(null); ed.host.style.cursor = ""; },
    pointerDown(p) {
      if (!ed.editable || !p.ground) return false;
      previewing = false;
      const [x, y] = p.ground;
      const g = hit(x, y);
      if (p.event.shiftKey) {
        // Shift+click adds a camera to the selection or takes it away; it doesn't drag.
        if (g) select(selection.includes(g.cam) ? selection.filter((c) => c !== g.cam) : [...selection, g.cam]);
        drag = null;
        renderPanel();
        render();
        return !!g;
      }
      // A click on one of the selected keeps them all (to drag them), the grabbed one last; elsewhere it alone.
      select(!g ? [] : selection.includes(g.cam) ? [...selection.filter((c) => c !== g.cam), g.cam] : [g.cam]);
      drag = g ? { part: g.part, start: [x, y], client: [p.event.clientX, p.event.clientY], orig: structuredClone(g.cam), others: new Map(selection.filter((c) => c !== g.cam).map((c) => [c, structuredClone(c)])), moved: false } : null;
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
        ed.host.style.cursor = g ? (selection.includes(g.cam) ? "grab" : "pointer") : "";
        return;
      }
      // A click (the ground under a still pointer can come out a hair apart) isn't a drag: it starts a few units off.
      // A click isn't a drag: it starts once the pointer has gone a few pixels. Selecting changes the panel above the
      // map, which can move the map under a still pointer, so the drag measures from where it starts, not the press.
      if (!drag.moved) {
        if (Math.hypot(p.event.clientX - drag.client[0], p.event.clientY - drag.client[1]) < 4) return;
        drag.moved = true;
        drag.start = [x, y];
        return;
      }
      const o = drag.orig, c = selected;
      if (drag.part === "target") {
        const dx = x - drag.start[0], dy = y - drag.start[1];
        c.targetX = round(o.targetX + dx);
        c.targetY = round(o.targetY + dy);
        for (const [cam, was] of drag.others) { cam.targetX = round(was.targetX + dx); cam.targetY = round(was.targetY + dy); }
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
      const moved = new Map([[selected, d.orig], ...(d.part === "target" ? d.others : [])]);
      const now = new Map([...moved.keys()].map((c) => [c, { targetX: c.targetX, targetY: c.targetY, rotation: c.rotation, distance: c.distance }]));
      for (const [c, was] of moved) Object.assign(c, { targetX: was.targetX, targetY: was.targetY, rotation: was.rotation, distance: was.distance });
      // A click whose pointer didn't take a camera anywhere is no edit.
      const changed = [...moved.keys()].filter((c) => (["targetX", "targetY", "rotation", "distance"] as const).some((k) => now.get(c)![k] !== c[k]));
      if (changed.length) updateAll(changed, (c) => now.get(c)!);
    },
    pointerLeave() { hover.textContent = ""; ed.host.style.cursor = ""; },
    // What the Camera Objects layer draws: the cameras as edited here, saved or not.
    async cameraObjects() { await load; return doc.cameras; },
    keyDown(e) {
      if ((e.key === "Delete" || e.key === "Backspace") && selected) { deleteSelected(); return true; }
      if (e.key === "Escape" && selected) { select([]); renderPanel(); render(); return true; }
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
      // The renames this save makes, taken with the text it writes.
      const saved = doc.cameras, renamed = names.renamed(saved);
      if (asJson) {
        const canonical = await w3.backend.invoke<string>("codec_canonicalize", { root, path: `${FILE}.json`, text });
        await w3.workspace.writeText(`${FILE}.json`, canonical);
      } else {
        await w3.backend.invoke("codec_write", { root, path: FILE, text });
      }
      if (doc.cameras === saved) unsaved = false;
      names.saved(saved);
      // The triggers follow the saved names (GUI parameters; script text after a question).
      if (renamed.length) await renameInTriggers(w3, "cam", renamed, "cameras");
    },
    async reloadFile(path) {
      if (!path.startsWith(FILE)) return false;
      await read();
      unsaved = false;
      select([]);
      if (active) { renderPanel(); render(); }
      return true;
    },
    dispose() { ed.setGroundOverlay(null); ed.setLabels(null); ed.host.style.cursor = ""; },
  };
}
