// Subterrains: "Split Terrain into Subterrains…" and "Merge Subterrains", thin wrappers over the backend's
// terrain_split / terrain_merge (crates/w3proj terrain_layout.rs, as `w3proj terrain split` and `merge`). Both are
// lossless: the map is the same afterwards, and every editor keeps reading and saving map/war3map.w3e.txt and the
// object files by those names (the backend answers for them from map/terrain/, crates/backend flatview.rs).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { checkpointOrStop } from "../../lib/checkpoint";
import { errorText } from "../../lib/oserror";
import { LAYOUT_FILE } from "../../lib/terrain/creationids";

/** The project's layout file when its terrain is split. */
export { LAYOUT_FILE };
/** The flat files the split layout stands for (terrain_layout.rs FLAT_NAMES). */
export const FLAT_FILES = ["map/war3map.w3e.txt", "map/war3map.doo.json", "map/war3mapUnits.doo.json", "map/war3map.w3r.json"];

/** What a conversion did (terrain_layout.rs Converted), relative to the project. */
interface Converted { written: string[]; removed: string[] }

/** How to split: one subterrain `main` over the canvas, a 2×2 grid, or rectangles `name:x,y,w,h` (corners). */
export type SplitLayout = "main" | "2x2" | string[];

/** Whether the open project's terrain is split (its file list has map/terrain/terrain.json). */
export function isSplit(w3: W3Api): boolean {
  return w3.workspace.files().some((f) => f.path.replace(/\\/g, "/").toLowerCase() === LAYOUT_FILE);
}

/** Rectangles as typed: `name:x,y,w,h`, separated by `;` or new lines. */
export function parseRects(text: string): string[] {
  return text.split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
}

/** The backend's argument for a layout: no rectangles for `main`. */
export const rectsOf = (layout: SplitLayout): string[] => (layout === "main" ? [] : layout === "2x2" ? ["2x2"] : layout);

async function askLayout(w3: W3Api): Promise<SplitLayout | undefined> {
  const pick = await w3.window.quickPick<"main" | "2x2" | "custom">([
    { label: "One subterrain (main)", description: "The whole canvas in map/terrain/main/, ready to be cut up later", value: "main" },
    { label: "2×2 grid", description: "Four subterrains: sw, se, nw, ne", value: "2x2" },
    { label: "Rectangles…", description: "name:x,y,w,h in corners, (0,0) the south-west corner", value: "custom" },
  ], { placeholder: "Split the terrain into" });
  if (!pick?.value) return undefined;
  if (pick.value !== "custom") return pick.value;
  const text = await w3.window.inputBox({
    prompt: "Subterrains as name:x,y,w,h (corners, (0,0) south-west), separated by ;. Corners outside all of them must all be alike.",
    placeholder: "west:0,0,65,129; east:65,0,64,129",
  });
  const rects = text ? parseRects(text) : [];
  return rects.length ? rects : undefined;
}

/** Runs a conversion: refused while an editor has unsaved changes (they'd be saved into the old layout's files, or
 *  lost); the derived work of the last edit first; a checkpoint where they're on; afterwards the file list read again
 *  and the editors of the converted files opened again (their files' stamps changed, their content didn't). */
async function convert(w3: W3Api, what: string, run: (root: string) => Promise<Converted>, quiet: boolean): Promise<Converted | null> {
  const project = w3.workspace.project();
  if (!project) throw new Error(`${what}: no project is open.`);
  const unsaved = w3.editors.unsavedPaths();
  if (unsaved.length) throw new Error(`${what}: save or discard the changes in ${unsaved.join(", ")} first.`);
  await w3.commands.execute("w3.terrain.settle").catch(() => {});
  // A checkpoint that fails stops it ("Nothing changed: …"); without the extension it goes on, as other big changes.
  await checkpointOrStop(w3, what);
  const root = project.root;
  let done: Converted;
  try {
    done = await run(root);
  } catch (e) {
    throw new Error(`${what}: ${errorText(e).replace(/\.?$/, ".")} Nothing was changed.`);
  }
  if (w3.workspace.project()?.root !== root) return done;
  await w3.workspace.refresh();
  const affected = (p: string) => { const k = p.replace(/\\/g, "/").toLowerCase(); return FLAT_FILES.includes(k) || k.startsWith("map/terrain/"); };
  for (const p of w3.editors.openPaths().filter(affected)) await w3.editors.reopen(p);
  if (!quiet) void w3.window.showInfo(`${what}: ${done.written.length} file${done.written.length === 1 ? "" : "s"} written, ${done.removed.length} removed.`);
  return done;
}

