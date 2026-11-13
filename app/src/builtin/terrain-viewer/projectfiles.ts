// What the terrain viewer reads of a project besides its terrain: the object data whose art and bases it draws with,
// and a file the map imports, else the game's. Shared by the open editor, the rebuilds with no editor open and
// `w3proj rebuild` (src/headless), so the derived files come out the same in each.

import type { EditorDocument, W3Api } from "../../extensions/api";
import { joinPath } from "../../lib/paths";
import { importedPath, modeNames } from "../../lib/imports";
import { campaignCandidates } from "./chapterimports";
import { loadSkins, withObjectArt, type ObjectArt } from "./objects";

/** The object data the terrain view needs (units, items, destructables, doodads): the bases
 *  of custom ids, and the files in the order their art applies — a chapter map's campaign first, then
 *  the map's own, then its Skin files (Reforged keeps art changes there). */
export async function mapObjectData(w3: W3Api): Promise<{ bases: Map<string, string>; art: ObjectArt[] }> {
  const kinds = ["w3u", "w3t", "w3b", "w3d"];
  const read = async (path: string, kind: string): Promise<ObjectArt | null> => {
    try { return { ...(JSON.parse(await w3.workspace.readText(path)) as Omit<ObjectArt, "kind">), kind }; } catch { return null; }
  };
  const art: ObjectArt[] = [];
  // A campaign's chapter map also uses the campaign's custom objects.
  const campaign = campaignRoot(w3);
  if (campaign) for (const k of kinds) { const f = await read(joinPath(campaign, "map", `war3campaign.${k}.json`), k); if (f) art.push(f); }
  const files = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
  for (const prefix of ["war3map", "war3mapSkin"]) {
    for (const k of kinds) {
      const path = `map/${prefix}.${k}.json`;
      if (!files.has(path.toLowerCase())) continue;
      const f = await read(path, k);
      if (f) art.push(f);
    }
  }
  const bases = new Map<string, string>();
  for (const f of [...art].reverse()) for (const o of f.custom ?? []) if (o.id && !bases.has(o.id)) bases.set(o.id, o.base);
  return { bases, art };
}

/** The skins (the game's object data with the map's art changes) and custom ids' bases the derived files are made
 *  with, from the project's saved object data. */
export async function savedObjects(w3: W3Api) {
  const [skins, { bases, art }] = await Promise.all([loadSkins(w3), mapObjectData(w3)]);
  return { skins: withObjectArt(skins, art), baseOf: (id: string) => bases.get(id) };
}

/** The campaign project of a chapter map project (…/maps/<file>), or undefined. */
function campaignRoot(w3: W3Api): string | undefined {
  const root = w3.workspace.project()?.root;
  return root ? /^(.*)[\\/]maps[\\/][^\\/]+[\\/]?$/.exec(root)?.[1] : undefined;
}

/** The files of a campaign's map folder, to find an import under its name on disk (see campaignCandidates); one listing per
 *  campaign for a few seconds, as most reads here are of the game's files. Null when it can't be listed. */
const listings = new Map<string, { at: number; files: Promise<string[] | null> }>();
function campaignListing(w3: W3Api, campaign: string): Promise<string[] | null> {
  const known = listings.get(campaign);
  if (known && Date.now() - known.at < 5000) return known.files;
  const files = w3.workspace.listFolder(joinPath(campaign, "map")).catch(() => null);
  listings.set(campaign, { at: Date.now(), files });
  return files;
}

/** A file the map imports: the project's own, else (chapter maps) the campaign's. In HD and
 *  Reforged modes an import's HD version (`_HD.w3mod\…`, as Reforged maps store them) wins. */
export async function readImport(w3: W3Api, path: string): Promise<Uint8Array> {
  const names = modeNames(path.replace(/\//g, "\\"), w3.settings.get<string>("game.graphicsMode") ?? "hd");
  const campaign = campaignRoot(w3);
  // The project's own files are known; only those are read (most paths are the game's), under the name they have on
  // disk: the game finds them whatever the case, and on Linux the name asked for may not be there.
  const own = names.flatMap((n) => importedPath(w3, n) ?? []);
  const candidates = [...own, ...(campaign ? campaignCandidates(campaign, names, await campaignListing(w3, campaign)) : [])];
  let last: unknown = new Error(`${path} isn't imported`);
  for (const c of candidates) {
    try { return await w3.workspace.readBytes(c); } catch (e) { last = e; }
  }
  throw last;
}

/** A file the map imports, else the game's; `tileset`: the map's, whose own versions of game
 *  files (`_Tilesets/<letter>.w3mod`: water, some creeps' textures, …) win as in the game. */
export async function readFile(w3: W3Api, doc: Pick<EditorDocument, "path">, path: string, tileset?: string): Promise<Uint8Array> {
  if (!doc.path.startsWith("game:") && w3.workspace.project()) {
    try { return await readImport(w3, path); } catch { /* use the game's */ }
  }
  return w3.game.read(path, { tileset });
}
