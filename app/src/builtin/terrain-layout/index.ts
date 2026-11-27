// Subterrains: the terrain's layout in map/terrain/ (crates/w3proj terrain_layout.rs), the only one since 2026-11-26
// (docs/terrain-subterrains-spec.md): a new map and every project opened have it (one subterrain main to begin with),
// and Edit Terrain Layout cuts it into more. Every change is lossless: the map is the same afterwards, and every editor
// keeps reading and saving map/war3map.w3e.txt and the object files by those names (the backend answers for them from
// map/terrain/, crates/backend flatview.rs). A project that couldn't be converted (its terrain kept raw, …) stays flat;
// the Terrain Layout editor and change_subterrains still offer it Split Terrain (terrain_split).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { MCP_EDITS_SERVICE, type McpEditsService } from "../../extensions/services";
import { checkpointOrStop } from "../../lib/checkpoint";
import { errorText } from "../../lib/oserror";
import { LAYOUT_FILE } from "../../lib/terrain/creationids";
import { loadOpenState, openSummary, type OpenState } from "../../lib/terrain/openset";
import { checkSeams, seamLines, seamSummary, type SeamReport } from "../../lib/terrain/seams";
import { joinPlan, nameProblem, parseRect, placePlan, planText, renamePlan, type PlannedSubterrain, type SubRect } from "../../lib/terrain/subterrainplan";
import { deleteSub, draftOf, planOf } from "../../lib/terrain/layoutdraft";
import { layoutPicture, slotColor, type Rgb } from "../../lib/terrain/layoutpicture";
import { drawnGroundTiles, parseW3e } from "../../lib/terrain/w3e";
import { readTerrainBytes, terrainPath } from "../../lib/terrain/w3etext";
import { ownGroundTiles } from "../../lib/terrain/tilesets";
import { parseSlk } from "../../lib/formats/text";
import { decodeImage } from "../../lib/image/index";
import { smallestMipColor } from "../../lib/image/mipcolor";
import { h } from "../../workbench/dom";
import { LAYOUT_DOC, layoutEditor, type LayoutEditorState, type LayoutOps, type LayoutPicture, type LayoutPreview, type LayoutState } from "./editor";

/** The project's layout file when its terrain is split. */
export { LAYOUT_FILE };
/** The flat files the split layout stands for (terrain_layout.rs FLAT_NAMES). */
export const FLAT_FILES = ["map/war3map.w3e.txt", "map/war3map.doo.json", "map/war3mapUnits.doo.json", "map/war3map.w3r.json"];

/** FLAT_FILES lowercased, to match the lowercased path in `affected` (the units file has a capital U). */
const FLAT_LOWER = FLAT_FILES.map((f) => f.toLowerCase());

/** What a conversion did (terrain_layout.rs Converted), relative to the project. */
interface Converted { written: string[]; removed: string[] }

/** How to split: one subterrain `main` over the canvas, a 2×2 grid, or rectangles `name:x,y,w,h` (corners). */
export type SplitLayout = "main" | "2x2" | string[];

/** Whether the open project's terrain is split (its file list has map/terrain/terrain.json). */
export function isSplit(w3: W3Api): boolean {
  return w3.workspace.files().some((f) => f.path.replace(/\\/g, "/").toLowerCase() === LAYOUT_FILE);
}

/** The backend's argument for a layout: no rectangles for `main`. */
export const rectsOf = (layout: SplitLayout): string[] => (layout === "main" ? [] : layout === "2x2" ? ["2x2"] : layout);

/** Runs a conversion: refused while an editor has unsaved changes (they'd be saved into the old layout's files, or
 *  lost); the derived work of the last edit first; a checkpoint where they're on; afterwards the file list read again
 *  and the editors of the converted files opened again (their files' stamps changed, their content didn't). */
async function convert<T extends Converted>(w3: W3Api, what: string, run: (root: string) => Promise<T>, quiet: boolean, checkpoint = true): Promise<T> {
  const project = w3.workspace.project();
  if (!project) throw new Error(`${what}: no project is open.`);
  const unsaved = w3.editors.unsavedPaths();
  if (unsaved.length) throw new Error(`${what}: save or discard the changes in ${unsaved.join(", ")} first.`);
  await w3.commands.execute("w3.terrain.settle").catch(() => {});
  // A checkpoint that fails stops it ("Nothing changed: …"); without the extension it goes on, as other big changes.
  if (checkpoint) await checkpointOrStop(w3, what);
  const root = project.root;
  let done: T;
  try {
    done = await run(root);
  } catch (e) {
    throw new Error(`${what}: ${errorText(e).replace(/\.?$/, ".")} Nothing was changed.`);
  }
  if (w3.workspace.project()?.root !== root) return done;
  await w3.workspace.refresh();
  const affected = (p: string) => { const k = p.replace(/\\/g, "/").toLowerCase(); return FLAT_LOWER.includes(k) || k.startsWith("map/terrain/"); };
  for (const p of w3.editors.openPaths().filter(affected)) await w3.editors.reopen(p);
  if (!quiet) void w3.window.showInfo(`${what}: ${done.written.length} file${done.written.length === 1 ? "" : "s"} written, ${done.removed.length} removed.`);
  return done;
}

/** Split Terrain of a project still flat (one opening couldn't convert: the Terrain Layout editor, change_subterrains).
 *  Resolves with what was written; rejects with the backend's reason when the split can't be lossless (nothing written
 *  then). */
export async function splitTerrain(w3: W3Api, arg: { layout: SplitLayout; quiet?: boolean }): Promise<Converted> {
  if (isSplit(w3)) throw new Error("Split Terrain: the terrain is split already (map/terrain/).");
  return convert(w3, "Split Terrain", (root) => w3.backend.invoke<Converted>("terrain_split", { root, rects: rectsOf(arg.layout) }), arg.quiet === true);
}

/** What `backend::mergehook::run` did (crates/backend mergehook.rs Outcome). */
export interface MergeHookResult { action: "installed" | "updated" | "removed" | "none" | "foreign" | "noGit"; git: boolean; hook: string; message: string }

