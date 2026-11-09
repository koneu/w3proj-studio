// Objects that triggers name by a generated global (regions gg_rct_, cameras gg_cam_), renamed in an editor:
// which were renamed since the last save, and the triggers following the saved names.

import type { W3Api } from "../../extensions/api";

/** The names objects had at the last save. Editors replace an object by an edited copy (undo keeps the
 *  old one), so a copy is marked as the same object (`copy`); objects made since have no saved name. */
export class SavedNames<T extends { name: string }> {
  private lineage = new WeakMap<T, number>();
  private next = 1;
  private names = new Map<number, string>();

  private key(o: T): number {
    let k = this.lineage.get(o);
    if (k === undefined) this.lineage.set(o, (k = this.next++));
    return k;
  }
  /** `to` is an edited copy of `from`; returns `to`. */
  copy(from: T, to: T): T {
    this.lineage.set(to, this.key(from));
    return to;
  }
  /** `list` is what was saved (or read). */
  saved(list: readonly T[]) {
    this.names = new Map(list.map((o) => [this.key(o), o.name]));
  }
  /** [saved name, name now] of the objects in `list` renamed since. */
  renamed(list: readonly T[]): [string, string][] {
    const out: [string, string][] = [];
    for (const o of list) {
      const was = this.names.get(this.key(o));
      if (was !== undefined && was !== o.name) out.push([was, o.name]);
    }
    return out;
  }
}

/** The triggers follow renamed objects (w3.triggers.renameGlobals: GUI parameters, script text after a
 *  question). A failure is shown, not thrown: the objects are saved already. */
export async function renameInTriggers(w3: W3Api, kind: string, renamed: [string, string][], what: string): Promise<void> {
  try {
    const n = await w3.commands.execute<{ gui: number; script: number; inEditor: boolean } | null>("w3.triggers.renameGlobals", kind, renamed, what);
    if (n && (n.gui || n.script)) {
      w3.output.channel("Triggers").append(`renamed ${what} in triggers: ${n.gui} parameter${n.gui === 1 ? "" : "s"}${n.script ? `, ${n.script} use${n.script === 1 ? "" : "s"} in script` : ""}${n.inEditor ? " (in the Trigger Editor)" : ""}`);
    }
  } catch (e) {
    void w3.window.showError(`The ${what} are saved, but their references in the triggers couldn't be renamed: ${e instanceof Error ? e.message : String(e)}. Problems › References in triggers lists them.`);
  }
}
