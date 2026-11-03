// The environment JASS is checked against: the game's common.j and Blizzard.j
// (read once), plus, for code inside a map, the declarations of its script.

import { envFrom, envWithout, type JassEnv } from "./check";

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

/** A checker for code inside a map: the game's environment plus what the map script declares
 *  (built once), without what the checked text declares itself (each time). */
export function mapJassChecker(read: (path: string) => Promise<string>, mapScript: Promise<string | null>): (src: string) => Promise<JassEnv> {
  const base = (async () => {
    const game = await gameJassEnv(read), script = await mapScript;
    return script ? envFrom([script], game) : game;
  })();
  return async (src) => envWithout(await base, src);
}
