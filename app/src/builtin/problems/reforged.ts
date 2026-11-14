// Reading Reforged (HD, DE) files from the game for the "Graphics modes" fixes, and the words and
// paths around them. Pure, so a test can stand in for the game.

import { textureCandidates } from "../../lib/model/texpath";

/** The Reforged art sets a Classic model can be made from. */
export type Source = "de" | "hd";

export const SOURCE_NAME: Record<Source, string> = { de: "DE", hd: "HD" };
/** The game folder of each set (root paths of the game's storage). */
const PREFIX: Record<Source, string> = { de: "War3.w3mod:_DE.w3mod:", hd: "War3.w3mod:_HD.w3mod:" };
const ROOT = "War3.w3mod:";

/** Folders searched for a file of `source`: its own set, the other one, then the Classic files
 *  (some textures are only stored there). */
export function layerOrder(source: Source): string[] {
  return [PREFIX[source], PREFIX[source === "de" ? "hd" : "de"], ROOT];
}

/** The sets that have every one of the files (lowercase game paths with "/"), the order being
 *  the one the app prefers: DE, then HD. */
export function conversionSources(paths: string[], has: (source: Source, key: string) => boolean): Source[] {
  return (["de", "hd"] as const).filter((s) => paths.length > 0 && paths.every((p) => has(s, p.replace(/\\/g, "/").toLowerCase())));
}

/** A type's model as the object data names it (without the variation number) and its variation count. */
export interface ModelArt { model: string; variations: number }
/** A Classic model the "Convert" fix can make: from the set `source`, the model `model` with its variations. */
export interface ConversionPlan extends ModelArt { source: Source }

/** The files of a model with its variations (X.mdx, or X0.mdx, X1.mdx… when there are several). */
export function variationFiles({ model, variations }: ModelArt): string[] {
  const stem = model.replace(/\.(mdl|mdx)$/i, "");
  const n = Math.max(1, variations);
  return Array.from({ length: n }, (_, v) => `${stem}${n > 1 ? v : ""}.mdx`);
}

/** The Classic models the Convert fix can make, one per Reforged set (DE, then HD): the first of the set's
 *  `candidates` whose every variation the set holds. A type's candidates are the model it reads in that set's own art
 *  (the skin tables split it: the Exterior Wall EW00 reads RuinsWall0 in Classic, which no folder has, and
 *  RuinTomb\…\ExteriorWall in HD and DE), then the model found missing. When no single set has all of a candidate,
 *  but both together do, DE is the source (the files are read from whichever has each, layerOrder). */
export function conversionPlans(candidates: Record<Source, ModelArt[]>, has: (source: Source, key: string) => boolean): ConversionPlan[] {
  const keys = (a: ModelArt) => variationFiles(a).map((p) => p.replace(/\\/g, "/").toLowerCase());
  const plans: ConversionPlan[] = [];
  for (const source of ["de", "hd"] as const) {
    const art = candidates[source].find((a) => a.model && keys(a).every((k) => has(source, k)));
    if (art) plans.push({ source, ...art });
  }
  if (plans.length) return plans;
  for (const source of ["de", "hd"] as const) {
    const art = candidates[source].find((a) => a.model && keys(a).every((k) => has("de", k) || has("hd", k)));
    if (art) return [{ source: "de", ...art }];
  }
  return [];
}

/** First readable of `candidates`, searched set by set. Returns the candidate's name and its bytes. */
export async function readLayered(
  candidates: string[], source: Source, read: (fullPath: string) => Promise<Uint8Array>, what = candidates[0] ?? "",
): Promise<{ name: string; bytes: Uint8Array; layer: string }> {
  let last: unknown = new Error(`${what}: not found in the game's ${SOURCE_NAME[source]}, other Reforged or Classic files`);
  for (const layer of layerOrder(source)) {
    for (const name of candidates) {
      try { return { name, bytes: await read(layer + name), layer }; } catch (e) { last = e; }
    }
  }
  throw last;
}

/** A file name in `dir` not yet in `used` (lowercase): "A.blp", then "A_2.blp", "A_3.blp"… Adds it. */
export function uniqueName(dir: string, file: string, used: Set<string>): string {
  const dot = file.lastIndexOf(".");
  const stem = dot < 0 ? file : file.slice(0, dot), ext = dot < 0 ? "" : file.slice(dot);
  for (let n = 1; ; n++) {
    const name = `${dir}\\${stem}${n > 1 ? `_${n}` : ""}${ext}`;
    if (!used.has(name.toLowerCase())) { used.add(name.toLowerCase()); return name; }
  }
}

/** The colour textures of a model that are not among `have` (lowercase archive names with a backslash): what a
 *  converted model names but the map doesn't hold. Replaceable textures and empty paths count as fine. */
export function missingTextures(textures: { path: string; replaceableId: number }[], have: (archiveName: string) => boolean): string[] {
  return textures.filter((t) => !t.replaceableId && t.path && !have(t.path.replace(/\//g, "\\").toLowerCase())).map((t) => t.path);
}

/** The models to say in the message: "the DE model X (or HD)". */
export function sourcesText(sources: Source[], firstPath: string): string {
  if (!sources.length) return "";
  const [main, ...others] = sources;
  return `Classic can be made from the ${SOURCE_NAME[main]} model ${firstPath.replace(/\//g, "\\")}${others.length ? ` (or the ${others.map((s) => SOURCE_NAME[s]).join(", ")} one)` : ""}`;
}

export { textureCandidates };
