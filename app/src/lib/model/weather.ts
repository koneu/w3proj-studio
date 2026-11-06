// Weather: a row of Weather.slk as a particle emitter. The game's weather models hold no emitters of the
// kind drawn here, while the table has them in full, so the emitter is made from the row.

import type { Model, ParticleEmitter2 } from "./mdx";
import type { Mat4 } from "./renderer";

/** The ground a weather covers. */
export interface WeatherBox { left: number; right: number; bottom: number; top: number }

export interface WeatherEffect {
  /** A model of one emitter; the emitter is changed as the box moves. */
  model: Model;
  /** The texture, without its extension. */
  texture: string;
  /** How high above the ground it starts. */
  height: number;
  /** Particles alive at once over GAME_VIEW. */
  particles: number;
  /** Which way it flies, as the world's +Z tilted, and how far sideways over its life. */
  tilt: Mat4;
  drift: [number, number];
}

/** The ground a game camera sees, which a row's particle count is taken to fill. */
export const GAME_VIEW = 2400;
/** The most particles of one weather, on a big region or from far away. */
export const MOST_PARTICLES = 6000;

const number = (row: Record<string, string>, key: string) => Number(row[key]) || 0;

/** Tilted by the row's angles about the x and y axes. */
function tiltOf(ax: number, ay: number): Mat4 {
  const [sx, cx, sy, cy] = [Math.sin(ax), Math.cos(ax), Math.sin(ay), Math.cos(ay)];
  return new Float32Array([cy, 0, -sy, 0, sx * sy, cx, sx * cy, 0, cx * sy, -sx, cx * cy, 0, 0, 0, 0, 1]);
}

/** The effect of a Weather.slk row. */
export function weatherEffect(row: Record<string, string>): WeatherEffect {
  const speed = number(row, "veloc"), lifespan = Math.max(0.05, number(row, "lifespan"));
  const head = number(row, "head") !== 0, tail = number(row, "tail") !== 0;
  const color = (part: string): [number, number, number] => [number(row, `red${part}`) / 255, number(row, `green${part}`) / 255, number(row, `blue${part}`) / 255];
  const cells = (from: string, to: string): [number, number, number] => [number(row, from), number(row, to), 1];
  const emitter: ParticleEmitter2 = {
    node: { name: "weather", objectId: 0, parentId: -1, flags: 0, kind: "weather" },
    speed, variation: number(row, "var"), latitude: number(row, "lati"), gravity: number(row, "accel"), lifespan,
    emissionRate: 0, width: 0, length: 0,
    filterMode: number(row, "alphaMode"),
    rows: Math.max(1, number(row, "texr")), columns: Math.max(1, number(row, "texc")),
    headOrTail: tail ? (head ? 2 : 1) : 0, tailLength: number(row, "taillen"), time: number(row, "midTime"),
    segmentColor: [color("Start"), color("Mid"), color("End")],
    segmentAlpha: [number(row, "alphaStart"), number(row, "alphaMid"), number(row, "alphaEnd")],
    segmentScaling: [number(row, "scaleStart"), number(row, "scaleMid"), number(row, "scaleEnd")],
    headIntervals: cells("hUVStart", "hUVMid"), headDecayIntervals: cells("hUVMid", "hUVEnd"),
    tailIntervals: cells("tUVStart", "tUVMid"), tailDecayIntervals: cells("tUVMid", "tUVEnd"),
    textureId: 0, squirt: false, priorityPlane: 0, replaceableId: 0,
  };
  const model: Model = {
    version: 0, name: `weather ${row.effectID}`, extent: { radius: 0, min: [0, 0, 0], max: [0, 0, 0] }, sequences: [], globalSequences: [], textures: [], materials: [],
    geosets: [], geosetAnims: [], nodes: [emitter.node], pivots: new Float32Array(3), particleEmitters2: [emitter], ribbons: [],
    textureAnims: [], skipped: [], warnings: [],
  };
  const tilt = tiltOf((number(row, "angx") * Math.PI) / 180, (number(row, "angy") * Math.PI) / 180);
  return {
    model, texture: `${row.texDir}\\${row.texFile}`, height: number(row, "height"), particles: number(row, "particles"),
    tilt, drift: [tilt[8] * speed * lifespan, tilt[9] * speed * lifespan],
  };
}

/** Sets the emitter for a box at ground height `z`, and gives where it stands. The box's particles keep the
 *  density of a game view, up to MOST_PARTICLES, and start upwind so that they come down over the box. */
export function placeWeather(w: WeatherEffect, box: WeatherBox, z: number): Mat4 {
  const e = w.model.particleEmitters2[0];
  e.width = box.right - box.left;
  e.length = box.top - box.bottom;
  const alive = Math.min(MOST_PARTICLES, (w.particles * e.width * e.length) / (GAME_VIEW * GAME_VIEW));
  e.emissionRate = alive / e.lifespan;
  const world = new Float32Array(w.tilt);
  world[12] = (box.left + box.right) / 2 - w.drift[0] / 2;
  world[13] = (box.bottom + box.top) / 2 - w.drift[1] / 2;
  world[14] = z + w.height;
  return world;
}

/** The box of a weather that follows the view, as wide as what's seen from `distance`. */
export function viewBox(x: number, y: number, distance: number): WeatherBox {
  const half = Math.max(GAME_VIEW, distance * 1.8) / 2;
  return { left: x - half, right: x + half, bottom: y - half, top: y + half };
}
