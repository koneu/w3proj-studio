// Opening a project whose terrain is still in the flat layout (map/war3map.w3e.txt and the flat object files) converts
// it into map/terrain/, the only layout since 2026-11-26 (docs/terrain-subterrains-spec.md); a campaign's chapter maps
// too. The backend does it (crates/backend flatview.rs convert_on_open), once per open and before the project's files
// are listed; this tells the user once what happened, or why a project stayed as it was.

/** What the backend's terrain_convert_on_open did (flatview.rs OpenConversion). */
export interface OpenConversion {
  /** "" the project opened, `maps/<chapter>` a chapter map. */
  converted: string[];
  /** Left as they were: [project, why]. */
  kept: [string, string][];
  message: string | null;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type Notify = (severity: "info" | "warning", message: string) => void;

/** Converts the project at `path` if its terrain is still flat; returns a function that tells the user (call it once
 *  the project is open, so the message isn't left behind by the switch). A check that fails doesn't stop the open: the
 *  project opens as it is, and the user is told why it wasn't converted. */
export async function convertFlatTerrain(invoke: Invoke, path: string): Promise<(notify: Notify) => void> {
  let done: OpenConversion;
  try {
    done = await invoke<OpenConversion>("terrain_convert_on_open", { path });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return (notify) => notify("warning", `The project's terrain layout couldn't be checked, so it opens as it is: ${why}`);
  }
  const message = done.message;
  if (!message) return () => {};
  return (notify) => notify(done.kept.length ? "warning" : "info", message);
}
