// Where the Problems checks look files up: the project's map folder (and a chapter map's campaign),
// then the game's data.

import type { FileInfo, W3Api } from "../../extensions/api";
import { toArchiveName } from "../../lib/formats/archivepath";
import { joinPath } from "../../lib/paths";
import { findCampaign } from "./invalid";

/** A path as the game looks it up: lower case, "\\", without art set or language folders
 *  (`_HD.w3mod\\`, `_Locales\\zhCN.w3mod\\`), which only choose the variant. */
const plainPath = (p: string) => {
  let s = p.replace(/\//g, "\\").toLowerCase();
  for (let before = ""; before !== s;) { before = s; s = s.replace(/^(_hd|_de|_teen)\.w3mod\\|^_locales\\[a-z]{4}\.w3mod\\/, ""); }
  return s;
};

/** The key of a game path in the lookup's cache. */
const gameKey = (path: string) => path.replace(/\//g, "\\").toLowerCase();

export type FileKind = "model" | "texture" | "file";

/** Where files are looked up: the project's map folder (and a chapter map's campaign), then the
 *  game's data (cached). */
export class FileLookup {
  /** The map's own files: plain path → path in the project ("map/…", as listed). */
  private own = new Map<string, string>();
  /** A chapter map's campaign's files: plain path → path below the campaign's map folder. */
  private campaignFiles = new Map<string, string>();
  /** The campaign project's folder, once known (a chapter map's only). */
  private campaign: string | undefined;
  private game = new Map<string, Promise<boolean>>();
  private ready: Promise<void>;
  constructor(private w3: W3Api) {
    const add = (into: Map<string, string>, list: FileInfo[]) => {
      for (const f of list) {
        const rel = f.path.replace(/\\/g, "/");
        if (!rel.toLowerCase().startsWith("map/")) continue;
        const archive = toArchiveName(rel.slice(4)), key = plainPath(archive);
        // Several variants (`_HD.w3mod\…`) give one key: the plain file stands for it if there is one.
        if (!into.has(key) || archive.replace(/\//g, "\\").toLowerCase() === key) into.set(key, rel);
      }
    };
    add(this.own, w3.workspace.files());
    // A campaign's chapter map also uses the campaign's imports. Only a folder that holds
    // war3campaign.w3f is a campaign (as for its custom objects); one that is but whose files can't
    // be listed makes the lookup fail, never pass for a campaign without files.
    this.ready = (async () => {
      const campaign = await findCampaign(w3);
      if (campaign === undefined) return;
      const failed = (why: string) => new Error(`The campaign's files (${campaign}) couldn't be listed (${why}), so files of the chapter map that may be among them can't be checked.`);
      let list: { files: FileInfo[]; unreadable: { path: string; error: string }[] };
      try { list = await w3.backend.invoke("project_files_partial", { root: campaign }); } catch (e) {
        throw failed(e instanceof Error ? e.message : String(e));
      }
      // The campaign folder holds its chapters' projects too (maps\<chapter>): one that can't be read
      // doesn't matter here, a folder of the campaign's own map does.
      const inMapFolder = list.unreadable.find((u) => /^map(\/|$)/i.test(u.path.replace(/\\/g, "/")));
      if (inMapFolder) throw failed(`${inMapFolder.path}: ${inMapFolder.error}`);
      this.campaign = campaign;
      add(this.campaignFiles, list.files);
    })();
    // The checks that ask report the failure; when none asks, it isn't an unhandled rejection.
    this.ready.catch(() => {});
  }
  /** Once the map's files are all known (a chapter map's campaign is listed in the background).
   *  Rejects, saying why, if the campaign's files can't be listed. */
  whenReady(): Promise<void> {
    return this.ready;
  }
  /** Whether the map (or a chapter map's campaign) has the file: only once whenReady() resolved,
   *  before that a campaign's files are missing from it. */
  inMap(path: string) {
    const key = plainPath(path);
    return this.own.has(key) || this.campaignFiles.has(key);
  }
  /** Whether the map's own folder has the file (not only a chapter map's campaign): what writing it
   *  into the map would replace rather than create. */
  inOwnMap(path: string) {
    return this.own.has(plainPath(path));
  }
  /** The bytes of the map's file as the game would find it: the map's own, else (a chapter map) its
   *  campaign's; null if neither has it. A file that is there but can't be read throws. Waits for
   *  whenReady(), and rejects as it does. */
  async read(path: string): Promise<Uint8Array | null> {
    await this.ready;
    const key = plainPath(path);
    const own = this.own.get(key);
    if (own !== undefined) return this.w3.workspace.readBytes(own);
    const theirs = this.campaignFiles.get(key);
    if (theirs !== undefined && this.campaign !== undefined) return this.w3.backend.readBytes(joinPath(this.campaign, theirs));
    return null;
  }
  inGame(path: string): Promise<boolean> {
    const key = gameKey(path);
    let p = this.game.get(key);
    if (!p) {
      p = this.w3.game.resolve(path.replace(/\//g, "\\")).then((r) => !!r, () => false);
      this.game.set(key, p);
    }
    return p;
  }
  /** The names exists() tries: as written, with the extensions the game also accepts
   *  (models without extension or as .mdl → .mdx; textures as .dds). */
  static variants(path: string, kind: FileKind): string[] {
    const variants = [path];
    if (kind === "model") {
      if (!/\.\w{3}$/.test(path)) variants.push(`${path}.mdx`);
      else if (/\.mdl$/i.test(path)) variants.push(path.replace(/\.mdl$/i, ".mdx"));
    }
    if (kind === "texture") {
      if (!/\.\w{3}$/.test(path)) variants.push(`${path}.blp`, `${path}.dds`);
      else if (/\.(blp|tif|tga|png)$/i.test(path)) variants.push(path.replace(/\.\w+$/, ".dds"));
    }
    return variants;
  }
  /** Whether any variant exists (see variants), in the map or in the game. */
  async exists(path: string, kind: FileKind): Promise<boolean> {
    const variants = FileLookup.variants(path, kind);
    await this.ready;
    if (variants.some((v) => this.inMap(v))) return true;
    for (const v of variants) if (await this.inGame(v)) return true;
    return false;
  }
  /** Looks up, in one backend call, the game paths that exists() will ask about for these and
   *  doesn't know yet (paths the map has itself are never asked about). Only a speed-up: if the
   *  batch fails, each is asked on its own later, as without it. */
  async prefetch(items: [path: string, kind: FileKind][]): Promise<void> {
    await this.ready;
    const paths: string[] = [];
    for (const [path, kind] of items) {
      const variants = FileLookup.variants(path, kind);
      if (!variants.some((v) => this.inMap(v))) paths.push(...variants);
    }
    await this.prefetchGame(paths);
  }
  /** Looks up, in one backend call, the game paths inGame() will be asked about and doesn't know yet. */
  async prefetchGame(paths: string[]): Promise<void> {
    const wanted = new Map<string, string>();
    for (const p of paths) {
      const key = gameKey(p);
      if (!this.game.has(key) && !wanted.has(key)) wanted.set(key, p.replace(/\//g, "\\"));
    }
    if (!wanted.size) return;
    const list = [...wanted];
    let found: (string | null)[];
    try { found = await this.w3.game.resolveMany(list.map(([, p]) => p)); } catch { return; }
    if (!Array.isArray(found) || found.length !== list.length) return;
    list.forEach(([key], i) => { if (!this.game.has(key)) this.game.set(key, Promise.resolve(!!found[i])); });
  }
}
