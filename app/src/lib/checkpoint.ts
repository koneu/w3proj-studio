// A checkpoint before something that can't be undone (discarding changes, replacing a script):
// what it destroys exists nowhere else, so a checkpoint that fails must not be passed over quietly.

import type { W3Api } from "../extensions/api";
import { commandNotFound } from "./commanderror";

const CREATE = "w3.checkpoints.create";

/** Makes a checkpoint first; true when the caller may go on. Without the checkpoints extension
 *  (disabled) it goes on, as the callers say ("where they're enabled"); a checkpoint that fails asks
 *  whether to go on without one. `what`: the action, for the question ("Discard 3 changes"). */
export async function checkpointBefore(w3: W3Api, what: string): Promise<boolean> {
  try {
    await w3.commands.execute(CREATE, { quiet: true });
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message === commandNotFound(CREATE)) return true;
    const go = "Continue without a checkpoint";
    return (await w3.window.showWarning(`The checkpoint failed: ${message}. ${what} anyway? Nothing keeps what it replaces.`, go, "Cancel")) === go;
  }
}
