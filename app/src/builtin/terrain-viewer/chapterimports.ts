import { joinPath } from "../../lib/paths";

/** Where a chapter map may find an archive path (`war3mapImported\a.mdx`, `_HD.w3mod\…`) in its campaign's `map` folder, in
 *  the order of `names`. `listing` is that folder's files (`/`-separated, relative), or null when not at hand: then only
 *  the name as asked for. With it, the name the file has on disk, whatever the case (the game finds files so; on Linux a
 *  name asked for in another case isn't there). A name the folder has no file for stays as asked for. The parts of an
 *  archive path are split on `\` and joined with the root's own separator. */
export function campaignCandidates(campaign: string, names: readonly string[], listing: readonly string[] | null): string[] {
  const lower = new Map<string, string>();
  const exact = new Set<string>();
  for (const f of listing ?? []) {
    exact.add(f);
    if (!lower.has(f.toLowerCase())) lower.set(f.toLowerCase(), f);
  }
  return names.map((n) => {
    const rel = n.split(/[\\/]+/).filter(Boolean).join("/");
    const found = exact.has(rel) ? rel : lower.get(rel.toLowerCase());
    return joinPath(campaign, "map", found ?? rel);
  });
}
