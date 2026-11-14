// war3mapExtra.txt: the World Editor's per-map preferences (Scenario > Map Properties > Prefs, and the Trigger
// Editor's JassHelper menu). Measured with the hidden editor (branch map-settings-we, 2026-11-14; TESTING.md "Map
// preferences"): one section, [MapExtraInfo], LF line ends and an empty line at the end, holding only what differs
// from the editor's defaults, in a fixed order whatever order they were set in. With nothing to say the editor saves
// the file empty (0 bytes) and keeps it in the map. Its JassHelper keys are written only with JassHelper on:
//
//   [MapExtraInfo]
//   EnableJassHelper=true
//   EnableJassHelperDebug=true
//   EnableJassHelperOptimizer=true
//   EnableJassHelperVJass=false
//   EnforceTerrainLimits=true
//   SkyModel=2
//   TimeOfDay=3
//
// SkyModel is the number of a sky in UI\WorldEditData.txt's [SkyModels] (2 = Felwood Sky); TimeOfDay 0 = not fixed,
// 1 dawn, 2 noon, 3 dusk, 4 midnight. Left out, each is "Use Editor Preference" (the editor's own setting).
//
// Reading takes keys case-insensitively; writing puts the known keys in the editor's order and keeps any other line
// (a key this build doesn't know) after them, as it was. A file whose values don't change is returned as it is.

export const MAP_EXTRA_PATH = "map/war3mapExtra.txt";
const SECTION = "MapExtraInfo";

/** The keys the editor writes, in the order it writes them. */
export const MAP_EXTRA_KEYS = ["EnableJassHelper", "EnableJassHelperDebug", "EnableJassHelperOptimizer", "EnableJassHelperVJass",
  "EnforceTerrainLimits", "SkyModel", "TimeOfDay"] as const;
export type MapExtraKey = typeof MAP_EXTRA_KEYS[number];

/** A map's preferences; a field left out is the editor's default. */
export interface MapExtra {
  /** Trigger Editor > JassHelper > Enable JassHelper (default off). */
  jassHelper?: boolean;
  /** Enable debug mode (default off). */
  debug?: boolean;
  /** Enable optimizer (default off). */
  optimizer?: boolean;
  /** Enable vJass (default on: only `false` is written). */
  vjass?: boolean;
  /** Prefs > Enforce Terrain Limits (default off). */
  enforceTerrainLimits?: boolean;
  /** Prefs > Sky Display: a [SkyModels] number. */
  skyModel?: number;
  /** Prefs > Time of Day: 0 not fixed, 1 dawn, 2 noon, 3 dusk, 4 midnight. */
  timeOfDay?: number;
}

/** Prefs > Time of Day's choices, by their stored number. */
export const TIMES_OF_DAY: readonly (readonly [number, string])[] = [[0, "Not Fixed"], [1, "Fixed - Dawn"], [2, "Fixed - Noon"], [3, "Fixed - Dusk"], [4, "Fixed - Midnight"]];

const FIELD: Record<MapExtraKey, keyof MapExtra> = {
  EnableJassHelper: "jassHelper", EnableJassHelperDebug: "debug", EnableJassHelperOptimizer: "optimizer",
  EnableJassHelperVJass: "vjass", EnforceTerrainLimits: "enforceTerrainLimits", SkyModel: "skyModel", TimeOfDay: "timeOfDay",
};
const BOOLEAN = new Set<keyof MapExtra>(["jassHelper", "debug", "optimizer", "vjass", "enforceTerrainLimits"]);
/** The JassHelper menu's switches under Enable JassHelper: the editor writes them only with it on. */
const UNDER_JASSHELPER = new Set<keyof MapExtra>(["debug", "optimizer", "vjass"]);

const header = (line: string) => /^\s*\[([^\]]*)\]\s*$/.exec(line)?.[1];
const keyOf = (line: string) => { const eq = line.indexOf("="); return eq > 0 ? line.slice(0, eq).trim() : null; };
const known = (k: string): MapExtraKey | undefined => MAP_EXTRA_KEYS.find((m) => m.toLowerCase() === k.toLowerCase());
const isOwnSection = (h: string) => h.trim().toLowerCase() === SECTION.toLowerCase();

/** A value as stored; one that can't be read (`EnableJassHelper=maybe`, `SkyModel=x`) counts as absent. */
function parseValue(field: keyof MapExtra, raw: string): boolean | number | undefined {
  const v = raw.trim();
  if (BOOLEAN.has(field)) return /^(true|1)$/i.test(v) ? true : /^(false|0)$/i.test(v) ? false : undefined;
  return /^-?\d+$/.test(v) ? Number(v) : undefined;
}

/** The preferences in a war3mapExtra.txt (only [MapExtraInfo] counts; the last of a repeated key wins). */
export function readMapExtra(text: string): MapExtra {
  const out: MapExtra = {};
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const h = header(line);
    if (h !== undefined) { inSection = isOwnSection(h); continue; }
    if (!inSection) continue;
    const k = keyOf(line);
    const key = k ? known(k) : undefined;
    if (!key) continue;
    const field = FIELD[key];
    const value = parseValue(field, line.slice(line.indexOf("=") + 1));
    if (value === undefined) delete out[field];
    else (out as Record<string, unknown>)[field] = value;
  }
  return out;
}

/** The lines the editor writes for these values: defaults left out, the JassHelper switches only with it on. */
function storedLines(values: MapExtra): string[] {
  const shown = (field: keyof MapExtra, v: unknown) => {
    if (v === undefined) return false;
    if (UNDER_JASSHELPER.has(field) && values.jassHelper !== true) return false;
    // Defaults: JassHelper, debug, optimizer and terrain limits off, vJass on.
    if (field === "vjass") return v === false;
    if (BOOLEAN.has(field)) return v === true;
    return true;
  };
  return MAP_EXTRA_KEYS.filter((k) => shown(FIELD[k], values[FIELD[k]])).map((k) => `${k}=${String(values[FIELD[k]])}`);
}

/**
 * `text` with the preferences set to `values` (a field left out is the editor's default: its key goes). When the
 * stored lines stay the same, `text` comes back as it was. Otherwise [MapExtraInfo] is written as the editor writes it
 * (`storedLines`: its order, defaults left out, LF, an empty line at the end); keys it doesn't know and other sections
 * stay, after it. Nothing to write gives an empty text, as the editor's save does.
 */
export function writeMapExtra(text: string, values: MapExtra): string {
  const lines = storedLines(values);
  if (storedLines(readMapExtra(text)).join("\n") === lines.join("\n")) return text;
  // Lines before any section stay before it (after it they would be read as its keys), other sections after it.
  const before: string[] = [], own: string[] = [], rest: string[] = [];
  let inSection = false, seenHeader = false;
  for (const line of text.length ? text.split(/\r?\n/) : []) {
    const h = header(line);
    if (h !== undefined) { inSection = isOwnSection(h); seenHeader = true; }
    if (inSection) {
      if (h !== undefined || line.trim() === "") continue;
      const k = keyOf(line);
      if (k && known(k)) continue;
      own.push(line);
    } else (seenHeader ? rest : before).push(line);
  }
  for (const list of [before, rest]) while (list.length && list[list.length - 1].trim() === "") list.pop();
  const body = lines.length || own.length ? [`[${SECTION}]`, ...lines, ...own, ""] : [];
  const all = [...before, ...body, ...rest];
  return all.length ? `${all.join("\n")}\n` : "";
}
