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
export const SCRIPT_INPUTS = /^map\/(war3map\.(wtg|wct|wts|w3i|w3r|w3c|w3s|w3l|doo|w3e|w3u|w3t|w3a|w3b)|war3mapUnits\.doo|war3mapSkin\.(w3u|w3a|w3b))(\.json)?$/i;

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

/** Functions that create the placed objects one after another: in which order the objects come doesn't matter to
 *  the game, and the World Editor's order isn't always Studio's (placed destructables, items, units). */
const PLACING = /^function (?:CreateAllDestructables|CreateAllItems|CreateBuildingsForPlayer\d+|CreateUnitsForPlayer\d+|CreateNeutral(?:Hostile|Passive)(?:Buildings)?) takes /;
/** A line that creates one placed object: it begins a block, with the lines after it that use what it made. */
const CREATES = /^\s*(?:set \w+ = |call )(?:Blz)?Create(?:Dead)?(?:Destructable|Item|Unit|BlightedGoldmine)\w*\s*\(/;
/** A line that begins a random pick of the next object's type (its lines up to that object belong to it). */
const PICKS = /^\s*(?:call RandomDistReset\b|set (?:unitID|itemID) = )/;
/** A unit's acquisition range: nothing else placing it reads that, and the World Editor sets it after the hero level
 *  and the mana, where Studio set it before until 2026-11 (scripts of that Studio still count as the same). */
const ACQUIRE = /^\s*call SetUnitAcquireRange\s*\(\s*(\w+)\s*,/;

/** The script with the object blocks of every placing function in one fixed order; everything else, the lines before
 *  a function's first object and the lines of each block among themselves, stays in its order (but for the
 *  acquisition range, which goes right after the line creating its unit). A block is a line that creates an object
 *  (or begins a random pick at the function's own level, with its `if … endif`) and the lines after it up to the next
 *  such line: they set up what it made (`set u = …` then `call SetUnitState( u, … )`). */
function placingInOrder(script: string): string {
  const lines = script.split("\n"), out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    if (!PLACING.test(lines[i])) continue;
    // `made`: the variable the block's unit was put into (null: a random pick, or an object not in a variable).
    type Block = { lines: string[]; acquire: string[]; made: string | null };
    const head: string[] = [], blocks: Block[] = [];
    let block: Block | null = null, depth = 0, picking = false;
    for (i++; i < lines.length && !/^endfunction\b/.test(lines[i]); i++) {
      const line = lines[i];
      let begins = false;
      const top = depth === 0;
      if (top) {
        if (CREATES.test(line)) { begins = !picking; picking = false; }
        else if (PICKS.test(line)) { begins = !picking; picking = true; }
      }
      if (/^\s*if\b.*\bthen\s*$/.test(line)) { depth++; picking = false; }
      else if (/^\s*endif\b/.test(line)) depth = Math.max(0, depth - 1);
      if (begins) blocks.push((block = { lines: [], acquire: [], made: picking ? null : (/^\s*set (\w+) = /.exec(line)?.[1] ?? null) }));
      if (block?.made && top && !begins && ACQUIRE.exec(line)?.[1] === block.made) block.acquire.push(line);
      else (block?.lines ?? head).push(line);
    }
    const sorted = blocks.map((b) => [b.lines[0], ...b.acquire, ...b.lines.slice(1)].join("\n")).sort();
    out.push(...head, ...sorted);
    if (i < lines.length) out.push(lines[i]);
  }
  return out.join("\n");
}

/** Whether two scripts differ at most in the order of their placed objects (see `placingInOrder`). */
export function sameButPlacingOrder(a: string, b: string): boolean {
  // The same lines in another order are as long.
  return a === b || (a.length === b.length && placingInOrder(a) === placingInOrder(b));
}

/** What regenerating does with the script there is now:
 *  - "same": it's what the map's data makes already (nothing to write);
 *  - "write": it's replaced: there is none, it's the one this app wrote last (`stamp` is its hash), it differs from
 *    what the map's data makes only in the order of its placed objects, or `force`;
 *  - "keep": anything else (changed by hand or by another program, the World Editor's own, not readable as text) stays,
 *    with `lost` the functions replacing it would drop that the generator never writes.
 *  `current`: the script's text, null when there's none, undefined when it's there but can't be read. */
export function scriptDecision(current: string | null | undefined, generated: string, stamp: string | null, force = false):
  { action: "same" | "write" } | { action: "keep"; lost: string[] } {
  if (current === generated) return { action: "same" };
  if (force || current === null) return { action: "write" };
  if (current !== undefined && stamp?.trim() === scriptHash(current)) return { action: "write" };
  if (current !== undefined && sameButPlacingOrder(current, generated)) return { action: "write" };
  return { action: "keep", lost: current === undefined ? [] : lostFunctions(current, generated) };
}

/** A short hash (FNV-1a), to recognise a script this app wrote. */
export function scriptHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}
