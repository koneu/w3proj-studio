// The environment JASS is checked against: the game's common.j and Blizzard.j
// (read once), plus, for code inside a map, the declarations of its script.
// Also the symbols code editors offer (completion, hover, go to definition).

import { declarations, envFrom, envWithout, sigText, type JassEnv } from "./check";

let game: Promise<JassEnv> | null = null;
const COMMON_J = "Scripts\\common.j", BLIZZARD_J = "Scripts\\Blizzard.j";

/** Types, natives, globals and functions of the game's common.j and Blizzard.j (cached);
 *  their source is "game:<path>". */
export function gameJassEnv(read: (path: string) => Promise<string>): Promise<JassEnv> {
  game ??= (async () => {
    const common = envFrom([await read(COMMON_J)], undefined, [`game:${COMMON_J}`]);
    return envFrom([await read(BLIZZARD_J)], common, [`game:${BLIZZARD_J}`]);
  })();
  game.catch(() => { game = null; });
  return game;
}

/** The trigger each function of a generated map script belongs to (by its "// Trigger: " banner). */
export function triggerOfFunctions(script: string): Map<string, string> {
  const out = new Map<string, string>();
  let trigger: string | null = null;
  for (const line of script.split(/\r?\n/)) {
    const banner = /^\/\/ Trigger: (.*)$/.exec(line);
    if (banner) { trigger = banner[1]; continue; }
    // Section banners ("//*  Players") end the triggers.
    if (/^\/\/\*  \S/.test(line)) { trigger = null; continue; }
    const fn = trigger ? /^function\s+(\w+)/.exec(line) : null;
    if (fn) out.set(fn[1], trigger!);
  }
  return out;
}

/** For code inside a map: the game's environment plus what the map script declares (built once);
 *  `without(src)` leaves out what the checked text declares itself, `symbols(src)` names for editing it. */
export function mapJass(read: (path: string) => Promise<string>, mapScript: Promise<string | null>) {
  const base = (async () => {
    const game = await gameJassEnv(read), script = await mapScript;
    return { env: script ? envFrom([script], game, ["map"]) : game, triggers: script ? triggerOfFunctions(script) : new Map<string, string>() };
  })();
  return {
    without: async (src: string) => envWithout((await base).env, src),
    symbols: async (src: string) => { const b = await base; return jassSymbols(b.env, src, b.triggers); },
  };
}

/** A name for completion, hover and go to definition (the shape of the code editor's CodeSymbol). */
export interface JassSymbol {
  name: string;
  kind: "type" | "native" | "function" | "global" | "constant" | "local" | "param" | "keyword";
  detail: string;
  at?: number;
  /** Declared elsewhere: "game:<path>" (a game script) or "trigger:<name>" (one of the map's triggers). */
  location?: string;
  scope?: [number, number];
}

const KEYWORDS = ["function", "takes", "returns", "nothing", "endfunction", "local", "array", "set", "call", "if", "then",
  "elseif", "else", "endif", "loop", "exitwhen", "endloop", "return", "and", "or", "not", "true", "false", "null", "constant",
  "globals", "endglobals", "native", "type", "extends", "debug"];

/** Where a declaration from `source` lives: a game script, or the trigger that defines it. */
function location(source: string | undefined, name: string, triggers: Map<string, string>): string | undefined {
  if (source?.startsWith("game:")) return source;
  if (source !== "map") return undefined;
  // gg_trg_<name> belongs to the trigger whose section defines InitTrig_<name>.
  const t = triggers.get(name) ?? (name.startsWith("gg_trg_") ? triggers.get(`InitTrig_${name.slice(7)}`) : undefined);
  return t ? `trigger:${t}` : undefined;
}

/** What `env` declares as symbols (computed once per environment and trigger map). */
const envSymbols = new WeakMap<JassEnv, JassSymbol[]>();
function symbolsOf(env: JassEnv, triggers: Map<string, string>): JassSymbol[] {
  let out = envSymbols.get(env);
  if (out) return out;
  out = [
    ...KEYWORDS.map((k): JassSymbol => ({ name: k, kind: "keyword", detail: k })),
    ...[...env.types].filter(([, p]) => p).map(([t, p]): JassSymbol => ({ name: t, kind: "type", detail: `type ${t} extends ${p}` })),
    ...["integer", "real", "boolean", "string", "handle", "code"].map((t): JassSymbol => ({ name: t, kind: "type", detail: t })),
    ...[...env.globals].map(([n, g]): JassSymbol => ({
      name: n, kind: g.constant ? "constant" : "global", detail: `${g.constant ? "constant " : ""}${g.type}${g.array ? " array" : ""} ${n}`,
      location: location(g.source, n, triggers),
    })),
    ...[...env.functions].map(([n, f]): JassSymbol => ({
      name: n, kind: f.native ? "native" : "function", detail: `${f.constant ? "constant " : ""}${f.native ? "native" : "function"} ${sigText(n, f)}`,
      location: location(f.source, n, triggers),
    })),
  ];
  envSymbols.set(env, out);
  return out;
}

/** Symbols for editing `src`: its own declarations (with positions), then `env`'s. */
export function jassSymbols(env: JassEnv, src: string, triggers: Map<string, string> = new Map()): JassSymbol[] {
  const own = declarations(src, env).map((d): JassSymbol => ({ name: d.name, kind: d.kind, detail: d.detail, at: d.from, scope: d.scope }));
  return [...own, ...symbolsOf(env, triggers)];
}
