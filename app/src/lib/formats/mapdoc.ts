// Reading a map's files whichever form they're in, for code that only looks at them.

import type { W3Api } from "../../extensions/api";
import { StringTable } from "./wts";

/** A map file as its JSON: the project's .json, or the raw file through its codec; null if there's neither. */
export const readMapDoc = async <T>(w3: W3Api, path: string): Promise<T | null> => {
  const root = w3.workspace.project()?.root;
  const text = await w3.workspace.readText(path).catch(() =>
    (root ? w3.backend.invoke<string>("codec_decode", { root, path: path.replace(/\.json$/, "") }).catch(() => null) : null));
  if (text === null) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
};

/** Turns "TRIGSTR_012" into the text in war3map.wts; anything else stays. */
export async function mapStrings(w3: W3Api): Promise<(value: string) => string> {
  const text = await w3.workspace.readText("map/war3map.wts").catch(() => null);
  if (text === null) return (value) => value;
  const table = new StringTable(text);
  return (value) => table.resolve(value);
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
