import type { GameInfo, Settings } from "../extensions/api";
import { invoke as backendInvoke } from "./backend";
import { gameDataError } from "./gameerror";

/** Documents with this prefix are files from the game's storage. */
export const GAME_SCHEME = "game:";

/** The setting with the cache's size, in megabytes (see GameService). */
export const GAME_CACHE_SETTING = "game.cacheMegabytes";
export const GAME_CACHE_DEFAULT_MB = 1024;

/** The setting that turns the fast game file transfer on (off by default; see GameService.fastRead). */
export const FAST_TRANSFER_SETTING = "game.fastTransfer";

/** Where the fast transfer's server is (backend `game_fast_transfer`). The token is for this page only: never log it. */
interface FastEndpoint { port: number; token: string }

/** Game reads waiting on the backend at most. Opening a big map asks for a thousand files at once;
 *  the backend reads them a few at a time anyway, and the rest only held memory and IPC there
 *  (about 315 in flight on GoldRush). Later ones wait here: the ones someone waits on first, each
 *  kind first come first asked (see BACKGROUND_TURN). */
export const MAX_READS_IN_FLIGHT = 32;

/** While reads someone waits on are queued, every this many free places one goes to the longest
 *  waiting background read: a map that keeps asking for files can't hold a check back for good. */
export const BACKGROUND_TURN = 8;

/** Background reads running at most, even with places free, and only one while reads someone waits
 *  on run or wait: those (a map opened while the Object Manager reads its tables) wait behind few,
 *  not behind a full queue. Taking every free place, they put GoldRush's first model reads 150 ms
 *  and its picture 0.4 s later. */
export const BACKGROUND_IN_FLIGHT = 8;

/** The share of the cache that files read more than once can hold (the rest is for files read
 *  once so far). A pass over many files read once (a check, a big map's models) only replaces
 *  others read once; the ones read again stay. */
export const PROTECTED_SHARE = 3 / 4;

