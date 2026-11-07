import type { GameInfo, Settings } from "../extensions/api";
import { invoke as backendInvoke } from "./backend";
import { gameDataError } from "./gameerror";

/** Documents with this prefix are files from the game's storage. */
export const GAME_SCHEME = "game:";

/** Read-only access to the installed game's data via the backend. */
export class GameService {
  private listCache: Promise<string[]> | null = null;

  constructor(private settings: Settings) {
    settings.onDidChange((k) => {
      if (k === "game.installDir") this.listCache = null;
    });
  }

  /** A backend call; a game data that can't be opened is said in words a person can act on (see gameerror). */
  private invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
    return backendInvoke<T>(command, args).catch((e) => { throw gameDataError(e, this.settings.get<string>("game.installDir")); });
  }

  private args() {
    return {
      install: this.settings.get<string>("game.installDir"),
      modeName: this.settings.get<string>("game.graphicsMode"),
    };
  }

  info(): Promise<GameInfo> {
    return this.invoke<GameInfo>("game_info", { install: this.args().install });
  }

  list(): Promise<string[]> {
    this.listCache ??= this.invoke<string>("game_list", { install: this.args().install }).then(
      (s) => s.split("\n"),
      (e) => {
        this.listCache = null;
        throw e;
      },
    );
    return this.listCache;
  }

  /** `tileset`: a tileset letter; its folders (`_Tilesets/<letter>.w3mod`) are searched first, as the game does for a map of that tileset. */
  resolve(path: string, tileset?: string): Promise<string | null> {
    return this.invoke<string | null>("game_resolve", { ...this.args(), path, tileset: tileset ?? null });
  }

  async read(path: string, tileset?: string): Promise<Uint8Array> {
    return new Uint8Array(await this.invoke<ArrayBuffer>("game_read", { ...this.args(), path, tileset: tileset ?? null }));
  }

  async readText(path: string, tileset?: string): Promise<string> {
    // TextDecoder drops a leading byte-order mark by default.
    return new TextDecoder("utf-8").decode(await this.read(path, tileset));
  }
}
