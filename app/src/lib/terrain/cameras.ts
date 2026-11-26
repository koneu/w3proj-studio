// Camera objects (war3map.w3c) drawn as the World Editor draws them, in the terrain viewer's Camera Objects layer
// and on the Cameras tab: one small camera model with an arrow to its target per camera (cameraMarkers), and where
// a click takes one (markerHandles).

import { float32Text, storableFloat32 } from "../formats/float32";

/** The values of a camera object the drawing needs (the w3c entry has more). */
export interface CameraObject { name?: string; targetX: number; targetY: number; zOffset?: number; rotation: number; distance: number; angleOfAttack: number; fieldOfView: number; posAbsoluteZ?: number; trailer?: number }

/**
 * A free camera (war3map.w3c's camera type 1, the World Editor's Create Free Camera) is kept by where it stands, not
 * by what it looks at: its distance is 1, its target one unit in front of it, and Pos Absolute Z is its height
 * (we-drive 2026-11-26, SD: from the view of target 500, 300, distance 1800, angle of attack 320, rotation 45 the
 * editor made target -474.47, -674.47, Z offset 1156.38, distance 1, Pos Absolute Z 1157.02; the angles, field of
 * view and clipping as for a normal camera). Set Camera To Current View keeps a free camera free. A free camera's Z
 * offset is its target's height itself, not one over the ground (on a hill the editor wrote Z 1492.66 and Pos Absolute
 * Z 1493.49, one unit of the line of sight apart).
 */
export const isFreeCamera = (c: { trailer?: number }) => !!c.trailer;
/** A free camera's distance: its target this far in front of it. */
export const FREE_DISTANCE = 1;
/** A free camera's marker is that of a camera of this distance with its arrow ending at the free camera's target: the
 *  World Editor's has one size, whatever the camera holds (measured on its pictures: the selection circle's radius is
 *  36.8, 0.096 of 384, and the model's length on screen fits). */
export const FREE_MARKER_DISTANCE = 384;
/** How far in front of a free camera Studio's view turns and zooms while looking through it (the picture is the same
 *  from any point on the camera's line of sight; round a point one unit away the view couldn't be moved). */
export const FREE_LOOK_DISTANCE = 1650;

/** The direction a camera looks (unit length), from its rotation and angle of attack in degrees. */
export function cameraForward(c: { rotation: number; angleOfAttack: number }): [number, number, number] {
  const r = c.rotation * RAD, a = c.angleOfAttack * RAD;
  return [Math.cos(a) * Math.cos(r), Math.cos(a) * Math.sin(r), Math.sin(a)];
}

type Placed = Pick<CameraObject, "targetX" | "targetY" | "zOffset" | "rotation" | "angleOfAttack" | "distance" | "trailer">;
/** The height a camera's `zOffset` counts from: the ground under its target, and nothing for a free camera. */
const zBase = (c: Placed, groundZ: (x: number, y: number) => number) => (isFreeCamera(c) ? 0 : groundZ(c.targetX, c.targetY));

/** The point `along` its line of sight from a camera's eye (0: the eye itself), in world coordinates. */
export function sightPoint(c: Placed, groundZ: (x: number, y: number) => number, along: number): [number, number, number] {
  const f = cameraForward(c), k = along - c.distance;
  return [c.targetX + f[0] * k, c.targetY + f[1] * k, zBase(c, groundZ) + (c.zOffset ?? 0) + f[2] * k];
}

