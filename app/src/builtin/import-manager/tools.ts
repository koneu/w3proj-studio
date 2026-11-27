// The import changes of the AI tools (MCP import_file, remove_import, list_imports), on the document the import list
// (war3map.imp.json, a campaign's war3campaign.imp.json) holds. Entries are added as the Import Manager's own imports
// are (lib/imports.ts: the path, the flags of a new import); the files themselves are copied and deleted by the caller.

import { entryFile, importPath, isMapFile, newEntryFlags, projectPath, samePath, takenWithVersions, type ImportEntry } from "../../lib/imports";

export interface ToolImportsDoc { format?: string; version: number; files: ImportEntry[] }
export const emptyImports = (): ToolImportsDoc => ({ format: "w3proj.imports/1", version: 1, files: [] });

/** The project's files by lower-case path, as listed. */
export type ProjectFiles = ReadonlyMap<string, { path: string; size: number }>;

/**
 * Where import_file puts `source` (a file on disk): the archive path asked for, with `\`, or war3mapImported\<its name>
 * (numbered when taken, as the Import Manager's Import files does). A path asked for is refused when it isn't one
 * inside the map, is one of the map's own files, or is taken: by an entry of the list, by a file of the project, or
 * (models and images) by the name's version for another graphics mode.
 */
export function importTarget(doc: ToolImportsDoc, files: ProjectFiles, source: string, asked: unknown, folder: string): { archive: string; file: string } {
  const takenOne = (p: string) => doc.files.some((e) => samePath(e.path, p)) || files.has(projectPath(p).toLowerCase());
  const taken = (p: string) => takenWithVersions(p, takenOne);
  if (asked === undefined) {
    const archive = importPath(source, taken, folder);
    return { archive, file: projectPath(archive) };
  }
  if (typeof asked !== "string" || !asked.trim()) throw new Error("path must be the file's path in the map, like war3mapImported\\\\Horn.mp3 or Units\\\\Human\\\\Footman\\\\Footman.mdx.");
  const archive = asked.trim().replace(/\//g, "\\");
  const parts = archive.split("\\");
  if (/^[A-Za-z]:/.test(archive) || parts.some((p) => !p || p === "." || p === "..")) throw new Error(`"${asked}" isn't a path inside the map.`);
  if (isMapFile(archive)) throw new Error(`${archive} is one of the map's own files, not an import.`);
  if (taken(archive)) throw new Error(`The map already has ${archive} (in its import list, as a file, or as this name's version for another graphics mode). Give another path, or remove_import it first.`);
  return { archive, file: projectPath(archive) };
}

/** Lists `archive` as a new import; false if the list has it already. */
export function addImport(doc: ToolImportsDoc, archive: string): boolean {
  if (doc.files.some((e) => samePath(e.path, archive))) return false;
  doc.files.push({ flags: newEntryFlags(archive), path: archive });
  return true;
}

/** Takes the entry of `path` off the list: by its listed path, or (a standard-path entry) by its path with the import
 *  folder in front. The entry, and the project file it stands for, if the project has it. */
export function removeImport(doc: ToolImportsDoc, files: ProjectFiles, path: unknown, folder: string): { entry: ImportEntry; file?: string } {
  const wanted = typeof path === "string" ? path.trim().replace(/\//g, "\\") : "";
  const has = (lower: string) => files.get(lower)?.path;
  const at = wanted ? doc.files.findIndex((e) => samePath(e.path, wanted) || samePath(`${folder}\\${e.path}`, wanted)) : -1;
  if (at < 0) throw new Error(`${wanted || String(path)} isn't in the import list. list_imports gives it.`);
  const [entry] = doc.files.splice(at, 1);
  // A file another entry still stands for stays that entry's.
  const file = entryFile(entry, folder, has);
  const shared = file !== undefined && doc.files.some((e) => entryFile(e, folder, has) === file);
  return { entry, ...(file && !shared ? { file } : {}) };
}

/** The list as list_imports shows it: each entry's path, the project file it stands for and its size, or missing. */
export function describeImports(doc: ToolImportsDoc, files: ProjectFiles, folder: string) {
  const has = (lower: string) => files.get(lower)?.path;
  return doc.files.map((e) => {
    const file = entryFile(e, folder, has);
    return { path: e.path, ...(file ? { file, size: files.get(file.toLowerCase())?.size } : { missing: true }) };
  });
}
