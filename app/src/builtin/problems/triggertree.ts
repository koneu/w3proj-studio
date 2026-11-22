// Check Trigger Tree in the Problems view: the backend's findings (`triggers_check`, crates/w3proj/src/trigger_check.rs)
// as problems at their file and line, and its fixes (`triggers_fix`: Renumber, Fix order.txt, Collapse) written as one
// undoable edit when asked for, never on their own.

import type { W3Api } from "../../extensions/api";
import { MCP_EDITS_SERVICE, type McpEditsService, type Problem } from "../../extensions/services";
import { errorText } from "../../lib/oserror";

export type TreeFix = "renumber" | "order" | "collapse";

/** One finding of `triggers_check`. */
export interface TreeIssue {
  severity: "error" | "warning";
  code: string;
  /** Project path (map/triggers/…). */
  file: string;
  line?: number;
  message: string;
  fix?: TreeFix;
}

export const FIXES: Record<TreeFix, { label: string; title: string }> = {
  renumber: { label: "Renumber", title: "Every item that holds a stored id an earlier one holds too loses it, so pack gives it a free one; the earlier keeps its id. Undo takes it back" },
  order: { label: "Fix order.txt", title: "Writes the folders' order.txt as the tree is read: entries whose file is gone go, files it doesn't list are added where they are now (after the listed ones). Undo takes it back" },
  collapse: { label: "Collapse", title: "Removes the later of two alike definitions of a variable (and its second place in an order.txt). Undo takes it back" },
};

/** A finding as a problem: located at its file and line, a click opens the file there, its fix as a button. */
export function treeProblem(i: TreeIssue, fix: (f: TreeFix) => Promise<unknown>): Problem {
  return {
    severity: i.severity,
    message: i.message,
    location: i.line ? `${i.file}:${i.line}` : i.file,
    about: `${i.code}:${i.file}`,
    reveal: { command: "w3.text.revealLine", args: [i.file, i.line ?? 1] },
    ...(i.fix ? { fixes: [{ label: FIXES[i.fix].label, title: FIXES[i.fix].title, run: async () => { await fix(i.fix!); } }] } : {}),
  };
}

/** Writes Check Trigger Tree's `fixes` into the project as one edit (MCP: Undo Last AI Edit, and the Problems run after
 *  it, take it back / show what is left). Refused while anything is unsaved: the Trigger Editor's own document would
 *  write over it. The plan is made from the files as they are when the edit runs. Resolves with the files changed. */
export async function fixTriggerTree(w3: W3Api, fixes: TreeFix[]): Promise<number> {
  const what = `Check Trigger Tree: ${fixes.map((f) => FIXES[f].label).join(", ")}`;
  const root = w3.workspace.project()?.root;
  if (!root) throw new Error(`${what}: no project is open.`);
  const unsaved = w3.editors.unsavedPaths();
  if (unsaved.length) throw new Error(`${what}: save or discard the changes in ${unsaved.join(", ")} first.`);
  const edits = await w3.services.get<McpEditsService>(MCP_EDITS_SERVICE);
  let n = 0;
  await edits.edit(what, async () => {
    // The answer may have come after a switch of the project: never another project's files.
    if (w3.workspace.project()?.root !== root) throw new Error(`${what}: the project changed meanwhile; nothing was changed.`);
    let plan: { write: { path: string; text: string }[]; delete: string[] };
    try {
      plan = await w3.backend.invoke("triggers_fix", { root, fixes });
    } catch (e) {
      throw new Error(`${what}: ${errorText(e).replace(/\.?$/, ".")} Nothing was changed.`);
    }
    if (w3.workspace.project()?.root !== root) throw new Error(`${what}: the project changed meanwhile; nothing was changed.`);
    const files = [...plan.write.map((w) => ({ path: w.path, text: w.text as string | null })), ...plan.delete.map((path) => ({ path, text: null }))];
    n = files.length;
    return files;
  });
  return n;
}
