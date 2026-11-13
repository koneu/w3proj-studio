// `w3proj check`: the project checked by the app's own code, without the app. The CLI (crates/cli, check.rs) starts
// this in Node with the job as its argument, answers its backend commands over the pipe (ipc.ts) and prints the
// report this ends with; the exit code is decided there from the rows' severities.
//
//   problems  the Problems view's checks (builtin/problems: the service's runChecked, so the project's
//             .w3proj/problems-ignore.json is honoured and the ignored are counted as in the view and Build)
//   melee     check_melee (terrain-viewer/meleefacts.ts meleeReport), on the saved files: by default only on maps
//             whose war3map.w3i has the Melee flag
//   path      check_path between two points (meleefacts.ts pathReport); only when the job gives them
//
// Nothing is written: the checks only read, and the CLI's backend refuses writes for this job.

import { headless, type Message } from "./host";
import type { ExtensionManifest } from "../extensions/api";
import { PROBLEMS_SERVICE, TERRAIN_SERVICE, type CheckedGroup, type ProblemsService, type TerrainToolGroup } from "../extensions/services";
import { readMapDocStrict } from "../lib/formats/mapdoc";
import { MELEE_MAP } from "../lib/terrain/owner";
import { terrainPath } from "../lib/terrain/w3etext";
import { meleeReport, pathReport, projectWalkSource, type WalkSource } from "../builtin/terrain-viewer/meleefacts";
import { mapObjectData, readFile } from "../builtin/terrain-viewer/projectfiles";
import * as problemsExtension from "../builtin/problems/index";
import * as pathingExtension from "../builtin/terrain-pathing/index";
import problemsManifest from "../builtin/problems/extension.json";
import terrainManifest from "../builtin/terrain-viewer/extension.json";
import pathingManifest from "../builtin/terrain-pathing/extension.json";

export type Section = "problems" | "melee" | "path";
export const SECTIONS: Section[] = ["problems", "melee", "path"];

export interface CheckJob {
  /** The project folder. */
  root: string;
  /** The sections asked for by name (`--only`); absent: problems, and melee on a melee map (path needs points). */
  only?: Section[];
  /** check_path's two points, world coordinates. */
  path?: { from: [number, number]; to: [number, number] };
  /** The collision size (a radius) of the unit the path and melee checks walk with; 32 as the MCP tools. */
  unitSize?: number;
  /** Settings that win over the project's and the defaults (the game folder, the graphics mode). */
  settings: Record<string, unknown>;
}

/** One line of the report. `check`: the Problems check's id, `melee/<rule>`, or `path`. */
export interface Row { severity: "error" | "warning" | "info"; check: string; location?: string; message: string }

export interface CheckReport {
  rows: Row[];
  /** Reports the project's ignore file left out (they aren't rows). */
  ignored: number;
  /** Why the ignore file wasn't applied, when it is there but can't be used (then nothing is left out). */
  ignoreError: string | null;
  /** What each section did: ran, or was skipped (and why). */
  sections: { section: Section; ran: boolean; note?: string }[];
  /** The Problems checks by id, as the view groups them. */
  problems?: CheckedGroup[];
  /** check_melee's answer as the MCP tool gives it. */
  melee?: unknown;
  /** check_path's answer as the MCP tool gives it. */
  path?: unknown;
  messages: Message[];
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));
const at = (p: readonly number[]) => `${Math.round(p[0])}, ${Math.round(p[1])}`;

