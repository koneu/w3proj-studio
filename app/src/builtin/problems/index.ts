// Problems: checks of the open project, like a compiler's errors and warnings
// (service "w3.problems"). Extensions register checks; the built-in ones look at
// the map script, file paths in object data, imported models' textures, placed
// objects and the import list. The side bar lists the result by check (click
// jumps to the place), the status bar shows the counts, and packing runs the
// checks first (map-project).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { PROBLEMS_SERVICE, type Problem, type ProblemCheck, type ProblemsService } from "../../extensions/services";
import { copyButton, h } from "../../workbench/dom";
import { builtinChecks } from "./checks";
import { deleteInvalid } from "./invalid";
import { mapChecks } from "./mapchecks";

interface Group { check: ProblemCheck; problems: Problem[]; error?: string }

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const checks: ProblemCheck[] = [];
  let groups: Group[] = [];
  let ran = false, running: Promise<Problem[]> | null = null;
  const folded = new Set<string>();
  const status = w3.statusBar.add({ id: "w3.problems.status", text: "", command: "w3.problems.show", align: "right", priority: 60 });
  ctx.subscriptions.push(status);

  const all = () => groups.flatMap((g) => g.problems);
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
      running ??= (async () => {
        if (!w3.workspace.project()) { groups = []; return []; }
        const result: Group[] = [];
        // One failing check doesn't stop the others.
        for (const check of [...checks]) {
          try { result.push({ check, problems: await check.run() }); } catch (e) {
            result.push({ check, problems: [], error: String(e instanceof Error ? e.message : e) });
          }
        }
        groups = result;
        ran = true;
        updateStatus();
        return all();
      })().finally(() => {
        // Redrawn once the run is over (its button shows "Checking…" while running).
        running = null;
        w3.views.refresh("w3.problems.list");
      });
      w3.views.refresh("w3.problems.list");
      return running;
    },
    problems: all,
  };
  ctx.subscriptions.push(w3.services.provide(PROBLEMS_SERVICE, service));
  ctx.subscriptions.push(w3.mcp.registerTool("list_problems", async () => {
    if (!w3.workspace.project()) throw new Error("No project is open in W3Proj Studio.");
    return (await service.run()).map(({ severity, message, location }) => ({ severity, message, location }));
  }));
  for (const c of [...builtinChecks(w3), ...mapChecks(w3)]) ctx.subscriptions.push(service.registerCheck(c));

  const run = (f: () => Promise<unknown>) => () => { f().catch((e) => w3.window.showError(String(e instanceof Error ? e.message : e))); };
  ctx.subscriptions.push(
    w3.commands.register("w3.problems.run", async () => { await w3.views.show("problems"); await service.run(); }),
    w3.commands.register("w3.problems.show", async () => { await w3.views.show("problems"); if (!ran) await service.run(); }),
    w3.commands.register("w3.problems.deleteInvalid", async () => {
      if (await deleteInvalid(w3)) await service.run();
    }),
    w3.commands.register("w3.problems.open", async (path: string) => { await w3.editors.open(path); }),
    w3.workspace.onDidChange(() => { if (!w3.workspace.project()) { ran = false; groups = []; } updateStatus(); }),
    w3.views.register("w3.problems.list", {
      render(el) {
        if (!w3.workspace.project()) { el.append(h("div.view-empty", {}, "Open a project to check it.")); return; }
        const total = all(), errors = total.filter((p) => p.severity === "error").length;
        el.append(h("div.camp-side-actions", {},
          h("button", { disabled: !!running, onclick: run(() => service.run()) }, running ? "Checking…" : ran ? "Check again" : "Check now"),
          groups.some((g) => g.check.id === "placements" && g.problems.some((p) => / unknown object type /.test(p.message)))
            ? h("button", { title: "Removes placed objects whose type neither the game nor the map has. Start locations stay.", onclick: run(() => w3.commands.execute("w3.problems.deleteInvalid")) }, "Delete Invalid Objects…") : null,
          h("span.muted.problems-summary", {}, ran ? (total.length ? ` ${errors} error${errors === 1 ? "" : "s"}, ${total.length - errors} warning${total.length - errors === 1 ? "" : "s"}` : " No problems found.") : "")));
        if (!ran) {
          el.append(h("div.view-empty", {}, "Checks the map script, files used by object data, imported models' textures, placed objects and imports. Build runs them too."));
          return;
        }
        for (const g of groups) {
          const n = g.problems.length;
          const fold = folded.has(g.check.id);
          el.append(h("div.camp-side-head.problems-head", { onclick: () => { if (fold) folded.delete(g.check.id); else folded.add(g.check.id); w3.views.refresh("w3.problems.list"); } },
            `${fold ? "▸" : "▾"} ${g.check.title}`, h("small", {}, g.error ? " (failed)" : ` ${n}`)));
          if (fold) continue;
          if (g.error) { el.append(h("div.view-empty.problems-failed", {}, `The check failed: ${g.error} `, copyButton(`${g.check.title}: the check failed: ${g.error}`))); continue; }
          if (!n) { el.append(h("div.view-empty", {}, "OK")); continue; }
          el.append(h("div.tree", {}, ...g.problems.map((p) => h(`div.problem-row.${p.severity}${p.reveal ? ".clickable" : ""}`, {
            title: [p.message, p.location].filter(Boolean).join("\n"),
            onclick: p.reveal ? run(() => w3.commands.execute(p.reveal!.command, ...(p.reveal!.args ?? []))) : undefined,
          }, h("span.problem-icon", {}, p.severity === "error" ? "✕" : "⚠"),
            h("span.problem-text", {}, p.message, p.location ? h("small.muted", {}, ` ${p.location}`) : null,
              ...(p.fixes?.length ? [h("span.problem-fixes", {}, ...p.fixes.map((f) => h("button.problem-fix", {
                title: f.title ?? "",
                onclick: (e: MouseEvent) => { e.stopPropagation(); run(async () => { await f.run(); await service.run(); })(); },
              }, f.label)))] : []))))));
        }
      },
    }),
  );
}