/** Install Merge Hook / Remove Merge Hook: the opt-in git post-merge hook that runs Check Terrain Seams after a merge
 *  that touched two subterrains (`w3proj terrain merge-hook`, one body in the backend). Says where the hook is and
 *  whether git was found; someone else's sh post-merge hook keeps its text (ours is a block in it), one that isn't an
 *  sh script is left as it is (the notice has the line to add to it). */
export async function mergeHook(w3: W3Api, arg?: { remove?: boolean; quiet?: boolean }): Promise<MergeHookResult> {
  const what = arg?.remove ? "Remove Merge Hook" : "Install Merge Hook";
  const project = w3.workspace.project();
  if (!project) throw new Error(`${what}: no project is open.`);
  const r = await w3.backend.invoke<MergeHookResult>("terrain_merge_hook", { root: project.root, remove: arg?.remove === true })
    .catch((e) => { throw new Error(`${what}: ${errorText(e)}`); });
  if (arg?.quiet !== true) {
    if (!r.git) void w3.window.showWarning(`${what}: git wasn't found, so there is no repository to put a hook in.`);
    else if (r.action === "foreign") void w3.window.showWarning(`${what}: ${r.message}`);
    else void w3.window.showInfo(`${what}: ${r.message} (git found)`);
  }
  return r;
}

/** What Check Terrain IDs found (terrain_ids.rs Report, backend flatview.rs check). */
export interface IdCheck {
  duplicates: { kind: string; number: number; files: string[]; members: FixMember[] }[];
  /** Information only: numbers found twice that terrain.json lists as kept from the imported map
   *  (`objects.<kind>.importedTwice`); they pack as they came. */
  kept: { kind: string; number: number; files: string[]; members: FixMember[] }[];
  overlaps: { a: string; aRange: [number, number]; b: string; bRange: [number, number] }[];
  /** Information only: moved objects and imported maps have numbers outside their subterrain's ranges. */
  outside: { subterrain: string; kind: string; count: number; examples: number[] }[];
  numbers: number;
  /** A number twice or ranges that overlap. */
  errors: boolean;
  /** The report as text, as `w3proj terrain check` prints it. */
  lines: string[];
}

/** Check Terrain IDs: creation numbers found twice per kind, every object holding one listed (a flat project too),
 *  overlapping id ranges (errors), numbers outside their subterrain's ranges (information), as `w3proj terrain check`.
 *  The report goes to the Subterrains output; a message says the outcome. Rejects when the files can't be read. */