/** The values of a free camera standing where the camera (or view) `c` has its eye, looking the same way. */
export function freeCameraAt(c: Placed, groundZ: (x: number, y: number) => number): { targetX: number; targetY: number; zOffset: number; distance: number; posAbsoluteZ: number } {
  const [x, y, z] = sightPoint(c, groundZ, FREE_DISTANCE);
  // Heights past what a camera holds stop there, X and Y as they are: the editor's free camera from a view 4145 up had
  // Z and Pos Absolute Z 4096 (we-compare camera-free-high).
  const held = (v: number, key: "zOffset" | "posAbsoluteZ") => Math.min(CAMERA_RANGES[key]![1], Math.max(CAMERA_RANGES[key]![0], v));
  return { targetX: x, targetY: y, zOffset: held(z, "zOffset"), distance: FREE_DISTANCE, posAbsoluteZ: held(sightPoint(c, groundZ, 0)[2], "posAbsoluteZ") };
}

/** A camera that isn't free, with another target and distance on `c`'s line of sight: the same eye, looking the same way. */
function onSight<C extends Placed>(c: C, groundZ: (x: number, y: number) => number, along: number): C {
  const [x, y, z] = sightPoint(c, groundZ, along);
  return { ...c, targetX: x, targetY: y, zOffset: z - groundZ(x, y), distance: along, trailer: 0 };
}

/** The camera whose target and distance Studio's view takes to look through `c`. */
export const lookCamera = <C extends Placed & { trailer?: number }>(c: C, groundZ: (x: number, y: number) => number): C =>
  (isFreeCamera(c) ? onSight(c, groundZ, FREE_LOOK_DISTANCE) : c);

/** The camera whose marker and selection circle stand for `c`. */
export const markerCamera = <C extends CameraObject>(c: C, groundZ: (x: number, y: number) => number): C =>
  (isFreeCamera(c) ? { ...c, zOffset: (c.zOffset ?? 0) - groundZ(c.targetX, c.targetY), distance: FREE_MARKER_DISTANCE, trailer: 0 } : c);

/** What the World Editor says when Enforce Camera Bounds refuses Create Camera or Set Camera To Current View (its
 *  "Error" box, WESTRING_WARNING_CREATECAMOUTOFBOUNDS). */
export const VIEW_OUTSIDE_BOUNDS = "The current camera position is outside of the world camera bounds.";

/** The rectangle of a w3i's `cameraBounds` (four corners as x, y pairs; the first two are left, bottom and right,
 *  top), or null when it has none to go by. */
function boundsRect(cameraBounds: readonly number[] | null | undefined): { left: number; bottom: number; right: number; top: number } | null {
  if (!Array.isArray(cameraBounds) || cameraBounds.length < 4) return null;
  const xs = cameraBounds.filter((_, i) => i % 2 === 0), ys = cameraBounds.filter((_, i) => i % 2 === 1);
  if (![...xs, ...ys].every((n) => Number.isFinite(n))) return null;
  const left = Math.min(...xs), right = Math.max(...xs), bottom = Math.min(...ys), top = Math.max(...ys);
  return left < right && bottom < top ? { left, bottom, right, top } : null;
}

/**
 * Enforce Camera Bounds, what the World Editor's switch does for a new camera: whether a camera may be made from, or
 * set to, a view whose target is `x`, `y`. With the switch on, Create Camera and Set Camera To Current View refuse a
 * view whose target lies outside the map's camera bounds (`cameraBounds` of war3map.w3i) and show
 * VIEW_OUTSIDE_BOUNDS; a target on the bounds' edge is inside. Where the eye is doesn't count. A map without camera
 * bounds to go by refuses nothing.
 * we-drive 2026-11-14 (branch camera-bounds-we, the empty 64x64 map: camera bounds x -2816..2816, y -3328..2816,
 * playable part to 3328; views of distance 3000, angle of attack 304, rotation 90): refused at 3000, 0 (inside the
 * playable part), 2820, 0, 4096, 0 and 0, 2900 (the eye inside the bounds); made at 2816, 0, 2700, 0, 0, 0 and
 * 0, -3000 (the eye south of the whole map). With the switch off all were made.
 */
export function viewInCameraBounds(cameraBounds: readonly number[] | null | undefined, x: number, y: number): boolean {
  const b = boundsRect(cameraBounds);
  return !b || (x >= b.left && x <= b.right && y >= b.bottom && y <= b.top);
}

