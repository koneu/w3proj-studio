import type { ExtensionContext, W3Api } from "../../extensions/api";
import { PROBLEMS_SERVICE, type ProblemsService } from "../../extensions/services";

interface UnpackReport {
  files: { archive_name: string; codec?: string; note?: string }[];
  unnamed: string[];
  errors: [string, string][];
  written: number;
  deleted: number;
  unchanged: number;
}

interface PackReport {
  output: string;
  files: number;
  bytes: number;
}

const MAP_FILTERS = [{ name: "Warcraft III map or campaign", extensions: ["w3x", "w3m", "w3n"] }];

function baseName(p: string) {
  return p.split(/[\\/]/).pop()!.replace(/\.(w3x|w3m|w3n)$/i, "");
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const out = w3.output.channel("Project");
  const projectItem = w3.statusBar.add({ id: "w3.project.name", text: "", command: "w3.project.reveal", priority: 100 });
  const weItem = w3.statusBar.add({ id: "w3.project.we", text: "", tooltip: "World Editor is open; saves sync into the project", align: "right", priority: 50 });
  // The release step on screen (not only in the command palette): pack, and pack + start the game.
  const buildItem = w3.statusBar.add({ id: "w3.project.build", text: "", command: "w3.project.pack", priority: 99 });
  const testItem = w3.statusBar.add({ id: "w3.project.test", text: "", command: "w3.project.testMap", priority: 98 });
  ctx.subscriptions.push(projectItem, weItem, buildItem, testItem);

  const root = () => {
    const p = w3.workspace.project();
    if (!p) throw new Error("Open or import a project first.");
    return p.root;
  };

  const updateStatus = () => {
    const p = w3.workspace.project();
    projectItem.text = p ? `◈ ${p.name.replace(/\|c[0-9a-f]{8}|\|r/gi, "")}` : "";
    projectItem.tooltip = p?.root ?? "";
    buildItem.text = p ? "⬇ Build" : "";
    buildItem.tooltip = p ? `Pack the project into ${p.default_output} (Ctrl+Shift+B)` : "";
    testItem.text = p ? "▶ Test" : "";
    testItem.tooltip = p ? "Pack and start Warcraft III with the map (Ctrl+F5)" : "";
  };
  ctx.subscriptions.push(w3.workspace.onDidChange(updateStatus));

  const logReport = (title: string, r: UnpackReport) => {
    out.append(`${title}: ${r.files.length} files (${r.files.filter((f) => f.codec).length} via codecs) — ${r.written} written, ${r.unchanged} unchanged, ${r.deleted} deleted`);
    for (const f of r.files.filter((f) => f.note)) out.append(`  stored raw: ${f.archive_name} (${f.note})`);
    for (const f of r.unnamed) out.append(`  unnamed (not packed): ${f}`);
    for (const [f, e] of r.errors) out.append(`  unreadable: ${f}: ${e}`);
  };

  /** Unpacks, asking before writing an incomplete (protected) map. */
  const unpack = async (map: string, dir: string, title: string): Promise<UnpackReport | null> => {
    const run = (allowIncomplete: boolean) =>
      w3.window.withProgress(title, () => w3.backend.invoke<UnpackReport>("project_unpack", { map, dir, allowIncomplete, install: w3.settings.get<string>("game.installDir") }));
    try {
      return await run(false);
    } catch (e) {
      const msg = String(e);
      if (!msg.startsWith("INCOMPLETE")) throw e;
      const choice = await w3.window.showWarning(
        `${msg.replace("INCOMPLETE: ", "")}. Those files can't be packed back. Continue anyway?`,
        "Continue",
        "Cancel",
      );
      return choice === "Continue" ? run(true) : null;
    }
  };

  /** `check`: run the Problems checks first and ask before packing a map with errors. */
  const pack = async (output: string | null, check = false): Promise<PackReport | null> => {
    // What's open in editors goes into the build too.
    const saved = await w3.editors.saveAll();
    if (saved) out.append(`saved ${saved} editor${saved === 1 ? "" : "s"} before packing`);
    if (check) {
      const problems = await w3.services.get<ProblemsService>(PROBLEMS_SERVICE).catch(() => null);
      const found = problems ? await w3.window.withProgress("Checking for problems", () => problems.run()) : [];
      const errors = found.filter((p) => p.severity === "error").length;
      if (found.length) out.append(`problems before packing: ${errors} errors, ${found.length - errors} warnings`);
      if (errors) {
        const c = await w3.window.showWarning(`The map has ${errors} error${errors === 1 ? "" : "s"} (see Problems). Pack anyway?`, "Pack anyway", "Show Problems", "Cancel");
        if (c === "Show Problems") await w3.commands.execute("w3.problems.show");
        if (c !== "Pack anyway") return null;
      }
    }
    const r = await w3.window.withProgress("Packing map", () => w3.backend.invoke<PackReport>("project_pack", { root: root(), output }));
    out.append(`packed ${r.files} files, ${r.bytes} bytes → ${r.output}`);
    return r;
  };

  const sync = async (map: string) => {
    const r = await unpack(map, root(), "Syncing from map");
    if (!r) return;
    logReport(`synced from ${map}`, r);
    if (r.written + r.deleted > 0) await w3.editors.closeAll();
    await w3.workspace.refresh();
    w3.window.showInfo(r.written + r.deleted ? `Project synced: ${r.written} files updated, ${r.deleted} removed.` : "Project already up to date.");
  };

  const editBuild = () => {
    const p = w3.workspace.project()!;
    return `${p.root}\\build\\${baseName(p.root)}.edit.w3x`;
  };

  ctx.subscriptions.push(
    w3.commands.register("w3.project.open", async (path?: string) => {
      path ??= (await w3.window.pickFolder({ title: "Open map project folder" })) ?? undefined;
      if (!path) return;
      if (!(await w3.editors.closeAllAsking())) return;
      await w3.workspace.open(path);
      out.append(`opened ${path}`);
    }),

    // `file`: the map or campaign to import (else asked for).
    w3.commands.register("w3.project.importMap", async (file?: string) => {
      const map = typeof file === "string" && file ? file : await w3.window.pickFile({ title: "Choose a map to import", filters: MAP_FILTERS });
      if (!map) return;
      const parent = await w3.window.pickFolder({ title: "Choose where to create the project folder" });
      if (!parent) return;
      const name = await w3.window.inputBox({ prompt: "Project folder name", value: baseName(map).replace(/[^\w\- .()]/g, "_") });
      if (!name) return;
      const dir = `${parent.replace(/[\\/]$/, "")}\\${name}`;
      if (await w3.backend.invoke<boolean>("fs_exists", { path: `${dir}\\w3proj.toml` })) {
        const c = await w3.window.showWarning(`${dir} already is a project. Overwrite its map files with ${baseName(map)}?`, "Overwrite", "Cancel");
        if (c !== "Overwrite") return;
      }
      // The new project replaces the open one: unsaved changes are settled first.
      if (!(await w3.editors.closeAllAsking())) return;
      const r = await unpack(map, dir, "Importing map");
      if (!r) return;
      logReport(`imported ${map} → ${dir}`, r);
      await w3.workspace.open(dir);
      const unnamed = r.unnamed.length ? ` ${r.unnamed.length} unnamed files were saved to unnamed/ but won't be packed.` : "";
      w3.window.showInfo(`Imported ${r.files.length} files into ${dir}.${unnamed}`);
    }),

    // `file`: the map to sync from (else asked for).
    w3.commands.register("w3.project.syncFromMap", async (file?: string) => {
      root();
      const map = typeof file === "string" && file ? file : await w3.window.pickFile({ title: "Sync project from map", filters: MAP_FILTERS });
      if (map) await sync(map);
    }),

    w3.commands.register("w3.project.pack", async () => {
      const r = await pack(null, true);
      if (!r) return;
      const c = await w3.window.showInfo(`Packed ${r.files} files → ${r.output}`, "Reveal");
      if (c === "Reveal") await w3.backend.invoke("reveal_in_explorer", { path: r.output });
    }),

    w3.commands.register("w3.project.packAs", async () => {
      const p = w3.workspace.project();
      if (!p) throw new Error("Open or import a project first.");
      const target = await w3.window.pickSaveFile({ title: "Pack map as", defaultPath: p.default_output, filters: MAP_FILTERS });
      if (!target) return;
      const r = await pack(target, true);
      if (!r) return;
      w3.window.showInfo(`Packed ${r.files} files → ${r.output}`);
    }),

    w3.commands.register("w3.project.openInWorldEditor", async () => {
      root();
      const exe = w3.settings.get<string>("worldEditor.path");
      const map = editBuild();
      await pack(map);
      await w3.backend.invoke("world_editor_open", { exe, map, root: root() });
      out.append(`World Editor opened ${map}; saving there syncs back into the project`);
      weItem.text = "● World Editor";
      w3.window.showInfo("Opened in the World Editor. Save there (Ctrl+S) and the project is updated.");
    }),

    w3.commands.register("w3.project.testMap", async () => {
      const r = await pack(null, true);
      if (!r) return;
      await w3.backend.invoke("game_test_map", { exe: w3.settings.get<string>("game.path"), map: r.output });
      out.append(`launched game with ${r.output}`);
    }),

    w3.commands.register("w3.project.reveal", async () => {
      await w3.backend.invoke("reveal_in_explorer", { path: root() });
    }),

    w3.commands.register("w3.project.showManifest", async () => {
      root();
      await w3.editors.open("w3proj.toml");
    }),

    w3.commands.register("w3.project.close", async () => {
      if (!(await w3.editors.closeAllAsking())) return;
      w3.workspace.close();
      await w3.editors.open("w3:welcome");
    }),
  );

  // Saves made in the World Editor flow back into the project.
  w3.backend
    .listen<{ map: string; root: string }>("w3://map-saved", async ({ map, root: r }) => {
      const p = w3.workspace.project();
      if (!p || p.root !== r) return;
      out.append(`World Editor saved ${map}`);
      const mode = w3.settings.get<string>("project.syncOnWorldEditorSave", "ask");
      if (mode === "never") return;
      if (mode === "ask") {
        const c = await w3.window.showInfo("The World Editor saved the map. Sync changes into the project?", "Sync", "Always", "Not now");
        if (c === "Always") await w3.settings.set("project.syncOnWorldEditorSave", "always");
        if (c !== "Sync" && c !== "Always") return;
      }
      await sync(map).catch((e) => w3.window.showError(`Sync failed: ${e}`));
    })
    .then((d) => ctx.subscriptions.push(d));
  w3.backend
    .listen<{ map: string }>("w3://world-editor-exited", ({ map }) => {
      out.append(`World Editor closed (${map})`);
      weItem.text = "";
    })
    .then((d) => ctx.subscriptions.push(d));

  // Reopen the last project (the workbench restores its tabs; the welcome page goes).
  const last = w3.settings.get<string[]>("recentProjects", [])[0];
  if (last) {
    w3.workspace.open(last).then(
      async () => {
        await w3.editors.close("w3:welcome");
        out.append(`reopened ${last}`);
      },
      () => out.append(`could not reopen ${last}`),
    );
  }
  updateStatus();
}
