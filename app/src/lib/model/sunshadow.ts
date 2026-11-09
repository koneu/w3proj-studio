// The sun's shadows in HD, as the World Editor's Reforged view casts them: the models' (and cliffs') own shapes, from
// the sun of the lighting model, on the ground and on the models. A depth picture from the sun (a shadow map) holds
// how far the sun's light gets; a surface farther than that is in shadow.
//
// Only what the camera sees needs shadows: the map covers the ground in view (clipped to the map and to a reach
// around the camera), seen from the sun, and reaches far enough toward the sun for anything standing in between to
// cast into it. Its edges move in whole texels so that the shadows don't crawl while the camera moves.

import type { Mat4, Vec3 } from "./renderer";

/** a · b of two column-major 4 × 4 matrices (renderer.ts has mat4.mul; that module reads SUN_FS from this one). */
function mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return out;
}

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: readonly number[]): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** The sun's lowest height (the cosine to straight up) shadows are cast from: a sun at or below the horizon would
 *  stretch every shadow without end. Lower suns are raised to this. */
export const LOWEST_SUN = 0.15;

/** The direction toward the sun (any length) as shadows are cast from it: unit length, at least LOWEST_SUN up. */
export function castingSun(dir: readonly number[]): Vec3 {
  let d = unit(dir);
  if (!(d[2] >= LOWEST_SUN)) {
    const flat = Math.hypot(d[0], d[1]);
    // Straight down or not a number: overhead.
    if (!(flat > 1e-6)) return [0, 0, 1];
    const s = Math.sqrt(1 - LOWEST_SUN * LOWEST_SUN) / flat;
    d = [d[0] * s, d[1] * s, LOWEST_SUN];
  }
  return d;
}

/** The axes the shadow map is laid out on: right and up across it, and `toward`, the direction toward the sun (the
 *  map looks along -toward). The map's up is north on the ground as far as it can be. */
export function sunAxes(dir: readonly number[]): { right: Vec3; up: Vec3; toward: Vec3 } {
  const toward = castingSun(dir);
  // North, unless the sun is straight overhead in the north-south plane: then east.
  const ref: Vec3 = Math.abs(toward[1]) > 0.999 ? [1, 0, 0] : [0, 1, 0];
  const right = unit(cross(ref, toward));
  const up = cross(toward, right);
  return { right, up, toward };
}

/** A box in the sun's axes: across (right, up) and along (depth from the sun: larger is farther from it). */
export interface SunBox { left: number; right: number; bottom: number; top: number; near: number; far: number }

/** World points in the sun's axes: [across right, across up, depth from the sun]. */
export function toSun(axes: ReturnType<typeof sunAxes>, p: readonly number[]): Vec3 {
  return [dot(axes.right, p), dot(axes.up, p), -dot(axes.toward, p)];
}

/** What the camera sees of the ground: the points where the view's corner rays (and its middle) cross the lowest and
 *  highest ground, no farther than `reach` from the eye, put inside the map's rectangle. */
export interface ViewGround {
  eye: Vec3;
  /** Unit directions of the view's rays through the picture's four corners and its middle. */
  rays: Vec3[];
  /** The lowest and highest ground (and water) of the map. */
  zMin: number;
  zMax: number;
  /** How far from the eye shadows are drawn at most. */
  reach: number;
  /** The map's rectangle: x0, y0, x1, y1. */
  rect: [number, number, number, number];
}

/** The corner rays of a camera (eye looking at target, vertical field of view fov, width over height aspect) and its
 *  middle, as unit directions: as TerrainRenderer.ray makes them. */
