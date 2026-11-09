// Checkpoints: while a project has saved changes it's packed into build/checkpoints every few
// minutes (git-ignored, like all of build/), so a bug or a slip costs minutes at worst, also in
// projects without git. Unsaved edits aren't included: saving them behind the user's back would
// run everything that follows a save (the map script, for one).

import type { ExtensionContext, ProjectInfo, W3Api } from "../../extensions/api";
import { joinPath } from "../../lib/paths";
import { checkpointName, checkpointState, newestFirst, toPrune } from "./checkpoints";

const FOLDER = "build/checkpoints";
/** The checkpoint folder of a project, or a checkpoint in it. */
const inFolder = (root: string, name = "") => joinPath(root, FOLDER, name);
/** How often the state is looked at; the setting decides when a checkpoint is made. */
const POLL = 20_000;

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const out = w3.output.channel("Project");
  /** The checkpoint being made, if one is. */
  let running: Promise<string> | null = null;
  /** The last checkpoint's file: names go by the second, and a second one in the same second waits for the next. */
  let last = "";
  /** Checkpoints being restored ("root|name", how many restores of it run): no pruning removes them meanwhile. */
  const restoring = new Map<string, number>();
  /** Projects told that their automatic checkpoints fail. */
  const warned = new Set<string>();

  const list = async (root: string) => w3.workspace.listFolder(inFolder(root)).catch(() => [] as string[]);

  /** Pathing, shadows and the minimap still due from a terrain edit belong in a checkpoint. A failure never stops one. */
  const settle = () => w3.commands.execute("w3.terrain.settle").catch(() => {});

  const pack = async (project: ProjectInfo, settleFirst: boolean): Promise<string> => {
    if (settleFirst) await settle();
    // A loop, not one wait: a timer that fires early or a clock set back must not give the name again.
    let name = checkpointName(project.default_output, new Date());
    while (`${project.root}|${name}` === last) {
      await new Promise((r) => setTimeout(r, 1000 - new Date().getMilliseconds() + 5));
      name = checkpointName(project.default_output, new Date());
    }
    last = `${project.root}|${name}`;
    const target = inFolder(project.root, name);
    await w3.backend.invoke("project_pack", { root: project.root, output: target });
    const keep = w3.settings.get<number>("checkpoints.keep") ?? 10;
    // A checkpoint being restored stays, however old: it's read after this one is made.
    const old = toPrune(await list(project.root), keep).filter((f) => !restoring.has(`${project.root}|${f}`));
    let removed = 0;
    // The project may have been changed meanwhile: its own root, not the current one. The new
    // checkpoint exists already, so an old one that can't go is only said.
    for (const f of old) {
      try {
        await w3.backend.invoke("fs_delete", { root: project.root, path: inFolder(project.root, f) });
        removed++;
      } catch (e) {
        out.append(`checkpoint ${f} couldn't be removed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    out.append(`checkpoint ${name}${removed ? ` (${removed} old one${removed === 1 ? "" : "s"} removed)` : ""}`);
    return name;
  };

  /** Packs `project` as it is on disk; the file's name. One at a time: while one is being made, this
   *  waits for it and then makes its own, since the running one may have started before the caller's
   *  last read and so wouldn't hold the state the caller is about to change. `settleFirst`: the
   *  rebuild due from an edit is done before (the automatic ones don't wait for it). */
  const create = async (project: ProjectInfo, settleFirst = true): Promise<string> => {
    while (running) await running.catch(() => {});
    const job = pack(project, settleFirst);
    running = job;
    try {
      return await job;
    } finally {
      if (running === job) running = null;
    }
  };

  const tick = async () => {
    // Captured once: everything below is about this project, also if another one is opened meanwhile.
    const project = w3.workspace.project();
    if (!project || running || w3.settings.get<boolean>("checkpoints.enabled") === false) return;
    const minutes = w3.settings.get<number>("checkpoints.intervalMinutes") ?? 5;
    const megabytes = w3.settings.get<number>("checkpoints.maxMegabytes") ?? 500;
    const newest = newestFirst(await list(project.root))[0]?.time ?? null;
    // files() is the open project's: if that's another one now, this look is void. A checkpoint asked
    // for meanwhile is as good as this one.
    if (w3.workspace.project()?.root !== project.root || running) return;
    if (checkpointState(w3.workspace.files(), newest, Date.now(), minutes * 60_000, megabytes * 1024 * 1024) !== "due") return;
    await create(project, false).catch((e) => {
      out.append(`checkpoint failed: ${String(e)}`);
      if (warned.has(project.root)) return;
      warned.add(project.root);
      void w3.window.showWarning(`Automatic checkpoints of this project fail: ${String(e)}`);
    });
  };

  /** Replaces the project's map files with a checkpoint's; what's there now is kept as one first. */
  const restore = async (project: ProjectInfo, name: string) => {
    // The editors closed after a question: the user may have opened another project meanwhile.
    const still = () => {
      if (w3.workspace.project()?.root !== project.root) throw new Error("Not restored: another project was opened meanwhile.");
    };
    still();
    const key = `${project.root}|${name}`;
    restoring.set(key, (restoring.get(key) ?? 0) + 1);
    try {
      // Settled by the caller, before the editors closed: settling now would open the terrain editor again.
      await create(project, false);
      still();
      if (!(await list(project.root)).includes(name)) throw new Error(`Not restored: the checkpoint ${name} is gone.`);
      // Asked already ("its files are replaced"), and what goes is in the checkpoint just made.
      await w3.commands.execute("w3.project.syncFromMap", inFolder(project.root, name), { replace: true });
    } finally {
      const n = (restoring.get(key) ?? 1) - 1;
      if (n > 0) restoring.set(key, n); else restoring.delete(key);
    }
  };

  const timer = setInterval(() => void tick().catch(() => {}), POLL);
  ctx.subscriptions.push(
    w3.mcp.registerTool("list_checkpoints", async () => {
      const project = w3.workspace.project();
      if (!project) throw new Error("No project is open in W3Proj Studio.");
      return newestFirst(await list(project.root)).map((c) => ({ name: c.name, at: new Date(c.time).toLocaleString() }));
    }),
    w3.mcp.registerTool("create_checkpoint", async () => {
      const project = w3.workspace.project();
      if (!project) throw new Error("No project is open in W3Proj Studio.");
      return { name: await create(project) };
    }),
    w3.mcp.registerTool("restore_checkpoint", async ({ name }) => {
      const project = w3.workspace.project();
      if (!project) throw new Error("No project is open in W3Proj Studio.");
      const found = newestFirst(await list(project.root)).find((c) => c.name === name);
      if (!found) throw new Error(`There's no checkpoint "${String(name)}". list_checkpoints gives them.`);
      const unsaved = w3.editors.unsavedPaths();
      if (unsaved.length) throw new Error(`Not restored: ${unsaved.join(", ")} ${unsaved.length === 1 ? "has" : "have"} unsaved changes. Ask the user to save or discard them first.`);
      const when = new Date(found.time).toLocaleString();
      if (!(await w3.window.confirm(`AI request: restore the map to the checkpoint of ${when}? Its files are replaced; a checkpoint of what's there now is made first.`, "Restore", 90_000))) {
        throw new Error("The user didn't confirm it in Studio, so nothing changed. Ask them before trying again.");
      }
      await settle();
      await w3.editors.closeAll();
      await restore(project, found.name);
      return `Restored the checkpoint of ${when}. undo_last_edit can't go back past this.`;
    }),
    { dispose: () => clearInterval(timer) },
    // `quiet` (other extensions, before something drastic): no message afterwards. Returns once a
    // checkpoint made for this call exists, also when an automatic one was running.
    w3.commands.register("w3.checkpoints.create", async (opts?: { quiet?: boolean }) => {
      const project = w3.workspace.project();
      if (!project) throw new Error("Open or import a project first.");
      if (!opts?.quiet) await w3.editors.saveAll();
      const name = await create(project);
      if (!opts?.quiet) void w3.window.showInfo(`Checkpoint saved: ${name}`);
    }),
    // For other extensions: the path of the newest checkpoint, null when there is none.
    w3.commands.register("w3.checkpoints.newest", async () => {
      const project = w3.workspace.project();
      const newest = project ? newestFirst(await list(project.root))[0] : undefined;
      return newest ? inFolder(project!.root, newest.name) : null;
    }),
    w3.commands.register("w3.checkpoints.restore", async () => {
      const project = w3.workspace.project();
      if (!project) throw new Error("Open or import a project first.");
      const all = newestFirst(await list(project.root));
      if (!all.length) { void w3.window.showInfo("This project has no checkpoints yet."); return; }
      const pick = await w3.window.quickPick(all.map((c) => ({ label: new Date(c.time).toLocaleString(), description: c.name, value: c.name })), { placeholder: "Restore the project to…" });
      if (!pick?.value) return;
      const c = await w3.window.showWarning(`Restore the project to ${pick.label}? Its map files are replaced by that version; a checkpoint of what's there now is made first. Unsaved edits are asked about.`, "Restore", "Cancel");
      if (c !== "Restore") return;
      await settle();
      if (!(await w3.editors.closeAllAsking())) return;
      await restore(project, pick.value);
    }),
  );
}
