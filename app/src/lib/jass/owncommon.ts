// The common.j a map's script is compiled and checked against when the map imports its own Scripts\common.j. The World
// Editor takes the map's file instead of the game's, never the two merged (docs/testing/saved-data-rules.md "Which
// common.j"). Studio does the same where the map's file declares everything the game's does, with the same signatures
// (declarations of its own on top are fine, e.g. WoW Reforged's GetUnitGoldCost); a file that lacks or changes any of
// the game's (an older copy, such as WoW Reforged's, which lacks newer natives) isn't used at all: the game's file is,
// with a warning naming what the map's lacks or changes.

/** What a common.j declares, by name: a type's parent, a native's parameter and return types, a global's kind and type. */
interface Declared { types: Map<string, string>; natives: Map<string, string>; globals: Map<string, string> }

function declared(text: string): Declared {
  const out: Declared = { types: new Map(), natives: new Map(), globals: new Map() };
  let inGlobals = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (/^globals\b/.test(line)) { inGlobals = true; continue; }
    if (/^endglobals\b/.test(line)) { inGlobals = false; continue; }
    if (inGlobals) {
      const g = /^(constant\s+)?(\w+)\s+(array\s+)?(\w+)\b/.exec(line);
      if (g && !out.globals.has(g[4])) out.globals.set(g[4], `${g[1] ? "constant " : ""}${g[2]}${g[3] ? " array" : ""}`);
      continue;
    }
    const t = /^type\s+(\w+)\s+extends\s+(\w+)/.exec(line);
    if (t) { if (!out.types.has(t[1])) out.types.set(t[1], t[2]); continue; }
    // Parameter names don't matter, nor whether the native is constant: only the types it takes and returns.
    const n = /^(?:constant\s+)?native\s+(\w+)\s+takes\s+(.*?)\s+returns\s+(\w+)/.exec(line);
    if (n && !out.natives.has(n[1])) {
      const takes = n[2].trim() === "nothing" ? "nothing" : n[2].split(",").map((p) => p.trim().split(/\s+/)[0]).join(", ");
      out.natives.set(n[1], `takes ${takes} returns ${n[3]}`);
    }
  }
  return out;
}

/** What the map's own common.j lacks or declares otherwise than the game's: "type x", "native X", "global X" each. */
export interface CommonJMismatch { lacks: string[]; changes: string[] }

/** The game's declarations the map's common.j lacks or changes; both empty: the map's file is compatible. */
export function commonJMismatch(game: string, own: string): CommonJMismatch {
  const have = declared(game), mine = declared(own);
  const lacks: string[] = [], changes: string[] = [];
  for (const [kind, label] of [["types", "type"], ["natives", "native"], ["globals", "global"]] as const) {
    for (const [name, sig] of have[kind]) {
      const other = mine[kind].get(name);
      if (other === undefined) lacks.push(`${label} ${name}`);
      else if (other !== sig) changes.push(`${label} ${name}`);
    }
  }
  return { lacks, changes };
}

/** The common.j to compile and check a map's script against: the map's own (`own`, null when it has none) as it is
 *  where it is compatible with the game's, else the game's, with a warning naming what the map's file lacks or changes. */
export function commonJFor(game: string, own: string | null): { text: string; from: "game" | "map"; warning?: string } {
  if (own === null) return { text: game, from: "game" };
  const { lacks, changes } = commonJMismatch(game, own);
  if (!lacks.length && !changes.length) return { text: own, from: "map" };
  const list = (names: string[]) => `${names.slice(0, 6).join(", ")}${names.length > 6 ? ` and ${names.length - 6} more` : ""}`;
  const what = [
    ...(lacks.length ? [`lacks ${lacks.length} of the game's declarations (${list(lacks)})`] : []),
    ...(changes.length ? [`declares ${changes.length} otherwise (${list(changes)})`] : []),
  ].join(" and ");
  return { text: game, from: "game", warning: `The map's own Scripts\\common.j ${what}: it isn't used, the map's script is compiled and checked against the game's common.j instead.` };
}