/** Split Terrain into Subterrains…: `arg.layout` skips the questions (MCP, app-smoke). Resolves with what was written,
 *  null when cancelled; rejects with the backend's reason when the split can't be lossless (nothing written then). */
export async function splitTerrain(w3: W3Api, arg?: { layout?: SplitLayout; quiet?: boolean }): Promise<Converted | null> {
  if (isSplit(w3)) throw new Error("Split Terrain: the terrain is split already (map/terrain/).");
  const layout = arg?.layout ?? (await askLayout(w3));
  if (!layout) return null;
  return convert(w3, "Split Terrain", (root) => w3.backend.invoke<Converted>("terrain_split", { root, rects: rectsOf(layout) }), arg?.quiet === true);
}

/** Merge Subterrains: map/terrain/ back into map/war3map.w3e.txt and the flat object files. */
export async function mergeTerrain(w3: W3Api, arg?: { quiet?: boolean }): Promise<Converted | null> {
  if (!isSplit(w3)) throw new Error("Merge Subterrains: the terrain isn't split (there is no map/terrain/terrain.json).");
  return convert(w3, "Merge Subterrains", (root) => w3.backend.invoke<Converted>("terrain_merge", { root }), arg?.quiet === true);
}

/** What Check Terrain IDs found (terrain_ids.rs Report, backend flatview.rs check). */
export interface IdCheck {
  duplicates: { kind: string; number: number; files: string[] }[];
  overlaps: { a: string; aRange: [number, number]; b: string; bRange: [number, number] }[];
  /** Information only: moved objects and imported maps have numbers outside their subterrain's ranges. */
  outside: { subterrain: string; kind: string; count: number; examples: number[] }[];
  numbers: number;
  /** A number twice or ranges that overlap. */
  errors: boolean;
  /** The report as text, as `w3proj terrain check` prints it. */
  lines: string[];
}

/** Check Terrain IDs: creation numbers found twice per kind, overlapping id ranges (errors), numbers outside their
 *  subterrain's ranges (information), as `w3proj terrain check`. The report goes to the Subterrains output; a message
 *  says the outcome. Rejects when the terrain isn't split or its files can't be read. */
export async function checkTerrainIds(w3: W3Api, arg?: { quiet?: boolean }): Promise<IdCheck> {
  const project = w3.workspace.project();
  if (!project) throw new Error("Check Terrain IDs: no project is open.");
  if (!isSplit(w3)) throw new Error("Check Terrain IDs: the terrain isn't split (there is no map/terrain/terrain.json).");
  let report: IdCheck;
  try {
    report = await w3.backend.invoke<IdCheck>("terrain_check", { root: project.root });
  } catch (e) {
    throw new Error(`Check Terrain IDs: ${errorText(e).replace(/\.?$/, ".")}`);
  }
  if (w3.workspace.project()?.root !== project.root || arg?.quiet) return report;
  const out = w3.output.channel("Subterrains");
  out.clear();
  for (const line of report.lines) out.append(line);
  const twice = report.duplicates.length, overlaps = report.overlaps.length;
  if (report.errors) {
    out.show();
    void w3.window.showError(`Check Terrain IDs: ${[twice ? `${twice} creation number${twice === 1 ? "" : "s"} found twice` : "", overlaps ? `${overlaps} overlapping id range${overlaps === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ")}. The Subterrains output lists them.`);
  } else {
    void w3.window.showInfo(`Check Terrain IDs: ${report.numbers} creation numbers, none twice, no overlapping ranges.`);
  }
  return report;
}

/** A command's failure as an error message (the reason the backend gave), and again for the caller. */
const shown = <A, R>(w3: W3Api, run: (arg?: A) => Promise<R>) => async (arg?: A) => {
  try {
    return await run(arg);
  } catch (e) {
    void w3.window.showError(errorText(e));
    throw e;
  }
};

export function activate(w3: W3Api, ctx: ExtensionContext) {
  ctx.subscriptions.push(
    w3.commands.register("w3.terrainLayout.split", shown(w3, (arg?: { layout?: SplitLayout; quiet?: boolean }) => splitTerrain(w3, arg))),
    w3.commands.register("w3.terrainLayout.merge", shown(w3, (arg?: { quiet?: boolean }) => mergeTerrain(w3, arg))),
    w3.commands.register("w3.terrainLayout.checkIds", shown(w3, (arg?: { quiet?: boolean }) => checkTerrainIds(w3, arg))),
  );
}
