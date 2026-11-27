// The camera changes of the AI tools (MCP set_camera, remove_camera), on the document war3map.w3c.json holds: the same
// values, ranges and file layout as the Cameras tab (index.ts), without a view to take them from.

import { CAMERA_FIELDS, cameraFieldName, EDITOR_VIEW_CLIP, isFreeCamera, nameDepthOfField, targetInCameraBounds, typedCameraValue, type CameraField } from "../../lib/terrain/cameras";

export interface ToolCamera {
  targetX: number; targetY: number; zOffset: number; rotation: number; angleOfAttack: number; distance: number; roll: number;
  fieldOfView: number; farZ: number; nearZ: number; localPitch?: number; localYaw?: number; localRoll?: number;
  dofDistance?: number; dofScale?: number; posAbsoluteZ?: number; name: string; trailer?: number;
}
export interface ToolCamerasDoc { format?: string; version: number; cameras: ToolCamera[] }

export const emptyCameras = (): ToolCamerasDoc => ({ format: "w3proj.cameras/1", version: 3, cameras: [] });

/** The values set_camera takes, by the names list_cameras gives them (target is [x, y]). */
const TOOL_FIELDS: readonly CameraField[] = ["zOffset", "rotation", "angleOfAttack", "distance", "roll", "fieldOfView", "farZ", "nearZ"];
/** What places a free camera (its height follows them in the Cameras tab, from the ground under it). */
const PLACING = new Set<string>(["targetX", "targetY", "zOffset", "rotation", "angleOfAttack", "distance"]);

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A camera as the Cameras tab makes it without a view to go by: the game camera's angle and distance, looking north,
 *  with the clipping of the World Editor's own view (EDITOR_VIEW_CLIP). */
const newCamera = (name: string): ToolCamera => ({
  targetX: 0, targetY: 0, zOffset: 0, rotation: 90, angleOfAttack: 304, distance: 1650, roll: 0, fieldOfView: 70, ...EDITOR_VIEW_CLIP, name,
});

/**
 * set_camera on `doc`: the camera `name` takes the values given, or is made with them (then `target` is needed; the
 * rest starts as newCamera has it). Every value is held to what the Cameras tab takes (typedCameraValue: the ranges
 * the World Editor keeps, the far clipping above the near, a 32-bit float), the far and near clipping against each
 * other as they end up; one that isn't refuses the call, nothing changed. `bounds`: the map's camera bounds while
 * Enforce Camera Bounds is on (a target past them lands on the bound, as a typed one does). What happened.
 */
export function setCamera(doc: ToolCamerasDoc, args: Record<string, unknown>, bounds: readonly number[] | null): { created: boolean; changed: boolean; camera: ToolCamera; moved?: [number, number] } {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) throw new Error("set_camera needs a name.");
  const values: Partial<Record<CameraField, number>> = {};
  let moved: [number, number] | undefined;
  if (args.target !== undefined) {
    const t = args.target;
    if (!Array.isArray(t) || t.length !== 2 || !t.every((n) => typeof n === "number" && Number.isFinite(n))) throw new Error("target must be [x, y].");
    const [x, y] = targetInCameraBounds(bounds, t[0], t[1]);
    if (x !== t[0] || y !== t[1]) moved = [x, y];
    values.targetX = x;
    values.targetY = y;
  }
  for (const key of TOOL_FIELDS) {
    if (args[key] === undefined) continue;
    if (typeof args[key] !== "number") throw new Error(`${key} must be a number.`);
    values[key] = args[key] as number;
  }
  const at = doc.cameras.findIndex((c) => sameName(c.name, name));
  const created = at < 0;
  if (created && values.targetX === undefined) throw new Error(`There's no camera "${name}": to make it, give target. Cameras: ${doc.cameras.map((c) => c.name).join(", ") || "(none)"}.`);
  const old = created ? newCamera(name) : doc.cameras[at];
  if (!created && isFreeCamera(old) && Object.keys(values).some((k) => PLACING.has(k))) {
    throw new Error(`"${old.name}" is a free camera: its place and direction are set in the Cameras tab (its height follows them there). roll, fieldOfView, farZ and nearZ can be set here.`);
  }
  const next: ToolCamera = { ...old, ...values };
  for (const key of Object.keys(values) as CameraField[]) {
    // Against the camera as it ends up, so far and near clipping given together are checked once, as a pair.
    const probe = { ...next, [key]: undefined } as Partial<Record<CameraField, number>>;
    const t = typedCameraValue([probe], [probe], key, String(values[key]));
    if ("refused" in t) throw new Error(`Not ${created ? "made" : "changed"}: ${t.refused}`);
  }
  const changed = created || (Object.keys(values) as CameraField[]).some((k) => old[k as keyof ToolCamera] !== values[k]);
  if (changed) {
    if (created) doc.cameras.push(next); else doc.cameras[at] = next;
    layOut(doc);
  }
  return { created, changed, camera: next, ...(moved ? { moved } : {}) };
}

/** remove_camera on `doc`; the camera that went. */
export function removeCamera(doc: ToolCamerasDoc, name: unknown): ToolCamera {
  const at = typeof name === "string" ? doc.cameras.findIndex((c) => sameName(c.name, name.trim())) : -1;
  if (at < 0) throw new Error(`There's no camera "${String(name)}". Cameras: ${doc.cameras.map((c) => c.name).join(", ") || "(none)"}.`);
  return doc.cameras.splice(at, 1)[0];
}

/** The file's layout as the Cameras tab's save writes it: a classic file (or one written empty) takes the Reforged
 *  layout once it has cameras, and every camera has that layout's fields. */
function layOut(doc: ToolCamerasDoc) {
  if (doc.version < 3 && doc.cameras.length) doc.version = 3;
  if (doc.version < 3) return;
  for (const c of doc.cameras) {
    Object.assign(c, { localPitch: c.localPitch ?? 0, localYaw: c.localYaw ?? 0, localRoll: c.localRoll ?? 0, trailer: c.trailer ?? 0 });
    nameDepthOfField(c, true);
  }
}

/** A camera as list_cameras and set_camera's answer show it. */
export const describeCamera = (c: ToolCamera) => ({
  name: c.name, ...(isFreeCamera(c) ? { free: true } : {}), target: [c.targetX, c.targetY], zOffset: c.zOffset, rotation: c.rotation, angleOfAttack: c.angleOfAttack,
  distance: c.distance, roll: c.roll, fieldOfView: c.fieldOfView, farZ: c.farZ, nearZ: c.nearZ,
});

export { CAMERA_FIELDS, cameraFieldName };
