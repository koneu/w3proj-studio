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

  /** Packs the project as it is on disk; the file's name, or null when one is being made. */
  const create = async (): Promise<string | null> => {
    const project = w3.workspace.project();
    if (!project || busy) return null;
    busy = true;
    try {
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
    await create().catch((e) => {
      out.append(`checkpoint failed: ${String(e)}`);
      if (warned.has(project.root)) return;
      warned.add(project.root);
      void w3.window.showWarning(`Automatic checkpoints of this project fail: ${String(e)}`);
    });
  };

  const timer = setInterval(() => void tick().catch(() => {}), POLL);
  ctx.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    // `quiet` (other extensions, before something drastic): no message afterwards.
    w3.commands.register("w3.checkpoints.create", async (opts?: { quiet?: boolean }) => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      if (!opts?.quiet) await w3.editors.saveAll();
      const name = await create();
      if (name && !opts?.quiet) void w3.window.showInfo(`Checkpoint saved: ${name}`);
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
      if (!(await w3.editors.closeAllAsking())) return;
      await create();
      await w3.commands.execute("w3.project.syncFromMap", `${project.root}\\${FOLDER.replace("/", "\\")}\\${pick.value}`);
    }),
  );
}
