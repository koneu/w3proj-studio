// What a project brings along that could cost data, said when it opens: files an older version left with a
// `\` in their name (moved where they belong only when the user says so), and map files whose names differ
// only in case (the map archive, like the game, holds one of them).

import type { OutputChannel, W3Api } from "../../extensions/api";
import { isWindowsPath } from "../../lib/paths";

/** A stray file as the backend finds it (`project_strays`, app/src-tauri/src/strays.rs). */
export interface Stray {
  path: string;
  /** From the folder holding the project. */
  shown: string;
  /** Where it belongs, below the project root. */
  rel: string;
  kind: "move" | "duplicate" | "conflict" | "unreadable" | "unsafe";
  error?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The question about stray files, or null when there are none; `actions`: the answers, the first one fixes. */
export function strayQuestion(strays: Stray[]): { message: string; actions: string[] } | null {
  if (!strays.length) return null;
  const moves = strays.filter((s) => s.kind === "move").length, copies = strays.filter((s) => s.kind === "duplicate").length;
  const left = strays.length - moves - copies;
  const first = strays.find((s) => s.kind === "move" || s.kind === "duplicate") ?? strays[0];
  const what = `${plural(strays.length, "file")} of this project ${strays.length === 1 ? "has" : "have"} a "\\" in ${strays.length === 1 ? "its" : "their"} name, left by an older version on Linux`
    + ` (e.g. ${first.shown}${first.rel ? `, which belongs at ${first.rel}` : ""}).`;
  const can = [moves ? `${plural(moves, "file")} can be moved where ${moves === 1 ? "it belongs" : "they belong"}` : "",
    copies ? `${plural(copies, "file")} ${copies === 1 ? "is a copy" : "are copies"} of what is there already and can be deleted` : ""].filter(Boolean).join("; ");
  const rest = left ? ` ${plural(left, "file")} can't be moved (something else is there, or the name leads nowhere) and ${left === 1 ? "is" : "are"} left alone.` : "";
  const list = " The Project output lists them all.";
  if (!moves && !copies) return { message: `${what}${rest}${list}`, actions: ["Show list"] };
  // Moved checkpoints are checkpoints like any other: the oldest beyond the number kept go with the next one.
  const checkpoints = strays.some((s) => s.kind === "move" && s.rel.startsWith("build/checkpoints/"))
    ? " Checkpoints moved into build/checkpoints count toward the number kept (checkpoints.keep): the oldest beyond it are removed with the next checkpoint." : "";
  const fix = moves && copies ? "Move and delete copies" : moves ? "Move them" : "Delete copies";
  return { message: `${what} ${can[0].toUpperCase()}${can.slice(1)}.${rest}${checkpoints}${list}`, actions: [fix, "Leave them", "Show list"] };
}

/** Paths under map/ (what goes into the archive) that differ only in case, in groups; none on a Windows root,
 *  whose file system doesn't keep them apart either. */
export function caseClashes(paths: string[], root: string): string[][] {
  if (isWindowsPath(root)) return [];
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const k = p.replace(/\\/g, "/");
    if (!/^map\//i.test(k)) continue;
    const key = k.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), k]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Looks at a project just opened (`root`): says what it found, and moves stray files only when asked to.
 *  Stops saying anything once another project is open. */
export async function checkOpenedProject(w3: W3Api, root: string, out: OutputChannel): Promise<void> {
  const current = () => w3.workspace.project()?.root === root;
  const clashes = caseClashes(w3.workspace.files().map((f) => f.path), root);
  if (clashes.length) {
    for (const g of clashes) out.append(`same name but for case: ${g.join(", ")}`);
    void w3.window.showWarning(`${clashes.map((g) => g.join(" and ")).slice(0, 3).join("; ")}${clashes.length > 3 ? ` and ${clashes.length - 3} more` : ""}`
      + ` differ only in case. The app keeps them apart, but the map archive (like the game) holds only one name, so Build refuses until one is renamed.`);
  }
  let strays: Stray[];
  try {
    strays = await w3.backend.invoke<Stray[]>("project_strays", { root });
  } catch (e) {
    out.append(`could not look for stray files: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const question = strayQuestion(strays);
  if (!question || !current()) return;
  out.append(`${plural(strays.length, "stray file")} (a "\\" in the name):`);
  for (const s of strays) out.append(`  ${s.shown} → ${s.rel || "(nowhere)"}: ${s.kind}${s.error ? ` (${s.error})` : ""}`);
  let answer = await w3.window.showWarning(question.message, ...question.actions);
  if (answer === "Show list") { out.show(); return; }
  if (answer !== question.actions[0] || !current()) return;
  let moved = 0, deleted = 0;
  const failed: string[] = [];
  for (const s of strays.filter((x) => x.kind === "move" || x.kind === "duplicate")) {
    if (!current()) break;
    try {
      const done = await w3.backend.invoke<"moved" | "deleted">("project_fix_stray", { root, path: s.path });
      if (done === "moved") moved++; else deleted++;
      out.append(`  ${done}: ${s.shown}${done === "moved" ? ` → ${s.rel}` : ""}`);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      failed.push(`${s.shown}: ${why}`);
      out.append(`  left: ${s.shown}: ${why}`);
    }
  }
  if (current()) await w3.workspace.refresh();
  const done = [moved ? `${plural(moved, "file")} moved` : "", deleted ? `${plural(deleted, "copy", "copies")} deleted` : ""].filter(Boolean).join(", ") || "Nothing moved";
  answer = failed.length
    ? await w3.window.showWarning(`${done}; ${plural(failed.length, "file")} left as ${failed.length === 1 ? "it was" : "they were"}: ${failed[0]}${failed.length > 1 ? " …" : ""}`, "Show list")
    : await w3.window.showInfo(`${done}.`);
  if (answer === "Show list") out.show();
}