export async function check(job: CheckJob): Promise<CheckReport> {
  const asked = job.only ? new Set(job.only) : null;
  for (const s of asked ?? []) if (!SECTIONS.includes(s)) throw new Error(`no section ${JSON.stringify(s)} (problems, melee, path)`);
  if (asked?.has("path") && !job.path) throw new Error("the path check needs its two points (--path x1,y1:x2,y2)");
  const unitSize = typeof job.unitSize === "number" && job.unitSize >= 0 ? job.unitSize : 32;
  const h = headless([problemsManifest, terrainManifest, pathingManifest] as ExtensionManifest[], job.settings);
  const { w3, workspace, messages } = h;
  await workspace.open(job.root);
  const report: CheckReport = { rows: [], ignored: 0, ignoreError: null, sections: [], messages };
  const rows = report.rows;

  if (!asked || asked.has("problems")) {
    await h.activate(problemsManifest.id, problemsExtension);
    const service = await w3.services.get<ProblemsService>(PROBLEMS_SERVICE);
    const r = await service.runChecked();
    report.ignored = r.ignored;
    report.ignoreError = r.ignoreError;
    // What a report says, without the app's buttons (fixes, where a click goes).
    report.problems = r.checks.map((g) => ({ ...g, problems: g.problems.map(({ severity, message, location, about }) => ({ severity, message, ...(location ? { location } : {}), ...(about ? { about } : {}) })) }));
    if (r.ignoreError) rows.push({ severity: "warning", check: "problems", location: ".w3proj/problems-ignore.json", message: `${r.ignoreError}; nothing is ignored until it is fixed` });
    for (const g of r.checks) {
      if (g.error) rows.push({ severity: "error", check: g.id, location: g.title, message: `the check failed: ${g.error}` });
      for (const p of g.problems) rows.push({ severity: p.severity, check: g.id, ...(p.location ? { location: p.location } : {}), message: p.message });
    }
    report.sections.push({ section: "problems", ran: true });
  }

  const wantMelee = !asked || asked.has("melee");
  const wantPath = !!job.path && (!asked || asked.has("path"));
  let source: Promise<WalkSource> | null = null;
  /** The saved map's ground and objects, read once for both; the Pathing tool's overrides apply as in the app. */
  const ground = () => (source ??= (async () => {
    const groups: TerrainToolGroup[] = [];
    w3.services.provide(TERRAIN_SERVICE, { registerToolGroup: (g: TerrainToolGroup) => { groups.push(g); return { dispose() {} }; } });
    await h.activate(pathingManifest.id, pathingExtension);
    await Promise.resolve();
    const terrain = terrainPath(w3.workspace.files().map((f) => f.path));
    const { bases } = await mapObjectData(w3);
    return projectWalkSource(w3, { read: (p) => readFile(w3, { path: terrain ?? "map/war3map.w3e" }, p), baseOf: (id) => bases.get(id), groups });
  })());

  if (wantMelee) {
    let skip: string | null = null;
    if (!asked) {
      // By default only a melee map is held to what ladder maps do.
      try {
        const info = await readMapDocStrict<{ flags?: number }>(w3, "map/war3map.w3i.json");
        if (!info) skip = "the project has no war3map.w3i, so it isn't a melee map";
        else if (!((info.flags ?? 0) & MELEE_MAP)) skip = "not a melee map (war3map.w3i's Melee flag is off; --only=melee checks it anyway)";
      } catch (e) {
        skip = `whether it is a melee map can't be told: ${text(e)}`;
        rows.push({ severity: "warning", check: "melee", location: "map/war3map.w3i", message: skip });
      }
    }
    if (skip) report.sections.push({ section: "melee", ran: false, note: skip });
    else {
      try {
        const m = await meleeReport(w3, await ground(), unitSize);
        report.melee = m;
        for (const f of m.findings) rows.push({ severity: f.severity, check: `melee/${f.rule}`, ...(f.at ? { location: at(f.at) } : {}), message: f.fix ? `${f.message} Fix: ${f.fix}` : f.message });
        report.sections.push({ section: "melee", ran: true });
      } catch (e) {
        rows.push({ severity: "error", check: "melee", message: `the check failed: ${text(e)}` });
        report.sections.push({ section: "melee", ran: false, note: text(e) });
      }
    }
  }

  if (wantPath && job.path) {
    const { from, to } = job.path;
    const where = `${at(from)} to ${at(to)}`;
    try {
      const p = await pathReport(await ground(), from, to, unitSize);
      report.path = p;
      if (p.walkable) {
        const narrow = p.narrowest ? `, narrowest ${p.narrowest.width} wide at ${at(p.narrowest.at)}` : "";
        rows.push({ severity: "info", check: "path", location: where, message: `a unit of size ${unitSize} gets through: ${Math.round(p.length ?? 0)} long${narrow}` });
      } else {
        const stuck = p.stuckAt ? `; it gets as far as ${at(p.stuckAt)}` : "";
        const by = p.standingNearby ? ` (${p.standingNearby.id} stands there)` : "";
        const fits = p.largestUnitThatFits !== undefined ? `; the largest unit that gets through has size ${p.largestUnitThatFits}` : "";
        rows.push({ severity: "error", check: "path", location: where, message: `a unit of size ${unitSize} doesn't get through: ${p.problem ?? "no way"}${stuck}${by}${fits}` });
      }
      report.sections.push({ section: "path", ran: true });
    } catch (e) {
      rows.push({ severity: "error", check: "path", location: where, message: `the check failed: ${text(e)}` });
      report.sections.push({ section: "path", ran: false, note: text(e) });
    }
  } else if (!asked) {
    report.sections.push({ section: "path", ran: false, note: "needs two points (--path x1,y1:x2,y2)" });
  }
  return report;
}
