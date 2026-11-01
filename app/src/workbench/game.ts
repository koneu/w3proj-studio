import type { GameInfo, Settings } from "../extensions/api";
import { invoke } from "./backend";

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

  private args() {
    return {
      install: this.settings.get<string>("game.installDir"),
      modeName: this.settings.get<string>("game.graphicsMode"),
    };
  }

  info(): Promise<GameInfo> {
    return invoke<GameInfo>("game_info", { install: this.args().install });
  }

  list(): Promise<string[]> {
    this.listCache ??= invoke<string>("game_list", { install: this.args().install }).then(
      (s) => s.split("\n"),
      (e) => {
        this.listCache = null;
        throw e;
      },
    );
    return this.listCache;
  }

  resolve(path: string): Promise<string | null> {
    return invoke<string | null>("game_resolve", { ...this.args(), path });
  }

  async read(path: string): Promise<Uint8Array> {
    return new Uint8Array(await invoke<ArrayBuffer>("game_read", { ...this.args(), path }));
  }

  async readText(path: string): Promise<string> {
    // TextDecoder drops a leading byte-order mark by default.
    return new TextDecoder("utf-8").decode(await this.read(path));
  }
}
