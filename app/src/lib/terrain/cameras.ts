// Camera objects (war3map.w3c) drawn on the ground: the target, the eye, the line between them and
// the field of view, one texel per pathing cell (32 units). The terrain viewer's Camera Objects layer
// and the Camera Editor's overlay both draw them with this.

/** The values of a camera object the drawing needs (the w3c entry has more). */
export interface CameraObject { name?: string; targetX: number; targetY: number; rotation: number; distance: number; angleOfAttack: number; fieldOfView: number }

/** The colours (RGBA) of one camera's parts, and the size of its two dots (radius in cells). */
export interface CameraLook { fov: number[]; line: number[]; target: number[]; eye: number[]; targetRadius: number; eyeRadius: number }

/** The Camera Objects layer of the View menu. */
export const LAYER_LOOK: CameraLook = { fov: [255, 150, 60, 130], line: [255, 190, 60, 230], target: [255, 190, 60, 255], eye: [255, 255, 255, 255], targetRadius: 2, eyeRadius: 1 };

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
/** Cell size of the drawing (world units): the pathing cells. */
export const CAMERA_CELL = 32;

/** Where a camera object's eye is over the ground (x, y): `distance` back from the target along its rotation. */
export const cameraEye = (c: CameraObject): [number, number] => {
  const d = c.distance * Math.abs(Math.cos(c.angleOfAttack * RAD));
  return [c.targetX - d * Math.cos(c.rotation * RAD), c.targetY - d * Math.sin(c.rotation * RAD)];
};

/**
 * The camera objects drawn on the ground, rows from the south, `width` × `height` cells from
 * (offsetX, offsetY). A camera with a value that isn't a number is left out whole. `lookOf` gives
 * each camera its colours (the Camera Editor shows the selected one apart); later cameras are
 * drawn over earlier ones.
 */
export function cameraColors(cameras: readonly CameraObject[], width: number, height: number, offsetX: number, offsetY: number,
  lookOf: (c: CameraObject) => CameraLook = () => LAYER_LOOK): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  const dot = (x: number, y: number, r: number, c: number[]) => {
    const cx = Math.floor((x - offsetX) / CAMERA_CELL), cy = Math.floor((y - offsetY) / CAMERA_CELL);
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
      const px = cx + i, py = cy + j;
      if (i * i + j * j <= r * r + r && px >= 0 && py >= 0 && px < width && py < height) rgba.set(c, (py * width + px) * 4);
    }
  };
  const line = (x0: number, y0: number, x1: number, y1: number, c: number[]) => {
    const n = Math.min(4096, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CAMERA_CELL / 2)));
    for (let k = 0; k <= n; k++) dot(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, 0, c);
  };
  for (const c of cameras) {
    if (![c.targetX, c.targetY, c.rotation, c.distance, c.angleOfAttack, c.fieldOfView].every(Number.isFinite)) continue;
    const look = lookOf(c);
    const [ex, ey] = cameraEye(c);
    // Field of view: two edges from the eye, as long as the eye-to-target line.
    const len = Math.hypot(c.targetX - ex, c.targetY - ey);
    const half = Math.min(80, Math.max(1, c.fieldOfView / 2)) * RAD;
    for (const s of [-1, 1]) {
      const a = c.rotation * RAD + s * half;
      line(ex, ey, ex + (len / Math.cos(half)) * Math.cos(a), ey + (len / Math.cos(half)) * Math.sin(a), look.fov);
    }
    line(ex, ey, c.targetX, c.targetY, look.line);
    dot(c.targetX, c.targetY, look.targetRadius, look.target);
    dot(ex, ey, look.eyeRadius, look.eye);
  }
  return rgba;
}
