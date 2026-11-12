// The map's sky and weather as the MCP tools set them (set_sky, set_weather): names are taken like Map Properties'
// pickers take them (an id or its label), everything works on the war3map.w3i document.

import { setW3iColorHex, w3iColorHex } from "../formats/w3icolor";

/** An id from `choices` ([id, label]) for what was typed: the id or the label, ignoring case. Else an error that lists the choices. */
export function resolveChoice(what: string, value: unknown, choices: readonly (readonly [string, string])[]): string {
  const text = String(value ?? "").trim().toLowerCase();
  const hit = choices.find(([id, label]) => id.toLowerCase() === text || label.toLowerCase() === text);
  if (hit) return hit[0];
  const shown = choices.slice(0, 60).map(([id, label]) => (id === label ? id : `${id} = ${label}`)).join("; ");
  throw new Error(`Unknown ${what} "${String(value)}". Choices: ${shown}${choices.length > 60 ? `; … (${choices.length} in all)` : ""}.`);
}

export const FOG_STYLES: readonly (readonly [string, string])[] = [["0", "Linear"], ["1", "Exponential 1"], ["2", "Exponential 2"]];
/** w3i flags: "Use terrain fog", "Enable water tinting". */
const FOG_FLAG = 0x2000, TINT_FLAG = 0x10000;
/** Nothing, as the w3i stores it. */
export const NO_WEATHER = "0x00000000";

export interface SkyArgs {
  lightEnvironment?: unknown; fogStyle?: unknown; fogStart?: unknown; fogEnd?: unknown; fogDensity?: unknown; fogColor?: unknown;
  useFog?: unknown; overSky?: unknown; waterTint?: unknown; tintWater?: unknown;
}
export interface SkyLists { tilesets: readonly (readonly [string, string])[] }

type Doc = Record<string, any>;

function num(name: string, v: unknown, int = false): number {
  if (typeof v !== "number" || !Number.isFinite(v) || (int && !Number.isInteger(v))) throw new Error(`${name} must be ${int ? "a whole " : "a "}number.`);
  return v;
}

/** "#rrggbb" or [red, green, blue] into a w3i colour's bytes, keeping its alpha. */
function setColor(name: string, bgra: number[], v: unknown) {
  if (Array.isArray(v) && v.length === 3 && v.every((c) => Number.isInteger(c) && c >= 0 && c <= 255)) {
    bgra[2] = v[0]; bgra[1] = v[1]; bgra[0] = v[2];
  } else if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v.trim())) setW3iColorHex(bgra, v.trim());
  else throw new Error(`${name} must be "#rrggbb" or [red, green, blue] (0 to 255).`);
}

/** Applies the arguments to the w3i document; the changes made, as text. Throws before changing anything the document can't take. */
export function applySky(doc: Doc, args: SkyArgs, lists: SkyLists): string[] {
  if (typeof doc.version === "number" && doc.version < 25) throw new Error(`This map's format (v${doc.version}) has no light, fog or water tint settings.`);
  const out: string[] = [];
  const work = structuredClone(doc);
  const set = (what: string, before: unknown, after: unknown) => {
    if (JSON.stringify(before) !== JSON.stringify(after)) out.push(`${what}: ${typeof before === "object" ? JSON.stringify(before) : String(before)} → ${typeof after === "object" ? JSON.stringify(after) : String(after)}`);
  };
  const flag = (bit: number, on: boolean, what: string) => {
    const was = ((work.flags ?? 0) & bit) !== 0;
    if (was !== on) { work.flags = on ? (work.flags ?? 0) | bit : (work.flags ?? 0) & ~bit; out.push(`${what}: ${was ? "on" : "off"} → ${on ? "on" : "off"}`); }
  };
  if (args.lightEnvironment !== undefined) {
    const text = String(args.lightEnvironment).trim().toLowerCase();
    const id = text === "" || text === "default" ? "" : resolveChoice("light environment", args.lightEnvironment, lists.tilesets);
    const was = work.lightEnvironment ?? "";
    work.lightEnvironment = id;
    set("light environment", was || "default", id || "default");
  }
  const fog = work.fog ?? (work.fog = { style: 0, start: 3000, end: 5000, density: 0.5, color: [255, 255, 255, 255] });
  let fogGiven = false;
  if (args.fogStyle !== undefined) { const was = fog.style; fog.style = Number(resolveChoice("fog style", args.fogStyle, FOG_STYLES)); set("fog style", was, fog.style); fogGiven = true; }
  for (const [key, field] of [["fogStart", "start"], ["fogEnd", "end"], ["fogDensity", "density"]] as const) {
    if (args[key] === undefined) continue;
    const was = fog[field]; fog[field] = num(key, args[key]); set(`fog ${field}`, was, fog[field]); fogGiven = true;
  }
  if (args.fogColor !== undefined) {
    const was = w3iColorHex(fog.color); setColor("fogColor", fog.color, args.fogColor); set("fog colour", was, w3iColorHex(fog.color)); fogGiven = true;
  }
  if (args.overSky !== undefined) {
    if (!work.terrainFog) throw new Error("This map's format has no \"draw over sky\" setting (it needs the 3.0 terrain fog).");
    const was = work.terrainFog.overSky; work.terrainFog.overSky = num("overSky", args.overSky, true); set("fog drawn over the sky", was, work.terrainFog.overSky);
  }
  if (args.useFog !== undefined) flag(FOG_FLAG, args.useFog === true, "terrain fog");
  else if (fogGiven) flag(FOG_FLAG, true, "terrain fog");
  if (args.waterTint !== undefined) {
    work.waterTint ??= [255, 255, 255, 255];
    const was = w3iColorHex(work.waterTint); setColor("waterTint", work.waterTint, args.waterTint); set("water tint", was, w3iColorHex(work.waterTint));
  }
  if (args.tintWater !== undefined) flag(TINT_FLAG, args.tintWater === true, "water tinting");
  else if (args.waterTint !== undefined) flag(TINT_FLAG, true, "water tinting");
  for (const k of Object.keys(doc)) delete doc[k];
  Object.assign(doc, work);
  return out;
}

/** The id for a weather effect named by id, label or "none" (also ""). */
export function resolveWeather(value: unknown, weather: readonly (readonly [string, string])[]): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "none" || text === "" || text === NO_WEATHER) return NO_WEATHER;
  return resolveChoice("weather effect", value, [[NO_WEATHER, "None"], ...weather]);
}
