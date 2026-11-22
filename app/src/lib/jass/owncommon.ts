// The common.j a map's script is compiled against when the map imports its own Scripts\common.j. WoW Reforged's has
// 3,994 constants and 2 natives the game's lacks, and a few newer natives of the game's it lacks in turn: JassHelper
// (pjass) fails with either file alone and passes with the game's plus the map's own extra declarations
// (trigger-folders stage 0). What the World Editor does here isn't known.

/** What a common.j declares: types, natives, globals (constants too), by name. */
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
      const g = /^(?:constant\s+)?\w+\s+(?:array\s+)?(\w+)\b/.exec(line);
      if (g && !out.globals.has(g[1])) out.globals.set(g[1], raw.trim());
      continue;
    }
    const t = /^type\s+(\w+)\b/.exec(line);
    if (t) { if (!out.types.has(t[1])) out.types.set(t[1], raw.trim()); continue; }
    const n = /^(?:constant\s+)?native\s+(\w+)\b/.exec(line);
    if (n && !out.natives.has(n[1])) out.natives.set(n[1], raw.trim());
  }
  return out;
}

/** The game's common.j with what the map's own declares and the game's doesn't added at its end, in the map's order:
 *  types, then the globals in a block of their own, then the natives. A declaration the game has stays the game's
 *  (the newer file decides a native's signature). Both files the same: the game's as it is. */
export function withOwnCommon(game: string, own: string): string {
  const have = declared(game), mine = declared(own);
  const add = <K extends keyof Declared>(kind: K) => [...mine[kind]].filter(([name]) => !have[kind].has(name) && !(kind !== "types" && (have.natives.has(name) || have.globals.has(name)))).map(([, line]) => line);
  const types = add("types"), globals = add("globals"), natives = add("natives");
  if (!types.length && !globals.length && !natives.length) return game;
  const eol = game.includes("\r\n") ? "\r\n" : "\n";
  const lines = [
    "",
    "// The map's own Scripts\\common.j declares these and the game's doesn't (W3Proj Studio adds them for JassHelper).",
    ...types,
    ...(globals.length ? ["globals", ...globals.map((g) => `    ${g}`), "endglobals"] : []),
    ...natives,
    "",
  ];
  return (game.endsWith("\n") ? game : game + eol) + lines.join(eol);
}
