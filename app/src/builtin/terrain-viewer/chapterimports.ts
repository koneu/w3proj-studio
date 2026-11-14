import { joinPath } from "../../lib/paths";

/** Where a chapter map may find an archive path (`war3mapImported\\a.mdx`, `_HD.w3mod\\…`) in its campaign's `map` folder, in
 *  the order of `names`. `listing` is that folder's files (`/`-separated, relative), or null when not at hand.
 *  With it, only the names the folder has a file for, each under the name it has on disk, whatever the case (the game
 *  finds files so; on Linux a name asked for in another case isn't there): most paths asked for are the game's, and a
 *  read of a file known not to be there is a wasted round trip each. Without it, every name as asked for. The parts of
 *  an archive path are split on `\\` and joined with the root's own separator. A name with a `.` or `..` part is left
 *  out: the names come from the map's files (a model's texture paths), and none of them may lead out of the folder. */
export function campaignCandidates(campaign: string, names: readonly string[], listing: readonly string[] | null): string[] {
  const lower = new Map<string, string>();
  const exact = new Set<string>();
  for (const f of listing ?? []) {
    exact.add(f);
    if (!lower.has(f.toLowerCase())) lower.set(f.toLowerCase(), f);
  }
  return names.flatMap((n) => {
    const parts = n.split(/[\\/]+/).filter(Boolean);
    if (!parts.length || parts.some((p) => p === "." || p === "..")) return [];
    const rel = parts.join("/");
    const found = exact.has(rel) ? rel : lower.get(rel.toLowerCase());
    if (listing && found === undefined) return [];
    return [joinPath(campaign, "map", found ?? rel)];
  });
}