export function viewRays(eye: readonly number[], target: readonly number[], fov: number, aspect: number): Vec3[] {
  const f = unit([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
  let r = unit([f[1], -f[0], 0]);
  if (Math.hypot(f[0], f[1]) < 1e-6) r = [1, 0, 0];
  const u = cross(r, f);
  const t = Math.tan(fov / 2);
  return [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]].map(([nx, ny]) => unit([
    f[0] + r[0] * nx * t * aspect + u[0] * ny * t,
    f[1] + r[1] * nx * t * aspect + u[1] * ny * t,
    f[2] + r[2] * nx * t * aspect + u[2] * ny * t,
  ]));
}

/** The points of the ground in view (ViewGround), at most 15: on every ray, where it is at the highest and the lowest
 *  ground (or at its reach, where it doesn't get there), and the eye's own spot when it's above the map. */
export function groundInView(v: ViewGround): Vec3[] {
  const [x0, y0, x1, y1] = v.rect;
  const clampXY = (p: Vec3): Vec3 => [Math.min(x1, Math.max(x0, p[0])), Math.min(y1, Math.max(y0, p[1])), p[2]];
  const out: Vec3[] = [];
  for (const d of v.rays) {
    const at = (t: number): Vec3 => [v.eye[0] + d[0] * t, v.eye[1] + d[1] * t, v.eye[2] + d[2] * t];
    // Where the ray is at height z, within [0, reach]; a ray that never gets there ends at its reach.
    const tAt = (z: number) => {
      if (Math.abs(d[2]) < 1e-9) return v.reach;
      const t = (z - v.eye[2]) / d[2];
      return t < 0 ? (v.eye[2] > z === d[2] > 0 ? v.reach : 0) : Math.min(t, v.reach);
    };
    const tHigh = tAt(v.zMax), tLow = tAt(v.zMin);
    // Only the part of the ray between the two heights meets ground.
    out.push(clampXY(at(Math.min(tHigh, tLow))), clampXY(at(Math.max(tHigh, tLow))));
  }
  out.push(clampXY([v.eye[0], v.eye[1], Math.min(v.zMax, Math.max(v.zMin, v.eye[2]))]));
  return out.map((p) => [p[0], p[1], Math.min(v.zMax, Math.max(v.zMin, p[2]))] as Vec3);
}

/**
 * The box of the shadow map, in the sun's axes: around the ground points `receivers`, reaching `casterHeight` above
 * them toward the sun (so a tall model or a cliff between the sun and the ground in view casts into it), and moved
 * and sized in whole texels of a `size`-texel map so that the shadows stay put as the view moves: its size rounds up
 * to a power of 2 in steps of an eighth, its corner to a texel.
 */
export function fitSunBox(axes: ReturnType<typeof sunAxes>, receivers: readonly Vec3[], casterHeight: number, size: number): SunBox {
  let l = Infinity, r = -Infinity, b = Infinity, t = -Infinity, n = Infinity, f = -Infinity;
  for (const p of receivers) {
    const s = toSun(axes, p);
    l = Math.min(l, s[0]); r = Math.max(r, s[0]);
    b = Math.min(b, s[1]); t = Math.max(t, s[1]);
    n = Math.min(n, s[2]); f = Math.max(f, s[2]);
  }
  if (!(l <= r && b <= t)) return { left: -1, right: 1, bottom: -1, top: 1, near: -1, far: 1 };
  // A caster casterHeight above a receiver is that much farther toward the sun along the sun's ray (over its height).
  n -= casterHeight / Math.max(axes.toward[2], LOWEST_SUN);
  // Quantised sizes: the same box for small changes of the view, which keeps the texels where they were.
  const quantise = (span: number) => Math.max(256, 2 ** (Math.ceil(Math.log2(Math.max(1, span)) * 8) / 8));
  const w = quantise(r - l), h = quantise(t - b);
  const cx = (l + r) / 2, cy = (b + t) / 2;
  const tx = w / size, ty = h / size;
  const left = Math.floor((cx - w / 2) / tx) * tx, bottom = Math.floor((cy - h / 2) / ty) * ty;
  return { left, right: left + w, bottom, top: bottom + h, near: n - 16, far: f + 16 };
}

/** An orthographic projection of the box (clip x, y, z in -1..1 over left..right, bottom..top, near..far). */
function ortho(box: SunBox): Mat4 {
  const m = new Float32Array(16);
  m[0] = 2 / (box.right - box.left);
  m[5] = 2 / (box.top - box.bottom);
  m[10] = 2 / (box.far - box.near);
  m[12] = -(box.right + box.left) / (box.right - box.left);
  m[13] = -(box.top + box.bottom) / (box.top - box.bottom);
  m[14] = -(box.far + box.near) / (box.far - box.near);
  m[15] = 1;
  return m;
}

/** World to the shadow map's clip space (x, y, depth in -1..1) for the sun's axes and a box. */
export function sunViewProj(axes: ReturnType<typeof sunAxes>, box: SunBox): Mat4 {
  const { right: r, up: u, toward: z } = axes;
  // Rows: right, up, -toward (depth grows away from the sun).
  const view = new Float32Array([r[0], u[0], -z[0], 0, r[1], u[1], -z[1], 0, r[2], u[2], -z[2], 0, 0, 0, 0, 1]);
  return mul(ortho(box), view);
}

/** The shadow map's lookup matrix: world to texture coordinates and depth, all 0..1 (what the shaders sample with). */
export function sunLookup(viewProj: Mat4): Mat4 {
  const bias = new Float32Array([0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0.5, 0.5, 0.5, 1]);
  return mul(bias, viewProj);
}

/** The texture unit the shaders read the shadow map from (the model shader uses 0–4). */
export const SUN_UNIT = 5;

/** A frame's shadow map as the shaders read it: the depth texture, world to its texture coordinates (sunLookup), and
 *  how big a texel is on the ground (world units). */
export interface SunShadow { texture: WebGLTexture; lookup: Mat4; texel: number; size: number }

/**
 * For fragment shaders: `sunLit(world, normal)`, how much of the sun reaches a world point (0 in shadow, 1 lit, between
 * at the soft edge), 1 without a shadow map (uSunOn 0) and outside it. Nine filtered lookups a texel and a half apart
 * (each comparison already blends four texels), the point pushed off its surface by a texel and a half along its normal
 * so that a surface doesn't shadow itself, and the shadow fading out toward the map's edge.
 */
export const SUN_FS = `uniform highp sampler2DShadow uSunShadow; uniform highp mat4 uSunLookup; uniform float uSunOn;
uniform highp float uSunTexel; uniform highp float uSunStep;
float sunLit(highp vec3 world, vec3 normal) {
  if (uSunOn < 0.5) return 1.0;
  vec3 n = normalize(normal);
  highp vec4 p = uSunLookup * vec4(world + n * (uSunTexel * 1.5), 1.0);
  highp vec2 edge = min(p.xy, 1.0 - p.xy);
  float fade = clamp(min(edge.x, edge.y) * 20.0, 0.0, 1.0);
  if (fade <= 0.0 || p.z >= 1.0) return 1.0;
  float s = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    s += texture(uSunShadow, vec3(p.xy + vec2(float(i), float(j)) * uSunStep, p.z - 0.0005));
  }
  return mix(1.0, s / 9.0, fade);
}`;

/** Sets a shader's shadow map (SUN_FS) on SUN_UNIT: the frame's, or none (`fallback`, a depth texture that's lit
 *  everywhere: a shadow sampler always needs one bound, or the draw fails). */
export function setSunShadow(gl: WebGL2RenderingContext, where: (name: string) => WebGLUniformLocation | null, sun: SunShadow | null | undefined, fallback: WebGLTexture) {
  gl.activeTexture(gl.TEXTURE0 + SUN_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, sun?.texture ?? fallback);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(where("uSunShadow"), SUN_UNIT);
  gl.uniform1f(where("uSunOn"), sun ? 1 : 0);
  if (!sun) return;
  gl.uniformMatrix4fv(where("uSunLookup"), false, sun.lookup);
  gl.uniform1f(where("uSunTexel"), sun.texel);
  gl.uniform1f(where("uSunStep"), 1.5 / sun.size);
}

/** A depth texture of `size` × `size` that shaders compare against (sampler2DShadow), filtered (each lookup blends
 *  four comparisons); `data` its depths (UNSIGNED_SHORT), or none. */
export function depthTexture(gl: WebGL2RenderingContext, size: number, data: Uint16Array | null = null): WebGLTexture | null {
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (data) gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT16, size, size, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_SHORT, data);
  else gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  return tex;
}

