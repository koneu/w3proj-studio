// Undo/redo for form-style editors, by snapshots taken after each change.
//
// The editor changes its data as before and then calls `commit()`; the history compares a
// snapshot (a string, e.g. JSON) with the last one and records the difference as one step.
// Consecutive commits with the same `group` (typing in one field) stay one step. Dirty is
// "differs from the saved snapshot", so undoing back to the saved state is clean again.

export class History {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private current: string;
  private saved: string;
  private group: unknown = undefined;

  /** `take`: the editor's state as a string; `restore`: puts a taken state back (and re-renders). */
  constructor(private take: () => string, private restore: (state: string) => void) {
    this.current = this.saved = take();
  }

  /** Records the change since the last commit; false when nothing changed. */
  commit(group?: unknown): boolean {
    const next = this.take();
    if (next === this.current) return false;
    if (group === undefined || group !== this.group || !this.undoStack.length) this.undoStack.push(this.current);
    this.group = group;
    this.redoStack = [];
    this.current = next;
    return true;
  }

  undo(): boolean { return this.step(this.undoStack, this.redoStack); }
  redo(): boolean { return this.step(this.redoStack, this.undoStack); }

  private step(from: string[], to: string[]): boolean {
    const state = from.pop();
    if (state === undefined) return false;
    to.push(this.current);
    this.current = state;
    this.group = undefined;
    this.restore(state);
    return true;
  }

  /** The current state is what's on disk now. */
  markSaved() { this.saved = this.current; this.group = undefined; }
  get dirty(): boolean { return this.current !== this.saved; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
}

/** Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z anywhere in `el` run `undo`/`redo`, also in form fields (in a
 *  form the focus is nearly always in one): the focused field is blurred first, so a value typed
 *  but not yet committed becomes a step of its own. Code editors (contenteditable) keep their own
 *  undo. Returns the listener's remover. */
export function bindUndoKeys(el: HTMLElement, undo: () => void, redo: () => void): () => void {
  if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    const isUndo = k === "z" && !e.shiftKey, isRedo = k === "y" || (k === "z" && e.shiftKey);
    if (!isUndo && !isRedo) return;
    const t = e.target as HTMLElement;
    if (t.isContentEditable) return;
    e.preventDefault();
    if (t !== el && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)) t.blur();
    // Focus stays in the editor (the re-render may remove the field), so the next Ctrl+Z works too.
    el.focus({ preventScroll: true });
    if (isUndo) undo(); else redo();
  };
  el.addEventListener("keydown", onKey);
  return () => el.removeEventListener("keydown", onKey);
}
