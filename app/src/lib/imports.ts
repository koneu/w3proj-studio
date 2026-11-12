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

// ---- Graphics modes ------------------------------------------------------------------------------------------------
// In Reforged mode the game reads `_HD.w3mod\<path>` before `<path>`: a map holds a Reforged version of a file there, the
// Classic one at the plain path, and object data, triggers and models name the plain path only. The World Editor's
// Asset Manager lists the two as separate rows (its Mode column: SD, HD); Blizzard's campaigns list the Reforged files
// as custom-path entries (flags 13) named `_HD.w3mod\…`.

/** The folder of a map's Reforged versions, spelled as Blizzard's maps do. */
export const REFORGED_FOLDER = "_HD.w3mod";
/** Flags of a Reforged version's entry (Blizzard's campaigns: custom path). */
export const REFORGED_FLAGS = CUSTOM_PATH_FLAGS;
const REFORGED_PREFIX = /^_hd\.w3mod\\/i;
/** The folder of a map's 3.0 (DE) versions: the game's `_DE.w3mod` art layer, which the 3.0 graphics mode reads first. */
export const DE_FOLDER = "_DE.w3mod";
/** Flags of a 3.0 version's entry: as a Reforged one's (the World Editor 3.0.1 keeps them as listed). */
export const DE_FLAGS = CUSTOM_PATH_FLAGS;
const DE_PREFIX = /^_de\.w3mod\\/i;

