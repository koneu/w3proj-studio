import { Turns } from "./turns";

/** The derived files (pathing, shadows, minimap) due after a burst of edits, and the one rebuild that makes them.
 *  `T` is the state before the first edit (shadows are updated from there). The job is dropped from `pending` before
 *  its work starts, so a rebuild that fails is not due again: a later settle (a save, a checkpoint, a map resize)
 *  finds nothing to wait for. Rebuilds run one at a time, as they write the same files. */
export class RebuildJobs<T> {
  private job: { key: string; from: T } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly turns = new Turns();

  constructor(private readonly deps: {
    /** The open project's root, "" with none. */
    project(): string | null | undefined;
    /** Whether an editor of the project's own terrain is open, and its root: it works from what it has loaded. */
    editorRoot(): string | null;
    /** The project's terrain file; null when it has none. */
    terrainPath(): string | null;
    /** Makes the files from the open editor's state. */
    deriveOpen(from: T): Promise<void>;
    /** Makes the files from the project's saved files (the editor closed since the edit). */
    deriveSaved(key: string, path: string, from: T): Promise<void>;
    delayMs: number;
  }) {}

  /** The rebuild is due (for `key`, unless one is already due for it) `delayMs` after the last call. */
  soon(from: () => T): void {
    const key = this.deps.project() ?? "";
    if (this.job?.key !== key) this.job = { key, from: from() };
    clearTimeout(this.timer);
    // A failure is shown by the rebuild itself.
    this.timer = setTimeout(() => void this.run().catch(() => {}), this.deps.delayMs);
  }

  /** Whether a rebuild is due. */
  get pending(): boolean { return this.job !== null; }

  /** Runs the rebuild now if one is due (and any running one ends first). Rejects when the rebuild fails. */
  run(): Promise<void> {
    return this.turns.run(async () => {
      const job = this.job;
      if (!job || job.key !== this.deps.project()) return;
      const editorRoot = this.deps.editorRoot();
      // Closed since the edit, it stays closed: the files are made from the project's saved ones.
      if (editorRoot === null) {
        const path = this.deps.terrainPath();
        if (!path) return;
        this.job = null;
        await this.deps.deriveSaved(job.key, path, job.from);
        return;
      }
      // The wait was long enough for another project to be opened: its job and editor are not this one's.
      if (this.job !== job || job.key !== this.deps.project() || editorRoot !== job.key) return;
      this.job = null;
      await this.deps.deriveOpen(job.from);
    });
  }

  /** What a settle does: the wait for the next burst ends, the rebuild runs now. */
  settle(): Promise<void> {
    clearTimeout(this.timer);
    return this.run();
  }

  /** The wait ends without a rebuild; the state due stays (a later settle makes it). */
  stopTimer(): void {
    clearTimeout(this.timer);
  }

  /** The rebuild due for project `key`, taken in by the caller (which rebuilds from it): its state before. */
  take(key: string): T | null {
    clearTimeout(this.timer);
    const due = this.job?.key === key ? this.job.from : null;
    if (due) this.job = null;
    return due;
  }

  /** Nothing is due: it was planned for terrain that has been replaced. */
  drop(): void {
    clearTimeout(this.timer);
    this.job = null;
  }

  /** The rebuilds' turns, for callers that queue their own work (a save's update, a checkpoint). */
  get queue(): Turns { return this.turns; }
}
