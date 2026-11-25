// war3map.w3i's terrain fog of version 39 (crates/w3proj/formats/w3i.json `terrainFog`): the World Editor's Height Start,
// Height End, Linear Start, Linear End, Max Opacity and Draw Fog Over Sky (Map Options, Height fog style; measured
// 2026-11-25, docs/testing/numeric-limits-measured.md).

/** The six words in the file's order. */
export interface TerrainFog {
  heightStart: number; heightEnd: number; linearStart: number; linearEnd: number; maxOpacity: number;
  /** 1 when ticked; any other number is drawn over the sky too (the script passes `!= 0`). */
  drawOverSky: number;
}

/** A 32-bit float as the codec writes it: a number, or "f32:0x…" (its bits) for NaN and infinities. */
type F32 = number | string;

const word = new DataView(new ArrayBuffer(4));
const bitsOfF32 = (v: unknown): number | undefined => {
  if (typeof v === "string") {
    const m = /^f32:0x([0-9a-f]{8})$/i.exec(v);
    if (!m) return undefined;
    word.setUint32(0, parseInt(m[1], 16), true);
  } else if (typeof v === "number") word.setFloat32(0, v, true);
  else return undefined;
  return word.getInt32(0, true);
};
const f32OfBits = (v: unknown): F32 | undefined => {
  if (typeof v !== "number" || !Number.isInteger(v)) return undefined;
  word.setInt32(0, v, true);
  const f = word.getFloat32(0, true);
  return Number.isFinite(f) ? f : `f32:0x${word.getUint32(0, true).toString(16).padStart(8, "0")}`;
};

/** Older JSON's names for heightStart, heightEnd and drawOverSky, and the type it gave their bytes: what the codec
 *  reads when the name is missing (`was`, `wasType`). */
const OLDER = [["heightStart", "style", f32OfBits], ["heightEnd", "overSky", f32OfBits], ["drawOverSky", "height", bitsOfF32]] as const;

/** The terrain fog of war3map.w3i's JSON with its names, also from JSON written before them (`style` and `overSky`, the
 *  i32 of Height Start's and End's bits; `height`, the f32 of Draw Fog Over Sky's), as the codec reads it: a name
 *  already there wins and the old keys go, the bytes stay. A copy; undefined stays undefined. */
export function namedTerrainFog<T>(tf: T): T extends object ? TerrainFog : T {
  if (!tf || typeof tf !== "object") return tf as never;
  const out: Record<string, unknown> = { ...(tf as Record<string, unknown>) };
  for (const [name, old, convert] of OLDER) {
    if (out[name] === undefined && out[old] !== undefined) {
      const v = convert(out[old]);
      if (v !== undefined) out[name] = v;
    }
    if (out[name] !== undefined) delete out[old];
  }
  return out as never;
}
