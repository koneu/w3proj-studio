// The World Editor's view, for comparing pictures of Studio with pictures of the editor: the size of its terrain
// view, its opening camera, the camera objects we-drive.mjs adds for `--look`, and the Studio camera app-drive.mjs
// sets for `--camera we`. Plain functions (no game, no app): we-camera.test.mjs runs them in CI.
//
// A look is "x,y[,distance[,aoa[,fov[,rotation]]]]", or "center[,distance…]" for the terrain's centre; missing values
// are the editor's opening camera.

/** The editor's terrain view in we-drive's display (TESTING.md, "Layout"). */
export const WE_VIEW = Object.freeze({ width: 1184, height: 844 });

/** The hour the editor stands at with its day and night fixed (its status bar: "Time: 06:00"; we-drive's default). */
export const WE_FIXED_HOUR = 6;

/**
 * Studio's terrain settings for a comparison with the editor (TESTING.md, "Comparing pictures"). "game" pairs with
 * we-drive's --compare-ready (game view on, the day fixed at WE_FIXED_HOUR): Studio's game view (V) at that hour, which
 * also leaves out the start locations, regions and the rest the editor hides there. "lit" is the map's lighting at that
 * hour with the editor's marks still drawn (the pair before Studio had a game view). "unlit" pairs with
 * --compare-ready-unlit (game view off, View > Lighting off): Studio's even light. Each sets game view, so a remembered
 * one doesn't carry into the comparison.
 */
export function studioLighting(mode) {
  if (mode === "game") return { "terrain.gameView": true, "terrain.lighting.enabled": true, "terrain.lighting.hour": WE_FIXED_HOUR };
  if (mode === "lit") return { "terrain.gameView": false, "terrain.lighting.enabled": true, "terrain.lighting.hour": WE_FIXED_HOUR };
  if (mode === "unlit") return { "terrain.gameView": false, "terrain.lighting.enabled": false };
  throw new Error(`a comparison is game, lit or unlit, not ${mode}`);
}

/** The camera the editor opens a map with, at the terrain's centre (TESTING.md, "The default camera"). */
export const WE_OPENING = Object.freeze({ distance: 3000, aoa: 304, fov: 70, rotation: 90 });

/**
 * Studio's camera for the editor's view of angle of attack 304 and field of view 70, fitted from a 256 grid of marked
 * ground corners at the view's 1184:844 (0.5 px rms; TESTING.md): the target moves towards the eye by SHIFT times the
 * distance, Studio's distance is SCALE times the editor's, pitch and vertical field of view are fixed.
 */
const FIT = Object.freeze({ aoa: 304, fov: 70, shift: 298 / 3000, scale: 2738 / 3000, pitch: 57.2, fovStudio: 41.06 });

const names = ["distance", "aoa", "fov", "rotation"];

/** Parses a look; throws on anything else (an unknown word, a value that isn't a number, too many values). */
export function parseLook(spec) {
  const parts = String(spec).split(",").map((s) => s.trim());
  const look = { center: false, x: null, y: null, ...WE_OPENING };
  let rest;
  if (/^(center|centre)$/i.test(parts[0])) {
    look.center = true;
    rest = parts.slice(1);
  } else {
    if (parts.length < 2) throw new Error(`a look is x,y[,distance[,aoa[,fov[,rotation]]]] or center[,distance…], not "${spec}"`);
    [look.x, look.y] = parts.slice(0, 2).map((p) => number(p, spec));
    rest = parts.slice(2);
  }
  if (rest.length > names.length) throw new Error(`a look has at most ${names.length} values after the target, not "${spec}"`);
  rest.forEach((p, i) => { if (p !== "") look[names[i]] = number(p, spec); });
  if (!(look.distance > 0)) throw new Error(`a look's distance must be above 0 ("${spec}")`);
  return look;
}

function number(p, spec) {
  const n = Number(p);
  if (p === "" || !Number.isFinite(n)) throw new Error(`"${p}" in the look "${spec}" isn't a number`);
  return n;
}

/** The size and corner (0, 0) of the terrain, from the head of a project's war3map.w3e.txt. */
export function terrainHead(w3eText) {
  const corners = /^corners\s+(\d+)\s+(\d+)\s*$/m.exec(w3eText);
  const offset = /^offset\s+(-?[\d.]+)\s+(-?[\d.]+)\s*$/m.exec(w3eText);
  if (!corners || !offset) throw new Error("no corners and offset lines in war3map.w3e.txt");
  return { width: Number(corners[1]), height: Number(corners[2]), offsetX: Number(offset[1]), offsetY: Number(offset[2]) };
}

