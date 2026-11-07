// Checkpoints: while a project has saved changes it's packed into build/checkpoints every few
// minutes (git-ignored, like all of build/), so a bug or a slip costs minutes at worst, also in
// projects without git. Unsaved edits aren't included: saving them behind the user's back would
// run everything that follows a save (the map script, for one).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { checkpointName, checkpointState, newestFirst, toPrune } from "./checkpoints";

const FOLDER = "build/checkpoints";
/** How often the state is looked at; the setting decides when a checkpoint is made. */
const POLL = 20_000;

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const out = w3.output.channel("Project");
  let busy = false;
  /** Projects told that their automatic checkpoints fail. */
  const warned = new Set<string>();

  const list = async (root: string) => w3.workspace.listFolder(`${root}\\build\\checkpoints`).catch(() => [] as string[]);

  /** Pathing, shadows and the minimap still due from a terrain edit belong in a checkpoint. A failure never stops one. */
  const settle = () => w3.commands.execute("w3.terrain.settle").catch(() => {});

  /** Packs the project as it is on disk; the file's name, or null when one is being made. `settleFirst`: the
   *  rebuild due from an edit is done before (the automatic ones don't wait for it). */
  const create = async (settleFirst = true): Promise<string | null> => {
    const project = w3.workspace.project();
    if (!project || busy) return null;
    busy = true;
    try {
      if (settleFirst) await settle();
      const name = checkpointName(project.default_output, new Date());
      const target = `${project.root}\\build\\checkpoints\\${name}`;
      await w3.backend.invoke("project_pack", { root: project.root, output: target });
      const keep = w3.settings.get<number>("checkpoints.keep") ?? 10;
      const old = toPrune(await list(project.root), keep);
      // The project may have been changed meanwhile: its own root, not the current one.
      for (const f of old) await w3.backend.invoke("fs_delete", { root: project.root, path: `${project.root}\\build\\checkpoints\\${f}` });
      out.append(`checkpoint ${name}${old.length ? ` (${old.length} old one${old.length === 1 ? "" : "s"} removed)` : ""}`);
      return name;
    } finally {
      busy = false;
    }
  };

  const tick = async () => {
    const project = w3.workspace.project();
    if (!project || busy || w3.settings.get<boolean>("checkpoints.enabled") === false) return;
    const minutes = w3.settings.get<number>("checkpoints.intervalMinutes") ?? 5;
    const megabytes = w3.settings.get<number>("checkpoints.maxMegabytes") ?? 500;
    const newest = newestFirst(await list(project.root))[0]?.time ?? null;
    if (checkpointState(w3.workspace.files(), newest, Date.now(), minutes * 60_000, megabytes * 1024 * 1024) !== "due") return;
    await create(false).catch((e) => {
      out.append(`checkpoint failed: ${String(e)}`);
      if (warned.has(project.root)) return;
      warned.add(project.root);
      void w3.window.showWarning(`Automatic checkpoints of this project fail: ${String(e)}`);
    });
  };

  /** Replaces the project's map files with a checkpoint's; what's there now is kept as one first. */
  const restore = async (root: string, name: string) => {
    // Settled by the caller, before the editors closed: settling now would open the terrain editor again.
    await create(false);
    await w3.commands.execute("w3.project.syncFromMap", `${root}\\${FOLDER.replace("/", "\\")}\\${name}`);
  };

  const timer = setInterval(() => void tick().catch(() => {}), POLL);
  ctx.subscriptions.push(
    w3.mcp.registerTool("list_checkpoints", async () => {
      const project = w3.workspace.project();
      if (!project) throw new Error("No project is open in W3Proj Studio.");
      return newestFirst(await list(project.root)).map((c) => ({ name: c.name, at: new Date(c.time).toLocaleString() }));
    }),
    w3.mcp.registerTool("create_checkpoint", async () => {
      if (!w3.workspace.project()) throw new Error("No project is open in W3Proj Studio.");
      return { name: await create() };
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
      await restore(project.root, found.name);
      return `Restored the checkpoint of ${when}. undo_last_edit can't go back past this.`;
    }),
    { dispose: () => clearInterval(timer) },
    // `quiet` (other extensions, before something drastic): no message afterwards.
    w3.commands.register("w3.checkpoints.create", async (opts?: { quiet?: boolean }) => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      if (!opts?.quiet) await w3.editors.saveAll();
      const name = await create();
      if (name && !opts?.quiet) void w3.window.showInfo(`Checkpoint saved: ${name}`);
    }),
    // For other extensions: the path of the newest checkpoint, null when there is none.
    w3.commands.register("w3.checkpoints.newest", async () => {
      const project = w3.workspace.project();
      const newest = project ? newestFirst(await list(project.root))[0] : undefined;
      return newest ? `${project!.root}\\build\\checkpoints\\${newest.name}` : null;
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
      await restore(project.root, pick.value);
    }),
  );
}
