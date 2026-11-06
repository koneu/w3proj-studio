// What the file browser works out, apart from what it draws: folders from paths, and which file a
// sound label plays.

export interface Folder { name: string; path: string; files: number; children: Folder[] }

/** The folders of a list of paths (backslashes), with how many files lie under each, in name order. */
export function folderTree(paths: readonly string[]): Folder {
  const root: Folder = { name: "", path: "", files: paths.length, children: [] };
  const known = new Map<string, Folder>([["", root]]);
  for (const path of paths) {
    const parts = path.split("\\").slice(0, -1);
    let parent = root, at = "";
    for (const name of parts) {
      at = at ? `${at}\\${name}` : name;
      const key = at.toLowerCase();
      let folder = known.get(key);
      if (!folder) {
        folder = { name, path: at, files: 0, children: [] };
        known.set(key, folder);
        parent.children.push(folder);
      }
      folder.files++;
      parent = folder;
    }
  }
  for (const f of known.values()) f.children.sort((a, b) => a.name.localeCompare(b.name));
  return root;
}

/** Whether a path lies in a folder, at any depth. The root holds everything. */
export const inFolder = (path: string, folder: string) => !folder || path.toLowerCase().startsWith(`${folder.toLowerCase()}\\`);

/** The folders from the root down to a path's own, to open the tree there. */
export function foldersOf(path: string): string[] {
  const parts = path.split("\\").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("\\"));
}

const AUDIO = /\.(wav|mp3|flac|ogg)$/i;
const stem = (path: string) => path.toLowerCase().replace(AUDIO, "");

/** Each label's first file, from the rows of UI\SoundInfo\*.slk. */
export function labelFiles(rows: readonly Record<string, string>[]) {
  const out = new Map<string, string>();
  for (const r of rows) {
    const first = r.FileNames?.split(",")[0]?.trim().replace(/\//g, "\\");
    if (r.SoundName && first && !out.has(r.SoundName)) out.set(r.SoundName, first);
  }
  return out;
}

/** The stored file a label's entry means: tables name a file with any sound extension, and
 *  unit acknowledgements name it without a folder. */
export function storedSound(file: string, gamePaths: readonly string[]) {
  const wanted = stem(file), bare = !file.includes("\\");
  return gamePaths.find((p) => AUDIO.test(p) && (bare ? stem(p).endsWith(`\\${wanted}`) : stem(p) === wanted)) ?? null;
}