/**
 * The shadow map's GPU side: a depth texture and the framebuffer drawing into it, made on first use. A lost context
 * takes both: they're made again once it's back (`begin` says false meanwhile, and the frame draws without shadows),
 * and a framebuffer the GPU won't take turns the shadows off for good rather than failing every frame.
 */
export class SunShadowMap {
  private texture: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;
  /** The framebuffer couldn't be made complete: no shadows on this GPU. */
  private failed = false;
  private stale = false;
  private readonly onLost = () => { this.stale = true; };

  constructor(readonly gl: WebGL2RenderingContext, readonly size = 2048) {
    gl.canvas.addEventListener?.("webglcontextlost", this.onLost);
  }

  /** Binds the framebuffer for the depth pass (viewport, cleared depth); false when there's none to draw into. */
  begin(): boolean {
    const gl = this.gl;
    if (this.failed || gl.isContextLost()) return false;
    if (this.stale) { this.texture = null; this.fbo = null; this.stale = false; }
    if (!this.fbo) {
      this.texture = depthTexture(gl, this.size);
      this.fbo = gl.createFramebuffer();
      if (!this.texture || !this.fbo) { this.texture = this.fbo = null; return false; }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.texture, 0);
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.free();
        // A lost context reports incomplete too: that isn't this GPU refusing.
        if (!gl.isContextLost()) this.failed = true;
        return false;
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.size, this.size);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    return true;
  }

  /** Back to the picture's framebuffer; the shadow map to read, with the frame's fit. */
  end(lookup: Mat4, texel: number): SunShadow | null {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    return this.texture ? { texture: this.texture, lookup, texel, size: this.size } : null;
  }

  private free() {
    const gl = this.gl;
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.texture) gl.deleteTexture(this.texture);
    this.fbo = this.texture = null;
  }

  dispose() {
    this.free();
    this.gl.canvas.removeEventListener?.("webglcontextlost", this.onLost);
  }
}

/** The whole fit for a frame:the sun's matrix for drawing the map, its lookup, and how big a texel is on the ground
 *  (world units; the shaders' bias against a surface shadowing itself grows with it). */
export function sunShadowFrame(sunDir: readonly number[], view: ViewGround, casterHeight: number, size: number) {
  const axes = sunAxes(sunDir);
  const box = fitSunBox(axes, groundInView(view), casterHeight, size);
  const viewProj = sunViewProj(axes, box);
  return { axes, box, viewProj, lookup: sunLookup(viewProj), texel: Math.max(box.right - box.left, box.top - box.bottom) / size };
}
