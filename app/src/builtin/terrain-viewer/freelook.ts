// The Cameras tab's Free view: the view turns round its own eye, not round the point it looks at, and the wheel
// moves the eye along where it looks. So it can stand close over the ground and look up, for making cameras; the
// World Editor's own controls (which the view keeps otherwise) can't. `yaw` points from the target to the eye and
// `pitch` lifts the eye, as the view's camera has them: a pitch below 0 looks up.

type Vec3 = [number, number, number];
export interface LookView { target: readonly number[]; yaw: number; pitch: number; distance: number }

/** The steepest the view looks up or down. */
export const FREE_PITCH = Math.PI / 2 - 0.02;
/** The least the eye stays over the ground (world units). */
export const EYE_CLEARANCE = 16;
/** A wheel step's length: this share of the eye's height over the ground, within these. */
const STEP = { share: 0.2, min: 24, max: 600 };

/** From the target to the eye, unit length. */
const back = (yaw: number, pitch: number): Vec3 => [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)];

export function eyeOf(v: LookView): Vec3 {
  const b = back(v.yaw, v.pitch);
  return [v.target[0] + b[0] * v.distance, v.target[1] + b[1] * v.distance, v.target[2] + b[2] * v.distance];
}

const around = (eye: Vec3, yaw: number, pitch: number, distance: number): Vec3 => {
  const b = back(yaw, pitch);
  return [eye[0] - b[0] * distance, eye[1] - b[1] * distance, eye[2] - b[2] * distance];
};

/** The view turned by `dYaw` and `dPitch` round its eye, which stays; the pitch within FREE_PITCH. */
export function lookAround(v: LookView, dYaw: number, dPitch: number): { target: Vec3; yaw: number; pitch: number } {
  const yaw = v.yaw + dYaw, pitch = Math.max(-FREE_PITCH, Math.min(FREE_PITCH, v.pitch + dPitch));
  return { target: around(eyeOf(v), yaw, pitch, v.distance), yaw, pitch };
}

/** One wheel step along where the view looks (`ahead`: forward): longer the higher the eye, and the eye stays
 *  EYE_CLEARANCE over the ground. Gives the new target. */
export function flyStep(v: LookView, ahead: boolean, groundZ: (x: number, y: number) => number): Vec3 {
  const eye = eyeOf(v), b = back(v.yaw, v.pitch);
  const step = Math.max(STEP.min, Math.min(STEP.max, (eye[2] - groundZ(eye[0], eye[1])) * STEP.share)) * (ahead ? 1 : -1);
  const next: Vec3 = [eye[0] - b[0] * step, eye[1] - b[1] * step, eye[2] - b[2] * step];
  next[2] = Math.max(next[2], groundZ(next[0], next[1]) + EYE_CLEARANCE);
  return around(next, v.yaw, v.pitch, v.distance);
}

/** The distance panning moves the view by: by the eye's height over the ground, so it doesn't race close to it. */
export function panReach(v: LookView, groundZ: (x: number, y: number) => number): number {
  const eye = eyeOf(v);
  return Math.max(200, Math.min(2000, eye[2] - groundZ(eye[0], eye[1])));
}
