// Import list helpers: where an imported file lives in the project, which map
// files are the map's own (not imports), and new entries as the World Editor
// makes them.

import { toArchiveName, toProjectPath } from "../../lib/formats/archivepath";

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

/** The map's own files at the archive root (and their JSON forms), which aren't imports. */
const OWN = /^(war3map(\.[a-z0-9]+|Map\.[a-z]+|Skin\.[a-z0-9]+|Units\.doo|Misc\.txt|Extra\.txt)|war3campaign\.[a-z0-9]+|conversation\.json|\(listfile\)|\(attributes\)|\(signature\))(\.json)?$/i;

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
export const isMapFile = (archivePath: string) => !/[\\/]/.test(archivePath) && OWN.test(archivePath);

/** Archive path for a file imported from disk: war3mapImported\<name> (campaigns: war3campImported),
 *  numbered if taken. */
export function importPath(fileName: string, taken: (path: string) => boolean, folder = IMPORT_FOLDER): string {
  const name = fileName.split(/[\\/]/).pop() ?? "file";
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; ; n++) {
    const p = `${folder}\\${stem}${n > 1 ? ` (${n})` : ""}${ext}`;
    if (!taken(p)) return p;
  }
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
