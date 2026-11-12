// A file's version per graphics mode in the Import Manager (lib/imports.ts: Reforged reads `_HD.w3mod\<path>` before
// `<path>`): which version a row can still get, which file of a row is shown in a mode, and the textures a model added
// for one mode brings along from next to it on disk. Pure, so tests need no app.

import { newEntryFlags, reforgedPathOf, type ImportEntry, type ImportRow } from "../../lib/imports";

/** The version a row can still get ("Add Reforged Version…", "Add Classic Version…"): its side, archive path and the
 *  flags of its entry. Null: the row has both. */
export function versionToAdd(row: ImportRow): { side: "classic" | "reforged"; path: string; flags: number } | null {
  if (row.classic && row.reforged) return null;
  const side = row.classic ? "reforged" : "classic";
  const path = side === "reforged" ? reforgedPathOf(row.path) : row.path;
  return { side, path, flags: newEntryFlags(path) };
}

/** The entry of a row a graphics mode shows (game.graphicsMode: "sd" Classic, else Reforged): its own version, else the
 *  other one (Reforged falls back to the plain path; a Reforged version alone is what the row has). */
export function shownEntry(row: ImportRow, mode: string | undefined): ImportEntry {
  const reforged = mode !== "sd";
  return (reforged ? row.reforged ?? row.classic : row.classic ?? row.reforged)!;
}

/** Where a texture a model names may lie next to the model on disk (`dir`, the model's folder), most exact first: its
 *  path below `dir` from the longest tail to the file name alone, and for Reforged's .blp/.tif/.tga names the .dds the
 *  game reads instead. `archive`: the path it is stored at in the map (a .dds keeps its extension). */
export function textureSpots(dir: string, texture: string): { file: string; archive: string }[] {
  const parts = texture.replace(/\//g, "\\").split("\\").filter((p) => p && p !== "." && p !== "..");
  if (!parts.length) return [];
  const base = dir.replace(/[\\/]+$/, "");
  const out: { file: string; archive: string }[] = [];
  const archive = parts.join("\\");
  const dds = /\.(blp|tif|tga)$/i.test(archive) ? archive.replace(/\.\w+$/, ".dds") : null;
  for (const name of [archive, ...(dds ? [dds] : [])]) {
    const p = name.split("\\");
    for (let i = 0; i < p.length; i++) out.push({ file: `${base}/${p.slice(i).join("/")}`, archive: name });
  }
  return out;
}

/** The textures of a model (`textures` as the model names them) to bring along with it: the colour textures (not
 *  replaceable, not empty) that lie next to it on disk (`exists`, first of textureSpots) and whose path in the map
 *  (`target`: the mode's path of the texture) isn't taken. One per texture path; in the model's order. */
export async function followingTextures(
  dir: string, textures: { path: string; replaceableId: number }[], target: (archive: string) => string,
  exists: (file: string) => Promise<boolean>, taken: (archive: string) => boolean,
): Promise<{ file: string; archive: string }[]> {
  const out: { file: string; archive: string }[] = [];
  const seen = new Set<string>();
  for (const t of textures) {
    if (t.replaceableId || !t.path || /^[a-z]:|^[\\/]/i.test(t.path)) continue;
    const key = t.path.replace(/\//g, "\\").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    for (const spot of textureSpots(dir, t.path)) {
      if (!(await exists(spot.file))) continue;
      const archive = target(spot.archive);
      if (!taken(archive)) out.push({ file: spot.file, archive });
      break;
    }
  }
  return out;
}
