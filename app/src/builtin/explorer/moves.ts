// What dropping files and folders on a folder does, or why it can't be done.

/** What the project can't work without at its place. */
const FIXED = new Set(["map", "w3proj.toml"]);

export interface MovePlan { moves: [from: string, to: string][]; problem: string | null }

/** `paths`: project paths; `folder`: the target ("" is the project's top); `exists`: whether a
 *  project path is taken (any case). Files inside a selected folder go with it. */
export function planMoves(paths: string[], folder: string, exists: (path: string) => boolean): MovePlan {
  const inside = (p: string, dir: string) => p.toLowerCase().startsWith(`${dir.toLowerCase()}/`);
  const roots = paths.filter((p) => !paths.some((q) => q !== p && inside(p, q)));
  const moves: [string, string][] = [];
  const targets = new Set<string>();
  for (const from of roots) {
    if (FIXED.has(from.toLowerCase())) return { moves: [], problem: `${from} has to stay where it is.` };
    if (from.toLowerCase() === folder.toLowerCase() || inside(folder, from)) return { moves: [], problem: `${from} can't be moved into itself.` };
    const name = from.slice(from.lastIndexOf("/") + 1);
    const to = folder ? `${folder}/${name}` : name;
    if (to.toLowerCase() === from.toLowerCase()) continue;
    if (exists(to) || targets.has(to.toLowerCase())) return { moves: [], problem: `${to} already exists.` };
    targets.add(to.toLowerCase());
    moves.push([from, to]);
  }
  return { moves, problem: null };
}
