// The game's folder at start: units, models and textures all come from an installed Warcraft III, so
// nearly everything fails without it. If the configured folder (by default the Windows one,
// C:\Program Files (x86)\Warcraft III) opens, nothing is asked. Otherwise the installs found in the usual
// places (the backend's game_find: the Windows default folders; Steam/Proton, Lutris and Wine prefixes on
// Linux) are offered, newest build first, with "Choose folder…" and "Later".

import type { QuickPickItem, W3Api } from "../../extensions/api";

export interface FoundGame { path: string; version: string }

export type GameChoice = { kind: "install"; path: string } | { kind: "browse" } | { kind: "later" };

/** The pick list: each install found (the newest marked), then choosing a folder by hand, then later. */
export function gameFolderItems(found: FoundGame[]): QuickPickItem<GameChoice>[] {
  const installs = found.map((g, i): QuickPickItem<GameChoice> => ({
    label: `Warcraft III ${g.version || "(build unknown)"}`,
    description: i === 0 && found.length > 1 ? "newest" : undefined,
    detail: g.path,
    value: { kind: "install", path: g.path },
  }));
  return [
    ...installs,
    { label: "Choose folder…", detail: "The folder that holds Warcraft III's _retail_ folder and .build.info", value: { kind: "browse" } },
    { label: "Later", detail: "Until then units, models and textures can't be shown, and new maps can't be made", value: { kind: "later" } },
  ];
}

/** Whether the game in a folder opens; the error's text if it doesn't. */
async function opens(w3: W3Api, install: string): Promise<string | null> {
  try {
    await w3.backend.invoke("game_info", { install });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Asks for the game's folder if the configured one doesn't open, or always with `force` (the command).
 *  Returns the folder chosen, or null. */
export async function checkGameFolder(w3: W3Api, force = false): Promise<string | null> {
  const current = w3.settings.get<string>("game.installDir") ?? "";
  if (!force && current && (await opens(w3, current)) === null) return null;
  const found = await w3.backend.invoke<FoundGame[]>("game_find").catch(() => [] as FoundGame[]);
  for (;;) {
    const placeholder = force
      ? `Warcraft III is read from ${current || "nowhere yet"}. Choose another`
      : found.length
        ? `Warcraft III wasn't found in ${current || "the configured folder"}. Choose the game to read units, models and textures from`
        : `Warcraft III wasn't found in ${current || "the configured folder"} or the usual places. Choose its folder`;
    const picked = (await w3.window.quickPick(gameFolderItems(found), { placeholder }))?.value;
    if (!picked || picked.kind === "later") return null;
    const folder = picked.kind === "install" ? picked.path : await w3.window.pickFolder({ title: "Choose the Warcraft III folder" });
    if (!folder) continue;
    const error = await opens(w3, folder);
    if (error === null) {
      await w3.settings.set("game.installDir", folder);
      void w3.window.showInfo(`Game data: reading Warcraft III from ${folder}. Change it with the "game.installDir" setting.`);
      return folder;
    }
    await w3.window.showError(`That folder's game data can't be opened: ${error}`);
  }
}
