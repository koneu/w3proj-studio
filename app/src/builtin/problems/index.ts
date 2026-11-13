// Problems: checks of the open project, like a compiler's errors and warnings
// (service "w3.problems"). Extensions register checks; the built-in ones look at
// the map script, file paths in object data, imported models' textures, placed
// objects and the import list. The side bar lists the result by check (click
// jumps to the place), the status bar shows the counts, and packing runs the
// checks first (map-project).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { PROBLEMS_SERVICE, type CheckedGroup, type Problem, type ProblemCheck, type ProblemsService } from "../../extensions/services";
import { copyButton, h } from "../../workbench/dom";
import { builtinChecks } from "./checks";
import { BONUS_QUEST_LIBRARY, aboutOf, emptyIgnore, IGNORE_FILE, isIgnored, parseIgnore, questLibraryOffered, serializeIgnore, withIgnored, withoutIgnored, type IgnoreFile } from "./ignore";
import { deleteInvalid } from "./invalid";
import { mapChecks } from "./mapchecks";
import { resultsStale } from "./projectkey";
import { RunScope } from "./runscope";

interface Group { check: ProblemCheck; problems: Problem[]; error?: string }

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const checks: ProblemCheck[] = [];
  let groups: Group[] = [];
  /** The project root the results are for. */
  let ranFor: string | null = null;
  let ran = false;
  /** The run going on: `root` is the project it checks, `adopted` whether its results became the
   *  shown ones (not when the project was closed or changed meanwhile). */
  let running: Promise<{ root: string | null; adopted: boolean; problems: Problem[]; ignored: number; ignoreError: string | null; checks: CheckedGroup[] }> | null = null;
  /** What the checks of the running run share; outside a run, nothing is shared. */
  let scope = new RunScope(w3, false);
  const folded = new Set<string>();
  /** The project's ignore (.w3proj/problems-ignore.json) as the last run read it; `ignoreBad` says why a file that
   *  is there can't be used (then nothing is hidden, and nothing is written over it). */
  let ignore: IgnoreFile = emptyIgnore();
  let ignoreBad: string | null = null;
  let showIgnored = false;
  /** Writes of the ignore file, one after the other. */
  let ignoreWrites: Promise<unknown> = Promise.resolve();
  const status = w3.statusBar.add({ id: "w3.problems.status", text: "", command: "w3.problems.show", align: "right", priority: 60 });
  ctx.subscriptions.push(status);

  const hidden = (g: Group, p: Problem) => !ignoreBad && isIgnored(ignore, g.check.id, aboutOf(p));
  const visible = (g: Group) => g.problems.filter((p) => !hidden(g, p));
  const all = () => groups.flatMap(visible);
  const ignoredCount = () => groups.reduce((n, g) => n + g.problems.length - visible(g).length, 0);
  /** Whether the file is there is asked of the disk (the file list can lag): absent is empty, unreadable is not. */
  const readIgnore = async (): Promise<{ file: IgnoreFile; bad: string | null }> => {
    try {
      const there = await w3.backend.invoke<boolean>("fs_exists", { path: w3.workspace.resolve(IGNORE_FILE) });
      if (!there) return { file: emptyIgnore(), bad: null };
      return { file: parseIgnore(await w3.workspace.readText(IGNORE_FILE)), bad: null };
    } catch (e) { return { file: emptyIgnore(), bad: `${IGNORE_FILE} is there but can't be used: ${String(e instanceof Error ? e.message : e)}` }; }
  };
  const updateStatus = () => {
    if (!ran || !w3.workspace.project()) { status.text = ""; return; }
    const errors = all().filter((p) => p.severity === "error").length, warnings = all().length - errors;
    status.text = `✕ ${errors}  ⚠ ${warnings}`;
    status.tooltip = "Problems of the project (click to show)";
  };

  const service: ProblemsService = {
    registerCheck(check) {
      checks.push(check);
      return { dispose: () => { const i = checks.indexOf(check); if (i >= 0) checks.splice(i, 1); } };
    },
    run() {
      return runCurrent().then((r) => r.problems);
    },
    runChecked() {
      return runCurrent().then((r) => ({ problems: r.problems, ignored: r.ignored, ignoreError: r.ignoreError, checks: r.checks }));
    },
    problems: all,
  };
  /** Starts a run, or joins the one going on (which may be for the project open when it started). */
  const start = () => {
    running ??= (async () => {
      const root = w3.workspace.project()?.root ?? null;
      if (!root) { groups = []; return { root, adopted: false, problems: [], ignored: 0, ignoreError: null, checks: [] }; }
      // The checks judge by the file list (an import whose file isn't there, files nothing lists): only once it has
      // every file. Right after an open each listed import would pass for missing, and a fix would drop it.
      await w3.workspace.filesReady();
      if (resultsStale(root, w3.workspace.project()?.root ?? null)) return { root, adopted: false, problems: [], ignored: 0, ignoreError: null, checks: [] };
      const result: Group[] = [];
      // What the built-in checks of this run share (each document read once); dropped when it ends.
      scope = new RunScope(w3);
      const loaded = await readIgnore();
      // One failing check doesn't stop the others.
      for (const check of [...checks]) {
        // Each check's time, as a User Timing measure ("problems:<id>"): DevTools and the bench read it.
        const started = performance.now();
        try { result.push({ check, problems: await check.run() }); } catch (e) {
          result.push({ check, problems: [], error: String(e instanceof Error ? e.message : e) });
        }
        performance.measure(`problems:${check.id}`, { start: started, end: performance.now() });
      }
      // The project was closed or changed while the checks ran: these results are not its own.
      if (resultsStale(root, w3.workspace.project()?.root ?? null)) return { root, adopted: false, problems: [], ignored: 0, ignoreError: null, checks: [] };
      groups = result;
      ignore = loaded.file;
      ignoreBad = loaded.bad;
      ranFor = root;
      ran = true;
      updateStatus();
      const byCheck = groups.map((g): CheckedGroup => {
        const shown = visible(g);
        return { id: g.check.id, title: g.check.title, problems: shown, ignored: g.problems.length - shown.length, ...(g.error ? { error: g.error } : {}) };
      });
      return { root, adopted: true, problems: all(), ignored: ignoredCount(), ignoreError: ignoreBad, checks: byCheck };
    })().finally(() => {
      // The run's documents aren't kept: the next run reads the files as they are then.
      scope = new RunScope(w3, false);
      // Redrawn once the run is over (its button shows "Checking…" while running).
      running = null;
      w3.views.refresh("w3.problems.list");
    });
    w3.views.refresh("w3.problems.list");
    return running;
  };
  /** A run for the project open now: the one going on may have been started for the project open
   *  before (its "nothing found" says nothing about this one, and Build would pack unchecked), so
   *  then a run of its own follows once that one is over. Its results are adopted only if the project
   *  stays open meanwhile. */
  /** A run that begins after this call: files changed just before it (a fix, a save) must be read by it. A run
   *  going on may have read them before, so the caller waits for it and a run of its own follows; callers meanwhile
   *  share that one. */
  let next: Promise<Awaited<ReturnType<typeof start>>> | null = null;
  const startAfter = () => {
    if (!running) return start();
    next ??= running.then(() => undefined, () => undefined).then(() => { next = null; return start(); });
    return next;
  };
  const runCurrent = async () => {
    for (let tries = 0; ; tries++) {
      const root = w3.workspace.project()?.root ?? null;
      const r = await startAfter();
      if (r.root === root || tries >= 2) return r;
    }
  };
  ctx.subscriptions.push(w3.services.provide(PROBLEMS_SERVICE, service));
  ctx.subscriptions.push(w3.mcp.registerTool("list_problems", async () => {
    const root = w3.workspace.project()?.root ?? null;
    if (!root) throw new Error("No project is open in W3Proj Studio.");
    const r = await runCurrent();
    // Not this project's results (it was closed or changed during the run): no answer, rather than "none".
    if (!r.adopted || r.root !== root || resultsStale(root, w3.workspace.project()?.root ?? null)) {
      throw new Error("The project changed while it was being checked; ask again once it stays open.");
    }
    const nIgnored = ignoredCount();
    const found = r.problems.map(({ severity, message, location }) => ({ severity, message, location }));
    // A check that failed found nothing, which isn't "no problems": say so (groups are this run's).
    const failed = groups.filter((g) => g.error);
    // Ignored reports are counted, not listed: the project's owner put them aside on purpose.
    const aside = nIgnored ? [{ severity: "warning" as const, message: `${nIgnored} report${nIgnored === 1 ? " is" : "s are"} ignored by the project (${IGNORE_FILE}) and not listed; there is nothing to fix in them.`, location: "Ignored reports", ignored: nIgnored }] : [];
    return [...failed.map((g) => ({ severity: "error" as const, message: `The check failed: ${g.error}`, location: g.check.title })), ...found, ...aside];
  }));
  for (const c of [...builtinChecks(w3, () => scope), ...mapChecks(w3, () => scope)]) ctx.subscriptions.push(service.registerCheck(c));

  /** Changes the ignore file: `change` gets the file as it is when its turn comes (writes go one after the other),
   *  and the project must still be the one asked about. */
  const changeIgnore = (change: (f: IgnoreFile) => IgnoreFile) => {
    const root = w3.workspace.project()?.root ?? null;
    const job = ignoreWrites.catch(() => undefined).then(async () => {
      if (!root || resultsStale(root, w3.workspace.project()?.root ?? null) || resultsStale(ranFor, root)) return;
      if (ignoreBad) throw new Error(ignoreBad);
      const next = change(ignore);
      await w3.workspace.writeText(IGNORE_FILE, serializeIgnore(next));
      if (resultsStale(root, w3.workspace.project()?.root ?? null)) return;
      ignore = next;
      updateStatus();
      w3.views.refresh("w3.problems.list");
    });
    ignoreWrites = job;
    return job;
  };
  const run = (f: () => Promise<unknown>) => () => { f().catch((e) => w3.window.showError(String(e instanceof Error ? e.message : e))); };
  ctx.subscriptions.push(
    w3.commands.register("w3.problems.run", async () => { await w3.views.show("problems"); await service.run(); }),
    w3.commands.register("w3.problems.show", async () => { await w3.views.show("problems"); if (!ran) await service.run(); }),
    w3.commands.register("w3.problems.deleteInvalid", async () => {
      if (await deleteInvalid(w3)) await service.run();
    }),
    w3.commands.register("w3.problems.toggleIgnored", () => { showIgnored = !showIgnored; w3.views.refresh("w3.problems.list"); }),
    w3.commands.register("w3.problems.open", async (path: string) => { await w3.editors.open(path); }),
    w3.workspace.onDidChange(() => {
      // Another map or project: the found problems of the previous one must not show.
      if (ran && resultsStale(ranFor, w3.workspace.project()?.root ?? null)) {
        ran = false; groups = []; ranFor = null;
        w3.views.refresh("w3.problems.list");
      }
      updateStatus();
    }),
    w3.views.register("w3.problems.list", {
      render(el) {
        if (!w3.workspace.project()) { el.append(h("div.view-empty", {}, "Open a project to check it.")); return; }
        const total = all(), errors = total.filter((p) => p.severity === "error").length;
        el.append(h("div.camp-side-actions", {},
          h("button", { disabled: !!running, onclick: run(() => service.run()) }, running ? "Checking…" : ran ? "Check again" : "Check now"),
          groups.some((g) => g.check.id === "placements" && g.problems.some((p) => / unknown object type /.test(p.message)))
            ? h("button", { title: "Removes placed objects whose type neither the game nor the map has. Start locations stay.", onclick: run(() => w3.commands.execute("w3.problems.deleteInvalid")) }, "Delete Invalid Objects…") : null,
          ran && !ignoreBad && questLibraryOffered(ignore, groups.flatMap((g) => visible(g).map((p) => ({ check: g.check.id, about: aboutOf(p) }))))
            ? h("button.problems-ignore-library", { title: "The Orc bonus chapters carry a quest library whose triggers nothing runs. Ignores these reports (here and in later runs); other triggers are still reported. Undo it from Show ignored.", onclick: run(() => changeIgnore((f) => ({ ...f, rules: [...f.rules, BONUS_QUEST_LIBRARY] }))) }, "Ignore the bonus campaign quest library") : null,
          ran && ignoredCount() ? h("button.problems-show-ignored", { title: "Lists the ignored reports too, each with an Un-ignore button", onclick: run(async () => { await w3.commands.execute("w3.problems.toggleIgnored"); }) }, `${showIgnored ? "Hide" : "Show"} ignored (${ignoredCount()})`) : null,
          h("span.muted.problems-summary", {}, ran ? (total.length ? ` ${errors} error${errors === 1 ? "" : "s"}, ${total.length - errors} warning${total.length - errors === 1 ? "" : "s"}` : " No problems found.") : "")));
        if (ran && ignoreBad) el.append(h("div.view-empty.problems-failed", {}, `${ignoreBad}. Nothing is hidden, and ignoring is off until it is fixed.`));
        if (!ran) {
          el.append(h("div.view-empty", {}, "Checks the map script, files used by object data, imported models' textures, placed objects and imports. Build runs them too."));
          return;
        }
        for (const g of groups) {
          const shown = showIgnored ? g.problems : visible(g);
          const n = visible(g).length;
          const fold = folded.has(g.check.id);
          el.append(h("div.camp-side-head.problems-head", { onclick: () => { if (fold) folded.delete(g.check.id); else folded.add(g.check.id); w3.views.refresh("w3.problems.list"); } },
            `${fold ? "▸" : "▾"} ${g.check.title}`, h("small", {}, g.error ? " (failed)" : ` ${n}`)));
          if (fold) continue;
          if (g.error) { el.append(h("div.view-empty.problems-failed", {}, `The check failed: ${g.error} `, copyButton(`${g.check.title}: the check failed: ${g.error}`))); continue; }
          if (!shown.length) { el.append(h("div.view-empty", {}, "OK")); continue; }
          const ignorable = (p: Problem) => !ignoreBad && !!(p.about || p.location);
          el.append(h("div.tree", {}, ...shown.map((p) => h(`div.problem-row.${p.severity}${p.reveal ? ".clickable" : ""}${hidden(g, p) ? ".ignored" : ""}`, {
            title: [p.message, p.location].filter(Boolean).join("\n"),
            onclick: p.reveal ? run(() => w3.commands.execute(p.reveal!.command, ...(p.reveal!.args ?? []))) : undefined,
          }, h("span.problem-icon", {}, p.severity === "error" ? "✕" : "⚠"),
            h("span.problem-text", {}, p.message, p.location ? h("small.muted", {}, ` ${p.location}`) : null,
              ...(p.fixes?.length ? [h("span.problem-fixes", {}, ...p.fixes.map((f) => h("button.problem-fix", {
                title: f.title ?? "",
                onclick: (e: MouseEvent) => { e.stopPropagation(); run(async () => { await f.run(); await service.run(); })(); },
              }, f.label)))] : []),
              hidden(g, p)
                ? h("span.problem-fixes", {}, h("button.problem-fix.problem-unignore", {
                  title: "Reports it again",
                  onclick: (e: MouseEvent) => { e.stopPropagation(); run(() => changeIgnore((f) => withoutIgnored(f, g.check.id, aboutOf(p), g.problems.map(aboutOf))))(); },
                }, "Un-ignore"))
                : ignorable(p) ? h("span.problem-fixes", {},
                  h("button.problem-fix.problem-ignore", {
                    title: "Stops reporting this (it is kept in the project's .w3proj/problems-ignore.json)",
                    onclick: (e: MouseEvent) => { e.stopPropagation(); run(() => changeIgnore((f) => withIgnored(f, g.check.id, [aboutOf(p)])))(); },
                  }, "Ignore"),
                  n > 1 ? h("button.problem-fix.problem-ignore-all", {
                    title: `Ignores all ${n} reports of "${g.check.title}" now listed`,
                    onclick: (e: MouseEvent) => { e.stopPropagation(); run(() => changeIgnore((f) => withIgnored(f, g.check.id, visible(g).filter(ignorable).map(aboutOf))))(); },
                  }, "Ignore all like this") : null) : null)))));
        }
      },
    }),
  );
}