/** The terrain's centre, where the editor's opening camera looks: offset + (corners - 1) * 64. */
export function terrainCentre({ width, height, offsetX, offsetY }) {
  return [offsetX + (width - 1) * 64, offsetY + (height - 1) * 64];
}

/** A look with its target filled in (the centre for "center"). */
export function resolveLook(look, head) {
  if (!look.center) return { ...look };
  const [x, y] = terrainCentre(head);
  return { ...look, x, y, center: false };
}

/**
 * Studio's camera (app-drive's --camera keys: x, y, distance, pitch, yaw, fov in degrees, fov vertical) showing what
 * the editor's view shows for this look, at the view's aspect (WE_VIEW). Only angle of attack 304 and field of view 70
 * are fitted; another angle or field of view throws rather than guess. The rotation turns the fit around the target
 * (yaw = rotation + 180, as Studio's camera preview has it; the fit was made at rotation 90).
 */
export function studioCamera(look) {
  if (look.x === null || look.y === null) throw new Error("the look has no target (resolve the centre first)");
  if (look.aoa !== FIT.aoa || look.fov !== FIT.fov) {
    throw new Error(`only angle of attack ${FIT.aoa} and field of view ${FIT.fov} are fitted to Studio's camera (got ${look.aoa}, ${look.fov})`);
  }
  const r = (look.rotation * Math.PI) / 180;
  const d = look.distance;
  let yaw = ((look.rotation + 180) % 360 + 360) % 360;
  if (yaw >= 180) yaw -= 360;
  return {
    x: round(look.x - FIT.shift * d * Math.cos(r)),
    y: round(look.y - FIT.shift * d * Math.sin(r)),
    distance: round(FIT.scale * d),
    pitch: FIT.pitch,
    yaw: round(yaw),
    fov: FIT.fovStudio,
  };
}

const round = (v) => Math.round(v * 1000) / 1000;

/** The name of the camera object for the look in row `i` (sorts before names a map usually has). */
export const lookName = (i) => `00 we-drive look ${String(i + 1).padStart(2, "0")}`;
/** The names of the two parking cameras, after the looks. */
export const PARK_NAMES = Object.freeze(["00 we-drive park 1", "00 we-drive park 2"]);

/**
 * Two cameras at opposite corners of the terrain (south-west, north-east). The editor draws a circle around the
 * selected camera's target, in the middle of the picture after View Selected Camera; selecting the parking camera
 * farther from the look moves that circle out of the picture without moving the view.
 */
export function parkingLooks({ width, height, offsetX, offsetY }) {
  return [[offsetX, offsetY], [offsetX + (width - 1) * 128, offsetY + (height - 1) * 128]]
    .map(([x, y]) => ({ center: false, x, y, ...WE_OPENING }));
}

/** Which of the parking cameras is farther from a resolved look (0 or 1). */
export function fartherPark(look, parks) {
  const d = (p) => (p.x - look.x) ** 2 + (p.y - look.y) ** 2;
  return d(parks[1]) > d(parks[0]) ? 1 : 0;
}

/** A camera object (war3map.w3c.json's shape) for a resolved look, in the file's version; named `name` if given. */
export function lookCamera(look, i, version, localAngles, name = lookName(i)) {
  const c = {
    targetX: look.x, targetY: look.y, zOffset: 0, rotation: look.rotation, angleOfAttack: look.aoa,
    distance: look.distance, roll: 0, fieldOfView: look.fov, farZ: 5000, nearZ: 100,
  };
  if (version >= 3 || localAngles) Object.assign(c, { localPitch: 0, localYaw: 0, localRoll: 0 });
  if (version >= 3) Object.assign(c, { dofDistance: 0, dofScale: 0, posAbsoluteZ: 0 });
  c.name = name;
  if (version >= 3) c.trailer = 0;
  return c;
}

/**
 * The cameras document with the looks' cameras first (row i of the editor's camera palette is look i), then the
 * parking cameras (`parks`, from parkingLooks; rows looks.length and after), the map's own after them. `doc` is the
 * parsed war3map.w3c.json, or null when the map has no camera file (then a version 3 file as the current editor
 * writes it). The given document isn't changed.
 */
export function addLookCameras(doc, looks, parks = []) {
  const base = doc ?? { format: "w3proj.cameras/1", version: 3, cameras: [] };
  if (!Array.isArray(base.cameras) || typeof base.version !== "number") throw new Error("war3map.w3c.json has no version or no cameras list");
  const local = base.localAngles === true;
  const ours = looks.map((l, i) => lookCamera(l, i, base.version, local));
  const parked = parks.map((l, i) => lookCamera(l, i, base.version, local, PARK_NAMES[i]));
  return { ...base, cameras: [...ours, ...parked, ...base.cameras] };
}