/**
 * Enforce Camera Bounds for a camera's typed target: the World Editor's Camera Properties puts a Target X or Y typed
 * past the camera bounds on the bound, without a word (we-drive 2026-11-14: Target X 3100 of a camera at 2700, -600
 * became 2816 with the switch on, and stayed 3100 with it off). The target, or the nearest point of the bounds;
 * the target as it is without bounds to go by, or when it is no number.
 */
export function targetInCameraBounds(cameraBounds: readonly number[] | null | undefined, x: number, y: number): [number, number] {
  const b = boundsRect(cameraBounds);
  if (!b || !Number.isFinite(x) || !Number.isFinite(y)) return [x, y];
  return [Math.min(b.right, Math.max(b.left, x)), Math.min(b.top, Math.max(b.bottom, y))];
}

/** The values the Cameras tab edits, in panel order: key, label, tooltip. Each is a 32-bit float in war3map.w3c. */
export const CAMERA_FIELDS = [
  ["targetX", "X", "Target X"], ["targetY", "Y", "Target Y"], ["zOffset", "Z", "Height offset above the ground"],
  ["rotation", "Rot", "Rotation (degrees; 90 looks north)"], ["angleOfAttack", "AoA", "Angle of attack (degrees; 304 is the game camera)"],
  ["distance", "Dist", "Distance to the target"], ["roll", "Roll", "Roll (degrees; not shown in the preview)"],
  ["fieldOfView", "FoV", "Field of view (degrees)"], ["farZ", "Far", "Far clipping"], ["nearZ", "Near", "Near clipping"],
  ["dofDistance", "DoF", "Depth of field distance (the World Editor's DoF Distance)"], ["dofScale", "DoF ×", "Depth of field scale (DoF Scale)"],
  ["posAbsoluteZ", "Abs Z", "Absolute height of the camera's position (Pos Absolute Z)"],
] as const;
export type CameraField = (typeof CAMERA_FIELDS)[number][0];
/** A field's name in a message: its tooltip without the note in brackets ("Rotation", "Depth of field scale"). */
export const cameraFieldName = (key: CameraField) => (CAMERA_FIELDS.find(([k]) => k === key)?.[2] ?? key).replace(/ \(.*\)$/, "");

/**
 * What the World Editor's Camera Properties keeps of a typed value: it puts anything outside these ranges on the
 * nearest end without a word (we-drive 2026-11-16, branch cam-region-limits, a map of 7 cameras each edited and saved:
 * distance 0 and -100 gave 0.5, 0.3 gave 0.5, 1000000 gave 100000; Rotation, Angle of Attack and Roll -50 gave 0, 400
 * and 500 gave 360, 360.5 gave 360; FoV 0 and 4.5 gave 5, 180 and 200 gave 120, 119.9 stayed; Z Offset 10000000 gave
 * 4096, -10000000 gave -4096, -300 stayed; Near Clipping -5 gave 0, 10000000 gave 9500, 4999 stayed; Far Clipping 0, 1,
 * 10, 50 and -50 gave 101, 10000000 gave 100000; branch we-compare-4, 2026-11-18: DoF Distance -100 gave 0, 10000000
 * and 99999999999 gave 10000, 0.3 stayed; DoF Scale -5 gave 0, 10000000 and 1000.5 gave 1000, 0.25 stayed; Pos
 * Absolute Z ±10000000 and 123456 gave ±4096, -300 stayed). Studio refuses such a value instead (decision 2026-11-15).
 * Local Pitch, Yaw and Roll (the dialog has them too) aren't fields here.
 */
