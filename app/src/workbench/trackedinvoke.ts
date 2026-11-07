import type { Stamp, WorkspaceService } from "./workspace";
import { invoke } from "./backend";

/** `w3.backend.invoke`. A command that writes a project file (`codec_write`) goes through the workspace,
 *  so its answer, the file's size and time, is noted and the save isn't later taken for a change by
 *  another program. Every extension is covered, with nothing for a caller to remember. */
export function backendInvoke<T>(workspace: Pick<WorkspaceService, "project" | "tracked">, command: string, args?: Record<string, unknown>): Promise<T> {
  if (command !== "codec_write" || typeof args?.path !== "string" || !workspace.project()) return invoke<T>(command, args);
  let answer: unknown;
  return workspace.tracked(args.path, typeof args.text === "string" ? args.text.length : 0, async () => {
    answer = await invoke<Stamp>(command, args);
    return answer as Stamp;
  }).then(() => answer as T);
}
