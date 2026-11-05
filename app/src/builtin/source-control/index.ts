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
import { lfsSize } from "./git";
import type { ExtensionContext, W3Api } from "../../extensions/api";
import { OBJECTS_SERVICE, type ObjectsService } from "../../extensions/services";
import { loadKind } from "../../lib/objects/metadata";
import { formatBytes, h } from "../../workbench/dom";
import { diffObjects, type ObjectChange } from "./objdiff";

interface Change { path: string; status: "M" | "A" | "D" | "R" | "U" | "C"; from?: string | null }
interface Status { branch: string; outer_repo: string; changes: Change[] }

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
        // A project inside a bigger repository (or one created by accident, e.g. in the home
        // folder): commits go there.
        if (status.outer_repo) {
          el.append(h("div.scm-outer.muted", { title: "The project is a folder inside this repository; commits are made there (limited to the project's files)." },
            `Repository: ${status.outer_repo}`));
        }
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
              // An LFS file is a small pointer in the commit, which names the real size.
              lfsSize(before.text) ?? w3.backend.invoke<number | null>("git_size", { root: r, path }),
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
          el.replaceChildren(head, ...(OBJECT_FILE.test(path) ? [objectSummary(w3, path, a, b)] : []), box);
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

/** Object data files (map, skin and campaign); group 1 is the kind ("w3u"). */
const OBJECT_FILE = /(?:^|\/)war3(?:map|campaign)(?:Skin)?\.(w3[utabdhq])\.json$/i;
const MAX_OBJECTS = 200;

/** Changed objects of an object data file, with their changed fields (labels and names from the
 *  game's data, filled in when loaded); an object opens in the Object Editor. */
function objectSummary(w3: W3Api, path: string, before: string, after: string): HTMLElement {
  const kind = OBJECT_FILE.exec(path)![1].toLowerCase();
  const el = h("div.diff-objects");
  let changes: ObjectChange[];
  try {
    changes = diffObjects(before ? JSON.parse(before) : null, after ? JSON.parse(after) : null);
  } catch (e) {
    el.append(h("div.muted", {}, `Objects can't be compared: ${(e as Error).message}`));
    return el;
  }
  if (!changes.length) return el;
  const show = (v: unknown) => {
    // Quoted, line breaks visible; paths keep single backslashes.
    const s = typeof v === "string" ? `"${v.replace(/\r?\n/g, "\\n")}"` : String(v);
    return s.length > 80 ? `${s.slice(0, 77)}…` : s;
  };
  const counts = (["added", "changed", "removed"] as const).map((w) => [w, changes.filter((c) => c.what === w).length] as const).filter(([, n]) => n);
  el.append(h("div.diff-objects-head", {}, `Objects: ${counts.map(([w, n]) => `${n} ${w}`).join(", ")}`));
  const list = h("div.diff-objects-list");
  el.append(list);
  // Labels and names come later (game data); rows are drawn first with ids.
  const labels = new Map<string, HTMLElement[]>(), names = new Map<string, HTMLElement[]>();
  const later = (map: Map<string, HTMLElement[]>, key: string, node: HTMLElement) => { map.set(key, [...(map.get(key) ?? []), node]); return node; };
  for (const c of changes.slice(0, MAX_OBJECTS)) {
    const mark = c.what === "added" ? "+" : c.what === "removed" ? "−" : "✎";
    const open = c.what === "removed" || /campaign/i.test(path) ? undefined
      : () => void w3.commands.execute("w3.objectEditor.open", kind, c.id).catch((e) => w3.window.showError(String(e)));
    list.append(h(`div.diff-object.diff-${c.what}${open ? ".clickable" : ""}`, { onclick: open, title: open ? "Open in the Object Editor" : "" },
      h("span.diff-mark", {}, mark), h("code", {}, c.id), " ", later(names, c.id, h("span", {})),
      h("small.muted", {}, c.section === "custom" ? ` custom, based on ${c.base}` : " game object")));
    for (const f of c.fields) {
      const where = [f.level ? `level ${f.level}` : "", f.data ? `data ${String.fromCharCode(64 + f.data)}` : "", f.set ? `set ${f.set}` : ""].filter(Boolean).join(", ");
      list.append(h("div.diff-field", {},
        later(labels, f.field, h("span", {}, f.field)), h("small.muted", {}, ` ${f.field}${where ? ` (${where})` : ""}: `),
        f.before === undefined ? h("span.diff-new", {}, show(f.after))
          : f.after === undefined ? h("span.diff-old", {}, `${show(f.before)} (back to default)`)
          : h("span", {}, h("span.diff-old", {}, show(f.before)), " → ", h("span.diff-new", {}, show(f.after)))));
    }
  }
  if (changes.length > MAX_OBJECTS) list.append(h("div.muted", {}, `… and ${changes.length - MAX_OBJECTS} more`));
  void (async () => {
    const meta = await loadKind(w3, kind).catch(() => null);
    for (const [id, nodes] of labels) { const l = meta?.fieldById.get(id)?.label; if (l) for (const n of nodes) { n.textContent = l; } }
    const objects = await w3.services.get<ObjectsService>(OBJECTS_SERVICE).catch(() => null);
    for (const [id, nodes] of names) {
      const n = (await objects?.name(id, [kind]).catch(() => undefined)) ?? meta?.names.get(id);
      if (n) for (const node of nodes) node.textContent = n;
    }
  })();
  return el;
}
