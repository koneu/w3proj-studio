// Source Control: git for the open project (the project may sit anywhere inside a repository;
// only its own files count). The side bar lists uncommitted changes, refreshed on save and when
// the window gets the focus back; a file's changes open side by side against the last commit
// (w3:diff:<path>); "Commit" stages and commits the project's changes. git itself runs in the
// backend (git_status, git_show, git_size; tool_run for init/add/commit).

import { json } from "@codemirror/lang-json";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { goToNextChunk, goToPreviousChunk, MergeView, getChunks } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, lineNumbers } from "@codemirror/view";
import type { ExtensionContext, W3Api } from "../../extensions/api";
import { formatBytes, h } from "../../workbench/dom";

interface Change { path: string; status: "M" | "A" | "D" | "R" | "U" | "C"; from?: string | null }
interface Status { branch: string; changes: Change[] }

const STATUS_TEXT: Record<Change["status"], string> = {
  M: "modified", A: "added", D: "deleted", R: "renamed", U: "untracked (new)", C: "conflict",
};
const DIFF = "w3:diff:";

export function activate(w3: W3Api, ctx: ExtensionContext) {
  /** null: not in a repository; undefined: not read yet. */
  let status: Status | null | undefined;
  let error = "";
  let busy = false;
  let message = "";
  const item = w3.statusBar.add({ id: "w3.scm.status", text: "", command: "w3.scm.show", align: "left", priority: 50 });
  ctx.subscriptions.push(item);

  const root = () => w3.workspace.project()?.root ?? null;
  const git = async (...args: string[]) => {
    const r = await w3.backend.invoke<{ code: number; stdout: string; stderr: string }>("tool_run", { exe: "git", args, cwd: root() });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed (${r.code})`);
    return r.stdout;
  };

  let refreshing: Promise<void> | null = null;
  const refresh = () => {
    refreshing ??= (async () => {
      const r = root();
      try {
        status = r ? await w3.backend.invoke<Status | null>("git_status", { root: r }) : undefined;
        error = "";
      } catch (e) {
        status = undefined;
        error = String(e instanceof Error ? e.message : e);
      }
      const n = status?.changes.length ?? 0;
      item.text = status ? `⎇ ${status.branch || "(no commits)"}${n ? `  ${n}` : ""}` : "";
      item.tooltip = status ? `${n} uncommitted change${n === 1 ? "" : "s"} in the project (Source Control)` : "";
      w3.views.refresh("w3.scm.changes");
    })().finally(() => { refreshing = null; });
    return refreshing;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refreshSoon = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 400); };

  const failed = (e: unknown) => void w3.window.showError(String(e instanceof Error ? e.message : e));
  const commit = async () => {
    const r = root();
    if (!r || !status?.changes.length) return;
    const msg = message.trim() || await w3.window.inputBox({ prompt: "Commit message", placeholder: "What changed" });
    if (!msg?.trim()) return;
    if (await w3.editors.saveAll()) await refresh();
    busy = true;
    w3.views.refresh("w3.scm.changes");
    try {
      // Only the project's own files (the repository may hold more).
      await git("add", "-A", "--", ".");
      await git("commit", "-m", msg.trim(), "--", ".");
      message = "";
      void w3.window.showInfo(`Committed ${status.changes.length} change${status.changes.length === 1 ? "" : "s"}.`);
    } finally {
      busy = false;
      await refresh();
    }
  };

  ctx.subscriptions.push(
    w3.workspace.onDidChange(() => void refresh()),
    w3.workspace.onDidSave(() => refreshSoon()),
    { dispose: () => clearTimeout(timer) },
    w3.commands.register("w3.scm.show", async () => { await w3.views.show("scm"); await refresh(); }),
    w3.commands.register("w3.scm.refresh", () => refresh()),
    w3.commands.register("w3.scm.diff", (path: string) => w3.editors.open(`${DIFF}${path}`, "w3.diff")),
    w3.commands.register("w3.scm.diffActive", async () => {
      const p = w3.editors.activePath();
      if (!p || p.startsWith("w3:") || p.startsWith("game:") || /^[a-z]:[\\/]/i.test(p)) throw new Error("Open a project file first.");
      await w3.editors.open(`${DIFF}${p}`, "w3.diff");
    }),
    w3.commands.register("w3.scm.commit", () => commit()),

    w3.views.register("w3.scm.changes", {
      actions: [{ icon: "↻", title: "Refresh", command: "w3.scm.refresh" }],
      render(el) {
        if (!root()) { el.append(h("div.view-empty", {}, "Open a project to see its changes.")); return; }
        if (status === undefined) {
          el.append(h("div.view-empty", {}, error ? `git: ${error}` : "Reading changes…"));
          if (!error) void refresh();
          return;
        }
        if (status === null) {
          el.append(h("div.view-empty", {}, "This project isn't in a git repository."),
            h("div.camp-side-actions", {}, h("button", {
              onclick: () => git("init").then(() => refresh(), failed),
              title: "git init in the project folder",
            }, "Initialize Repository")));
          return;
        }
        const n = status.changes.length;
        const input = h("textarea.scm-message", {
          rows: 2, placeholder: `Message (commit on ${status.branch || "a new branch"})`, value: message, disabled: busy,
          oninput: () => { message = input.value; },
          onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); commit().catch(failed); } },
        }) as HTMLTextAreaElement;
        el.append(h("div.scm-commit", {}, input, h("button", {
          disabled: busy || !n, title: "Stages and commits every change of the project (Ctrl+Enter)", onclick: () => commit().catch(failed),
        }, busy ? "Committing…" : `Commit${n ? ` ${n} change${n === 1 ? "" : "s"}` : ""}`)));
        if (!n) { el.append(h("div.view-empty", {}, "No changes since the last commit.")); return; }
        const rows = [...status.changes].sort((a, b) => a.path.localeCompare(b.path)).map((c) => {
          const slash = c.path.lastIndexOf("/");
          const open = () => w3.editors.open(`${DIFF}${c.path}`, "w3.diff").catch(failed);
          return h(`div.scm-row.scm-${c.status}`, {
            title: `${c.path} — ${STATUS_TEXT[c.status]}${c.from ? ` (from ${c.from})` : ""}`,
            onclick: open,
            oncontextmenu: (e: MouseEvent) => {
              e.preventDefault();
              w3.window.showContextMenu({ x: e.clientX, y: e.clientY }, [
                { label: "Open Changes", run: open },
                { label: "Open File", disabled: c.status === "D", run: () => w3.editors.open(c.path).catch(failed) },
              ]);
            },
          }, h("span.scm-name", {}, c.path.slice(slash + 1)), h("small.muted", {}, slash > 0 ? ` ${c.path.slice(0, slash)}` : ""),
            h("span.scm-status", {}, c.status));
        });
        el.append(h("div.tree", {}, ...rows));
      },
    }),

    w3.editors.registerProvider("w3.diff", {
      async resolve(el, doc) {
        const path = doc.path.slice(DIFF.length);
        el.classList.add("diff-pane");
        let view: MergeView | null = null;
        const render = async () => {
          const r = root();
          if (!r) throw new Error("No project is open.");
          const [before, after] = await Promise.all([
            w3.backend.invoke<string | null>("git_show", { root: r, path }).then((t) => ({ text: t }), (e) => ({ text: null, error: String(e) })),
            w3.workspace.readText(path).then((t) => ({ text: t as string | null }), (e) => ({ text: null, error: (e as Error).name === "NotUtf8Error" ? "binary file" : String(e) })),
          ]);
          const missing = (x: { text: string | null; error?: string }) => x.text === null && !x.error;
          view?.destroy();
          view = null;
          const head = h("div.diff-head", {},
            h("span", {}, path), h("small.muted", {}, missing(before) ? "  new file" : missing(after) ? "  deleted" : "  last commit ↔ working copy"));
          // Binary files (terrain, models, …): sizes only.
          if ("error" in before && before.error || "error" in after && after.error) {
            const [a, b] = await Promise.all([
              w3.backend.invoke<number | null>("git_size", { root: r, path }),
              w3.workspace.readBytes(path).then((x) => x.length, () => null),
            ]);
            el.replaceChildren(head, h("div.view-empty", {}, `Binary file: ${a === null ? "not in the last commit" : formatBytes(a)} → ${b === null ? "deleted" : formatBytes(b)}.`));
            return;
          }
          const a = before.text ?? "", b = after.text ?? "";
          const box = h("div.diff-view");
          const lang = /\.json$/i.test(path) ? [json()] : [];
          const ro = [EditorState.readOnly.of(true), EditorView.editable.of(false), lineNumbers(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), oneDark, ...lang];
          view = new MergeView({ a: { doc: a, extensions: ro }, b: { doc: b, extensions: ro }, parent: box, collapseUnchanged: { margin: 3, minSize: 6 }, gutter: true });
          const chunks = getChunks(view.b.state)?.chunks ?? [];
          const lines = (s: string) => (s ? s.split(/\r\n|\r|\n/).length : 0);
          const step = (cmd: typeof goToNextChunk) => () => { if (view) { cmd(view.b); view.b.focus(); } };
          head.append(
            h("small.muted", {}, `  ${chunks.length} change${chunks.length === 1 ? "" : "s"}${a !== b && !chunks.length ? " (line endings only)" : ""} · ${lines(a)} → ${lines(b)} lines`),
            h("span.diff-actions", {},
              h("button", { title: "Previous change", onclick: step(goToPreviousChunk) }, "↑"),
              h("button", { title: "Next change", onclick: step(goToNextChunk) }, "↓"),
              missing(after) ? null : h("button", { onclick: () => w3.editors.open(path).catch(failed) }, "Open File")));
          el.replaceChildren(head, box);
        };
        await render();
        // Saved again (here or outside the app): redraw.
        const subs = [
          w3.workspace.onDidSave((p) => { if (p.toLowerCase() === path.toLowerCase()) void render().catch(() => {}); }),
          w3.workspace.onDidChange(() => void render().catch(() => {})),
        ];
        return {
          focus: () => view?.b.focus(),
          dispose: () => { view?.destroy(); for (const s of subs) s.dispose(); },
        };
      },
    }),
  );
  void refresh();
}
