import type { ExtensionContext, W3Api } from "../../extensions/api";
import { PROBLEMS_SERVICE, type ProblemsService } from "../../extensions/services";
import { gameProgram, joinPath, onWindows } from "../../lib/paths";
import { testMapArgs, testMapOptions } from "./testmap";
import { checkOpenedProject, offerStrayMoves } from "./strays";
import { deleteQuestion, wouldDelete } from "../../lib/syncdeletes";

interface UnpackReport {
  files: { archive_name: string; codec?: string; note?: string }[];
  unnamed: string[];
  errors: [string, string][];
  written: number;
  deleted: number;
  unchanged: number;
  /** Files with a "\" in their name that the sync left alone (from the project root). */
  strays?: string[];
}

interface PackReport {
  output: string;
  files: number;
  bytes: number;
}

const MAP_FILTERS = [{ name: "Warcraft III map or campaign", extensions: ["w3x", "w3m", "w3n"] }];

function baseName(p: string) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop()!.replace(/\.(w3x|w3m|w3n)$/i, "");
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

  // A project just opened is looked at once: stray files of an older version, map files that differ only in case.
  let checkedRoot: string | null = null;
  const checkOpened = () => {
    const root = w3.workspace.project()?.root ?? null;
    if (root === checkedRoot) return;
    checkedRoot = root;
    if (root) void checkOpenedProject(w3, root, out).catch((e) => out.append(`could not look at ${root}: ${e instanceof Error ? e.message : String(e)}`));
  };
  ctx.subscriptions.push(w3.workspace.onDidChange(checkOpened));
  checkOpened();

  const logReport = (title: string, r: UnpackReport) => {
    out.append(`${title}: ${r.files.length} files (${r.files.filter((f) => f.codec).length} via codecs) — ${r.written} written, ${r.unchanged} unchanged, ${r.deleted} deleted`);
    for (const f of r.files.filter((f) => f.note)) out.append(`  stored raw: ${f.archive_name} (${f.note})`);
    for (const f of r.unnamed) out.append(`  unnamed (not packed): ${f}`);
    for (const [f, e] of r.errors) out.append(`  unreadable: ${f}: ${e}`);
    for (const f of r.strays ?? []) out.append(`  kept (a "\\" in the name, not deleted): ${f}`);
  };

  /** Unpacks, asking before writing an incomplete (protected) map, and with `askDeletes` before deleting files of the
   *  project the map doesn't have (the backend then writes nothing until the answer). */
  const unpack = async (map: string, dir: string, title: string, askDeletes = false): Promise<UnpackReport | null> => {
    let allowIncomplete = false, refuseDeletes = askDeletes;
    for (;;) {
      try {
        return await w3.window.withProgress(title, () => w3.backend.invoke<UnpackReport>("project_unpack", {
          map, dir, allowIncomplete, refuseDeletes, install: w3.settings.get<string>("game.installDir"),
        }));
      } catch (e) {
        const msg = String(e);
        const gone = wouldDelete(e);
        if (gone && refuseDeletes) {
          out.append(`syncing from ${map} would remove ${gone.length} files:`);
          for (const g of gone) out.append(`  ${g}`);
          const q = deleteQuestion(gone, baseName(map));
          const choice = await w3.window.showWarning(q.message, ...q.actions);
          if (choice === "Show list") out.show();
          if (choice !== q.actions[0]) return null;
          refuseDeletes = false;
        } else if (msg.startsWith("INCOMPLETE") && !allowIncomplete) {
          const choice = await w3.window.showWarning(
            `${msg.replace("INCOMPLETE: ", "")}. Those files can't be packed back. Continue anyway?`,
            "Continue",
            "Cancel",
          );
          if (choice !== "Continue") return null;
          allowIncomplete = true;
        } else throw e;
      }
    }
  };

  /** `check`: run the Problems checks first and ask before packing a map with errors. */
  const pack = async (output: string | null, check = false): Promise<PackReport | null> => {
    // What's open in editors goes into the build too.
    const saved = await w3.editors.saveAll();
    if (saved) out.append(`saved ${saved} editor${saved === 1 ? "" : "s"} before packing`);
    // The script follows saves a moment later; it has to be in this build. (The extension can be off.)
    await w3.commands.execute("w3.script.settle").catch(() => {});
    // Likewise pathing, shadows and the minimap, which follow a terrain edit a few seconds later.
    await w3.commands.execute("w3.terrain.settle").catch(() => {});
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

  /** `askDeletes`: ask before removing files the map doesn't have (not when the user agreed to replace them already,
   *  as for restoring a checkpoint). */
  const sync = async (map: string, askDeletes = true) => {
    const dir = root();
    const r = await unpack(map, dir, "Syncing from map", askDeletes);
    if (!r) return;
    logReport(`synced from ${map}`, r);
    const rewritten = r.written + r.deleted > 0;
    if (rewritten) await w3.editors.closeAll();
    await w3.workspace.refresh();
    // The tabs come back with the files as synced (those of files the map doesn't have stay away); not into another
    // project opened meanwhile, whose own tabs come back as it opens.
    if (rewritten && w3.workspace.project()?.root === dir) await w3.editors.restore().catch((e) => out.append(`could not open the tabs again: ${e}`));
    // A script the map brought that Studio would write the same is Studio's: saves go on regenerating it. (The
    // extension can be off.)
    await w3.commands.execute("w3.script.adopt").catch(() => {});
    w3.window.showInfo(r.written + r.deleted ? `Project synced: ${r.written} files updated, ${r.deleted} removed.` : "Project already up to date.");
    // Files with a "\" in their name the sync left alone: offered to be moved where they belong.
    if (r.strays?.length) await offerStrayMoves(w3, dir, out);
  };

  const installDir = () => w3.settings.get<string>("game.installDir") ?? "C:\\Program Files (x86)\\Warcraft III";

  /** A program of the game: as set, else the one in game.installDir. Read through `get`, which takes these from the
   *  user's settings only: a project (shared through git or a zip) must never choose a program to run. */
  const program = (key: string, file: string) =>
    gameProgram(w3.settings.get<string>(key), installDir(), file);

  /** The game would just stay in its main menu, with nothing to say why. */
  const needStartLocation = async () => {
    const units = await w3.workspace.readText("map/war3mapUnits.doo.json").catch(() => null);
    if (units !== null && !units.includes('"sloc"')) {
      throw new Error("This map has no start location, so the game can't start it. Place one, or save in the terrain view, which adds Player 1's.");
    }
  };

  /** Packs into the game's own Maps folder (in Documents; under Proton, the prefix's), in a "w3proj" folder there,
   *  so the map can be started from the game's Custom Game when Test Map can't start it directly. */
  const packToGame = async () => {
    const p = w3.workspace.project();
    if (!p) throw new Error("Open or import a project first.");
    await needStartLocation();
    const maps = await w3.backend.invoke<string>("game_maps_folder", { install: installDir() });
    const name = p.default_output.split(/[\\/]/).pop() || `${baseName(p.root)}.w3x`;
    const r = await pack(joinPath(maps, "w3proj", name), true);
    if (!r) return;
    const c = await w3.window.showInfo(`Packed into the game's maps: ${r.output}. In Warcraft III, start it from Custom Game (folder "w3proj").`, "Reveal");
    if (c === "Reveal") await w3.backend.invoke("reveal_in_explorer", { path: r.output });
  };

  const editBuild = () => {
    const p = w3.workspace.project()!;
    return joinPath(p.root, "build", `${baseName(p.root)}.edit.w3x`);
  };

  /** A map, campaign or map folder into a new project folder (the backend tells a folder by itself). */
  const importMap = async (map: string) => {
    const parent = await w3.window.pickFolder({ title: "Choose where to create the project folder" });
    if (!parent) return;
    const name = await w3.window.inputBox({ prompt: "Project folder name", value: baseName(map).replace(/[^\w\- .()]/g, "_") });
    if (!name) return;
    const dir = joinPath(parent, name);
    if (await w3.backend.invoke<boolean>("fs_exists", { path: joinPath(dir, "w3proj.toml") })) {
      const c = await w3.window.showWarning(`${dir} already is a project. Overwrite its map files with ${baseName(map)}?`
        + ` Files under map/ that ${baseName(map)} doesn't have are removed.`, "Overwrite", "Cancel");
      if (c !== "Overwrite") return;
    }
    // The new project replaces the open one: unsaved changes are settled first.
    if (!(await w3.editors.closeAllAsking())) return;
    const r = await unpack(map, dir, "Importing map");
    if (!r) return;
    logReport(`imported ${map} → ${dir}`, r);
    // Opening another project looks for its stray files anyway; the open one is looked at again here.
    const wasOpen = w3.workspace.project()?.root === dir;
    await w3.workspace.open(dir);
    if (wasOpen && r.strays?.length) void offerStrayMoves(w3, dir, out);
    const unnamed = r.unnamed.length ? ` ${r.unnamed.length} unnamed files were saved to unnamed/ but won't be packed.` : "";
    w3.window.showInfo(`Imported ${r.files.length} files into ${dir}.${unnamed}`);
  };

  ctx.subscriptions.push(
    w3.commands.register("w3.project.open", async (path?: string) => {
      path ??= (await w3.window.pickFolder({ title: "Open map project folder" })) ?? undefined;
      if (!path) return;
      if (!(await w3.editors.closeAllAsking())) return;
      await w3.workspace.open(path);
      out.append(`opened ${path}`);
    }),

    // `file`: the map or campaign to import (else asked for); a map folder works too.
    w3.commands.register("w3.project.importMap", async (file?: string) => {
      const map = typeof file === "string" && file ? file : await w3.window.pickFile({ title: "Choose a map to import", filters: MAP_FILTERS });
      if (map) await importMap(map);
    }),

    // `folder`: a map saved as a folder (the World Editor's "Warcraft III Scenario Folder"), else asked for.
    w3.commands.register("w3.project.importMapFolder", async (folder?: string) => {
      const map = typeof folder === "string" && folder ? folder : await w3.window.pickFolder({ title: "Choose a map folder (loose war3map.* files) to import" });
      if (map) await importMap(map);
    }),
  );

  ctx.subscriptions.push(
    // `file`: the map to sync from (else asked for). `opts.replace`: the user agreed already that the project's map
    // files are replaced (restoring a checkpoint), so files the map doesn't have are removed without asking.
    w3.commands.register("w3.project.syncFromMap", async (file?: string, opts?: { replace?: boolean }) => {
      root();
      const map = typeof file === "string" && file ? file : await w3.window.pickFile({ title: "Sync project from map", filters: MAP_FILTERS });
      if (map) await sync(map, opts?.replace !== true);
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
      const exe = program("worldEditor.path", "World Editor.exe");
      const map = editBuild();
      await pack(map);
      await w3.backend.invoke("world_editor_open", { exe, map, root: root() });
      out.append(`World Editor opened ${map}; saving there syncs back into the project`);
      weItem.text = "● World Editor";
      w3.window.showInfo("Opened in the World Editor. Save there (Ctrl+S) and the project is updated.");
    }),

    w3.commands.register("w3.project.testMap", async () => {
      await needStartLocation();
      // The options are read before packing, so a wrong one stops before anything is written.
      const args = testMapArgs(testMapOptions(w3.settings));
      const r = await pack(null, true);
      if (!r) return;
      await w3.backend.invoke("game_test_map", { exe: program("game.path", "Warcraft III.exe"), map: r.output, args });
      out.append(`launched game with ${r.output} (${args.join(" ")})`);
      // Under Proton the game's own login can stay invisible, and then the game never gets past its first screen.
      if (!onWindows()) {
        const c = await w3.window.showInfo("Warcraft III is starting. If it stays on its first screen (its login can stay hidden under Proton), pack the map into the game's Maps folder and start it from Custom Game.", "Pack into Game's Maps");
        if (c === "Pack into Game's Maps") await packToGame();
      }
    }),

    w3.commands.register("w3.project.packToGame", packToGame),

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
