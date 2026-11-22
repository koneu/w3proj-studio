// The trigger folders (map/triggers/) in a test's made-up project, without the backend: a fake workspace stands them
// in two entries, map/triggers/triggers.json holding the TriggerFile the backend's read gives (as JSON, with its custom
// texts in `texts` if it has any) and map/triggers/header.j the custom script header. Tests whose point is the folders themselves use the real backend
// (crates/backend/src/triggers.rs, headless/rustbackend.ts).

import { TRIGGERS_ROOT, type ProjectTriggers } from "../triggers/project";
import { textTriggers, type TriggerFile } from "../triggers/wtg";

export const HEADER_FILE = "map/triggers/header.j";

/** A fake workspace's readTriggers over `get` (a file's text, undefined when absent; it may throw for one that can't
 *  be read). Null without the root entry; one that isn't a TriggerFile throws, as the backend's read does. */
export function fakeReadTriggers(get: (path: string) => string | undefined | Promise<string | undefined>): () => Promise<ProjectTriggers | null> {
  return async () => {
    const root = await get(TRIGGERS_ROOT);
    if (root === undefined) return null;
    // The custom texts may come along as `texts` (textTriggers order).
    const { texts, ...file } = JSON.parse(root) as TriggerFile & { texts?: (string | null)[] };
    if (typeof file?.reforged !== "boolean" || !Array.isArray(file.items) || !Array.isArray(file.variables)) throw new Error(`${TRIGGERS_ROOT} isn't a trigger tree`);
    const header = (await get(HEADER_FILE)) ?? null;
    return {
      file, custom: { reforged: file.reforged, version: 1, comment: "", header, texts: textTriggers(file).map((_, i) => texts?.[i] ?? null) },
      files: file.items.map(() => null), headerFile: header === null ? null : HEADER_FILE, stored: {}, language: "jass", script: "kept", warnings: [],
    };
  };
}