export const CAMERA_RANGES: Partial<Record<CameraField, readonly [number, number]>> = {
  distance: [0.5, 100000], rotation: [0, 360], angleOfAttack: [0, 360], roll: [0, 360], fieldOfView: [5, 120],
  zOffset: [-4096, 4096], nearZ: [0, 9500], farZ: [101, 100000],
  dofDistance: [0, 10000], dofScale: [0, 1000], posAbsoluteZ: [-4096, 4096],
};
/** The least the far clipping lies beyond the near: the editor moves one to keep it (near 6000 over far 5000 gave far
 *  6001; far 150 then near 200 gave near 149; near 100 with far 100.5 gave far 101). */
export const MIN_CLIP_GAP = 1;

/** Why `value` can't be `key` of a camera that has `other` (its camera values), or null. */
function cameraValueProblem(key: CameraField, value: number, label: string, other: Partial<Record<CameraField, number>>): string | null {
  const range = CAMERA_RANGES[key];
  if (range && (value < range[0] || value > range[1])) return `${label} must be from ${range[0]} to ${range[1]}.`;
  if (key === "nearZ" && Number.isFinite(other.farZ) && other.farZ! - value < MIN_CLIP_GAP) return `${label} must be at least ${MIN_CLIP_GAP} below the far clipping (${other.farZ}).`;
  if (key === "farZ" && Number.isFinite(other.nearZ) && value - other.nearZ! < MIN_CLIP_GAP) return `${label} must be at least ${MIN_CLIP_GAP} above the near clipping (${other.nearZ}).`;
  return null;
}

/**
 * A value typed for `key` of the cameras `targets`, as the Cameras tab takes it (docs/testing/refused-values.md): the
 * cameras of `cameras` among them whose value it changes, or why it is refused. A refused value changes nothing: it
 * isn't held to the nearest float, and an empty field or text is no value. `typed`: the field's text.
 */
export function typedCameraValue<C extends Partial<Record<CameraField, number>>>(cameras: readonly C[], targets: readonly C[], key: CameraField, typed: string):
  { value: number; changing: C[] } | { refused: string } {
  const label = cameraFieldName(key);
  const v = Number(typed);
  if (typed.trim() === "" || !storableFloat32(v)) return { refused: float32Text(label) };
  const changing = targets.filter((c) => cameras.includes(c) && c[key] !== v);
  for (const c of changing) {
    const problem = cameraValueProblem(key, v, label, c);
    if (problem) return { refused: problem };
  }
  return { value: v, changing };
}

/** A view's far and near clipping, which a camera made or set from the view takes. */
export interface ViewClip { farZ: number; nearZ: number }

/** The World Editor's own view's clipping: what a camera made from a view that never looked through a camera gets,
 *  whatever its distance (we-drive 2026-11-15, branch camera-farz-we: Create Camera from the opening view of the empty
 *  64x64 map and of 4v4_MountHyjal, and after six wheel notches out to 5314.7, gave far 50000, near 16). */
export const EDITOR_VIEW_CLIP: Readonly<ViewClip> = Object.freeze({ farZ: 50000, nearZ: 16 });

/**
 * The World Editor's Adjust Clipping (Ctrl and the mouse wheel over the terrain view; we-drive 2026-11-23, branch
 * feat/camera-cutoff, the far clipping read back from cameras made after each step, spec tests/we-compare/camera-cutoff.json):
 * a notch toward the user (Wheel Down) multiplies the view's far clipping by 1.1, one away (Wheel Up) divides it by 1.1,
 * both in single precision (50000 one notch nearer is 45454.543, 101 one farther 111.100006); the result is kept within
 * 101 and 100000 (sixty notches either way stop there, also with the near clipping at 100). The near clipping, the
 * camera and the zoom stay; the far plane cuts the picture at that depth from the eye (a straight line across flat
 * ground: 3415.07 cut the opening view of a flat map 3415 deep). Nothing shows the value, and a map opened again
 * starts at EDITOR_VIEW_CLIP.
 */
export const FAR_CLIP = Object.freeze({ step: 1.1, min: 101, max: 100000 });

