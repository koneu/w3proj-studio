// Searching the game's files for the MCP tool, by the path maps use.

/** "War3.w3mod:_Locales/deDE.w3mod:UI/X.txt" → "UI\X.txt": what object data and scripts write. */
const plainPath = (full: string) => full.slice(full.lastIndexOf(":") + 1).replace(/\//g, "\\");

export interface GameFile { path: string; /** Graphics packs it's in, when it isn't in the base game. */ only?: string[] }

/** The graphics pack of a stored file, null for the base game: "War3.w3mod:_DE.w3mod:X" → "DE". */
const graphicsPack = (full: string) => /^War3\.w3mod:_(HD|DE|Teen)\b/i.exec(full)?.[1].toUpperCase() ?? null;

/** Every word of `filter` must be in the path. One file stored for several graphics modes is
 *  listed once, the way maps name it: models as .mdl, and images as .blp, which is what the
 *  game also finds when it stores them as .dds. */
export function findGameFiles(all: readonly string[], filter: string, extension?: string): GameFile[] {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const ending = extension ? `.${extension.replace(/^\./, "").toLowerCase()}` : null;
  const seen = new Map<string, { path: string; packs: Set<string | null> }>();
  for (const full of all) {
    const shown = plainPath(full).replace(/\.mdx$/i, ".mdl").replace(/\.dds$/i, ".blp");
    const lower = shown.toLowerCase();
    if (ending && !lower.endsWith(ending === ".mdx" ? ".mdl" : ending === ".dds" ? ".blp" : ending)) continue;
    if (!words.every((w) => lower.includes(w))) continue;
    const file = seen.get(lower) ?? { path: shown, packs: new Set() };
    file.packs.add(graphicsPack(full));
    seen.set(lower, file);
  }
  // Files everyone has come first: one in a pack alone is invisible in the other graphics modes.
  const found = [...seen.values()].map(({ path, packs }): GameFile => (packs.has(null) ? { path } : { path, only: [...packs as Set<string>].sort() }));
  return found.sort((a, b) => Number(!!a.only) - Number(!!b.only) || a.path.localeCompare(b.path));
}
