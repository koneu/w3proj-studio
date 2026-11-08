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
 *  (about 315 in flight on GoldRush). Later ones wait here: the ones someone waits on first, each
 *  kind first come first asked (see BACKGROUND_TURN). */
export const MAX_READS_IN_FLIGHT = 32;

/** While reads someone waits on are queued, every this many free places one goes to the longest
 *  waiting background read: a map that keeps asking for files can't hold a check back for good. */
export const BACKGROUND_TURN = 8;

/** The share of the cache that files read more than once can hold (the rest is for files read
 *  once so far). A pass over many files read once (a check, a big map's models) only replaces
 *  others read once; the ones read again stay. */
export const PROTECTED_SHARE = 3 / 4;

interface Waiting { key: string; background: boolean; give: () => void }

/** Read-only access to the installed game's data via the backend. The game's files don't change
 *  while the app runs, so what was read is kept (up to `game.cacheMegabytes`) and a file that isn't
 *  there is remembered as such: a map opened again, another editor showing the same model, or a
 *  reload of the object data asks the backend nothing. The cache is a segmented LRU: a file read
 *  once waits in a probation part, read again (not by a background read) it moves to the protected
 *  part (PROTECTED_SHARE of the size); what must go is the least recently used of probation first.
 *  `reload` forgets it all, for an install that changed underneath (a patch). */
export class GameService {
  private listCache: Promise<string[]> | null = null;
  /** Reads by install, graphics mode, tileset and path, running or done. */
  private files = new Map<string, Promise<Uint8Array>>();
  /** Finished reads in `files` read once so far, with their size, least recently used first. */
  private probation = new Map<string, number>();
  /** Finished reads in `files` read again, with their size, least recently used first. */
  private protected = new Map<string, number>();
  private cachedBytes = 0;
  private protectedBytes = 0;
  /** Reads that went to the backend: for tests and the app smoke's guard. */
  backendReads = 0;
  /** Reads asked of this service, kept or not: an editor loading twice asks for everything twice (the app smoke's guard). */
  requests = 0;
  /** Paths the backend said aren't there, in order (each once, as they're remembered): for the app smoke's guard. */
  readonly backendMisses: string[] = [];
  /** Reads waiting on the backend now, and the ones queued for a place (see MAX_READS_IN_FLIGHT). */
  private inFlight = 0;
  /** Queued reads someone waits on, and background ones, each in the order asked. */
  private queuedNow: Waiting[] = [];
  private queuedLater: Waiting[] = [];
  /** The queued read of each key (to move a background one forward when someone waits on it). */
  private queuedByKey = new Map<string, Waiting>();
  /** Places given to reads someone waits on since a background read had one (see BACKGROUND_TURN). */
  private sinceLater = 0;

  /** Backend reads not finished yet, running or queued: the app smoke waits for none before it counts. */
  get readsPending(): number { return this.inFlight + this.queuedNow.length + this.queuedLater.length; }

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
    this.probation.clear();
    this.protected.clear();
    this.cachedBytes = 0;
    this.protectedBytes = 0;
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

  /** Each caller gets its own copy: one that changes its bytes can't change another's.
   *  `background`: nobody waits on it now (see GameReadOptions). */
  async read(path: string, tileset?: string, background = false): Promise<Uint8Array> {
    this.requests++;
    const args = this.args();
    // As the backend looks paths up: either slash, any case.
    const key = [args.install ?? "", args.modeName ?? "", tileset ?? "", path.replace(/\\/g, "/").toLowerCase()].join("|");
    let read = this.files.get(key);
    if (read) {
      if (!background) {
        this.used(key);
        // Someone waits on a read queued in the background now.
        const waiting = this.queuedByKey.get(key);
        if (waiting?.background) {
          waiting.background = false;
          this.queuedLater.splice(this.queuedLater.indexOf(waiting), 1);
          this.queuedNow.push(waiting);
        }
      }
    } else {
      this.backendReads++;
      const started = this.limited(key, background, () => this.invoke<ArrayBuffer>("game_read", { ...args, path, tileset: tileset ?? null })).then((b) => new Uint8Array(b));
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
   *  its place to the next queued (see next). */
  private async limited<T>(key: string, background: boolean, job: () => Promise<T>): Promise<T> {
    if (this.inFlight < MAX_READS_IN_FLIGHT) this.inFlight++;
    else {
      await new Promise<void>((give) => {
        const waiting: Waiting = { key, background, give };
        (background ? this.queuedLater : this.queuedNow).push(waiting);
        this.queuedByKey.set(key, waiting);
      });
    }
    try {
      return await job();
    } finally {
      const next = this.next();
      if (next) {
        if (this.queuedByKey.get(next.key) === next) this.queuedByKey.delete(next.key);
        next.give();
      } else this.inFlight--;
    }
  }

  /** The queued read that gets a free place: the longest waiting of those someone waits on, except
   *  every BACKGROUND_TURN-th place, which goes to the longest waiting background read. */
  private next(): Waiting | undefined {
    if (this.queuedLater.length && (!this.queuedNow.length || this.sinceLater >= BACKGROUND_TURN - 1)) {
      this.sinceLater = 0;
      return this.queuedLater.shift();
    }
    if (this.queuedLater.length) this.sinceLater++;
    return this.queuedNow.shift();
  }

  /** A read of a kept file that someone waits on: read once before, it is now in use (protected). */
  private used(key: string) {
    const size = this.protected.get(key);
    if (size !== undefined) {
      this.protected.delete(key);
      this.protected.set(key, size);
      return;
    }
    const once = this.probation.get(key);
    // Still running: reads at once of one file count as one.
    if (once === undefined) return;
    this.probation.delete(key);
    this.protected.set(key, once);
    this.protectedBytes += once;
    this.trim();
  }

  /** Counts a finished read in (as read once), and lets others go past the limit. */
  private keep(key: string, read: Promise<Uint8Array>, size: number) {
    // Cleared or replaced meanwhile.
    if (this.files.get(key) !== read) return;
    if (size > this.cacheLimit / 4) {
      this.files.delete(key);
      return;
    }
    this.probation.set(key, size);
    this.cachedBytes += size;
    this.trim();
  }

  /** Keeps the protected part to its share (its least recently used go back to probation), then
   *  lets the least recently used of probation go, then of the protected part, until the cache fits. */
  private trim() {
    const limit = this.cacheLimit;
    for (const [old, n] of this.protected) {
      if (this.protectedBytes <= limit * PROTECTED_SHARE) break;
      this.protected.delete(old);
      this.protectedBytes -= n;
      this.probation.set(old, n);
    }
    for (const segment of [this.probation, this.protected]) {
      for (const [old, n] of segment) {
        if (this.cachedBytes <= limit) return;
        segment.delete(old);
        this.files.delete(old);
        this.cachedBytes -= n;
        if (segment === this.protected) this.protectedBytes -= n;
      }
    }
  }

  async readText(path: string, tileset?: string, background = false): Promise<string> {
    // TextDecoder drops a leading byte-order mark by default.
    return new TextDecoder("utf-8").decode(await this.read(path, tileset, background));
  }
}
