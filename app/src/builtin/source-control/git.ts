// What git's text output means, and what to run for a change: kept apart from the view so it can
// be tested.

export interface Change { path: string; status: "M" | "A" | "D" | "R" | "U" | "C"; from?: string | null }

/** The real size of a file that's a Git LFS pointer in the commit, null for other text. */
export function lfsSize(text: string | null): number | null {
  if (!text?.startsWith("version https://git-lfs.github.com/spec/")) return null;
  const m = /^size (\d+)$/m.exec(text);
  return m ? Number(m[1]) : null;
}

/** Fields of a record of \`git log\` and \`git for-each-ref\` (unit separator). */
const FIELD = "\u001f";

export interface Commit { hash: string; short: string; author: string; date: string; subject: string }
/** \`git log\` format that parseLog reads. */
export const LOG_FORMAT = ["%H", "%h", "%an", "%ad", "%s"].join("%x1f");

export function parseLog(out: string): Commit[] {
  return out.split("\n").filter(Boolean).map((line) => {
    const [hash, short, author, date, ...subject] = line.split(FIELD);
    return { hash, short, author, date, subject: subject.join(FIELD) };
  });
}

export interface CommitFile { status: string; path: string; from?: string }

/** \`git show --name-status -z --format=\`: status, path(s), separated by zeros. */
export function parseNameStatus(out: string): CommitFile[] {
  const parts = out.split("\0").map((p) => p.replace(/^\s+/, "")).filter(Boolean);
  const files: CommitFile[] = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    if (/^[RC]/.test(status)) { files.push({ status: status[0], from: parts[i], path: parts[i + 1] }); i += 2; }
    else { files.push({ status: status[0], path: parts[i] }); i++; }
  }
  return files;
}

export interface Branch { name: string; current: boolean; upstream: string }
/** \`git for-each-ref refs/heads\` format that parseBranches reads. */
export const BRANCH_FORMAT = ["%(refname:short)", "%(HEAD)", "%(upstream:short)"].join("%1f");

export function parseBranches(out: string): Branch[] {
  return out.split("\n").filter(Boolean).map((line) => {
    const [name, head, upstream] = line.split(FIELD);
    return { name, current: head === "*", upstream: upstream ?? "" };
  });
}

/** \`git rev-list --left-right --count @{u}...HEAD\`: commits only upstream has, only HEAD has. */
export function parseCounts(out: string): { behind: number; ahead: number } | null {
  const m = /^(\d+)\s+(\d+)/.exec(out.trim());
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null;
}

/** Why a name can't be a branch, or null (the rules of git check-ref-format). */
export function branchProblem(name: string): string | null {
  if (!name) return "A branch needs a name.";
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return `"${name}" can't start with - or /, or end with /, . or .lock.`;
  // eslint-disable-next-line no-control-regex
  if (/[\s~^:?*[\\\u0000-\u001f\u007f]|\.\.|\/\/|@\{/.test(name)) return `"${name}" has characters a branch can't have (spaces, ~ ^ : ? * [ \\, ..).`;
  return null;
}

/** Paths of a selection of changes as git has to see them (a rename is two paths). */
export function commitPaths(changes: Change[]): string[] {
  return [...new Set(changes.flatMap((c) => (c.from ? [c.from, c.path] : [c.path])))];
}

/** How to throw a change away: files to restore from HEAD, to take out of the index, to delete. */
export interface DiscardPlan { restore: string[]; unstage: string[]; remove: string[] }

export function discardPlan(changes: Change[]): DiscardPlan {
  const plan: DiscardPlan = { restore: [], unstage: [], remove: [] };
  for (const c of changes) {
    if (c.status === "U") plan.remove.push(c.path);
    else if (c.status === "A") { plan.unstage.push(c.path); plan.remove.push(c.path); }
    else if (c.status === "R") { plan.unstage.push(c.path); plan.remove.push(c.path); if (c.from) plan.restore.push(c.from); }
    else if (c.status === "M" || c.status === "D") plan.restore.push(c.path);
    // A conflict isn't thrown away file by file: that's aborting the merge.
  }
  return plan;
}

/** Splits arguments for commands that take many paths (Windows limits a command line). */
export function chunks(paths: string[], maxChars = 20000): string[][] {
  const out: string[][] = [];
  let now: string[] = [], size = 0;
  for (const p of paths) {
    if (size + p.length + 3 > maxChars && now.length) { out.push(now); now = []; size = 0; }
    now.push(p);
    size += p.length + 3;
  }
  if (now.length) out.push(now);
  return out;
}

/** "w3:diff:@<hash>:<path>" (after the prefix): a file in a commit; else a working copy path. */
export function diffTarget(rest: string): { rev: string | null; path: string } {
  const m = /^@([0-9a-f]{4,64}):(.*)$/.exec(rest);
  return m ? { rev: m[1], path: m[2] } : { rev: null, path: rest };
}