/** The Reforged version's path of a plain path ("war3mapImported\a.mdx" → "_HD.w3mod\war3mapImported\a.mdx"). */
export const reforgedPathOf = (plain: string) => `${REFORGED_FOLDER}\\${plain.replace(/\//g, "\\")}`;
/** Whether an archive path is a Reforged version (below `_HD.w3mod\`, any case). */
export const isReforgedPath = (path: string) => REFORGED_PREFIX.test(path.replace(/\//g, "\\"));
/** The 3.0 version's path of a plain path ("war3mapImported\a.mdx" → "_DE.w3mod\war3mapImported\a.mdx"). */
export const dePathOf = (plain: string) => `${DE_FOLDER}\\${plain.replace(/\//g, "\\")}`;
/** Whether an archive path is a 3.0 version (below `_DE.w3mod\`, any case). */
export const isDePath = (path: string) => DE_PREFIX.test(path.replace(/\//g, "\\"));
/** The plain path a Reforged or 3.0 version stands for ("_hd.w3mod\x.mdx" → "x.mdx"); a plain path as it is. */
export const classicPathOf = (path: string) => path.replace(/\//g, "\\").replace(REFORGED_PREFIX, "").replace(DE_PREFIX, "");
/** The flags a new entry for an archive path gets: a Reforged version's as Blizzard's campaigns list them, else the
 *  current editors'. */
export const newEntryFlags = (path: string) => (isReforgedPath(path) ? REFORGED_FLAGS : isDePath(path) ? DE_FLAGS : NEW_IMPORT_FLAGS);

/** Which graphics modes a new import is meant for: both (the plain path, as before), Classic only (the plain path too:
 *  Reforged reads it as well until a Reforged version is added), Reforged only (below `_HD.w3mod\`). */
export type UseIn = "both" | "classic" | "reforged" | "de";
/** Whether "Use in" applies to a file: models and textures (the files the game has per graphics mode). */
export const hasModeVersions = (path: string) => kindOf(path) === "Model" || kindOf(path) === "Image";
/** The archive path an import of `plain` gets for a "Use in" choice (other files than models and textures stay plain). */
export const pathForUse = (plain: string, use: UseIn) =>
  !hasModeVersions(plain) ? plain : use === "reforged" ? reforgedPathOf(plain) : use === "de" ? dePathOf(plain) : plain;
/** Whether `path` (a new import's path) clashes with what is there: itself or its other version (an unrelated
 *  `_HD.w3mod\` file of the same name would stand in for it in Reforged, and the other way round). */
export const takenWithVersions = (path: string, taken: (path: string) => boolean) => {
  const plain = classicPathOf(path);
  return taken(path) || [plain, reforgedPathOf(plain), dePathOf(plain)].some((p) => p !== path && taken(p));
};

/** One row of the Import Manager: a plain entry and the entries of its Reforged and 3.0 versions are one row, each alone
 *  is one. `path`: the plain path (what the map's data names). */
export interface ImportRow { key: string; path: string; classic?: ImportEntry; reforged?: ImportEntry; de?: ImportEntry }
/** The graphics modes' versions of a file: Classic (the plain path), Reforged (`_HD.w3mod\`), 3.0 (`_DE.w3mod\`). */
export type Side = "classic" | "reforged" | "de";
export const SIDES: readonly Side[] = ["classic", "reforged", "de"];
/** Which version an archive path is. */
export const sideOf = (path: string): Side => (isReforgedPath(path) ? "reforged" : isDePath(path) ? "de" : "classic");
/** The path of a plain path's version. */
export const sidePathOf = (plain: string, side: Side) => (side === "reforged" ? reforgedPathOf(plain) : side === "de" ? dePathOf(plain) : plain.replace(/\//g, "\\"));
/** The entries of a row (Classic, Reforged, 3.0). */
export const rowEntries = (r: ImportRow): ImportEntry[] => SIDES.map((s) => r[s]).filter((e): e is ImportEntry => !!e);
/** The rows of the list, in the order of each row's first entry. `pathOf`: the archive path an entry stands for (a
 *  standard-path entry's name is inside the import folder). A second entry for the same version stays a row of its
 *  own (lists may name a path twice). */
export function importRows(entries: readonly ImportEntry[], pathOf: (e: ImportEntry) => string = (e) => e.path): ImportRow[] {
  const rows: ImportRow[] = [];
  const byKey = new Map<string, ImportRow>();
  for (const e of entries) {
    const full = pathOf(e).replace(/\//g, "\\");
    const side = sideOf(full);
    const path = classicPathOf(full);
    const key = path.toLowerCase();
    const row = byKey.get(key);
    if (row && !row[side]) {
      row[side] = e;
      // The plain entry's spelling names the row.
      if (side === "classic") row.path = path;
      continue;
    }
    const fresh: ImportRow = { key: row ? `${key}|${rows.length}` : key, path, [side]: e };
    if (!row) byKey.set(key, fresh);
    rows.push(fresh);
  }
  return rows;
}

/** What Change path does to a row: each version moves (from → to, archive paths). A row with a Reforged or 3.0 version
 *  takes the plain path (an `_HD.w3mod\` or `_DE.w3mod\` in front is left out: the versions follow into their folders);
 *  a Classic entry alone moves to whatever is typed, as before. */
export function rowMoves(row: ImportRow, to: string, pathOf: (e: ImportEntry) => string = (e) => e.path): { entry: ImportEntry; from: string; to: string }[] {
  const target = row.reforged || row.de ? classicPathOf(to) : to.replace(/\//g, "\\");
  return SIDES.filter((s) => row[s]).map((s) => ({ entry: row[s]!, from: pathOf(row[s]!), to: sidePathOf(target, s) }));
}

/** The map's own names for an archive path in a graphics mode, in the order the game reads them: Classic ("sd") only the
 *  plain path; Reforged ("hd") the `_HD.w3mod\` version, then the plain one; 3.0 ("de") the `_DE.w3mod\` version, then
 *  the `_HD.w3mod\` one, then the plain one (the game's own 3.0 layer falls back to its Reforged art, then Classic). */
export function modeNames(archive: string, mode: string | undefined): string[] {
  const plain = classicPathOf(archive);
  return mode === "sd" || mode === "classic" ? [plain] : mode === "de" ? [dePathOf(plain), reforgedPathOf(plain), plain] : [reforgedPathOf(plain), plain];
}

/** The graphics mode a preview reads the map's files in: its preference ("classic"; "reforged", "hd"; "de"), else the
 *  mode set (game.graphicsMode; Reforged HD when unset, as the setting's default). */
export function previewMode(prefer: string | undefined, setting: string | undefined): "sd" | "hd" | "de" {
  const m = prefer === "classic" ? "sd" : prefer ? prefer : setting ?? "hd";
  return m === "sd" ? "sd" : m === "de" ? "de" : "hd";
}
/** The map's own names for the names a file may have (`variants`: a texture's .blp and .dds, …) in a graphics mode, in
 *  the order they are read: every version of the mode's first layer before any of the next layer's. */
export function ownNames(variants: readonly string[], mode: string | undefined): string[] {
  const names = variants.map((v) => modeNames(v.replace(/\//g, "\\"), mode));
  const layers = Math.max(0, ...names.map((n) => n.length));
  const out: string[] = [];
  for (let i = 0; i < layers; i++) for (const n of names) if (n[i] !== undefined) out.push(n[i]);
  return out.filter((n, i, all) => all.indexOf(n) === i);
}

/** The project file the map reads for an archive path in a graphics mode (see modeNames, importedPath). */
export function importedPathFor(w3: Pick<W3Api, "workspace">, archive: string, mode: string | undefined): string | undefined {
  for (const n of modeNames(archive.replace(/\//g, "\\"), mode)) { const p = importedPath(w3, n); if (p !== undefined) return p; }
  return undefined;
}

/** The bytes of the map's file for an archive path in a graphics mode (see importedPathFor): null when the map has none. */
export async function readImportedFor(w3: Pick<W3Api, "workspace">, archive: string, mode: string | undefined): Promise<Uint8Array | null> {
  const path = importedPathFor(w3, archive, mode);
  return path === undefined ? null : w3.workspace.readBytes(path);
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