export async function checkTerrainIds(w3: W3Api, arg?: { quiet?: boolean }): Promise<IdCheck> {
  const project = w3.workspace.project();
  if (!project) throw new Error("Check Terrain IDs: no project is open.");
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
    void w3.window.showError(`Check Terrain IDs: ${[twice ? `${twice} creation number${twice === 1 ? "" : "s"} found twice` : "", overlaps ? `${overlaps} overlapping id range${overlaps === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ")}. The Subterrains output lists them${twice ? "; Fix Duplicate Creation Numbers… renumbers them or deletes exact copies" : ""}.`);
  } else {
    const kept = report.kept?.length ?? 0;
    const twiceText = kept ? `${kept} kept twice as the imported map has ${kept === 1 ? "it" : "them"} (the Subterrains output lists them)` : "none twice";
    void w3.window.showInfo(`Check Terrain IDs: ${report.numbers} creation numbers, ${twiceText}, no overlapping ranges.`);
  }
  return report;
}

/** One object holding a creation number found twice, and what a fix does with it (terrain_ids.rs FixMember). */
export interface FixMember {
  file: string;
  index: number;
  id: string;
  x: number | null;
  y: number | null;
  copyOf?: number;
  action: "keep" | "renumber" | "delete" | "stays";
  to?: number;
}
/** What fixing creation numbers found twice does (terrain_ids.rs FixPlan, backend flatview.rs fix_ids). */
export interface FixPlan {
  mode: "renumber" | "deleteCopies" | null;
  groups: { kind: string; number: number; members: FixMember[] }[];
  renumbered: number;
  deleted: number;
  stillTwice: number;
  unchecked: string[];
  files: { path: string; text: string }[];
  lines: string[];
}
export type FixMode = "renumber" | "deleteCopies";

/** Fix Duplicate Creation Numbers…: every creation number found twice (flat or split project) with all its objects,
 *  then, by choice, Renumber (every object of a number but the first gets the next free number: its subterrain's range,
 *  in a flat map above the highest) or Delete Copies (only exact copies of an earlier object go; those that differ stay
 *  and are said). The plans and their counts are shown first; nothing changes without a choice. Refused while anything
 *  is unsaved; the files are written as one edit (Undo takes it back). `arg.mode` chooses without asking, `arg.dryRun`
 *  only gives the plan (MCP, app-smoke). Resolves with the plan carried out (or shown), null when cancelled or there is
 *  nothing to fix. */
export async function fixCreationIds(w3: W3Api, arg?: { mode?: FixMode; dryRun?: boolean; quiet?: boolean }): Promise<FixPlan | null> {
  const what = "Fix Duplicate Creation Numbers";
  const project = w3.workspace.project();
  if (!project) throw new Error(`${what}: no project is open.`);
  const root = project.root;
  const plan = async (mode: FixMode | null) => {
    try {
      return await w3.backend.invoke<FixPlan>("terrain_fix_ids", { root, mode });
    } catch (e) {
      throw new Error(`${what}: ${errorText(e).replace(/\.?$/, ".")} Nothing was changed.`);
    }
  };
  const found = await plan(null);
  const out = w3.output.channel("Subterrains");
  if (!found.groups.length) {
    if (!arg?.quiet) void w3.window.showInfo(`${what}: no creation number is found twice.`);
    return arg?.dryRun ? found : null;
  }
  let mode = arg?.mode ?? null;
  if (arg?.dryRun) return mode ? plan(mode) : found;
  const unsaved = w3.editors.unsavedPaths();
  if (unsaved.length) throw new Error(`${what}: save or discard the changes in ${unsaved.join(", ")} first.`);
  const objects = found.groups.reduce((n, g) => n + g.members.length, 0);
  if (!mode) {
    const [renumber, deleting] = [await plan("renumber"), await plan("deleteCopies")];
    out.clear();
    for (const line of found.lines) out.append(line);
    out.show();
    const RENUMBER = `Renumber ${renumber.renumbered}`, DELETE = `Delete ${deleting.deleted} Cop${deleting.deleted === 1 ? "y" : "ies"}`;
    const choices = deleting.deleted ? [RENUMBER, DELETE] : [RENUMBER];
    const pick = await w3.window.showWarning(
      `${found.groups.length} creation number${found.groups.length === 1 ? " is" : "s are"} found twice, on ${objects} objects (the Subterrains output lists them). ` +
      `Renumber: ${renumber.renumbered} object${renumber.renumbered === 1 ? "" : "s"} get new numbers (scripts naming them by number, gg_…_0581, then mean the first). ` +
      `Delete Copies: ${deleting.deleted} exact cop${deleting.deleted === 1 ? "y is" : "ies are"} removed, ${deleting.stillTwice} object${deleting.stillTwice === 1 ? "" : "s"} still share a number. Undo takes it back.`,
      ...choices, "Cancel");
    mode = pick === RENUMBER ? "renumber" : pick === DELETE ? "deleteCopies" : null;
    if (!mode) return null;
  }
  // The answer took a while: the project, and what is unsaved, as they are now.
  if (w3.workspace.project()?.root !== root) throw new Error(`${what}: the project changed meanwhile; nothing was changed.`);
  if (w3.editors.unsavedPaths().length) throw new Error(`${what}: save or discard the changes in ${w3.editors.unsavedPaths().join(", ")} first.`);
  const chosen = await plan(mode);
  if (!chosen.files.length) return chosen;
  const edits = await w3.services.get<McpEditsService>(MCP_EDITS_SERVICE);
  const n = mode === "renumber" ? `${chosen.renumbered} renumbered` : `${chosen.deleted} cop${chosen.deleted === 1 ? "y" : "ies"} deleted`;
  await edits.edit(`${what} (${n})`, async () => chosen.files);
  if (w3.workspace.project()?.root === root) await w3.workspace.refresh();
  out.clear();
  for (const line of chosen.lines) out.append(line);
  if (!arg?.quiet) void w3.window.showInfo(`${what}: ${n}${chosen.stillTwice ? `; ${chosen.stillTwice} objects still share a number (they differ: Renumber fixes them)` : ""}.`);
  return chosen;
}

/** Check Terrain Seams: the whole terrain as saved (every subterrain read, closed ones too) checked along the seams
 *  with the terrain brushes' cliff, ramp and water rules (lib/terrain/seams.ts, as `w3proj terrain seams` and
 *  `w3proj pack`). Nothing is changed. The report goes to the Subterrains output; a message says the outcome. Rejects
 *  when the terrain isn't split or its files can't be read. */
export async function checkTerrainSeams(w3: W3Api, arg?: { quiet?: boolean }): Promise<SeamReport> {
  const what = "Check Terrain Seams";
  const project = w3.workspace.project();
  if (!project) throw new Error(`${what}: no project is open.`);
  if (!isSplit(w3)) throw new Error(`${what}: the terrain isn't split (there is no map/terrain/terrain.json).`);
  let report: SeamReport | null;
  try {
    report = await checkSeams((cmd, args) => w3.backend.invoke(cmd, args), project.root);
  } catch (e) {
    throw new Error(`${what}: ${errorText(e).replace(/\.?$/, ".")}`);
  }
  if (!report) throw new Error(`${what}: the terrain isn't split (there is no map/terrain/terrain.json).`);
  if (w3.workspace.project()?.root !== project.root || arg?.quiet) return report;
  const out = w3.output.channel("Subterrains");
  out.clear();
  for (const line of seamLines(report)) out.append(line);
  const unsaved = w3.editors.unsavedPaths().length ? " (as saved: unsaved changes aren't in it)" : "";
  if (report.issues.length) {
    out.show();
    const text = `${what}: ${seamSummary(report)}${unsaved}. The Subterrains output lists them.`;
    void (report.errors ? w3.window.showError(text) : w3.window.showWarning(text));
  } else {
    void w3.window.showInfo(`${what}: ${seamSummary(report)}${unsaved}.`);
  }
  return report;
}

// ---- New, Resize, Rename and Join Subterrains (lib/terrain/subterrainplan.ts, backend terrain_relayout) ----

/** A rectangle given to a command: `x,y,w,h` text or numbers. */
type RectArg = string | { x: number; y: number; w: number; h: number };
const rectOf = (r: RectArg | undefined) => (typeof r === "string" ? parseRect(r) : r && [r.x, r.y, r.w, r.h].every(Number.isFinite) ? r : null);
const rectText = (s: { x: number; y: number; w: number; h: number }) => `${s.x},${s.y},${s.w},${s.h}`;

/** Changes the subterrains: `plan` makes the new set from the current ones (a string: why it can't; undefined:
 *  cancelled). Refused while anything is unsaved, before any question; the change itself goes through `convert` (the
 *  derived work first, a checkpoint, the file list read again, the editors of the terrain and object files opened
 *  again: the open choice may have changed with the names). The map stays the same; only which file holds what changes. */
async function changeSubterrains(w3: W3Api, what: string, plan: (subs: SubRect[]) => Promise<PlannedSubterrain[] | string | undefined>, quiet: boolean, preview?: boolean): Promise<Converted | Previewed | null> {
  const project = w3.workspace.project();
  if (!project) throw new Error(`${what}: no project is open.`);
  if (preview) {
    // Only what it would do: nothing is written, so unsaved changes don't stop it (they would stop the change).
    const p = await planned(w3, what, plan);
    if (p === undefined) return null;
    return { plan: p.map(planText), preview: await previewLayout(w3, p, what) };
  }
  const unsaved = w3.editors.unsavedPaths();
  if (unsaved.length) throw new Error(`${what}: save or discard the changes in ${unsaved.join(", ")} first.`);
  const p = await planned(w3, what, plan);
  if (p === undefined) return null;
  // The questions took time: another project, or an edit made meanwhile, stops it.
  if (w3.workspace.project()?.root !== project.root) throw new Error(`${what}: the project changed meanwhile. Nothing was changed.`);
  const done = await convert(w3, what, (root) => w3.backend.invoke<Converted>("terrain_relayout", { root, plan: p.map(planText) }), quiet);
  w3.views.refresh(SUBTERRAINS_VIEW);
  return done;
}

/** The new set `plan` makes from the subterrains on disk; a string from `plan` is the refusal (thrown). */
async function planned(w3: W3Api, what: string, plan: (subs: SubRect[]) => Promise<PlannedSubterrain[] | string | undefined>): Promise<PlannedSubterrain[] | undefined> {
  const s = await openState(w3, what);
  const p = await plan(s.subterrains.map(({ name, x, y, w, h }) => ({ name, x, y, w, h })));
  if (typeof p === "string") throw new Error(`${what}: ${p.replace(/\.?$/, ".")} Nothing was changed.`);
  return p;
}

/** Picks one of `subs` (`given` skips the question). */
async function pickSubterrain(w3: W3Api, subs: SubRect[], placeholder: string, given?: string): Promise<SubRect | undefined | string> {
  if (given !== undefined) return subs.find((s) => s.name === given) ?? `There is no subterrain "${given}".`;
  const pick = await w3.window.quickPick(subs.map((s) => ({ label: s.name, description: `${s.w}×${s.h} corners at ${s.x},${s.y}`, value: s })), { placeholder });
  return pick?.value;
}

const RECT_PROMPT = "x,y,w,h in corners ((0,0) the south-west corner; a subterrain owns corners x to x+w-1)";

/** New Subterrain…: a rectangle that takes a whole side off the subterrains it covers (or all of one), or lies where
 *  none is; it gets the next block of creation numbers. */
export function newSubterrain(w3: W3Api, arg?: { name?: string; rect?: RectArg; quiet?: boolean; preview?: boolean }) {
  return changeSubterrains(w3, "New Subterrain", async (subs) => {
    const name = arg?.name ?? (await w3.window.inputBox({ prompt: "The new subterrain's name (its folder under map/terrain/)" }));
    if (name === undefined) return undefined;
    const bad = nameProblem(name, subs);
    if (bad) return bad;
    const text = arg?.rect ?? (await w3.window.inputBox({ prompt: `Where: ${RECT_PROMPT}`, placeholder: subs[0] ? rectText(subs[0]) : "0,0,64,64" }));
    if (text === undefined) return undefined;
    const r = rectOf(text);
    return r ? placePlan(subs, { name, ...r, from: [] }) : `"${typeof text === "string" ? text : rectText(text)}" isn't x,y,w,h`;
  }, arg?.quiet === true, arg?.preview);
}

/** Resize Subterrain…: its new rectangle takes from its neighbours what it covers (a whole side of each); corners it
 *  gives up must be the default corner, or another subterrain has to take them (resize that one over them). */
export function resizeSubterrain(w3: W3Api, arg?: { name?: string; rect?: RectArg; quiet?: boolean; preview?: boolean }) {
  return changeSubterrains(w3, "Resize Subterrain", async (subs) => {
    const s = await pickSubterrain(w3, subs, "Resize which subterrain?", arg?.name);
    if (s === undefined || typeof s === "string") return s;
    const text = arg?.rect ?? (await w3.window.inputBox({ prompt: `${s.name}'s new rectangle: ${RECT_PROMPT}`, value: rectText(s) }));
    if (text === undefined) return undefined;
    const r = rectOf(text);
    return r ? placePlan(subs, { name: s.name, ...r, from: [s.name] }, s.name) : `"${typeof text === "string" ? text : rectText(text)}" isn't x,y,w,h`;
  }, arg?.quiet === true, arg?.preview);
}

/** Rename Subterrain…: its folder is renamed, its creation-number ranges stay. */
export function renameSubterrain(w3: W3Api, arg?: { name?: string; to?: string; quiet?: boolean; preview?: boolean }) {
  return changeSubterrains(w3, "Rename Subterrain", async (subs) => {
    const s = await pickSubterrain(w3, subs, "Rename which subterrain?", arg?.name);
    if (s === undefined || typeof s === "string") return s;
    const to = arg?.to ?? (await w3.window.inputBox({ prompt: `${s.name}'s new name (its folder is renamed)`, value: s.name }));
    if (to === undefined || to === s.name) return undefined;
    return renamePlan(subs, s.name, to);
  }, arg?.quiet === true, arg?.preview);
}

/** Join Subterrains…: two or more side by side become one over the rectangle round them, with all their ranges. */
export function joinSubterrains(w3: W3Api, arg?: { names?: string[]; to?: string; quiet?: boolean; preview?: boolean }) {
  return changeSubterrains(w3, "Join Subterrains", async (subs) => {
    let names = arg?.names;
    if (!names) {
      const a = await pickSubterrain(w3, subs, "Join which subterrain…");
      if (a === undefined || typeof a === "string") return a;
      const b = await pickSubterrain(w3, subs.filter((s) => s.name !== a.name), `…with which (beside ${a.name})?`);
      if (b === undefined || typeof b === "string") return b;
      names = [a.name, b.name];
    }
    const to = arg?.to ?? (await w3.window.inputBox({ prompt: "The joined subterrain's name", value: names[0] }));
    if (to === undefined) return undefined;
    return joinPlan(subs, names, to);
  }, arg?.quiet === true, arg?.preview);
}

/** Delete Subterrain (the layout editor's Delete, and the MCP tool's): it joins the first neighbour whose rectangle and
 *  its make one rectangle (its objects and creation-number ranges go there); without one its corners are left
 *  uncovered, which the backend allows only where they are all the default corner. The last one stays. */
export function deleteSubterrain(w3: W3Api, arg: { name: string; quiet?: boolean; preview?: boolean }) {
  return changeSubterrains(w3, "Delete Subterrain", async (subs) => {
    const r = deleteSub(draftOf(subs, [0, 0]), arg.name);
    return typeof r === "string" ? r : planOf(r.draft);
  }, arg.quiet === true, arg.preview);
}

/** What a change would do, as the tool's `preview` answers it. */
interface Previewed { plan: string[]; preview: LayoutPreview }
const isPreviewed = (v: Converted | Previewed | null): v is Previewed => !!v && "preview" in v;

/** The MCP tool change_subterrains: New, Resize, Rename, Join or Delete Subterrains by their commands' own code (the
 *  same plan, the same refusals: unsaved changes, a rectangle cutting one in pieces, corners left out that aren't the
 *  default one, a bad name), and Split Terrain of a flat project, without questions: what a command would ask must be
 *  given. `preview`: only what it would do (the layout editor's preview: files, objects per subterrain, objects that
 *  change subterrain), nothing written. Resolves with what changed and the subterrains afterwards. */
export async function changeSubterrainsTool(w3: W3Api, args: Record<string, unknown>) {
  const { action, name, rect, to, names, rects } = args;
  const preview = args.preview === true;
  const str = (v: unknown, what: string) => {
    if (typeof v !== "string" || !v.trim()) throw new Error(`${String(action)} needs ${what}.`);
    return v;
  };
  const box = (v: unknown): RectArg => {
    if (typeof v === "string") return v;
    const r = v as { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null;
    if (r && typeof r === "object" && [r.x, r.y, r.w, r.h].every((n) => Number.isInteger(n))) return r as RectArg;
    throw new Error(`${String(action)} needs rect: "x,y,w,h" in corners, or { x, y, w, h }.`);
  };
  let done: Converted | Previewed | null;
  switch (action) {
    case "new": done = await newSubterrain(w3, { name: str(name, "name"), rect: box(rect), quiet: true, preview }); break;
    case "resize": done = await resizeSubterrain(w3, { name: str(name, "name"), rect: box(rect), quiet: true, preview }); break;
    case "rename": {
      const from = str(name, "name"), into = str(to, "to");
      if (from === into) throw new Error("rename: to is its name already. Nothing was changed.");
      done = await renameSubterrain(w3, { name: from, to: into, quiet: true, preview });
      break;
    }
    case "join": {
      if (!Array.isArray(names) || names.length < 2 || !names.every((n) => typeof n === "string")) throw new Error("join needs names: two or more subterrains side by side.");
      done = await joinSubterrains(w3, { names: names as string[], to: str(to, "to"), quiet: true, preview });
      break;
    }
    case "delete": done = await deleteSubterrain(w3, { name: str(name, "name"), quiet: true, preview }); break;
    case "split": {
      if (rects !== undefined && (!Array.isArray(rects) || !rects.every((r) => typeof r === "string"))) throw new Error("split takes rects: a list of \"name:x,y,w,h\" (none: one subterrain main over the canvas).");
      const list = (rects as string[] | undefined) ?? [];
      const layout: SplitLayout = list.length ? list : "main";
      if (preview) {
        if (isSplit(w3)) throw new Error("Split Terrain: the terrain is split already (map/terrain/).");
        done = { plan: rectsOf(layout), preview: await previewSplitRects(w3, rectsOf(layout)) };
      } else done = await splitTerrain(w3, { layout, quiet: true });
      break;
    }
    default: throw new Error("action must be \"new\", \"resize\", \"rename\", \"join\", \"delete\" or \"split\".");
  }
  if (isPreviewed(done)) return { preview: true, plan: done.plan, ...done.preview };
  const root = w3.workspace.project()?.root;
  const state = root ? await loadOpenState((cmd, a) => w3.backend.invoke(cmd, a), root).catch(() => null) : null;
  return { written: done?.written ?? [], removed: done?.removed ?? [], subterrains: state?.subterrains.map(({ name: n, x, y, w, h, open }) => ({ name: n, x, y, w, h, open })) ?? [] };
}

// ---- the Terrain Layout editor (editor.ts) ----

/** The layout on disk as the Terrain Layout editor and get_subterrains show it: a split project's subterrains with
 *  their open state and creation-number ranges; a flat project's canvas. */
export async function readLayoutState(w3: W3Api): Promise<LayoutState> {
  const project = w3.workspace.project();
  if (!project) throw new Error("No project is open.");
  const root = project.root;
  const invoke = <T>(cmd: string, args: Record<string, unknown>) => w3.backend.invoke<T>(cmd, args);
  if (isSplit(w3)) {
    const s = await loadOpenState(invoke, root);
    if (!s) throw new Error("the terrain isn't split into subterrains");
    const ids = await invoke<{ subterrains: { name: string; idRanges: [number, number][] }[] } | null>("terrain_id_layout", { root });
    return {
      layout: "split", canvas: s.corners, partial: s.partial, error: s.error,
      subterrains: s.subterrains.map(({ name, x, y, w, h, open, halo, bytes }) => ({ name, x, y, w, h, open, halo, bytes, idRanges: ids?.subterrains.find((i) => i.name === name)?.idRanges ?? [] })),
    };
  }
  const t = await readTerrain(w3);
  return { layout: "flat", canvas: [t.width, t.height], subterrains: [], partial: false, error: null };
}

/** The project's terrain as the editors read it (a split one assembled; closed subterrains default-filled). */
async function readTerrain(w3: W3Api) {
  const path = terrainPath(w3.workspace.files().map((f) => f.path));
  if (!path) throw new Error("This project has no war3map.w3e.");
  return parseW3e(await readTerrainBytes(path, { readText: () => w3.workspace.readText(path), readBytes: () => w3.workspace.readBytes(path) }));
}

/** The editor's background: the ground in its tiles' colours (the game's textures' smallest mip, as the minimap; a
 *  colour per slot without the game). */
async function layoutPictureOf(w3: W3Api): Promise<LayoutPicture> {
  const t = await readTerrain(w3);
  const rows = await w3.game.readText("TerrainArt\\Terrain.slk").then(parseSlk, () => [] as Record<string, string>[]);
  const byId = new Map(rows.map((r) => [r.tileID, r]));
  const drawn = drawnGroundTiles(t, ownGroundTiles(rows, t.tileset));
  const colors: (Rgb | null)[] = await Promise.all(drawn.map(async (id) => {
    const row = byId.get(id);
    if (!row?.dir || !row.file) return null;
    const path = `${row.dir}\\${row.file}.blp`;
    try { return smallestMipColor(decodeImage(await w3.game.read(path), path)); } catch { return null; }
  }));
  return { width: t.width, height: t.height, rgba: layoutPicture(t, (slot) => colors[slot] ?? slotColor(slot)) };
}

/** What `plan` would do (the backend's preview); its refusal as the error, worded as the change's. */
export async function previewLayout(w3: W3Api, plan: PlannedSubterrain[], what = "Change Subterrains"): Promise<LayoutPreview> {
  const root = w3.workspace.project()?.root;
  if (!root) throw new Error(`${what}: no project is open.`);
  try {
    return await w3.backend.invoke<LayoutPreview>("terrain_relayout_preview", { root, plan: plan.map(planText) });
  } catch (e) {
    throw new Error(`${what}: ${errorText(e).replace(/\.?$/, ".")}`);
  }
}

/** What Split Terrain into `rects` (the backend's form) would do. */
async function previewSplitRects(w3: W3Api, rects: string[]): Promise<LayoutPreview> {
  const root = w3.workspace.project()?.root;
  if (!root) throw new Error("Split Terrain: no project is open.");
  try {
    return await w3.backend.invoke<LayoutPreview>("terrain_split_preview", { root, rects });
  } catch (e) {
    throw new Error(`Split Terrain: ${errorText(e).replace(/\.?$/, ".")}`);
  }
}

/** Rectangles as Split Terrain takes them: none is one subterrain `main` over the canvas (the default corner the most
 *  common one), others `name:x,y,w,h`. */
const gridLayout = (rects: SubRect[]): SplitLayout => (rects.length ? rects.map((r) => `${r.name}:${rectText(r)}`) : "main");

/** The layout editor's Apply: the whole draft as one change of the subterrains (the backend's relayout, kept so
 *  `undoLayoutChange` takes it back as one step). Refused, nothing changed, while anything is unsaved; the reasons of
 *  the Subterrains commands. The number to take it back with. */
export async function applyLayout(w3: W3Api, plan: PlannedSubterrain[]): Promise<number> {
  const what = "Change Subterrains";
  if (!isSplit(w3)) throw new Error(`${what}: the terrain is still in the old single-file layout (Split Terrain in Edit Terrain Layout… first).`);
  const done = await convert(w3, what, (root) => w3.backend.invoke<Converted & { undo: number }>("terrain_relayout", { root, plan: plan.map(planText), undoable: true }), true);
  w3.views.refresh(SUBTERRAINS_VIEW);
  return done.undo;
}

/** Takes a change of `applyLayout` back (`redo`: makes it again): refused while anything is unsaved, or when the
 *  subterrains' files changed since (the backend says which). */
export async function undoLayoutChange(w3: W3Api, id: number, redo: boolean): Promise<void> {
  await convert(w3, redo ? "Redo Change Subterrains" : "Undo Change Subterrains", (root) => w3.backend.invoke<Converted>("terrain_relayout_undo", { root, id, redo }), true, false);
  w3.views.refresh(SUBTERRAINS_VIEW);
}

/** The Terrain Layout editor's calls (editor.ts). */
export function layoutOps(w3: W3Api): LayoutOps {
  return {
    readState: () => readLayoutState(w3),
    picture: () => layoutPictureOf(w3),
    preview: (plan) => previewLayout(w3, plan),
    previewSplit: (rects) => previewSplitRects(w3, rectsOf(gridLayout(rects))),
    apply: (plan) => applyLayout(w3, plan),
    undo: (id, redo) => undoLayoutChange(w3, id, redo),
    split: async (rects) => { await splitTerrain(w3, { layout: gridLayout(rects), quiet: true }); },
    seams: async () => {
      const r = await checkTerrainSeams(w3, { quiet: true });
      return r.issues.flatMap((i) => i.corners.map((c) => ({ x: c.x, y: c.y, error: i.severity === "error", text: i.message })));
    },
  };
}

/** The open Terrain Layout editor's state (null: none open), for get_subterrains. */
let editorState: LayoutEditorState | null = null;

/** The MCP tool get_subterrains: the layout on disk (subterrains, rectangles, open ones, creation-number ranges, or a
 *  flat project's canvas) and, when the Terrain Layout editor is open, its draft and preview. */
export async function getSubterrainsTool(w3: W3Api) {
  const s = await readLayoutState(w3);
  return { ...s, open: s.subterrains.filter((x) => x.open).map((x) => x.name), editor: editorState };
}

// ---- Open Subterrains… (spec "Working on Part of the Map") ----

/** The project's open state (terrain_open_state); rejects for a flat project. */
async function openState(w3: W3Api, what: string): Promise<OpenState> {
  const project = w3.workspace.project();
  if (!project) throw new Error(`${what}: no project is open.`);
  if (!isSplit(w3)) throw new Error(`${what}: the terrain is still in the old single-file layout (Split Terrain in Edit Terrain Layout… first).`);
  const s = await loadOpenState((cmd, args) => w3.backend.invoke(cmd, args), project.root);
  if (!s) throw new Error(`${what}: the terrain isn't split into subterrains.`);
  return s;
}

/** Opens `names` (all of them removes the choice): refused while an editor has unsaved changes (the terrain editor
 *  reloads, and what it holds would be saved into the other subterrains' files, or lost); the derived work of the last
 *  edit first; afterwards the file list read again and the editors of the flat files opened again. The new state. */
export async function setOpenSubterrains(w3: W3Api, names: string[]): Promise<OpenState | null> {
  const what = "Open Subterrains";
  const project = w3.workspace.project();
  if (!project) throw new Error(`${what}: no project is open.`);
  const unsaved = w3.editors.unsavedPaths();
  if (unsaved.length) throw new Error(`${what}: save or discard the changes in ${unsaved.join(", ")} first.`);
  await w3.commands.execute("w3.terrain.settle").catch(() => {});
  const root = project.root;
  let state: OpenState | null;
  try {
    state = await w3.backend.invoke<OpenState | null>("terrain_set_open", { root, names });
  } catch (e) {
    throw new Error(`${what}: ${errorText(e).replace(/\.?$/, ".")} Nothing was changed.`);
  }
  if (w3.workspace.project()?.root !== root) return state;
  // The view's next paint starts from the new choice, not the old one (see renderView).
  if (state) viewState = { root, state };
  await w3.workspace.refresh();
  for (const p of w3.editors.openPaths().filter((p) => FLAT_LOWER.includes(p.replace(/\\/g, "/").toLowerCase()))) await w3.editors.reopen(p);
  w3.views.refresh(SUBTERRAINS_VIEW);
  return state;
}

/** Open Subterrains…: `arg.names` (MCP, app-smoke) or `arg.all` skip the questions; otherwise a pick that toggles one
 *  subterrain at a time until "Open the ticked ones". Resolves with the new state, null when cancelled. */
export async function openSubterrains(w3: W3Api, arg?: { names?: string[]; all?: boolean }): Promise<OpenState | null> {
  const s = await openState(w3, "Open Subterrains");
  if (arg?.all) return setOpenSubterrains(w3, s.subterrains.map((x) => x.name));
  if (arg?.names) return setOpenSubterrains(w3, arg.names);
  const ticked = new Set(s.error ? s.subterrains.map((x) => x.name) : s.subterrains.filter((x) => x.open).map((x) => x.name));
  for (;;) {
    type Pick = { kind: "apply" } | { kind: "all" } | { kind: "toggle"; name: string };
    const pick = await w3.window.quickPick<Pick>([
      { label: `Open the ticked ones (${ticked.size} of ${s.subterrains.length})`, value: { kind: "apply" }, disabled: ticked.size ? undefined : "Tick at least one" },
      { label: "Open all", description: "The whole map, as without subterrains", value: { kind: "all" } },
      ...s.subterrains.map((x) => ({
        label: `${ticked.has(x.name) ? "☑" : "☐"} ${x.name}`,
        description: `${x.w}×${x.h} corners at ${x.x},${x.y} · ${sizeText(x.bytes)}${x.open ? "" : " · closed now"}`,
        value: { kind: "toggle" as const, name: x.name },
      })),
    ], { placeholder: s.error ? `The choice can't be read (${s.error}): pick again` : "Pick a subterrain to tick or untick it; closed ones aren't read, drawn or saved" });
    if (!pick?.value) return null;
    if (pick.value.kind === "apply") return setOpenSubterrains(w3, [...ticked]);
    if (pick.value.kind === "all") return setOpenSubterrains(w3, s.subterrains.map((x) => x.name));
    const n = pick.value.name;
    if (ticked.has(n)) ticked.delete(n);
    else ticked.add(n);
  }
}

const sizeText = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** The side view listing the subterrains with a box each: ticking one opens it, unticking closes it (the terrain
 *  editor reloads); a closed one isn't read, drawn or saved. */
export const SUBTERRAINS_VIEW = "w3.terrainLayout.subterrains";

function renderView(w3: W3Api, el: HTMLElement) {
  if (!w3.workspace.project()) {
    el.append(h("div.view-empty", {}, "Open a project to see its subterrains."));
    return;
  }
  if (!isSplit(w3)) {
    el.append(h("div.view-empty", {}, "The terrain isn't split into subterrains. ", h("button.link-inline", { onclick: () => void w3.commands.execute("w3.terrainLayout.edit").catch(() => {}) }, "Edit Terrain Layout…")));
    return;
  }
  // The last state read paints at once: the view is cleared at every refresh (and a toggle refreshes it more than once),
  // and an empty "Reading…" in between made the list collapse and pop back.
  const root = w3.workspace.project()!.root;
  const cached = viewState?.root === root ? viewState.state : undefined;
  const body = h("div.tree", {}, ...(cached ? [] : [h("div.muted", {}, "Reading the subterrains…")]));
  el.append(body);
  const paint = (s: OpenState) => {
    const rows: HTMLElement[] = [];
    const summary = s.error ? `The choice can't be read: ${s.error}` : `${openSummary(s)}${s.partial ? " · closed ones aren't read, drawn or saved" : ""}`;
    rows.push(h("div.muted.subterrain-summary", {}, summary));
    const choose = (names: string[]) => void setOpenSubterrains(w3, names).catch((e) => w3.window.showError(errorText(e)));
    for (const x of s.subterrains) {
      const box = h("input", { type: "checkbox", checked: x.open, title: x.open ? `Close ${x.name}` : `Open ${x.name}` }) as HTMLInputElement;
      box.addEventListener("change", () => {
        const names = new Set(s.subterrains.filter((y) => y.open).map((y) => y.name));
        if (box.checked) names.add(x.name);
        else names.delete(x.name);
        if (!names.size) { box.checked = true; void w3.window.showWarning("At least one subterrain stays open."); return; }
        choose([...names]);
      });
      rows.push(h("label.tree-row.subterrain-row", { title: `${x.name}: corners ${x.x}–${x.x + x.w - 1}, ${x.y}–${x.y + x.h - 1}` },
        box,
        h("span.tree-label", {}, x.name),
        h("span.muted", {}, ` ${x.w}×${x.h} · ${sizeText(x.bytes)}${x.halo ? " · halo" : ""}`)));
    }
    rows.push(h("div.tree-row", {},
      h("button.link-inline", { onclick: () => choose(s.subterrains.map((y) => y.name)) }, "Open all"),
      " · ",
      h("button.link-inline", { title: "Toggle Subterrain Overlay: the rectangles and names over the terrain editor's map", onclick: () => void w3.commands.execute("w3.terrain.toggleSubterrains").catch((e) => w3.window.showError(errorText(e))) }, "Show on the map")));
    rows.push(h("div.tree-row", {},
      h("button.link-inline", { title: "Edit Terrain Layout: draw, resize, rename, join, delete or cut into rows and columns", onclick: () => void w3.commands.execute("w3.terrainLayout.edit").catch((e) => w3.window.showError(errorText(e))) }, "Edit Terrain Layout…")));
    body.replaceChildren(...rows);
  };
  if (cached) paint(cached);
  void openState(w3, "Subterrains").then((s) => { viewState = { root, state: s }; paint(s); }, (e) => body.replaceChildren(h("div.view-empty", {}, errorText(e))));
}

/** What the subterrains view showed last, for the next paint to start from. */
let viewState: { root: string; state: OpenState } | undefined;

/** The Terrain Layout editor's id. */
export const LAYOUT_EDITOR = "w3.terrainLayout.editor";
export { LAYOUT_DOC };

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
    w3.commands.register("w3.terrainLayout.installMergeHook", shown(w3, (arg?: { quiet?: boolean }) => mergeHook(w3, arg))),
    w3.commands.register("w3.terrainLayout.removeMergeHook", shown(w3, (arg?: { quiet?: boolean }) => mergeHook(w3, { ...arg, remove: true }))),
    w3.commands.register("w3.terrainLayout.checkIds", shown(w3, (arg?: { quiet?: boolean }) => checkTerrainIds(w3, arg))),
    w3.mcp.registerTool("change_subterrains", (args) => changeSubterrainsTool(w3, args)),
    w3.commands.register("w3.terrainLayout.fixIds", shown(w3, (arg?: { mode?: FixMode; dryRun?: boolean; quiet?: boolean }) => fixCreationIds(w3, arg))),
    w3.mcp.registerTool("fix_creation_ids", async ({ mode, apply }) => {
      if (mode !== undefined && mode !== "renumber" && mode !== "deleteCopies") throw new Error("mode must be \"renumber\" or \"deleteCopies\" (or left out to list the numbers found twice).");
      if (apply === true && mode === undefined) throw new Error("apply needs a mode: \"renumber\" or \"deleteCopies\".");
      const r = await fixCreationIds(w3, { mode: mode as FixMode | undefined, dryRun: apply !== true, quiet: true });
      if (!r) return { groups: [], summary: "No creation number is found twice." };
      return { applied: apply === true && !!r.files.length, mode: r.mode, groups: r.groups, renumbered: r.renumbered, deleted: r.deleted, stillTwice: r.stillTwice, unchecked: r.unchecked, summary: r.lines.find((l) => l.includes("found twice")) ?? "" };
    }),
    w3.commands.register("w3.terrainLayout.checkSeams", shown(w3, (arg?: { quiet?: boolean }) => checkTerrainSeams(w3, arg))),
    w3.mcp.registerTool("check_terrain_seams", async () => {
      const r = await checkTerrainSeams(w3, { quiet: true });
      return { errors: r.errors, warnings: r.warnings, seams: r.seams, seamCorners: r.seamCorners, issues: r.issues, summary: seamSummary(r) };
    }),
    // `quiet`: the caller tells of a failure (Map Size opening every subterrain for itself, lib/terrain/openall.ts).
    w3.commands.register("w3.terrainLayout.openSubterrains", (arg?: { names?: string[]; all?: boolean; quiet?: boolean }) =>
      (arg?.quiet ? openSubterrains(w3, arg) : shown(w3, (a?: { names?: string[]; all?: boolean }) => openSubterrains(w3, a))(arg))),
    w3.commands.register("w3.terrainLayout.newSubterrain", shown(w3, (arg?: { name?: string; rect?: RectArg; quiet?: boolean }) => newSubterrain(w3, arg))),
    w3.commands.register("w3.terrainLayout.resizeSubterrain", shown(w3, (arg?: { name?: string; rect?: RectArg; quiet?: boolean }) => resizeSubterrain(w3, arg))),
    w3.commands.register("w3.terrainLayout.renameSubterrain", shown(w3, (arg?: { name?: string; to?: string; quiet?: boolean }) => renameSubterrain(w3, arg))),
    w3.commands.register("w3.terrainLayout.joinSubterrains", shown(w3, (arg?: { names?: string[]; to?: string; quiet?: boolean }) => joinSubterrains(w3, arg))),
    w3.commands.register("w3.terrainLayout.deleteSubterrain", shown(w3, (arg?: { name?: string; quiet?: boolean }) => {
      if (!arg?.name) throw new Error("Delete Subterrain: name one (the Terrain Layout editor's Delete picks it on the map).");
      return deleteSubterrain(w3, { name: arg.name, quiet: arg.quiet });
    })),
    w3.mcp.registerTool("get_subterrains", () => getSubterrainsTool(w3)),
    w3.editors.registerProvider(LAYOUT_EDITOR, { resolve: (el) => layoutEditor(w3, el, layoutOps(w3), (s) => { editorState = s; }) }),
    w3.commands.register("w3.terrainLayout.edit", async () => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      await w3.editors.open(LAYOUT_DOC, LAYOUT_EDITOR);
    }),
    w3.views.register(SUBTERRAINS_VIEW, { render: (el) => renderView(w3, el) }),
    w3.workspace.onDidChange(() => w3.views.refresh(SUBTERRAINS_VIEW)),
  );
}
