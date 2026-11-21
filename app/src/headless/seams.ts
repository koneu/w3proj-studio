// `w3proj terrain seams` and the seam check of `w3proj pack`: Check Terrain Seams (lib/terrain/seams.ts) run in Node
// without the app. The CLI (crates/cli, seams.rs) starts this with the job as its argument and answers its one backend
// command (terrain_whole: the whole terrain assembled from every subterrain) over the pipe; the report goes back as it
// is, and the CLI prints it and decides the exit code. Nothing is written.

import { call } from "./ipc";
import { checkSeams, seamLines, type SeamReport } from "../lib/terrain/seams";

export interface SeamsJob { root: string }

/** The report, with its lines as the CLI prints them; null `report` for a flat project. */
export async function seams(job: SeamsJob): Promise<{ report: SeamReport | null; lines: string[] }> {
  if (typeof job.root !== "string" || !job.root) throw new Error("the seams job needs the project folder (root)");
  const report = await checkSeams((cmd, args) => call(cmd, args) as Promise<never>, job.root);
  return { report, lines: report ? seamLines(report) : [] };
}
