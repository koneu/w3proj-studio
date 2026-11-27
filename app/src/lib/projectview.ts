// The project's files as a user is shown them (the Explorer, Go to File): those on disk. The list the app's code works
// from has more (FileInfo.virtual): names it reads and writes that are other files on disk.

import type { FileInfo } from "../extensions/api";

/** The files that are on disk. */
export const realFiles = (files: readonly FileInfo[]): FileInfo[] => files.filter((f) => !f.virtual);

const LAYOUT = /^((?:.*\/)?map\/)terrain\/terrain\.json$/i;
const FLAT_TERRAIN = /^((?:.*\/)?map\/)war3map\.w3e\.txt$/i;

/** What opening a file a user picked opens: a split terrain's terrain.json is the way to the terrain editor, which works
 *  on the virtual single file. Every other file is itself. */
export function openTarget(path: string, files: readonly FileInfo[]): string {
  const map = LAYOUT.exec(path)?.[1]?.toLowerCase();
  if (map === undefined) return path;
  return files.find((f) => f.virtual && FLAT_TERRAIN.exec(f.path)?.[1].toLowerCase() === map)?.path ?? path;
}

/** How the tab of a virtual file is named and what its tooltip says, so no tab passes for a file on disk: the terrain
 *  editor's of a split terrain is "Terrain"; another keeps its name, its tooltip saying where the data really is. Null:
 *  a file on disk (or one not listed). */
export function virtualTab(path: string, files: readonly FileInfo[]): { label: string; tooltip: string } | null {
  if (!files.some((f) => f.virtual && f.path.toLowerCase() === path.toLowerCase())) return null;
  const name = path.slice(path.lastIndexOf("/") + 1), map = path.slice(0, path.length - name.length);
  if (/^war3map\.w3e\.txt$/i.test(name) && FLAT_TERRAIN.test(path)) return { label: "Terrain", tooltip: `The terrain in ${map}terrain/` };
  const where = /\.(w3u|w3t|w3b|w3d|w3a|w3h|w3q)\.json$/i.test(name) ? `put together from ${map}objects/`
    : /^war3map(\.doo\.json|units\.doo\.json|\.w3r\.json)$/i.test(name) ? `put together from ${map}terrain/`
    : /^pathing\.json$/i.test(name) ? "put together from the pathing.txt files under map/terrain/"
    : `kept in ${map.replace(/map\/$/i, "")}build/derived/`;
  return { label: name, tooltip: `${path}: not a file there; ${where}` };
}

/** The virtual files made from what is at or under `path` (a real file or folder): deleting, moving or renaming that
 *  changes them, so their editors' unsaved changes count and their tabs close. */
export function virtualOver(path: string, files: readonly FileInfo[]): string[] {
  const p = path.toLowerCase();
  const touches = (folder: string) => p === folder || p.startsWith(`${folder}/`) || folder.startsWith(`${p}/`);
  return files.filter((f) => {
    if (!f.virtual) return false;
    const name = f.path.toLowerCase();
    if (name === p || name.startsWith(`${p}/`)) return true;
    const m = /^((?:.*\/)?map\/)(war3(?:map|campaign)[^/]*)$/.exec(name);
    if (!m) return false;
    const [, map, file] = m;
    if (/\.(w3u|w3t|w3b|w3d|w3a|w3h|w3q)\.json$/.test(file)) return touches(`${map}objects`);
    return /^war3map(\.w3e\.txt|\.doo\.json|units\.doo\.json|\.w3r\.json)$/.test(file) && touches(`${map}terrain`);
  }).map((f) => f.path);
}