/** The view's far clipping after one notch of Adjust Clipping (`farther`: Wheel Down), as the World Editor steps it. */
export function stepFarClip(far: number, farther: boolean): number {
  const f = Math.fround;
  const start = Number.isFinite(far) ? far : EDITOR_VIEW_CLIP.farZ;
  const next = farther ? f(f(start) * f(FAR_CLIP.step)) : f(f(start) / f(FAR_CLIP.step));
  return Math.min(FAR_CLIP.max, Math.max(FAR_CLIP.min, next));
}

/** The terrain view's depth range at camera distance `distance` with the view's far clipping `farZ`: the far plane
 *  there (the World Editor's: at 100000 with far 40960 its picture is black), the near one by the distance as Studio
 *  has it (a fiftieth, at least 10), but always well short of the far one so the projection stays whole. */
export function viewDepthRange(distance: number, farZ: number): { near: number; far: number } {
  const far = Number.isFinite(farZ) && farZ > 1 ? farZ : EDITOR_VIEW_CLIP.farZ;
  const byDistance = Number.isFinite(distance) ? Math.max(10, distance / 50) : 10;
  return { near: Math.min(byDistance, far / 4), far };
}

/**
 * The view's clipping as the World Editor keeps it for Create Camera and Set Camera To Current View (spec
 * tests/we-compare/camera-farz.json): EDITOR_VIEW_CLIP when the map opens; View Selected Camera gives the view that
 * camera's far and near clipping, which then stay through zooming and scrolling until another camera is looked
 * through. Distance plays no part (cameras of distance 500 to 5000 with far 5000 or 9000 gave new cameras the same).
 * Adjust Clipping (stepFar) changes the far one. The terrain view draws with it (its far plane).
 */
export class ViewClipping {
  private clip: ViewClip = { ...EDITOR_VIEW_CLIP };
  /** Looking through camera `c` (View): its clipping becomes the view's; a value that is no number keeps the view's. */
  lookThrough(c: Partial<ViewClip>): void {
    this.clip = {
      farZ: Number.isFinite(c.farZ) ? c.farZ! : this.clip.farZ,
      nearZ: Number.isFinite(c.nearZ) ? c.nearZ! : this.clip.nearZ,
    };
  }
  /** One notch of Adjust Clipping: the far clipping by stepFarClip. */
  stepFar(farther: boolean): void { this.clip = { ...this.clip, farZ: stepFarClip(this.clip.farZ, farther) }; }
  /** The clipping a camera made or set from the view takes. */
  current(): ViewClip { return { ...this.clip }; }
}

/** Version 3's floats after the local angles: the World Editor's DoF Distance, DoF Scale and Pos Absolute Z, in the
 *  file's order (the codec's cameras definition). JSON written before they had names keeps them in `unknown`. */
export const DEPTH_OF_FIELD = ["dofDistance", "dofScale", "posAbsoluteZ"] as const;
type DepthOfField = { [K in (typeof DEPTH_OF_FIELD)[number]]?: number } & { unknown?: number[] };

/** Gives a camera of older JSON its named fields (from `unknown`, which goes); a named field already there wins, as the
 *  codec reads it. `fill`: the missing ones become 0, as a version 3 file needs them. */
export function nameDepthOfField(c: DepthOfField, fill = false): void {
  DEPTH_OF_FIELD.forEach((k, i) => {
    const old = c.unknown?.[i];
    if (c[k] === undefined && (old !== undefined || fill)) c[k] = old ?? 0;
  });
  delete c.unknown;
}

const RAD = Math.PI / 180;

/** The camera marker's colour before light (RGB; the renderer lights it with the map's light, setShapes): fitted on
 *  the World Editor's HD pictures (we-drive, 2026-11-13) of 12b_RoC_Orc04Interlude's 28 cameras (mean 49,67,151 at
 *  its opening view) and of cameras on cliff.w3m (136,242,254), together. */
