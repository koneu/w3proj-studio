// Protects map scripts that aren't made from the map's triggers. Maps can carry code that exists
// only in war3map.j / war3map.lua (W3Champions' maps: 800 injected functions), and regenerating
// the script from the triggers would drop it without a trace.

/** Project file holding the hash of the script this app wrote last: a script that still has it holds nothing but
 *  what the map's data made, so it's replaced without asking. */
export const SCRIPT_STAMP = ".w3proj/generated-script";

/** Words every warning about a script that is kept (not regenerated) has: Map Size's undo withdraws those its
 *  resize caused. */
export const KEPT_SCRIPT_WORDS = "so it isn't regenerated";

/** The map script's files (JASS, Lua): what the generator writes. */
export const SCRIPT_FILES = ["map/war3map.j", "map/war3map.lua"];

/** Files the map script is made from (also as their .json documents): saving one regenerates it. */
export const SCRIPT_INPUTS = /^map\/(war3map\.(wtg|wct|wts|w3i|w3r|w3c|w3s|w3l|doo|w3e|w3u|w3t|w3a)|war3mapUnits\.doo|war3mapSkin\.w3u)(\.json)?$/i;

/** Top-level functions of a JASS or Lua script ("function f", also Lua's "f = function"). */
function functionsOf(script: string): Set<string> {
  return new Set([...script.matchAll(/^(?:local )?(?:function ([\w.:]+)|([\w.]+) *= *function\b)/gm)].map((m) => m[1] ?? m[2]));
}

/** Functions the generator itself writes, which come and go with the map's contents (a deleted
 *  trigger, the last region, …). */
const GENERATED = new RegExp("^(?:main|config|InitGlobals|InitSounds|InitCustomTriggers|InitCustomPlayerSlots|InitCustomTeams" +
  "|InitAllyPriorities|InitRandomGroups|InitUpgrades(?:_Player\\d+)?|InitTechTree(?:_Player\\d+)?|RunInitializationTriggers" +
  "|CreateRegions|CreateCameras|CreateAllDestructables|CreateAllItems|CreateAllUnits|CreatePlayerBuildings|CreatePlayerUnits" +
  "|CreateNeutral\\w*|CreateBuildingsForPlayer\\d+|CreateUnitsForPlayer\\d+|Trig_\\w+|InitTrig_\\w+|\\w+_DropItems)$");

/** Functions of `current` that `generated` doesn't have and that the generator didn't write:
 *  code that would be lost by replacing the one with the other. */
export function lostFunctions(current: string, generated: string): string[] {
  const kept = functionsOf(generated);
  return [...functionsOf(current)].filter((f) => !kept.has(f) && !GENERATED.test(f));
}

/** What regenerating does with the script there is now:
 *  - "same": it's what the map's data makes already (nothing to write);
 *  - "write": it's replaced: there is none, it's the one this app wrote last (`stamp` is its hash), or `force`;
 *  - "keep": anything else (changed by hand or by another program, the World Editor's own, not readable as text) stays,
 *    with `lost` the functions replacing it would drop that the generator never writes.
 *  `current`: the script's text, null when there's none, undefined when it's there but can't be read. */
export function scriptDecision(current: string | null | undefined, generated: string, stamp: string | null, force = false):
  { action: "same" | "write" } | { action: "keep"; lost: string[] } {
  if (current === generated) return { action: "same" };
  if (force || current === null) return { action: "write" };
  if (current !== undefined && stamp?.trim() === scriptHash(current)) return { action: "write" };
  return { action: "keep", lost: current === undefined ? [] : lostFunctions(current, generated) };
}

/** A short hash (FNV-1a), to recognise a script this app wrote. */
export function scriptHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}
