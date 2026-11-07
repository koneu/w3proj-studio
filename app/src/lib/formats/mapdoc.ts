// Reading a map's files whichever form they're in, for code that only looks at them.

import type { W3Api } from "../../extensions/api";
import { StringTable } from "./wts";
import { parseW3e } from "../terrain/w3e";
import { readTerrainBytes, terrainPath } from "../terrain/w3etext";

/** A map file as its JSON: the project's .json, or the raw file through its codec; null if there's neither. */
export const readMapDoc = async <T>(w3: W3Api, path: string): Promise<T | null> => {
  const root = w3.workspace.project()?.root;
  const text = await w3.workspace.readText(path).catch(() =>
    (root ? w3.backend.invoke<string>("codec_decode", { root, path: path.replace(/\.json$/, "") }).catch(() => null) : null));
  if (text === null) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
};

/** Like readMapDoc, but tells a file that isn't there (null) from one that is there and can't be read
 *  (throws, naming it): for code that acts on what it finds, where "unreadable" must never pass for "empty". */
export const readMapDocStrict = async <T>(w3: W3Api, path: string): Promise<T | null> => {
  const doc = await readMapDoc<T>(w3, path);
  if (doc !== null) return doc;
  const there = async (p: string) => w3.backend.invoke<boolean>("fs_exists", { path: w3.workspace.resolve(p) }).catch(() => true);
  if ((await there(path)) || (await there(path.replace(/\.json$/, "")))) throw new Error(`${path} is there but can't be read.`);
  return null;
};

/** Turns "TRIGSTR_012" into the text in war3map.wts; anything else stays. */
export async function mapStrings(w3: W3Api): Promise<(value: string) => string> {
  const text = await w3.workspace.readText("map/war3map.wts").catch(() => null);
  if (text === null) return (value) => value;
  const table = new StringTable(text);
  return (value) => table.resolve(value);
}

/** The project's JSON form of a map file. A file kept raw can't be changed as text, so that fails. */
export function jsonPathOf(w3: W3Api, name: string): string {
  const path = `map/${name}.json`, files = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
  if (!files.has(path.toLowerCase()) && files.has(`map/${name}`.toLowerCase())) throw new Error(`${name} is kept raw in this project, so it can't be edited here.`);
  return path;
}

/** What the terrain file says about the map: its own tileset, which is the one that counts, and
 *  its grid. Null without a terrain file. */
export async function terrainFacts(w3: W3Api): Promise<{ tileset: string; offsetX: number; offsetY: number; width: number; height: number } | null> {
  const path = terrainPath(w3.workspace.files().map((f) => f.path));
  if (!path) return null;
  const t = parseW3e(await readTerrainBytes(path, { readText: () => w3.workspace.readText(path), readBytes: () => w3.workspace.readBytes(path) }));
  return { tileset: t.tileset, offsetX: t.offsetX, offsetY: t.offsetY, width: t.width, height: t.height };
}

/** For tools: the project, or a clear failure. */
export function requireProject(w3: W3Api) {
  const project = w3.workspace.project();
  if (!project) throw new Error("No project is open in W3Proj Studio.");
  return project;
}

/** Cuts a list for a tool's answer, saying how much there was. */
export const capped = <T>(list: T[], limit: unknown, fallback: number) => {
  const most = typeof limit === "number" && limit > 0 ? limit : fallback;
  return { total: list.length, shown: Math.min(most, list.length), items: list.slice(0, most) };
};
