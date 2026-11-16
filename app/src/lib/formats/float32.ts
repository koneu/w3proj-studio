// The map files' 32-bit floats (positions, angles, region edges, camera values): what such a field holds.

/** The largest finite 32-bit float. */
export const FLOAT32_MAX = 3.4028234663852886e38;

/** Whether `v` can be stored in a 32-bit float field: a finite number no larger than FLOAT32_MAX either way (past it
 *  the file would hold infinity). Precision is not checked: a value between two floats is stored as the nearer. */
export const storableFloat32 = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= FLOAT32_MAX;

/** What is said of a value a 32-bit float field can't hold. */
export const float32Text = (label: string) => `${label} must be a number from -3.4e38 to 3.4e38 (a 32-bit float).`;
