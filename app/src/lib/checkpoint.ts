// A checkpoint before something that can't be undone (discarding changes, replacing a script):
// what it destroys exists nowhere else, so a checkpoint that fails must not be passed over quietly.

import type { W3Api } from "../extensions/api";
import { commandNotFound } from "./commanderror";

const CREATE = "w3.checkpoints.create";

/** Whether this session has said that checkpoints are off (see checkpointIfOn). */
let saidOff = false;

/** Makes a checkpoint before a change that only a checkpoint takes back (Delete Invalid Objects, importing
 *  objects, replacing a sound, AI edits); true when one was made. Without the checkpoints extension (disabled)
 *  the change goes on without one: the first time in a session a warning says so, later ones are quiet. A
 *  checkpoint that fails otherwise throws, so the caller stops before changing anything. `what`: the change
 *  ("Delete Invalid Objects"). */
export async function checkpointIfOn(w3: W3Api, what: string): Promise<boolean> {
  try {
    await w3.commands.execute(CREATE, { quiet: true });
    return true;
  } catch (e) {
    if ((e instanceof Error ? e.message : String(e)) !== commandNotFound(CREATE)) throw e;
    if (!saidOff) {
      saidOff = true;
      void w3.window.showWarning(`${what} went on without a checkpoint: the Checkpoints extension is off, so there is none to go back to. `
        + "Changes like this one aren't checkpointed until it is on again (said once per session).");
    }
    return false;
  }
}

/** For tests: the next checkpointIfOn without the extension warns again, as in a new session. */
export function forgetCheckpointsOffWarning() { saidOff = false; }

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
