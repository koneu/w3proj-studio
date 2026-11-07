import type { GameInfo, Settings } from "../extensions/api";
import { invoke as backendInvoke } from "./backend";
import { gameDataError } from "./gameerror";

/** Documents with this prefix are files from the game's storage. */
export const GAME_SCHEME = "game:";

/** The setting with the cache's size, in megabytes (see GameService). */
export const GAME_CACHE_SETTING = "game.cacheMegabytes";
export const GAME_CACHE_DEFAULT_MB = 1024;

/** Game reads waiting on the backend at most. Opening a big map asks for a thousand files at once;
 *  the backend reads them a few at a time anyway, and the rest only held memory and IPC there
 *  (about 315 in flight on GoldRush). Later ones wait here, first come first asked. */
export const MAX_READS_IN_FLIGHT = 32;

/** Read-only access to the installed game's data via the backend. The game's files don't change
 *  while the app runs, so what was read is kept (up to `game.cacheMegabytes`, the least recently
 *  read go first) and a file that isn't there is remembered as such: a map opened again, another
 *  editor showing the same model, or a reload of the object data asks the backend nothing.
 *  `reload` forgets it all, for an install that changed underneath (a patch). */
export class GameService {
  private listCache: Promise<string[]> | null = null;
  /** Reads by install, graphics mode, tileset and path, in the order last used. */
  private files = new Map<string, Promise<Uint8Array>>();
  /** Size of each finished read in `files`. */
  private sizes = new Map<string, number>();
  private cachedBytes = 0;
  /** Reads that went to the backend: for tests and the app smoke's guard. */
  backendReads = 0;
  /** Paths the backend said aren't there, in order (each once, as they're remembered): for the app smoke's guard. */
  readonly backendMisses: string[] = [];
  /** Reads waiting on the backend now, and the ones queued for a place (see MAX_READS_IN_FLIGHT). */
  private inFlight = 0;
  private queued: (() => void)[] = [];

  /** Backend reads not finished yet, running or queued: the app smoke waits for none before it counts. */
  get readsPending(): number { return this.inFlight + this.queued.length; }

  /** `cacheBytes`: a fixed size instead of the setting's (tests). */
  constructor(private settings: Settings, private cacheBytes?: number) {
    settings.onDidChange((k) => {
      if (k === "game.installDir") this.reload();
      if (k === GAME_CACHE_SETTING) this.trim();
    });
  }

  /** Forgets every file read and the file list: the next reads ask the game's storage again. */
  reload() {
    this.listCache = null;
    this.files.clear();
    this.sizes.clear();
    this.cachedBytes = 0;
  }

  /** Bytes of game files kept at most. */
  get cacheLimit(): number {
    if (this.cacheBytes !== undefined) return this.cacheBytes;
    const mb = Number(this.settings.get<number>(GAME_CACHE_SETTING) ?? GAME_CACHE_DEFAULT_MB);
    return Number.isFinite(mb) && mb >= 0 ? mb * 1024 * 1024 : GAME_CACHE_DEFAULT_MB * 1024 * 1024;
  }

  /** Bytes kept now. */
  get cachedSize(): number { return this.cachedBytes; }

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

  /** `resolve` for many paths in one backend call: the full path or null of each, in order. */
  resolveMany(paths: string[], tileset?: string): Promise<(string | null)[]> {
    return this.invoke<(string | null)[]>("game_resolve_many", { ...this.args(), paths, tileset: tileset ?? null });
  }

  /** Each caller gets its own copy: one that changes its bytes can't change another's. */
  async read(path: string, tileset?: string): Promise<Uint8Array> {
    const args = this.args();
    // As the backend looks paths up: either slash, any case.
    const key = [args.install ?? "", args.modeName ?? "", tileset ?? "", path.replace(/\\/g, "/").toLowerCase()].join("|");
    let read = this.files.get(key);
    if (read) {
      this.files.delete(key);
      this.files.set(key, read);
    } else {
      this.backendReads++;
      const started = this.limited(() => this.invoke<ArrayBuffer>("game_read", { ...args, path, tileset: tileset ?? null })).then((b) => new Uint8Array(b));
      read = started;
      this.files.set(key, started);
      started.then((bytes) => this.keep(key, started, bytes.byteLength), (e) => {
        // Only "not there" is for good; another failure (game data that can't be opened, the
        // storage busy) is tried again next time.
        const message = typeof e === "string" ? e : String((e as Error)?.message ?? e);
        if (/^not found: /.test(message)) this.backendMisses.push(path);
        else if (this.files.get(key) === started) this.files.delete(key);
      });
    }
    return (await read).slice();
  }

  /** Runs a backend read when one of MAX_READS_IN_FLIGHT places is free; a finished read hands
   *  its place to the longest waiting. */
  private async limited<T>(job: () => Promise<T>): Promise<T> {
    if (this.inFlight < MAX_READS_IN_FLIGHT) this.inFlight++;
    else await new Promise<void>((give) => this.queued.push(give));
    try {
      return await job();
    } finally {
      const next = this.queued.shift();
      if (next) next();
      else this.inFlight--;
    }
  }

  /** Counts a finished read in, and lets the least recently used go past the limit. */
  private keep(key: string, read: Promise<Uint8Array>, size: number) {
    // Cleared or replaced meanwhile.
    if (this.files.get(key) !== read) return;
    if (size > this.cacheLimit / 4) {
      this.files.delete(key);
      return;
    }
    this.sizes.set(key, size);
    this.cachedBytes += size;
    this.trim();
  }

  /** Lets the least recently used go until the cache fits its limit. */
  private trim() {
    const limit = this.cacheLimit;
    for (const old of this.files.keys()) {
      if (this.cachedBytes <= limit) break;
      const n = this.sizes.get(old);
      if (n === undefined) continue;
      this.files.delete(old);
      this.sizes.delete(old);
      this.cachedBytes -= n;
    }
  }

  async readText(path: string, tileset?: string): Promise<string> {
    // TextDecoder drops a leading byte-order mark by default.
    return new TextDecoder("utf-8").decode(await this.read(path, tileset));
  }
}
