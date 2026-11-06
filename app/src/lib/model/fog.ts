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

/** The game's camera: maps set their fog for what's seen from this far. */
const GAME_CAMERA = 1650;

/** Fog as seen from an editor's camera `distance` from what it looks at: a map's fog is meant for the game's
 *  camera, so from further out it would cover everything. It moves back, so what's looked at stays as clear
 *  as in the game, and what's further away fades as it does there. */
export const fogForCamera = (f: Fog, distance: number): Fog => {
  const back = Math.max(0, distance - GAME_CAMERA);
  return { ...f, start: f.start + back, end: f.end + back };
};

/** How much fog is at a depth, 0 to 1: what the shader's fogAmount works out. The scale of the exponential
 *  styles is a guess: almost no map uses them. */
export function fogAmount(f: Pick<Fog, "style" | "start" | "end" | "density">, depth: number): number {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  if (f.style === 0) return f.end > f.start ? clamp((depth - f.start) / (f.end - f.start)) : depth >= f.end ? 1 : 0;
  const d = (depth * f.density) / EXP_SCALE;
  return clamp(1 - Math.exp(f.style === 1 ? -d : -d * d));
}

const EXP_SCALE = 1000;

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
    float d = vFogDepth * uFogRange.z / ${EXP_SCALE.toFixed(1)};
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