export const MARKER_RGB: readonly [number, number, number] = [66, 112, 228];

/**
 * The World Editor's camera marker, measured with we-drive (2026-11-13, cameras of distance 500, 1000 and 2000 on a
 * flat map; pictures in target/evidence/camera-layer of the main checkout): a small movie camera (a box, two reels on
 * top, a lens in front) and an arrow from it to the target, one model pointing along the camera's view and scaled by
 * its distance, so it is world-sized (it grows as the view comes closer) and a camera farther away draws bigger. The
 * arrow's tip is the target; the camera's back lies 0.365 of the distance from it (the camera's eye is farther out).
 * Sizes below are fractions of the distance, `along` measured back from the target.
 */
const MARKER = {
  head: { tip: 0, base: 0.035, half: 0.008 },
  shaft: { from: 0.035, to: 0.29, half: 0.0022 },
  lens: { front: 0.28, back: 0.295, frontHalf: 0.009, backHalf: 0.006, up: -0.0025 },
  body: { front: 0.295, back: 0.365, half: 0.013, low: -0.009, high: 0.004 },
  reels: { at: [0.313, 0.347], up: 0.0125, radius: 0.0085, half: 0.009 },
};
/**
 * A camera's marker frame: the world point `along` (back from the target toward the eye), `side` (to the camera's
 * right) and `up` (the camera's up) away from its target, all as fractions of its distance. The target stands
 * `zOffset` over the ground (`groundZ`). Null for a camera with a value that isn't a number, or no distance.
 */
function markerFrame(camera: CameraObject, groundZ: (x: number, y: number) => number): ((along: number, side: number, up: number) => number[]) | null {
  if (!(camera.distance > 0)) return null;
  const c = markerCamera(camera, groundZ);
  const zOff = c.zOffset ?? 0;
  if (![c.targetX, c.targetY, zOff, c.rotation, c.distance, c.angleOfAttack].every(Number.isFinite) || c.distance <= 0) return null;
  const tz = groundZ(c.targetX, c.targetY) + zOff;
  if (!Number.isFinite(tz)) return null;
  const r = c.rotation * RAD, a = c.angleOfAttack * RAD, d = c.distance;
  // Forward (from the eye to the target), right and up of the camera.
  const f = [Math.cos(a) * Math.cos(r), Math.cos(a) * Math.sin(r), Math.sin(a)];
  const s = [Math.sin(r), -Math.cos(r), 0];
  const u = [s[1] * f[2] - s[2] * f[1], s[2] * f[0] - s[0] * f[2], s[0] * f[1] - s[1] * f[0]];
  const o = [c.targetX, c.targetY, tz];
  return (along, side, up) => [0, 1, 2].map((i) => o[i] + (-f[i] * along + s[i] * side + u[i] * up) * d);
}

/** Where a camera's marker (cameraMarkers) can be taken: its target (the arrow's tip) and its camera's box, front and
 *  back (world points), and how wide the box is (world units). Null where no marker is drawn. */
export function markerHandles(c: CameraObject, groundZ: (x: number, y: number) => number): { target: number[]; front: number[]; back: number[]; width: number } | null {
  const at = markerFrame(c, groundZ);
  if (!at) return null;
  return { target: at(0, 0, 0), front: at(MARKER.lens.front, 0, 0), back: at(MARKER.body.back, 0, 0), width: 2 * MARKER.body.half * (isFreeCamera(c) ? FREE_MARKER_DISTANCE : c.distance) };
}

/** How far a point (x, y) is from the segment a–b (points on the view, pixels). */
export function segmentDistance(x: number, y: number, a: readonly number[], b: readonly number[]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy) / len2)) : 0;
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

/** Floats per corner of cameraMarkers' triangles: x, y, z, the face's normal, r, g, b, a. */
export const MARKER_STRIDE = 10;

