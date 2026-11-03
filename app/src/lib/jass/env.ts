// The environment JASS is checked against: the game's common.j and Blizzard.j
// (read once), plus, for code inside a map, the declarations of its script.

import { declarations, envFrom, envWithout, sigText, type JassEnv } from "./check";

let game: Promise<JassEnv> | null = null;

/** Types, natives, globals and functions of the game's common.j and Blizzard.j (cached). */
export function gameJassEnv(read: (path: string) => Promise<string>): Promise<JassEnv> {
  game ??= (async () => {
    const common = envFrom([await read("Scripts\\common.j")]);
    return envFrom([await read("Scripts\\Blizzard.j")], common);
  })();
  game.catch(() => { game = null; });
  return game;
}

/** For code inside a map: the game's environment plus what the map script declares (built once);
 *  `without(src)` leaves out what the checked text declares itself, `symbols(src)` names for editing it. */
export function mapJass(read: (path: string) => Promise<string>, mapScript: Promise<string | null>) {
  const base = (async () => {
    const game = await gameJassEnv(read), script = await mapScript;
    return script ? envFrom([script], game) : game;
  })();
  return {
    without: async (src: string) => envWithout(await base, src),
    symbols: async (src: string) => jassSymbols(await base, src),
  };
}

/** A name for completion, hover and go to definition (the shape of the code editor's CodeSymbol). */
export interface JassSymbol {
  name: string;
  kind: "type" | "native" | "function" | "global" | "constant" | "local" | "param" | "keyword";
  detail: string;
  at?: number;
  scope?: [number, number];
}

const KEYWORDS = ["function", "takes", "returns", "nothing", "endfunction", "local", "array", "set", "call", "if", "then",
  "elseif", "else", "endif", "loop", "exitwhen", "endloop", "return", "and", "or", "not", "true", "false", "null", "constant",
  "globals", "endglobals", "native", "type", "extends", "debug"];

/** What `env` declares as symbols (computed once per environment). */
const envSymbols = new WeakMap<JassEnv, JassSymbol[]>();
function symbolsOf(env: JassEnv): JassSymbol[] {
  let out = envSymbols.get(env);
  if (out) return out;
  out = [
    ...KEYWORDS.map((k): JassSymbol => ({ name: k, kind: "keyword", detail: k })),
    ...[...env.types].filter(([, p]) => p).map(([t, p]): JassSymbol => ({ name: t, kind: "type", detail: `type ${t} extends ${p}` })),
    ...["integer", "real", "boolean", "string", "handle", "code"].map((t): JassSymbol => ({ name: t, kind: "type", detail: t })),
    ...[...env.globals].map(([n, g]): JassSymbol => ({ name: n, kind: g.constant ? "constant" : "global", detail: `${g.constant ? "constant " : ""}${g.type}${g.array ? " array" : ""} ${n}` })),
    ...[...env.functions].map(([n, f]): JassSymbol => ({ name: n, kind: f.native ? "native" : "function", detail: `${f.constant ? "constant " : ""}${f.native ? "native" : "function"} ${sigText(n, f)}` })),
  ];
  envSymbols.set(env, out);
  return out;
}

/** Symbols for editing `src`: its own declarations (with positions), then `env`'s. */
export function jassSymbols(env: JassEnv, src: string): JassSymbol[] {
  const own = declarations(src, env).map((d): JassSymbol => ({ name: d.name, kind: d.kind, detail: d.detail, at: d.from, scope: d.scope }));
  return [...own, ...symbolsOf(env)];
}
