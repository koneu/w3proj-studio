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

/** The listed path a field's value means: values may lack the extension, and differ in case. */
export function findListed(value: string, paths: readonly string[]) {
  const wanted = (value.split(",")[0] ?? "").trim().replace(/\//g, "\\").replace(/\.\w+$/, "").toLowerCase();
  return wanted ? paths.find((p) => p.replace(/\.\w+$/, "").toLowerCase() === wanted) ?? null : null;
}

/** What a unit says, in the order a set is best heard by. */
const SET_SOUNDS = ["What", "Ready", "Yes", "YesAttack", "Warcry", "Pissed"];

/** Unit sound sets: the names shared by labels like FootmanWhat and FootmanYes. */
export function soundSets(labels: readonly string[]) {
  const sets = new Set<string>();
  const ending = new RegExp(`(${[...SET_SOUNDS].sort((a, b) => b.length - a.length).join("|")})$`);
  for (const l of labels) { const m = ending.exec(l); if (m && m.index > 0) sets.add(l.slice(0, m.index)); }
  return [...sets].sort((a, b) => a.localeCompare(b));
}

/** The label a sound field plays, or null when there's nothing to hear. Weapon sounds name a weapon,
 *  with a label per thing hit: flesh is what a player hears most. */
export function fieldSound(metaType: string, value: string, labels: readonly string[]) {
  const v = value.trim();
  if (!v || v === "_" || v === "Nothing" || v === "None") return null;
  const known = (l: string) => labels.find((x) => x.toLowerCase() === l.toLowerCase()) ?? null;
  if (metaType === "soundLabel") return known(v);
  if (metaType === "combatSound") return known(`${v}Flesh`);
  if (metaType === "unitSound") return SET_SOUNDS.map((s) => known(v + s)).find(Boolean) ?? null;
  return null;
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
