// Source Control: git for the open project (the project may sit anywhere inside a repository;
// only its own files count). The side bar lists uncommitted changes, refreshed on save and when
// the window gets the focus back; a file's changes open side by side against the last commit
// (w3:diff:<path>); "Commit" stages and commits the project's changes. git itself runs in the
// backend (git_status, git_show, git_size; tool_run for init/add/commit).

import { goToNextChunk, goToPreviousChunk, MergeView, getChunks } from "@codemirror/merge";
import { addPage, isMergeLine, revertArgs, takeVersionArgs, BRANCH_FORMAT, branchProblem, chunks, commitPaths, deleteBranchArgs, diffTarget, discardPlan, lfsSize, logArgs, noFilter, notFullyMerged, PAGE, parseBranches, parseCounts, parseFilter, parseLog, parseNameStatus, renameBranchArgs, takeSide, type Branch, type Side, type Change, type Commit, type CommitFile } from "./git";
import type { ExtensionContext, W3Api } from "../../extensions/api";
import { OBJECTS_SERVICE, type ObjectsService } from "../../extensions/services";
import { isFullPath } from "../../lib/paths";
import { isLosslessPath, readTextFile } from "../../lib/formats/wts";
import { textCodec } from "../../lib/formats/codepage";
import { keyOf } from "../../lib/keys";
import { checkpointBefore } from "../../lib/checkpoint";
import { loadKind } from "../../lib/objects/metadata";
import { formatBytes, h } from "../../workbench/dom";
import { diffExtensions } from "./diffext";
import { diffTrigger, diffVariables, triggerFileKind } from "./trigdiff";
import { diffObjects, flatOfObjectFile, objectFileOf, type ObjectChange } from "./objdiff";
import { errorText } from "../../lib/oserror";

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
  /** Changes left out of the next commit (project paths); everything else is ticked. */
  const unticked = new Set<string>();
  /** What the branch row shows. */
  let branches: Branch[] = [], remotes: string[] = [], counts: { behind: number; ahead: number } | null = null, merging = false;
  /** History: the commits, and the files of the one that's open. */
  let log: Commit[] = [], openCommit: string | null = null, openFiles: CommitFile[] = [];
  /** More commits than listed; the search box's text; the list's element (the box isn't redrawn while typing). */
  let moreLog = false, query = "", loadingMore = false, historyList: HTMLElement | null = null;
  /** Changes with each search and each full reading: a page that comes back after it is dropped. */
  let logGeneration = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined, searchedIn: string | null | undefined;
  const item = w3.statusBar.add({ id: "w3.scm.status", text: "", command: "w3.scm.show", align: "left", priority: 50 });
  ctx.subscriptions.push(item);

  const root = () => w3.workspace.project()?.root ?? null;
  const git = async (...args: string[]) => {
    const r = await w3.backend.invoke<{ code: number; stdout: string; stderr: string }>("tool_run", { exe: "git", args, cwd: root() });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `git ${args[0]} failed (${r.code})`);
    return r.stdout;
  };

  /** Branches, remotes, the distance to the upstream, a merge in progress, the log. A repository
   *  without commits has none of these, and that isn't an error. */
  const readRepository = async () => {
    const quiet = (...args: string[]) => git(...args).catch(() => "");
    branches = parseBranches(await quiet("for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads"));
    remotes = (await quiet("remote")).split("\n").filter(Boolean);
    const current = branches.find((b) => b.current);
    counts = current?.upstream ? parseCounts(await quiet("rev-list", "--left-right", "--count", "@{u}...HEAD")) : null;
    merging = (await quiet("rev-parse", "--verify", "-q", "MERGE_HEAD")).trim() !== "";
    // What's been paged in stays (up to the commits listed), and the search stays.
    const generation = ++logGeneration;
    const size = Math.max(PAGE, log.length);
    const first = parseLog(await quiet(...logArgs(parseFilter(query), 0, size)));
    if (generation !== logGeneration) return;
    ({ commits: log, more: moreLog } = addPage([], first, size));
    loadingMore = false;
  };

  /** Reads the next page of the history (or, with `restart`, the first one of a new search). */
  const readHistory = async (restart: boolean) => {
    const generation = ++logGeneration;
    const have = restart ? [] : log;
    const asked = query;
    let fetched: Commit[];
    try { fetched = parseLog(await git(...logArgs(parseFilter(asked), have.length, PAGE))); }
    catch (e) { if (generation === logGeneration) { loadingMore = false; drawHistory(); } throw e; }
    if (generation !== logGeneration) return;
    ({ commits: log, more: moreLog } = addPage(have, fetched, PAGE));
    if (restart) { openCommit = null; openFiles = []; }
    loadingMore = false;
    drawHistory();
  };
  const loadMore = () => {
    if (loadingMore || !moreLog) return Promise.resolve();
    loadingMore = true;
    drawHistory();
    return readHistory(false);
  };
  const searchSoon = (text: string) => {
    query = text;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void readHistory(true).catch(failed), 300);
  };

  let refreshing: Promise<void> | null = null;
  const refresh = () => {
    refreshing ??= (async () => {
      const r = root();
      try {
        status = r ? await w3.backend.invoke<Status | null>("git_status", { root: r }) : undefined;
        error = "";
        if (status) await readRepository();
        else { branches = []; remotes = []; counts = null; merging = false; log = []; moreLog = false; loadingMore = false; logGeneration++; }
        // Another project: its history starts without the last one's search.
        if (r !== searchedIn) { searchedIn = r; if (query) { query = ""; if (status) await readRepository(); } }
      } catch (e) {
        status = undefined;
        error = String(e instanceof Error ? e.message : e);
      }
      const n = status?.changes.length ?? 0;
      item.text = status ? `⎇ ${status.branch || "(no commits)"}${n ? `  ${n}` : ""}` : "";
      item.tooltip = status ? `${n} uncommitted change${n === 1 ? "" : "s"} in the project (Source Control)` : "";
      w3.views.refresh("w3.scm.changes");
      w3.views.refresh("w3.scm.history");
    })().finally(() => { refreshing = null; });
    return refreshing;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refreshSoon = () => { clearTimeout(timer); timer = setTimeout(() => void refresh(), 400); };

  const failed = (e: unknown) => void w3.window.showError(String(e instanceof Error ? e.message : e));
  const commit = async () => {
    const r = root();
    if (!r) return;
    // What a terrain edit by a tool still has to write (pathing, shadows, minimap) belongs in the commit: it comes
    // first, so the changes below are the ones that exist now.
    await w3.commands.execute("w3.terrain.settle").catch(() => {});
    await w3.editors.saveAll();
    await refreshing?.catch(() => {});
    await refresh();
    const selected = status?.changes.filter((c) => !unticked.has(c.path)) ?? [];
    if (!status || !selected.length) return;
    const msg = message.trim() || await w3.window.inputBox({ prompt: "Commit message", placeholder: "What changed" });
    if (!msg?.trim()) return;
    // A merge that needed decisions is finished by this commit: its trigger tree is checked after it.
    const mergedFrom = merging ? await headNow() : "";
    busy = true;
    w3.views.refresh("w3.scm.changes");
    try {
      // Only the project's own files (the repository may hold more).
      if (selected.length === status.changes.length) {
        await git("add", "-A", "--", ".");
        await git("commit", "-m", msg.trim(), "--", ".");
      } else {
        const paths = commitPaths(selected);
        // What was staged before doesn't count: the ticks decide.
        await git("reset", "-q", "--", ".").catch(() => {});
        for (const part of chunks(paths)) await git("add", "-A", "--", ...part);
        // In a bigger repository only these paths; there, a list too long for one command fails.
        await (status.outer_repo ? git("commit", "-m", msg.trim(), "--", ...paths) : git("commit", "-m", msg.trim()));
      }
      message = "";
      unticked.clear();
      void w3.window.showInfo(`Committed ${selected.length} change${selected.length === 1 ? "" : "s"}.`);
      if (mergedFrom) await checkTriggersAfter(mergedFrom).catch(() => {});
    } finally {
      busy = false;
      await refresh();
    }
  };

  /** Throws changes away: there's no undo, so a checkpoint keeps what they were. */
  const discard = async (changes: Change[]) => {
    if (!changes.length) return;
    const what = changes.length === 1 ? changes[0].path : `${changes.length} changes`;
    const c = await w3.window.showWarning(`Discard ${what}? New files are deleted, the others go back to the last commit. A checkpoint is made first, where they're enabled.`, "Discard", "Cancel");
    if (c !== "Discard") return;
    // Discarded changes exist nowhere else: a failed checkpoint asks before anything goes.
    if (!(await checkpointBefore(w3, `Discard ${what}`))) return;
    const plan = discardPlan(changes);
    for (const part of chunks(plan.unstage)) await git("rm", "--cached", "-f", "--quiet", "--", ...part);
    for (const part of chunks(plan.restore)) await git("restore", "--source=HEAD", "--staged", "--worktree", "--", ...part);
    if (plan.remove.length) {
      const { error: failed_ } = await w3.workspace.deleteMany(plan.remove);
      if (failed_) throw new Error(failed_);
    }
    for (const ch of changes) { unticked.delete(ch.path); await w3.editors.close(ch.path); }
    await w3.workspace.refresh();
    await refresh();
  };

  /** Changing what the working copy holds: editors are closed first (their files will change). */
  const withClosedEditors = async (run: () => Promise<void>) => {
    if (!(await w3.editors.closeAllAsking())) return;
    try { await run(); } finally { await w3.workspace.refresh(); await refresh(); }
  };

  /** Resolves a conflicted file by taking one side whole; the editor of that file is closed first. */
  const resolveWith = async (c: Change, side: Side) => {
    if (c.status !== "C") return;
    await w3.editors.close(c.path);
    try { await takeSide(git, side, c.path); } finally { await w3.workspace.refresh(); await refresh(); }
  };

  const switchBranch = async () => {
    const pick = await w3.window.quickPick<string>([
      { label: "+ Create a new branch…", value: "" },
      ...branches.map((b) => ({ label: b.name, description: `${b.current ? "current" : ""}${b.upstream ? ` ${b.upstream}` : ""}`.trim(), value: b.name })),
    ], { placeholder: "Switch to a branch" });
    if (!pick) return;
    if (pick.value) {
      if (branches.find((b) => b.name === pick.value)?.current) return;
      await withClosedEditors(async () => { await git("switch", pick.value!); });
      return;
    }
    const name = (await w3.window.inputBox({ prompt: "New branch (from the current commit)" }))?.trim();
    if (!name) return;
    const problem = branchProblem(name);
    if (problem) throw new Error(problem);
    // The working copy stays: nothing to reopen.
    await git("switch", "-c", name);
    await refresh();
  };

  const merge = async () => {
    const others = branches.filter((b) => !b.current);
    if (!others.length) { void w3.window.showInfo("There's no other branch to merge."); return; }
    const pick = await w3.window.quickPick<string>(others.map((b) => ({ label: b.name, value: b.name })), { placeholder: "Merge into the current branch" });
    if (pick?.value) await mergeRef(pick.value);
  };

  /** After a merge or pull that moved the branch from commit `before`: when it changed map/triggers/, Check Trigger
   *  Tree runs (disjoint files merge without a conflict into ids or variables held twice) and says what it found; with
   *  findings the Problems view shows them with their fixes. */
  const checkTriggersAfter = async (before: string) => {
    const r = root();
    if (!r || !before) return;
    const changed = (await git("diff", "--name-only", before, "HEAD", "--", "map/triggers").catch(() => "")).trim();
    if (!changed) return;
    let found: unknown[];
    try {
      found = await w3.backend.invoke<unknown[]>("triggers_check", { root: r });
    } catch (e) {
      void w3.window.showWarning(`The merge changed the trigger tree, and Check Trigger Tree couldn't run: ${errorText(e)}`);
      return;
    }
    if (!found.length) { void w3.window.showInfo("The merge changed the trigger tree: Check Trigger Tree found nothing wrong."); return; }
    void w3.window.showWarning(`The merge changed the trigger tree: Check Trigger Tree found ${found.length} problem${found.length === 1 ? "" : "s"}. The Problems view lists ${found.length === 1 ? "it" : "them"} with the fixes.`);
    await w3.commands.execute("w3.problems.checkTriggerTree").catch(() => {});
  };
  const headNow = () => git("rev-parse", "-q", "--verify", "HEAD").then((s) => s.trim(), () => "");

  const mergeRef = (ref: string) => withClosedEditors(async () => {
    const before = await headNow();
    try {
      await git("merge", "--no-edit", ref);
      void w3.window.showInfo(`Merged ${ref}.`);
      // The files are as merged now: the check reads them from disk.
      await checkTriggersAfter(before);
    } catch (e) {
      await refresh();
      // Conflicts are left for the user: the files show them, Abort Merge goes back.
      if (merging) void w3.window.showWarning(`Merging ${ref} needs your decision: files marked C have conflicts. Fix and commit them, or use Abort Merge.`);
      else throw e;
    }
  });

  const addRemote = async () => {
    const url = (await w3.window.inputBox({ prompt: "Remote address (URL or path)", placeholder: "https://github.com/you/your-map.git" }))?.trim();
    if (!url) return;
    await git("remote", "add", "origin", url);
    await refresh();
    void w3.window.showInfo(`Remote origin: ${url}`);
  };

  const push = async () => {
    const current = branches.find((b) => b.current);
    if (!current) throw new Error("There's nothing to push yet: make a first commit.");
    if (!remotes.length) throw new Error("This repository has no remote: use Add Remote.");
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    await w3.window.withProgress(`Pushing ${current.name}`, () => (current.upstream ? git("push") : git("push", "-u", remote, current.name))).catch((e) => {
      throw /rejected|fetch first|non-fast-forward/.test(String(e)) ? new Error(`${remote} has commits this branch doesn't have: Pull first, then Push.`) : e;
    });
    await refresh();
    void w3.window.showInfo(`Pushed ${current.name}.`);
  };

  const pull = async () => {
    const current = branches.find((b) => b.current);
    if (!current?.upstream) throw new Error("This branch has no upstream yet: push it first.");
    // Only fast-forward: a real merge goes through Merge Branch, with its conflicts in view.
    let diverged = false;
    await withClosedEditors(async () => {
      const before = await headNow();
      await w3.window.withProgress(`Pulling ${current.name}`, () => git("pull", "--ff-only")).then(
        () => void w3.window.showInfo(`Pulled ${current.name}.`),
        (e) => { if (/fast-forward|divergent/i.test(String(e))) diverged = true; else throw e; });
      if (!diverged) await checkTriggersAfter(before);
    });
    if (!diverged) return;
    // Both sides have commits: the normal case with two people on a map.
    const c = await w3.window.showWarning(`This branch and ${current.upstream} both have new commits (${counts?.ahead ?? "some"} here, ${counts?.behind ?? "some"} there). Merge them?`, "Merge", "Cancel");
    if (c === "Merge") await mergeRef(current.upstream);
  };

  /** Deleting a branch: not the current one; one with commits no other branch has only after a question. */
  const deleteBranch = async (given?: string) => {
    const name = given ?? (await w3.window.quickPick<string>(
      branches.filter((b) => !b.current).map((b) => ({ label: b.name, description: b.upstream, value: b.name })),
      { placeholder: "Delete which branch?" }))?.value;
    if (!name) { if (given === undefined && branches.every((b) => b.current)) void w3.window.showInfo("There's no other branch to delete."); return; }
    const b = branches.find((x) => x.name === name);
    if (!b) throw new Error(`There's no branch ${name}.`);
    if (b.current) throw new Error(`${name} is the branch the project is on: switch to another one first.`);
    try {
      await git(...deleteBranchArgs(name, false));
    } catch (e) {
      if (!notFullyMerged(e)) throw e;
      const c = await w3.window.showWarning(`${name} has commits that no other branch has. Deleting it loses them (they stay findable in the reflog for a while). Delete it anyway?`, "Delete Branch", "Cancel");
      if (c !== "Delete Branch") return;
      await git(...deleteBranchArgs(name, true));
    } finally {
      await refresh();
    }
    void w3.window.showInfo(`Deleted branch ${name}.`);
  };

  /** Renaming a branch (the current one or another); the name is checked as git checks it. */
  const renameBranch = async (given?: string) => {
    const from = given ?? (await w3.window.quickPick<string>(
      branches.map((b) => ({ label: b.name, description: b.current ? "current" : "", value: b.name })),
      { placeholder: "Rename which branch?" }))?.value;
    if (!from) return;
    if (!branches.some((b) => b.name === from)) throw new Error(`There's no branch ${from}.`);
    const to = (await w3.window.inputBox({ prompt: `New name of ${from}`, value: from }))?.trim();
    if (!to || to === from) return;
    if (branches.some((b) => b.name === to)) throw new Error(`There's a branch ${to} already.`);
    // Checked before git is asked (renameBranchArgs refuses what git would take for an option).
    const args = renameBranchArgs(from, to);
    try { await git(...args); } finally { await refresh(); }
    void w3.window.showInfo(`Renamed ${from} to ${to}.`);
  };

  /** Revert Commit: a new commit that undoes one of the history. A commit whose changes conflict with later ones isn't
   *  reverted (the revert is taken back and said); a merge commit isn't either. */
  const revertCommit = async (c: Commit) => {
    const args = revertArgs(c.hash);
    if (isMergeLine(await git("rev-list", "--parents", "-n", "1", c.hash))) {
      throw new Error(`${c.short} is a merge commit: reverting it needs a choice of which side to keep, which the history can't make. Revert the commits it brought in instead.`);
    }
    if (merging) throw new Error("A merge is in progress: finish or abort it first.");
    const answer = await w3.window.showWarning(`Revert "${c.subject}" (${c.short})? A new commit is made that undoes its changes; the commit itself stays in the history.`, "Revert", "Cancel");
    if (answer !== "Revert") return;
    let done = false;
    await withClosedEditors(async () => {
      try {
        await git(...args);
        done = true;
      } catch (e) {
        // Stopped at a conflict: back to how it was, nothing half done.
        if ((await git("rev-parse", "-q", "--verify", "REVERT_HEAD").catch(() => "")).trim()) {
          await git("revert", "--abort");
          throw new Error(`${c.short} can't be reverted by itself: later commits changed the same places. Nothing was changed.`);
        }
        throw e;
      }
    });
    if (done) void w3.window.showInfo(`Reverted "${c.subject}" in a new commit.`);
  };

  /** Take This Version: a file of the working copy as a commit of the history had it; it then shows under Changes, to
   *  commit or discard. What the file holds now exists nowhere else when it has changes: a checkpoint keeps it. */
  const takeVersion = async (c: Commit, f: CommitFile) => {
    const args = takeVersionArgs(c.hash, f.path);
    if (f.status === "D") throw new Error(`${c.short} deleted ${f.path}: there's no version of it in that commit.`);
    const answer = await w3.window.showWarning(`Replace ${f.path} with its version from "${c.subject}" (${c.short})? What it holds now is replaced; a checkpoint is made first, where they're enabled.`, "Take This Version", "Cancel");
    if (answer !== "Take This Version") return;
    if (!(await checkpointBefore(w3, `Take ${f.path} from ${c.short}`))) return;
    await w3.editors.close(f.path);
    try { await git(...args); } finally { await w3.workspace.refresh(); await refresh(); }
    void w3.window.showInfo(`${f.path} is as in ${c.short} now: it shows under Changes.`);
  };

  const toggleCommit = async (hash: string) => {
    if (openCommit === hash) { openCommit = null; openFiles = []; }
    else {
      openFiles = parseNameStatus(await git("show", "--relative", "--name-status", "-z", "--format=", hash, "--", "."));
      openCommit = hash;
    }
    drawHistory();
  };

  /** The history's commits (and Load more) in the list element of the view as it's drawn now. */
  const drawHistory = () => {
    const el = historyList;
    if (!el?.isConnected) return;
    if (!log.length) {
      el.replaceChildren(h("div.view-empty.scm-log-empty", {}, noFilter(parseFilter(query)) ? "No commits yet." : "No matches."));
      return;
    }
    el.replaceChildren(h("div.tree", {}, ...log.flatMap((c) => [
      h("div.scm-log-row", { title: `${c.hash}\n${c.author}, ${c.date}\n${c.subject}`, onclick: () => void toggleCommit(c.hash).catch(failed),
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          w3.window.showContextMenu({ x: e.clientX, y: e.clientY }, [{ label: "Revert Commit…", run: () => void revertCommit(c).catch(failed) }]);
        } },
        h("span.tree-icon", {}, openCommit === c.hash ? "▾" : "▸"), h("span.scm-log-subject", {}, c.subject), h("small.muted", {}, c.date),
        openCommit === c.hash ? h("button.icon-button.scm-log-revert", { title: "Revert this commit: a new commit that undoes its changes",
          onclick: (e: MouseEvent) => { e.stopPropagation(); void revertCommit(c).catch(failed); } }, "↩") : null),
      ...(openCommit === c.hash ? openFiles.map((f) => h("div.scm-log-file", { title: f.from ? `${f.from} → ${f.path}` : f.path,
        onclick: () => void w3.editors.open(`${DIFF}@${c.hash}:${f.path}`, "w3.diff").catch(failed),
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          w3.window.showContextMenu({ x: e.clientX, y: e.clientY }, [
            { label: "Open Changes", run: () => void w3.editors.open(`${DIFF}@${c.hash}:${f.path}`, "w3.diff").catch(failed) },
            { label: "Take This Version…", disabled: f.status === "D", run: () => void takeVersion(c, f).catch(failed) },
          ]);
        } },
        h("span.scm-status", {}, f.status), h("span.scm-log-name", {}, f.path.split("/").pop() ?? f.path),
        f.status === "D" ? null : h("button.icon-button.scm-log-take", { title: "Take this version: the file in the working copy becomes what this commit had",
          onclick: (e: MouseEvent) => { e.stopPropagation(); void takeVersion(c, f).catch(failed); } }, "⤓"))) : []),
    ])), ...(moreLog ? [h("div.camp-side-actions", {}, h("button.scm-log-more", {
      disabled: loadingMore, title: `Shows the next ${PAGE} commits`, onclick: () => void loadMore().catch(failed),
    }, loadingMore ? "Loading…" : "Load more"))] : []));
  };

  ctx.subscriptions.push(
    w3.workspace.onDidChange(() => void refresh()),
    w3.workspace.onDidSave(() => refreshSoon()),
    { dispose: () => { clearTimeout(timer); clearTimeout(searchTimer); } },
    w3.commands.register("w3.scm.show", async () => { await w3.views.show("scm"); await refresh(); }),
    w3.commands.register("w3.scm.refresh", () => refresh()),
    w3.commands.register("w3.scm.diff", (path: string) => w3.editors.open(`${DIFF}${path}`, "w3.diff")),
    w3.commands.register("w3.scm.diffActive", async () => {
      const p = w3.editors.activePath();
      if (!p || p.startsWith("w3:") || p.startsWith("game:") || isFullPath(p)) throw new Error("Open a project file first.");
      await w3.editors.open(`${DIFF}${p}`, "w3.diff");
    }),
    w3.commands.register("w3.scm.commit", () => commit()),
    w3.commands.register("w3.scm.discardAll", async () => { await refresh(); await discard(status?.changes ?? []); }),
    w3.commands.register("w3.scm.branch", async () => { await refresh(); await switchBranch(); }),
    w3.commands.register("w3.scm.deleteBranch", async (name?: string) => { await refresh(); await deleteBranch(name); }),
    w3.commands.register("w3.scm.renameBranch", async (name?: string) => { await refresh(); await renameBranch(name); }),
    w3.commands.register("w3.scm.merge", async () => { await refresh(); await merge(); }),
    w3.commands.register("w3.scm.mergeAbort", () => withClosedEditors(async () => { await git("merge", "--abort"); })),
    w3.commands.register("w3.scm.addRemote", () => addRemote()),
    w3.commands.register("w3.scm.push", async () => { await refresh(); await push(); }),
    w3.commands.register("w3.scm.pull", async () => { await refresh(); await pull(); }),

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
        const ticked = status.changes.filter((c) => !unticked.has(c.path)).length;
        const run = (cmd: string) => () => void w3.commands.execute(cmd).catch(failed);
        const current = branches.find((b) => b.current);
        el.append(h("div.scm-branch", {},
          h("button.scm-branch-name", { title: "Switch or create a branch", onclick: run("w3.scm.branch") }, `⎇ ${status.branch || "(no commits)"}`),
          h("button", { title: "Rename a branch", onclick: run("w3.scm.renameBranch") }, "✎"),
          h("button", { title: "Delete a branch", disabled: branches.length < 2, onclick: run("w3.scm.deleteBranch") }, "✕"),
          ...(counts ? [h("span.muted", { title: `${counts.ahead} to push, ${counts.behind} to pull` }, `↑${counts.ahead} ↓${counts.behind}`)] : []),
          ...(remotes.length
            ? [h("button", { title: "Push this branch", disabled: !current, onclick: run("w3.scm.push") }, "Push"), h("button", { title: "Pull (fast-forward only)", disabled: !current?.upstream, onclick: run("w3.scm.pull") }, "Pull")]
            : [h("button", { title: "Add a remote to push to", onclick: run("w3.scm.addRemote") }, "Add remote…")])));
        if (merging) el.append(h("div.scm-merging", {}, "A merge is in progress. ", h("button.link-inline", { onclick: run("w3.scm.mergeAbort") }, "Abort it")));
        const input = h("textarea.scm-message", {
          rows: 2, placeholder: `Message (commit on ${status.branch || "a new branch"})`, value: message, disabled: busy,
          oninput: () => { message = input.value; },
          onkeydown: (e: KeyboardEvent) => { if (keyOf(e) === "Enter" && e.ctrlKey) { e.preventDefault(); commit().catch(failed); } },
        }) as HTMLTextAreaElement;
        // A project inside a bigger repository (or one created by accident, e.g. in the home
        // folder): commits go there.
        if (status.outer_repo) {
          el.append(h("div.scm-outer.muted", { title: "The project is a folder inside this repository; commits are made there (limited to the project's files)." },
            `Repository: ${status.outer_repo}`));
        }
        el.append(h("div.scm-commit", {}, input, h("button", {
          disabled: busy || !ticked, title: "Stages and commits the ticked changes (Ctrl+Enter)", onclick: () => commit().catch(failed),
        }, busy ? "Committing…" : `Commit${n ? ` ${ticked === n ? "" : `${ticked} of `}${n} change${n === 1 ? "" : "s"}` : ""}`)));
        if (!n) { el.append(h("div.view-empty", {}, "No changes since the last commit.")); return; }
        // What object a file of map/objects/ holds, beside its name (an id alone says little); the names come later.
        const objectRows: { node: HTMLElement; id: string; ext: string; noun: string }[] = [];
        const objectLabel = (path: string, deleted: boolean) => {
          const o = objectFileOf(path);
          if (!o) return [];
          const node = h("span.scm-object", {}, ` ${o.noun}`);
          if (!deleted && !/(^|\/)maps\//i.test(path) && objectRows.length < MAX_OBJECTS) objectRows.push({ node, ...o });
          return [node];
        };
        const rows = [...status.changes].sort((a, b) => a.path.localeCompare(b.path)).map((c) => {
          const slash = c.path.lastIndexOf("/");
          const open = () => w3.editors.open(`${DIFF}${c.path}`, "w3.diff").catch(failed);
          const tick = h("input.scm-tick", { type: "checkbox", checked: !unticked.has(c.path), title: "Part of the next commit",
            onclick: (e: MouseEvent) => e.stopPropagation(),
            onchange: () => { if (tick.checked) unticked.delete(c.path); else unticked.add(c.path); w3.views.refresh("w3.scm.changes"); } });
          return h(`div.scm-row.scm-${c.status}`, {
            title: `${c.path} — ${STATUS_TEXT[c.status]}${c.from ? ` (from ${c.from})` : ""}`,
            onclick: open,
            oncontextmenu: (e: MouseEvent) => {
              e.preventDefault();
              w3.window.showContextMenu({ x: e.clientX, y: e.clientY }, [
                { label: "Open Changes", run: open },
                { label: "Open File", disabled: c.status === "D", run: () => w3.editors.open(c.path).catch(failed) },
                "-",
                ...(c.status === "C" ? [
                  { label: "Accept Current (ours)", run: () => void resolveWith(c, "ours").catch(failed) },
                  { label: "Accept Incoming (theirs)", run: () => void resolveWith(c, "theirs").catch(failed) },
                  "-" as const,
                ] : []),
                { label: "Discard Changes…", disabled: c.status === "C", run: () => void discard([c]).catch(failed) },
              ]);
            },
          }, tick, h("span.scm-name", {}, c.path.slice(slash + 1)), ...objectLabel(c.path, c.status === "D"), h("small.muted", {}, slash > 0 ? ` ${c.path.slice(0, slash)}` : ""),
            h("span.scm-status", {}, c.status));
        });
        el.append(h("div.tree", {}, ...rows));
        if (objectRows.length) {
          void w3.services.get<ObjectsService>(OBJECTS_SERVICE).then(async (objects) => {
            for (const o of objectRows) {
              const name = await objects.name(o.id, [o.ext]).catch(() => undefined);
              if (name) o.node.textContent = ` ${name} (${o.noun})`;
            }
          }, () => {});
        }
      },
    }),

    w3.views.register("w3.scm.history", {
      render(el) {
        historyList = null;
        if (!root() || !status) { el.append(h("div.view-empty", {}, "No repository.")); return; }
        if (!log.length && !query) { el.append(h("div.view-empty", {}, "No commits yet.")); return; }
        const box = h("input.scm-log-search", {
          type: "search", value: query, placeholder: "Search: message, author:name or path:file",
          title: "Searches the commit messages; \"author:\" or \"path:\" in front searches the author or the commits that changed a file or folder",
          oninput: () => searchSoon(box.value),
        }) as HTMLInputElement;
        historyList = h("div.scm-log-list");
        el.append(h("div.scm-branch", {}, box), historyList);
        drawHistory();
      },
    }),

    w3.editors.registerProvider("w3.diff", {
      async resolve(el, doc) {
        const { rev, path } = diffTarget(doc.path.slice(DIFF.length));
        el.classList.add("diff-pane");
        let view: MergeView | null = null;
        const render = async () => {
          const r = root();
          if (!r) throw new Error("No project is open.");
          // A string table or map script in an old code page as lossless text, as the editors read it (lib/formats/wts
          // readTextFile); the backend does the same for a commit's copy.
          const lossless = isLosslessPath(path);
          const shown = (spec: string | undefined) => w3.backend.invoke<string | null>("git_show", { root: r, path, rev: spec, lossless }).then((t) => ({ text: t }), (e) => ({ text: null, error: String(e) }));
          // A file of a commit: against its parent. Otherwise the working copy against the last commit.
          const [before, after] = await Promise.all([
            shown(rev ? `${rev}^` : undefined),
            rev ? shown(rev) : readTextFile(w3.workspace, path).then((t) => ({ text: t as string | null }), (e) => ({ text: null, error: (e as Error).name === "NotUtf8Error" ? "binary file" : String(e) })),
          ]);
          const missing = (x: { text: string | null; error?: string }) => x.text === null && !x.error;
          view?.destroy();
          view = null;
          const head = h("div.diff-head", {},
            h("span", {}, path), h("small.muted", {}, missing(before) ? "  new file" : missing(after) ? "  deleted" : rev ? `  commit ${rev.slice(0, 8)}` : "  last commit ↔ working copy"));
          // Binary files (terrain, models, …): sizes only.
          if ("error" in before && before.error || "error" in after && after.error) {
            const [a, b] = await Promise.all([
              // An LFS file is a small pointer in the commit, which names the real size.
              lfsSize(before.text) ?? w3.backend.invoke<number | null>("git_size", { root: r, path, rev: rev ? `${rev}^` : undefined }),
              rev ? lfsSize(after.text) ?? w3.backend.invoke<number | null>("git_size", { root: r, path, rev }) : w3.workspace.readBytes(path).then((x) => x.length, () => null),
            ]);
            el.replaceChildren(head, h("div.view-empty", {}, `Binary file: ${a === null ? "not in the last commit" : formatBytes(a)} → ${b === null ? "deleted" : formatBytes(b)}.`));
            return;
          }
          const a = before.text ?? "", b = after.text ?? "";
          const box = h("div.diff-view");
          const ro = diffExtensions(path);
          // Lines in an old code page show readable in the map's text encoding (lib/formats/codepage.ts); the view is
          // read-only, and what is compared are the texts as stored.
          const codec = textCodec((k) => w3.settings.get(k));
          view = new MergeView({ a: { doc: codec.show(a), extensions: ro }, b: { doc: codec.show(b), extensions: ro }, parent: box, collapseUnchanged: { margin: 3, minSize: 6 }, gutter: true });
          const chunks = getChunks(view.b.state)?.chunks ?? [];
          const lines = (s: string) => (s ? s.split(/\r\n|\r|\n/).length : 0);
          const step = (cmd: typeof goToNextChunk) => () => { if (view) { cmd(view.b); view.b.focus(); } };
          head.append(
            h("small.muted", {}, `  ${chunks.length} change${chunks.length === 1 ? "" : "s"}${a !== b && !chunks.length ? " (line endings only)" : ""} · ${lines(a)} → ${lines(b)} lines`),
            h("span.diff-actions", {},
              h("button", { title: "Previous change", onclick: step(goToPreviousChunk) }, "↑"),
              h("button", { title: "Next change", onclick: step(goToNextChunk) }, "↓"),
              missing(after) ? null : h("button", { onclick: () => w3.editors.open(path).catch(failed) }, "Open File")));
          el.replaceChildren(head, ...(OBJECT_FILE.test(path) || objectFileOf(path) ? [objectSummary(w3, path, a, b, codec.show)] : []), ...(triggerFileKind(path) ? [triggerSummary(path, before.text, after.text)] : []), box);
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

/** What changed in a trigger file, over its text diff (trigdiff.ts): a GUI trigger's events, conditions and actions,
 *  or a folder's variables. Empty when nothing of that changed, or the file can't be read as one. */
function triggerSummary(path: string, before: string | null, after: string | null): HTMLElement {
  const el = h("div.diff-objects.diff-triggers");
  const mark = { added: "+", removed: "−", changed: "✎", moved: "↕", switched: "◐" } as const;
  const row = (what: keyof typeof mark, text: string, note = "") => h(`div.diff-object.diff-${what === "moved" || what === "switched" ? "changed" : what}`, {},
    h("span.diff-mark", {}, mark[what]), h("span", {}, text), note ? h("small.muted", {}, ` ${note}`) : null);
  try {
    if (triggerFileKind(path) === "variables") {
      const changes = diffVariables(before ?? "", after ?? "");
      if (!changes.length) return el;
      el.append(h("div.diff-objects-head", {}, `Variables: ${(["added", "changed", "removed"] as const).map((w) => [w, changes.filter((c) => c.what === w).length] as const).filter(([, n]) => n).map(([w, n]) => `${n} ${w}`).join(", ")}`),
        h("div.diff-objects-list", {}, ...changes.map((c) => row(c.what, c.name, c.note))));
      return el;
    }
    const d = diffTrigger(before ? JSON.parse(before) : null, after ? JSON.parse(after) : null);
    if (!d.header.length && !d.lines.length) return el;
    const counts = (["event", "condition", "action"] as const).map((k) => `${d.counts[k][1]} ${k}${d.counts[k][1] === 1 ? "" : "s"}${d.counts[k][0] !== d.counts[k][1] ? ` (was ${d.counts[k][0]})` : ""}`).join(", ");
    el.append(h("div.diff-objects-head", {}, `Trigger: ${counts}`),
      h("div.diff-objects-list", {}, ...d.header.map((t) => row("changed", t)), ...d.lines.map((l) => row(l.what, `${l.kind} ${l.name}`, l.note ?? ""))));
  } catch (e) {
    el.append(h("div.muted", {}, `The trigger can't be compared: ${errorText(e)}`));
  }
  return el;
}

/** Object data files (map, skin and campaign); group 1 is the kind ("w3u"). */
const OBJECT_FILE = /(?:^|\/)war3(?:map|campaign)(?:Skin)?\.(w3[utabdhq])\.json$/i;
const MAX_OBJECTS = 200;

/** Changed objects of an object data file, with their changed fields (labels and names from the
 *  game's data, filled in when loaded); an object opens in the Object Editor. */
function objectSummary(w3: W3Api, path: string, before: string, after: string, shownText: (stored: string) => string): HTMLElement {
  const one = objectFileOf(path);
  const kind = one ? one.ext : OBJECT_FILE.exec(path)![1].toLowerCase();
  const read = (text: string) => (one ? flatOfObjectFile(one.section, text) : text ? JSON.parse(text) : null);
  const el = h("div.diff-objects");
  let changes: ObjectChange[];
  try {
    changes = diffObjects(read(before), read(after));
  } catch (e) {
    el.append(h("div.muted", {}, `Objects can't be compared: ${errorText(e)}`));
    return el;
  }
  if (!changes.length) return el;
  const show = (v: unknown) => {
    // Quoted, line breaks visible; paths keep single backslashes.
    const s = typeof v === "string" ? `"${shownText(v).replace(/\r?\n/g, "\\n")}"` : String(v);
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
    // A chapter map's object (maps/…) isn't one the Object Editor would open here; a campaign project's own
    // (map/war3campaign.w3u.json) is: the Object Editor opens the campaign's objects there.
    const open = c.what === "removed" || /(^|\/)maps\//i.test(path) ? undefined
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
