// What a failure to open the game's data says to the person: the backend's error ("game data:
// .build.info: <the system's words> (os error 3)") is about a file they never chose, in the system's
// language. What they need is what's wrong and where to fix it.

export class GameDataError extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
    this.name = "GameDataError";
  }
}

/** A backend error of the game data as a GameDataError; any other error is given back as it is. */
export function gameDataError(e: unknown, install: string | undefined): unknown {
  const text = e instanceof Error ? e.message : String(e);
  if (!text.startsWith("game data:")) return e;
  const detail = text.slice("game data:".length).trim();
  const where = install ? ` in "${install}"` : "";
  return new GameDataError(
    `The game's data couldn't be opened${where}. Units, models and textures come from an installed Warcraft III: ` +
      `set "game.installDir" to the game's folder (Preferences: Open Settings (JSON)). Details: ${detail}`,
    detail,
  );
}
