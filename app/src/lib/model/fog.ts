// Distance fog: what a map's fog settings do to whatever is drawn, shared by the ground, the water and
// the models, so that everything fades together.

export interface Fog {
  /** 0 linear between start and end, 1 and 2 exponential by density. */
  style: number;
  start: number;
  end: number;
  density: number;
  /** r, g, b in 0–1. */
  color: [number, number, number];
}

const TERRAIN_FOG = 0x2000;

/** A map's fog, or null when its "Fog" option is off: most maps hold values they don't use. Stored blue first. */
export function fogOf(info: { flags?: number; fog?: { style: number; start: number; end: number; density: number; color: number[] } }): Fog | null {
  const fog = info.fog;
  if (!fog || !((info.flags ?? 0) & TERRAIN_FOG)) return null;
  const [b, g, r] = fog.color;
  return { style: fog.style, start: fog.start, end: fog.end, density: fog.density, color: [r / 255, g / 255, b / 255] };
}

/** How much fog is at a depth, 0 to 1: what the shader's `fogged` works out. As in the game (Direct3D's
 *  fixed-function fog), `depth` is the view depth from the eye in world units, whatever the camera looks at:
 *  zoomed out, a near fog covers everything there too. Linear runs from start to end; exponential is
 *  1 - 1/e^(depth·density), squared 1 - 1/e^((depth·density)²), the density taken as it is (per world unit),
 *  so 0.5 is fog all over from the game's camera (1650 away), as the game shows. */
export function fogAmount(f: Pick<Fog, "style" | "start" | "end" | "density">, depth: number): number {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  if (f.style === 0) return f.end > f.start ? clamp((depth - f.start) / (f.end - f.start)) : depth >= f.end ? 1 : 0;
  const d = Math.max(0, depth) * f.density;
  return clamp(1 - Math.exp(f.style === 1 ? -d : -d * d));
}

/** The fog colour for a model layer's filter mode: a layer that adds to or multiplies what's behind it has to
 *  fade to what changes nothing there (black for additive, white for modulate, grey for modulate 2x), or a
 *  fogged tree's additive leaves would light up as a brighter ghost in a fog that hides everything else. */
export function fogColorForBlend(filterMode: number, color: readonly [number, number, number]): [number, number, number] {
  if (filterMode === 3 || filterMode === 4) return [0, 0, 0];
  if (filterMode === 5) return [1, 1, 1];
  if (filterMode >= 6) return [0.5, 0.5, 0.5];
  return [color[0], color[1], color[2]];
}

/** For vertex shaders: declares vFogDepth, to be set to gl_Position.w. */
export const FOG_VS = "out float vFogDepth;";

/** For fragment shaders: fogged(rgb). */
export const FOG_FS = `in float vFogDepth;
uniform vec4 uFogColor; uniform vec3 uFogRange; uniform float uFogStyle;
vec3 fogged(vec3 c) {
  if (uFogColor.a < 0.5) return c;
  float amount;
  if (uFogStyle < 0.5) amount = uFogRange.y > uFogRange.x ? clamp((vFogDepth - uFogRange.x) / (uFogRange.y - uFogRange.x), 0.0, 1.0) : (vFogDepth >= uFogRange.y ? 1.0 : 0.0);
  else {
    // Past 20 it's all fog anyway; the cap keeps the square inside mediump's range.
    float d = min(max(vFogDepth, 0.0) * uFogRange.z, 20.0);
    amount = clamp(1.0 - exp(uFogStyle < 1.5 ? -d : -d * d), 0.0, 1.0);
  }
  return mix(c, uFogColor.rgb, amount);
}`;

/** Sets the shader's fog; null turns it off. */
export function setFog(gl: WebGL2RenderingContext, where: (name: string) => WebGLUniformLocation | null, fog: Fog | null | undefined) {
  gl.uniform4f(where("uFogColor"), fog?.color[0] ?? 0, fog?.color[1] ?? 0, fog?.color[2] ?? 0, fog ? 1 : 0);
  gl.uniform3f(where("uFogRange"), fog?.start ?? 0, fog?.end ?? 0, fog?.density ?? 0);
  gl.uniform1f(where("uFogStyle"), fog?.style ?? 0);
}
