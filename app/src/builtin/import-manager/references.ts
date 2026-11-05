// Files of the project that use an import's archive path (see lib/formats/pathrefs): text files
// (object data and other JSON, scripts, trigger text, string tables, .txt, .mdl) and the
// texture paths of .mdx models are updated when the import moves; map data still kept in its
// binary form can only be reported.

import type { W3Api } from "../../extensions/api";
import { countPathRefs, replacePathRefs, samePathRef } from "../../lib/formats/pathrefs";
import { renameTextures, parseMdx } from "../../lib/model/mdx";

export interface PathRefs {
  /** Project path and number of references. */
  files: { path: string; count: number }[];
  /** Binary map data files mentioning the path (not changed). */
  raw: string[];
}

const TEXT = /\.(json|txt|j|lua|wts|mdl|fdf|toc|ai|slk)$/i;
/** The import lists themselves are changed by the Import Manager. */
const IMPORT_LISTS = /^map\/war3(map|campaign)\.imp(\.json)?$/i;
/** Binary map data with paths in it: object data, map info, sounds, triggers. */
const RAW_DATA = /^map\/war3(map|mapskin|campaign)\.(w3[utbdahqis]|wtg|wct|w3f)$/i;

/** References to `from` (an archive path) in the project's map files, except `skip` (the
 *  moved file itself). */
export async function findPathRefs(w3: W3Api, from: string, skip: string): Promise<PathRefs> {
  const out: PathRefs = { files: [], raw: [] };
  // Without a model's extension: object data can name it either way, or not at all.
  const needle = new TextEncoder().encode(from.toLowerCase().replace(/\.(mdx|mdl)$/, ""));
  for (const f of w3.workspace.files()) {
    const p = f.path;
    if (!p.toLowerCase().startsWith("map/") || IMPORT_LISTS.test(p) || p.toLowerCase() === skip.toLowerCase()) continue;
    if (TEXT.test(p)) {
      const count = countPathRefs(await w3.workspace.readText(p), from);
      if (count) out.files.push({ path: p, count });
    } else if (/\.mdx$/i.test(p)) {
      const count = await modelRefs(w3, p, from);
      if (count) out.files.push({ path: p, count });
    } else if (RAW_DATA.test(p) && contains(await w3.workspace.readBytes(p), needle)) {
      out.raw.push(p);
    }
  }
  return out;
}

/** Changes the references `findPathRefs` found. */
export async function updatePathRefs(w3: W3Api, refs: PathRefs, from: string, to: string): Promise<void> {
  for (const { path } of refs.files) {
    if (/\.mdx$/i.test(path)) {
      const bytes = await w3.workspace.readBytes(path);
      await w3.workspace.writeBytes(path, renameTextures(bytes, (t) => (samePathRef(t, from) ? replacePathRefs(t, from, to) : t)));
    } else {
      await w3.workspace.writeText(path, replacePathRefs(await w3.workspace.readText(path), from, to));
    }
  }
}

async function modelRefs(w3: W3Api, path: string, from: string): Promise<number> {
  try {
    return parseMdx(await w3.workspace.readBytes(path)).textures.filter((t) => samePathRef(t.path, from)).length;
  } catch {
    return 0; // not a model we can read: not a reference we can change either
  }
}

/** Case-insensitive (ASCII) byte search. */
function contains(hay: Uint8Array, needle: Uint8Array): boolean {
  const lower = (b: number) => (b >= 65 && b <= 90 ? b + 32 : b);
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (lower(hay[i + k]) !== needle[k]) continue outer;
    return true;
  }
  return false;
}