/** A queued read; `give` starts it, saying whether it runs as a background read. */
interface Waiting { key: string; background: boolean; give: (asBackground: boolean) => void }

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
  /** Paths the backend said aren't there, in order (each once, as they're remembered; `reload` empties it, as it forgets them): for the app smoke's guard. */
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
  /** Background reads running (see BACKGROUND_IN_FLIGHT). */
  private backgroundInFlight = 0;

  /** The fast transfer's server while `game.fastTransfer` is on: asked once, null when it can't be had or failed. */
  private fast: Promise<FastEndpoint | null> | null = null;
  /** Backend reads the fast transfer answered, and ones that went to `game_read` after it failed (tests, the app smoke). */
  fastReads = 0;
  fastFallbacks = 0;

  /** Test and smoke builds only (off in the app): every shared read is checksummed when handed out; the next read of the
   *  file and `sharedChanged` check the kept bytes against it, so a caller that wrote into them, or detached their buffer,
   *  is found (a wrong `shared: true`). Costs a pass over each file read this way. */
  guardShared = false;
  private sharedSums = new Map<string, { path: string; bytes: Uint8Array; length: number; sum: number }>();
  /** Paths whose shared bytes were found changed, in order found (the guard; `reload` doesn't empty it). */
  readonly sharedChanges: string[] = [];

  /** Backend reads not finished yet, running or queued: the app smoke waits for none before it counts. */
  get readsPending(): number { return this.inFlight + this.queuedNow.length + this.queuedLater.length; }

  /** `cacheBytes`: a fixed size instead of the setting's (tests). */
  constructor(private settings: Settings, private cacheBytes?: number) {
    settings.onDidChange((k) => {
      if (k === "game.installDir") this.reload();
      if (k === GAME_CACHE_SETTING) this.trim();
      if (k === FAST_TRANSFER_SETTING) {
        this.fast = null;
        // Off: the server stops and its port closes (reads still running fall back to game_read).
        if (!this.fastOn) backendInvoke("game_fast_transfer", { on: false }).catch(() => {});
      }
    });
  }

  private get fastOn(): boolean { return this.settings.get<boolean>(FAST_TRANSFER_SETTING) === true; }

  /** Forgets every file read and the file list: the next reads ask the game's storage again. A fast transfer that
   *  failed is tried again too. */
  reload() {
    this.fast = null;
    this.listCache = null;
    this.files.clear();
    this.probation.clear();
    this.protected.clear();
    this.cachedBytes = 0;
    this.protectedBytes = 0;
    this.backendMisses.length = 0;
    this.sharedSums.clear();
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
   *  `background`: nobody waits on it now (see GameReadOptions).
   *  `shared`: the kept bytes themselves, not a copy (see GameReadOptions): the caller must never write to them. */
  async read(path: string, tileset?: string, background = false, shared = false): Promise<Uint8Array> {
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
      const started = this.limited(key, background, () => this.backendRead(args, path, tileset));
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
    const bytes = await read;
    if (this.guardShared) this.guard(key, path, bytes, shared);
    return shared ? bytes : bytes.slice();
  }

  /** The guard (see `guardShared`) for a read of `key`: the earlier shared hand-out of these bytes must be as it was
   *  (else it throws, naming the file), and a shared hand-out is noted. */
  private guard(key: string, path: string, bytes: Uint8Array, shared: boolean) {
    const noted = this.sharedSums.get(key);
    if (noted && noted.bytes === bytes) this.checkNoted(noted);
    if (shared && (!noted || noted.bytes !== bytes)) this.sharedSums.set(key, { path, bytes, length: bytes.byteLength, sum: checksum(bytes) });
  }

  private checkNoted(noted: { path: string; bytes: Uint8Array; length: number; sum: number }) {
    if (noted.bytes.byteLength === noted.length && checksum(noted.bytes) === noted.sum) return;
    this.sharedChanges.push(noted.path);
    // Said once, then taken as the new state: one wrong caller isn't reported by every later read.
    noted.length = noted.bytes.byteLength;
    noted.sum = checksum(noted.bytes);
    throw new Error(`game file ${noted.path} was changed by a caller that read it with shared: true`);
  }

  /** The guard's check of every file handed out shared so far: the paths found changed (empty: all as they were). */
  sharedChanged(): string[] {
    const found: string[] = [];
    for (const noted of this.sharedSums.values()) {
      try { this.checkNoted(noted); } catch { found.push(noted.path); }
    }
    return found;
  }

  /** One file from the backend: through the fast transfer when it's on and answers, else by `game_read`. */
  private async backendRead(args: { install?: string; modeName?: string }, path: string, tileset?: string): Promise<Uint8Array> {
    if (this.fastOn) {
      const bytes = await this.fastRead(args, path, tileset);
      if (bytes) {
        this.fastReads++;
        return bytes;
      }
      this.fastFallbacks++;
    }
    return new Uint8Array(await this.invoke<ArrayBuffer>("game_read", { ...args, path, tileset: tileset ?? null }));
  }

  /** The fast transfer (setting `game.fastTransfer`): an HTTP GET to the app's own server on 127.0.0.1 (backend
   *  fastgame.rs), several times faster than the IPC for big files. Null whenever it doesn't give the file, and the
   *  read goes to `game_read`: the server can't be had (no backend command, headless), the storage isn't open there
   *  yet (409, game_read opens it), any other answer. A request that doesn't reach it (the port closed or blocked)
   *  turns it off until the setting changes or `reload`. "Not found" is an answer: thrown as `game_read` throws it. */
  private async fastRead(args: { install?: string; modeName?: string }, path: string, tileset?: string): Promise<Uint8Array | null> {
    this.fast ??= backendInvoke<FastEndpoint | null>("game_fast_transfer", { on: true }).catch(() => null);
    const asked = this.fast;
    const endpoint = await asked;
    if (!endpoint) return null;
    const query = new URLSearchParams({ install: args.install ?? "", mode: args.modeName ?? "", path });
    if (tileset) query.set("tileset", tileset);
    let answer: Response;
    try {
      answer = await fetch(`http://127.0.0.1:${endpoint.port}/${endpoint.token}/read?${query}`, { cache: "no-store", credentials: "omit", redirect: "error" });
    } catch {
      if (this.fast === asked) this.fast = Promise.resolve(null);
      return null;
    }
    try {
      if (answer.status === 200) return new Uint8Array(await answer.arrayBuffer());
      if (answer.status === 404) {
        const text = await answer.text();
        if (/^not found: /.test(text)) throw text;
      }
    } catch (e) {
      if (typeof e === "string") throw e;
      // The body broke off: game_read gives the whole file.
    }
    return null;
  }

  /** Runs a backend read when one of MAX_READS_IN_FLIGHT places is free; a finished read hands
   *  its place to the next queued (see next). */
  private async limited<T>(key: string, background: boolean, job: () => Promise<T>): Promise<T> {
    // Whether it runs as a background read (it may be moved up while queued).
    let asBackground = background;
    if (this.inFlight < MAX_READS_IN_FLIGHT && (!background || this.backgroundRoom())) {
      this.inFlight++;
      if (background) this.backgroundInFlight++;
    } else {
      asBackground = await new Promise<boolean>((give) => {
        const waiting: Waiting = { key, background, give };
        (background ? this.queuedLater : this.queuedNow).push(waiting);
        this.queuedByKey.set(key, waiting);
      });
    }
    try {
      return await job();
    } finally {
      if (asBackground) this.backgroundInFlight--;
      const next = this.next();
      if (next) {
        if (this.queuedByKey.get(next.key) === next) this.queuedByKey.delete(next.key);
        if (next.background) this.backgroundInFlight++;
        next.give(next.background);
      } else this.inFlight--;
      // The last read waited on finished: background reads may take more places now.
      while (this.queuedLater.length && !this.queuedNow.length && this.inFlight < MAX_READS_IN_FLIGHT && this.backgroundRoom()) {
        const more = this.queuedLater.shift()!;
        if (this.queuedByKey.get(more.key) === more) this.queuedByKey.delete(more.key);
        this.inFlight++;
        this.backgroundInFlight++;
        more.give(true);
      }
    }
  }

  /** Whether another background read may run: BACKGROUND_IN_FLIGHT at most, and only one while reads
   *  someone waits on run or wait (their reading and parsing would hold those up). */
  private backgroundRoom(): boolean {
    const waitedOn = this.inFlight - this.backgroundInFlight > 0 || this.queuedNow.length > 0;
    return this.backgroundInFlight < (waitedOn ? 1 : BACKGROUND_IN_FLIGHT);
  }

  /** The queued read that gets a free place: the longest waiting of those someone waits on, except
   *  every BACKGROUND_TURN-th place, which goes to the longest waiting background read (see
   *  backgroundRoom). */
  private next(): Waiting | undefined {
    const later = this.queuedLater.length > 0 && this.backgroundRoom();
    if (later && (!this.queuedNow.length || this.sinceLater >= BACKGROUND_TURN - 1)) {
      this.sinceLater = 0;
      return this.queuedLater.shift();
    }
    if (later) this.sinceLater++;
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

/** FNV-1a over the bytes (the guard of shared reads: a change of any byte or of the length shows). */
function checksum(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}
