// One JassHelper run on a whole map script, in a new temp folder (tool_run, toolrun.rs).

import { joinPath } from "../../lib/paths";

/** What a run needs from the app: the backend, file access and a pause. */
export interface RunIo {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  writeText(path: string, text: string): Promise<void>;
  readText(path: string): Promise<string>;
  sleep?(ms: number): Promise<void>;
}
export interface ToolResult { code: number; stdout: string; stderr: string; killed?: string }
/** Its output, or what it wrote about its errors (logs/compileerrors.txt, and the script its failing step was reading). */
export type RunResult = { output: string } | { log: string; current: string | null; dir: string };

/** How often a run that wrote no result at all is made. */
export const JASSHELPER_ATTEMPTS = 3;

/** One run at a time in this app: two JassHelpers at once (the map's script and Check with JassHelper) share a Wine
 *  prefix and the program's folder. */
let queue: Promise<unknown> = Promise.resolve();

/** Runs `exe` (jasshelper.exe) on `script` with the game's common.j and Blizzard.j. A run that exits 0 having written
 *  neither its output nor its errors did no work: seen through Proton when another JassHelper ran in the same prefix
 *  (another app or tester, 2026-11-14: an empty logs folder, or none, and exit code 0), where the map's script then
 *  "couldn't be regenerated ... os error 2". It is run again in a new folder after a short random pause, up to
 *  JASSHELPER_ATTEMPTS times, and then is an error that says so. */
export function runJassHelper(io: RunIo, exe: string, script: string, commonJ: string, blizzardJ: string, flags: string[], idleMs: number): Promise<RunResult> {
  const run = queue.then(() => runQueued(io, exe, script, commonJ, blizzardJ, flags, idleMs));
  queue = run.catch(() => undefined);
  return run;
}

async function runQueued(io: RunIo, exe: string, script: string, commonJ: string, blizzardJ: string, flags: string[], idleMs: number): Promise<RunResult> {
  const exists = (path: string) => io.invoke<boolean>("fs_exists", { path });
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    const dir = await io.invoke<string>("tool_temp_dir");
    await io.writeText(joinPath(dir, "common.j"), commonJ);
    await io.writeText(joinPath(dir, "Blizzard.j"), blizzardJ);
    await io.writeText(joinPath(dir, "input.j"), script);
    // Ended when it goes this long without progress, or doesn't exit once its result is written (JassHelper in Wine
    // has kept running after its work; toolrun.rs).
    const r = await io.invoke<ToolResult>("tool_run", {
      exe, args: ["--scriptonly", ...flags, "common.j", "Blizzard.j", "input.j", "output.j"], cwd: dir,
      guard: { idleMs, resultFiles: ["output.j", "logs/compileerrors.txt"] },
    });
    const errorsAt = joinPath(dir, "logs/compileerrors.txt"), outputAt = joinPath(dir, "output.j");
    if (r.killed) {
      // Ended before it exited: its files say how it went. Errors written: those. Its output alone: the result.
      if (await exists(errorsAt)) r.code = 1;
      else if (await exists(outputAt)) return { output: await io.readText(outputAt) };
      // Hung having written nothing (Wine's desktop gone, proton.rs end_stale_desktops): once more.
      else if (attempt === 1) continue;
      else throw new Error(`JassHelper didn't finish: ${r.killed}, and wrote no result (files in ${dir}). "vjass.timeout" sets the time.`);
    }
    if (r.code !== 0) {
      // JassHelper writes its errors (its own, or pjass's) to logs\compileerrors.txt.
      const log = await io.readText(errorsAt).catch(() => r.stdout || r.stderr || `exit code ${r.code}`);
      return { log, current: await io.readText(joinPath(dir, "logs/currentmapscript.j")).catch(() => null), dir };
    }
    if (await exists(outputAt)) return { output: await io.readText(outputAt) };
    if (await exists(errorsAt)) {
      // Errors written with exit code 0: they are what it said.
      return { log: await io.readText(errorsAt), current: await io.readText(joinPath(dir, "logs/currentmapscript.j")).catch(() => null), dir };
    }
    if (attempt < JASSHELPER_ATTEMPTS) { await sleep(500 + Math.random() * 1500); continue; }
    const said = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(" · ");
    throw new Error(`JassHelper exited without writing its output or its errors, ${attempt} times (files in ${dir})${said ? `: ${said}` : ""}`);
  }
}
