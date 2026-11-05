// Protects map scripts that aren't made from the map's triggers. Maps can carry code that exists
// only in war3map.j / war3map.lua (W3Champions' maps: 800 injected functions), and regenerating
// the script from the triggers would drop it without a trace.

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

/** A short hash (FNV-1a), to recognise a script this app wrote. */
export function scriptHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}
