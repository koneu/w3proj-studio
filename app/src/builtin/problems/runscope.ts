// What the checks of one Problems run share, so that a run reads each thing once: the map's documents
// (several checks read the object data and the placement files), and one lookup of the map's files,
// whose game paths are resolved in batches. A scope lives for one run only: the next run, and another
// project, start with nothing cached, so nothing found in one project's files is used for another's.

import type { W3Api } from "../../extensions/api";
import { readMapDoc, readMapDocStrict } from "../../lib/formats/mapdoc";
import { parseIni } from "../../lib/formats/text";
import { parseTriggerData, type TriggerData } from "../../lib/triggers/triggerdata";
import { validateTriggers, type TriggerIssue } from "../../lib/triggers/validate";
import { readWctFile, readWtgFile, textTriggers, wtgPath, type TriggerFile } from "../../lib/triggers/wtg";
import { FileLookup } from "./checks";

export class RunScope {
  private docs = new Map<string, Promise<unknown>>();
  private files: FileLookup | null = null;
  /** `share` false: every call reads again, as without a scope (the control of the read-count test). */
  constructor(private w3: W3Api, private share = true) {}

  /** A map document as readMapDoc reads it, read once per run. Callers must not change it. */
  doc<T>(path: string): Promise<T | null> {
    if (!this.share) return readMapDoc<T>(this.w3, path);
    let p = this.docs.get(path);
    if (!p) {
      p = readMapDoc<T>(this.w3, path);
      this.docs.set(path, p);
    }
    return p as Promise<T | null>;
  }

  /** As readMapDocStrict: a document that is there but can't be read throws, an absent one is null. */
  docStrict<T>(path: string): Promise<T | null> {
    return readMapDocStrict<T>(this.w3, path, (_, p) => this.doc(p));
  }

  /** Starts reading these documents at once, instead of one after another as the checks ask. */
  async prefetch(paths: string[]): Promise<void> {
    if (this.share) await Promise.all(paths.map((p) => this.doc(p)));
  }

  private triggerFile: Promise<TriggerFile | null> | null = null;
  private data: Promise<TriggerData> | null = null;

  /** The game's TriggerData with its display names (WorldEditStrings), read once per run. */
  triggerData(): Promise<TriggerData> {
    const load = async () => {
      const strings = new Map<string, string>();
      for (const f of ["UI\\WorldEditStrings.txt", "UI\\WorldEditGameStrings.txt"]) {
        for (const sec of parseIni(await this.w3.game.readText(f, { background: true }).catch(() => "")).values()) for (const [k, v] of sec) strings.set(k.toUpperCase(), v);
      }
      return parseTriggerData(await this.w3.game.readText("UI\\TriggerData.txt", { background: true }), strings);
    };
    if (!this.share) return load();
    return (this.data ??= load());
  }

  /** The project's GUI triggers, read once per run: null without a trigger file; a file that is there and
   *  can't be read rejects (callers tell the two apart). */
  triggers(): Promise<TriggerFile | null> {
    const load = async () => {
      const path = wtgPath(this.w3.workspace.files());
      return path ? readWtgFile(this.w3.workspace, path, () => this.triggerData()) : null;
    };
    if (!this.share) return load();
    return (this.triggerFile ??= load());
  }

  private validation: Promise<TriggerIssue[] | null> | null = null;

  /** What Validate Map Triggers finds in the project's GUI triggers, once per run; null without a trigger
   *  file; rejects when the trigger file is there and can't be read. */
  triggerIssues(): Promise<TriggerIssue[] | null> {
    const load = async () => {
      const file = await this.triggers();
      if (!file) return null;
      const data = await this.triggerData();
      // Script texts that can run triggers: none without the file; when it can't be read, which triggers
      // it runs isn't known (null), and none is called unused.
      const scripts = await readWctFile(this.w3.workspace, textTriggers(file).length).then((c) => (c ? [c.header, ...c.texts] : []), () => null);
      return validateTriggers(file, data, { scripts });
    };
    if (!this.share) return load();
    return (this.validation ??= load());
  }

  /** The run's lookup of the map's and the game's files (made at first use). */
  lookup(): FileLookup {
    if (!this.share) return new FileLookup(this.w3);
    return (this.files ??= new FileLookup(this.w3));
  }
}

/** `f` over `items` with at most `limit` running at once; the results in the order of `items`. */
export async function mapLimit<T, R>(items: T[], limit: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
