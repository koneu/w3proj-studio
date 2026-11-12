// Import list helpers: where an imported file lives in the project, which map
// files are the map's own (not imports), and new entries as the World Editor
// makes them.

import type { FileInfo, W3Api } from "../extensions/api";
import { toArchiveName, toProjectPath } from "./formats/archivepath";

/** A war3map.imp entry (format definition "imports"). */
export interface ImportEntry { flags: number; path: string }

/** Flags of files imported with the standard path (war3mapImported\…) by current editors. */
export const NEW_IMPORT_FLAGS = 21;
/** Flags of "standard path" entries (classic editors): the listed name is inside the import folder. */
const STANDARD_FLAGS = [5, 8];
/** A custom path (flags of classic editors' "use custom path"). */
export const CUSTOM_PATH_FLAGS = 13;
export const IMPORT_FOLDER = "war3mapImported";
export const CAMPAIGN_IMPORT_FOLDER = "war3campImported";

/** The project file of an archive path ("war3mapImported\a.blp" → "map/war3mapImported/a.blp"). */
export const projectPath = (archivePath: string) => `map/${toProjectPath(archivePath)}`;
/** The archive path of a file in the project's map folder ("map/…"). */
export const archivePath = (projectFile: string) => toArchiveName(projectFile.replace(/^map\//, ""));

/** Same archive path regardless of case (the game's archive isn't case sensitive). */
export const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The map's own files at the archive root (and their JSON or text project forms), which aren't
 *  imports (war3mapPreview.tga, the preview image, too: maps without any import entry hold it). */
const OWN = /^(war3map(\.[a-z0-9]+|Map\.[a-z]+|Preview\.[a-z]+|Skin\.[a-z0-9]+|Units\.doo|Misc\.txt|Extra\.txt)|war3campaign(\.[a-z0-9]+|Skin\.[a-z0-9]+|Misc\.txt|Extra\.txt)|conversation\.json|\(listfile\)|\(attributes\)|\(signature\))(\.json|\.txt)?$/i;

const SOUND = /\.(flac|ogg|mp3|wav)$/i;
/** The project files that can stand for an archive path: itself, and for sounds the same name with
 *  another sound extension (Blizzard's maps list .flac where the archive holds .ogg; the game takes it). */
/** The project files that can stand for a list entry: standard-path entries (flags 5, 8) are looked
 *  for in the import folder first (920 of a campaign's entries are), then as listed. */
export function entryCandidates(e: ImportEntry, folder: string): string[] {
  return STANDARD_FLAGS.includes(e.flags) ? [...candidates(`${folder}\\${e.path}`), ...candidates(e.path)] : candidates(e.path);
}

export function candidates(archivePath: string): string[] {
  const own = projectPath(archivePath);
  return SOUND.test(archivePath) ? [own, ...[".flac", ".ogg", ".mp3", ".wav"].map((e) => projectPath(archivePath.replace(SOUND, e)))] : [own];
}
export const isMapFile = (archivePath: string) => {
  // Also in an art set or language folder (Blizzard's maps hold _Locales\deDE.w3mod\war3map.wts and the like).
  const name = archivePath.replace(/^(?:(?:_hd|_de|_teen)\.w3mod[\\/]|_locales[\\/][a-z]{4}\.w3mod[\\/])+/i, "");
  return !/[\\/]/.test(name) && OWN.test(name);
};

/** The project file a list entry stands for: the first of its candidates the project has, in any case (the game's
 *  archive isn't case sensitive), as `has` (lower-case project path → the path as listed) finds it. */
export function entryFile(e: ImportEntry, folder: string, has: (lowerPath: string) => string | undefined): string | undefined {
  for (const c of entryCandidates(e, folder)) { const f = has(c.toLowerCase()); if (f) return f; }
  return undefined;
}

/** The files of the project's map folder (`projectFiles`: project paths, "map/…" as listed) that no entry of the import
 *  list stands for and that aren't the map's own files: packed into the map all the same, and used by the game (an
 *  import replacing a game file), but the World Editor's Import Manager doesn't show them. Project paths, in the
 *  order given. */
export function unlistedFiles(projectFiles: readonly string[], entries: readonly ImportEntry[], folder: string): string[] {
  const inMap = projectFiles.map((p) => p.replace(/\\/g, "/")).filter((p) => p.toLowerCase().startsWith("map/"));
  const byLower = new Map<string, string>();
  for (const p of inMap) if (!byLower.has(p.toLowerCase())) byLower.set(p.toLowerCase(), p);
  const claimed = new Set(entries.map((e) => entryFile(e, folder, (l) => byLower.get(l))?.toLowerCase()).filter((x): x is string => !!x));
  return inMap.filter((p) => !claimed.has(p.toLowerCase()) && !isMapFile(archivePath(p)));
}

/** Per file list (the workspace replaces the array when a file comes or goes): exact project paths, and lower case →
 *  the first path listed so. */
const listIndex = new WeakMap<readonly FileInfo[], { exact: Set<string>; lower: Map<string, string> }>();

/** The project file `path` ("map/…") is listed as, in whatever case it has on disk: the game finds a map's files
 *  whatever the case, but on Linux a file read under another case isn't there. The exact spelling wins when both
 *  are listed. Undefined when the project has no such file. */
export function listedPath(files: readonly FileInfo[], path: string): string | undefined {
  let index = listIndex.get(files);
  if (!index) {
    index = { exact: new Set(), lower: new Map() };
    for (const f of files) {
      const p = f.path.replace(/\\/g, "/");
      index.exact.add(p);
      if (!index.lower.has(p.toLowerCase())) index.lower.set(p.toLowerCase(), p);
    }
    listIndex.set(files, index);
  }
  const want = path.replace(/\\/g, "/");
  return index.exact.has(want) ? want : index.lower.get(want.toLowerCase());
}

/** The project file of an archive path the map uses (`Units\Human\Footman\Footman.mdx`, `war3mapImported\a.blp`), found
 *  as the game finds it, whatever its case: "map/…" as listed, or undefined when the map has no such file. */
export function importedPath(w3: Pick<W3Api, "workspace">, archive: string): string | undefined {
  return listedPath(w3.workspace.files(), projectPath(archive.replace(/\//g, "\\")));
}

/** The bytes of the map's own file for an archive path (see importedPath): null when the map has none. A file that is
 *  listed but can't be read rejects. */
export async function readImported(w3: Pick<W3Api, "workspace">, archive: string): Promise<Uint8Array | null> {
  const path = importedPath(w3, archive);
  return path === undefined ? null : w3.workspace.readBytes(path);
}

/** Archive path for a file imported from disk: war3mapImported\<name> (campaigns: war3campImported),
 *  numbered if taken. */
export function importPath(fileName: string, taken: (path: string) => boolean, folder = IMPORT_FOLDER): string {
  return numberedPath(folder, fileName.split(/[\\/]/).pop() ?? "file", taken);
}

function numberedPath(folder: string, name: string, taken: (path: string) => boolean): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n++) {
    const p = `${folder}\\${stem}${n > 1 ? ` (${n})` : ""}${ext}`;
    if (!taken(p)) return p;
  }
}

/** Archive path for a file of an imported folder (`relative`: "Pack/fx/a.blp"): the folder's
 *  structure stays below the import folder, numbered if taken. */
export function importTreePath(relative: string, taken: (path: string) => boolean, folder = IMPORT_FOLDER): string {
  const parts = relative.split(/[\\/]/);
  const name = parts.pop() ?? "file";
  return numberedPath([folder, ...parts].join("\\"), name, taken);
}

/** System and tool leftovers that a folder import skips (dot files and folders such as .git). */
export function isJunkFile(relative: string): boolean {
  const parts = relative.split(/[\\/]/);
  return parts.some((p) => p.startsWith(".")) || /^(thumbs\.db|desktop\.ini)$/i.test(parts[parts.length - 1]);
}

/** What a file is, by its extension (for the list and choosing a viewer). */
export function kindOf(path: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? "").toLowerCase();
  if (["blp", "dds", "tga", "png", "jpg"].includes(ext)) return "Image";
  if (["mdx", "mdl"].includes(ext)) return "Model";
  if (["flac", "wav", "mp3", "ogg"].includes(ext)) return "Sound";
  if (["j", "lua", "ai", "txt", "fdf", "toc", "slk", "json", "wts"].includes(ext)) return "Text";
  return ext ? ext.toUpperCase() : "File";
}