/**
 * The Camera Objects layer: a marker per camera (MARKER) as triangles, MARKER_STRIDE floats per corner (x, y, z, the
 * face's outward normal, then r, g, b, a in 0..1: the colour before light, which the renderer adds as on a placed
 * model). The target stands `zOffset` over the ground (`groundZ`), as the game puts it. A camera with a value that
 * isn't a number, or no distance, is left out.
 */
export function cameraMarkers(cameras: readonly CameraObject[], groundZ: (x: number, y: number) => number,
  rgb: readonly number[] = MARKER_RGB): number[] {
  const out: number[] = [];
  const col = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1];
  for (const c of cameras) {
    const at = markerFrame(c, groundZ);
    if (!at) continue;
    /** A closed part from its faces (corner lists, 3 or 4 each), each shaded by its normal turned away from the part's middle. */
    const part = (faces: number[][][]) => {
      const all = faces.flat(), mid = [0, 1, 2].map((i) => all.reduce((sum, p) => sum + p[i], 0) / all.length);
      for (const face of faces) {
        const [p, q, w] = face;
        const e1 = [0, 1, 2].map((i) => q[i] - p[i]), e2 = [0, 1, 2].map((i) => w[i] - p[i]);
        let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        n = n.map((v) => v / len);
        const centre = [0, 1, 2].map((i) => face.reduce((sum, v) => sum + v[i], 0) / face.length);
        if (n.reduce((sum, v, i) => sum + v * (centre[i] - mid[i]), 0) < 0) n = n.map((v) => -v);
        for (let k = 1; k + 1 < face.length; k++) for (const v of [face[0], face[k], face[k + 1]]) out.push(v[0], v[1], v[2], n[0], n[1], n[2], ...col);
      }
    };
    /** A box or frustum along the view: rectangles at `a0` and `a1` (half side, low and high up each). */
    const frustum = (a0: number, s0: number, lo0: number, hi0: number, a1: number, s1: number, lo1: number, hi1: number) => {
      const ring0 = [at(a0, -s0, lo0), at(a0, s0, lo0), at(a0, s0, hi0), at(a0, -s0, hi0)];
      const ring1 = [at(a1, -s1, lo1), at(a1, s1, lo1), at(a1, s1, hi1), at(a1, -s1, hi1)];
      part([ring0, ring1, ...[0, 1, 2, 3].map((i) => [ring0[i], ring0[(i + 1) % 4], ring1[(i + 1) % 4], ring1[i]])]);
    };
    const { head, shaft, lens, body, reels } = MARKER;
    // The arrowhead: a pyramid with its tip on the target.
    const tip = at(head.tip, 0, 0);
    const base = [at(head.base, -head.half, -head.half), at(head.base, head.half, -head.half), at(head.base, head.half, head.half), at(head.base, -head.half, head.half)];
    part([base, ...[0, 1, 2, 3].map((i) => [tip, base[i], base[(i + 1) % 4]])]);
    frustum(shaft.from, shaft.half, -shaft.half, shaft.half, shaft.to, shaft.half, -shaft.half, shaft.half);
    frustum(lens.front, lens.frontHalf, lens.up - lens.frontHalf, lens.up + lens.frontHalf, lens.back, lens.backHalf, lens.up - lens.backHalf, lens.up + lens.backHalf);
    frustum(body.front, body.half, body.low, body.high, body.back, body.half, body.low, body.high);
    // The reels: eight-sided drums across the camera, on top of the box.
    for (const along of reels.at) {
      const rim = (side: number) => Array.from({ length: 8 }, (_, k) => {
        const t = (k / 8) * Math.PI * 2;
        return at(along + Math.cos(t) * reels.radius, side, reels.up + Math.sin(t) * reels.radius);
      });
      const left = rim(-reels.half), right = rim(reels.half);
      part([left, right, ...left.map((_, k) => [left[k], left[(k + 1) % 8], right[(k + 1) % 8], right[k]])]);
    }
  }
  return out;
}
