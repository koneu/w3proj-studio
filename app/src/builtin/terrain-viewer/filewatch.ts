// Which saved files change what the terrain editor has loaded.
import type { Skin } from "./objects";

/** The minimap and preview are generated from the map, by the editor's own save. They're images
 *  under map/, but no model uses them: taking them for imports reloaded every model on each save. */
const GENERATED_ART = /^map\/war3map(map|preview)\.(blp|tga|dds)$/;

/** An imported model or texture, or the import list: loaded art may be out of date. */
export function changesImports(path: string): boolean {
  const l = path.replace(/\\/g, "/").toLowerCase();
  if (GENERATED_ART.test(l)) return false;
  return /^map\/war3map\.imp(\.json)?$/.test(l) || (l.startsWith("map/") && /\.(mdx|mdl|blp|dds|tga)$/.test(l));
}

/** Object data the map saves: what gives a placed type its model, scale and so on. */
export function changesObjectData(path: string): boolean {
  return /^map\/war3map(skin)?\.w3[udbt](\.json)?$/.test(path.replace(/\\/g, "/").toLowerCase());
}

interface ObjectContext { skins: Map<string, Skin>; bases: Map<string, string> }

/** Of the given ids, those that look different, or are no longer or newly known, between two loads
 *  of the object data. Only placed objects of these need drawing again. */
export function changedTypes(before: ObjectContext, after: ObjectContext, ids: Iterable<string>): Set<string> {
  const look = (c: ObjectContext, id: string) => {
    const own = c.skins.get(id);
    const base = c.bases.get(id);
    const skin = own ?? c.skins.get(base ?? "");
    return skin ? JSON.stringify([skin, own ? null : base]) : "";
  };
  const out = new Set<string>();
  for (const id of ids) if (look(before, id) !== look(after, id)) out.add(id);
  return out;
}

/** A reload that waits for a burst of saves to end, then runs once at a time. Whoever needs what it
 *  loads asks `settled()`: it resolves when nothing is waiting or running, so a tool that follows a
 *  save sees the result of it. */
export class DebouncedReload {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private release: (() => void) | undefined;
  private running: Promise<void> = Promise.resolve();

  constructor(private run: () => Promise<void>, private onError: (e: unknown) => void, private delay = 300) {}

  schedule() {
    clearTimeout(this.timer);
    this.pending ??= new Promise<void>((done) => { this.release = done; });
    this.timer = setTimeout(() => void this.fire(), this.delay);
  }

  settled(): Promise<void> {
    return this.pending ?? Promise.resolve();
  }

  /** Drops what is waiting (a reload that runs already goes on) and ends the wait for it. */
  cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.finish();
  }

  private async fire() {
    this.timer = undefined;
    this.running = this.running.then(() => this.run()).catch((e) => this.onError(e));
    await this.running;
    // Saved again while it ran: the next run is on its way, and it ends the wait.
    if (this.timer === undefined) this.finish();
  }

  private finish() {
    const done = this.release;
    this.pending = this.release = undefined;
    done?.();
  }
}
