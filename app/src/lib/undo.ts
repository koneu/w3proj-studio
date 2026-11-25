// Undo/redo for form-style editors, by snapshots taken after each change.
//
// The editor changes its data as before and then calls `commit()`; the history compares a
// snapshot (a string, e.g. JSON) with the last one and records the difference as one step.
// Consecutive commits with the same `group` (typing in one field) stay one step. Dirty is
// "differs from the saved snapshot", so undoing back to the saved state is clean again.

import { addKeyContext, UNDO_CONTEXT, undoStepOf } from "./keybindings";

/** The saved point of an editor that keeps its own undo stack of snapshots (dirty when the stack's depth differs from
 *  `at`). `take` is called before a save writes, `saved` when it ends: an edit made while the save wrote stays unsaved
 *  (the file holds the state of `take`), and an undo or redo meanwhile leaves the tab unsaved too. */
export class StackSave {
  /** Undo depth at the last save; -1: no depth is the saved one. */
  at = 0;
  private moves = 0;
  take(depth: number) { return { depth, moves: this.moves }; }
  /** An undo or redo ran. */
  moved() { this.moves++; }
  saved(taken: { depth: number; moves: number }) { this.at = taken.moves === this.moves ? taken.depth : -1; }
  /** A change was pushed at `depth` (the stack's new length): a save point that was undone past can't be reached again. */
  pushed(depth: number) { if (this.at > depth - 1) this.at = -1; }
}

/** Undo/redo of an editor that keeps whole states of its own (objects, not strings): `push` the state before each
 *  change; one push is one step, whatever changed. Dirty is "the depth differs from the saved one" (StackSave), so an
 *  edit made while a save writes stays unsaved, and so does an undo or redo meanwhile. */
export class StateStack<T> {
  private undos: T[] = [];
  private redos: T[] = [];
  private mark = new StackSave();

  /** Records `before`, the state as it was before a change, as one step; the redo steps are dropped. */
  push(before: T) {
    this.undos.push(before);
    this.redos = [];
    this.mark.pushed(this.undos.length);
  }
  /** The state the next undo (or redo) would go back to, without moving. */
  peek(step: "undo" | "redo"): T | undefined { return (step === "undo" ? this.undos : this.redos).at(-1); }
  /** Takes the next undo (or redo) state; `current(next)` is the state now, kept for the way back. Undefined (and
   *  nothing moves) when there is no step. */
  move(step: "undo" | "redo", current: (next: T) => T): T | undefined {
    const [from, to] = step === "undo" ? [this.undos, this.redos] : [this.redos, this.undos];
    const next = from.pop();
    if (next === undefined) return undefined;
    this.mark.moved();
    to.push(current(next));
    return next;
  }
  /** The point the next save writes; `saved` with it once written. */
  take() { return this.mark.take(this.undos.length); }
  saved(taken: ReturnType<StackSave["take"]>) { this.mark.saved(taken); }
  get dirty(): boolean { return this.undos.length !== this.mark.at; }
  get canUndo(): boolean { return this.undos.length > 0; }
  get canRedo(): boolean { return this.redos.length > 0; }
}

/** One step of a StepHistory: its label, what the editor keeps to take it back and do it again (`data`), and `id`, the
 *  state after it: unique within the history and never given again, so a saved state is known again after undo and
 *  redo, and a step that was dropped is never mistaken for a new one. */
export interface Step<T> { readonly label: string; readonly id: number; readonly data: T }

/** Undo/redo of an editor that records labelled steps (e.g. the state before and after a change): `push` each change
 *  done, `undo`/`redo` hand back the step to take back or do again. Unsaved is judged by state, not content: the
 *  state after the last step done (`state`, its id; 0 before the first) against the one saved, so the content of the
 *  saved state reached by another step is unsaved, and a save that took `state` when it began leaves an edit made
 *  while it wrote unsaved. */
export class StepHistory<T> {
  private steps: Step<T>[] = [];
  /** How many of `steps` are done (the rest are the redo steps). */
  private at = 0;
  private nextId = 1;
  /** The state before the oldest step kept: 0, or the id of the last step the limit dropped. */
  private base = 0;
  private savedAt = 0;
  private readonly limit: number;

  /** `limit`: how many undo steps are kept at most (the oldest go first); no limit by default. */
  constructor(opts: { limit?: number } = {}) { this.limit = opts.limit ?? Infinity; }

  /** Records a change done as one step; the redo steps are dropped. The id of the state now. */
  push(label: string, data: T): number {
    const step = { label, id: this.nextId++, data };
    this.steps.splice(this.at, this.steps.length, step);
    if (this.steps.length > this.limit) this.base = this.steps.shift()!.id;
    this.at = this.steps.length;
    return step.id;
  }
  /** The step to take back (now done no more); undefined, and nothing moves, when there is none. */
  undo(): Step<T> | undefined { return this.at > 0 ? this.steps[--this.at] : undefined; }
  /** The step to do again; undefined, and nothing moves, when there is none. */
  redo(): Step<T> | undefined { return this.at < this.steps.length ? this.steps[this.at++] : undefined; }
  /** The state now: the id of the last step done, or the state before the oldest step kept. */
  get state(): number { return this.at ? this.steps[this.at - 1].id : this.base; }
  /** Whether step `id` is the one redo does next. */
  isNext(id: number): boolean { return this.at < this.steps.length && this.steps[this.at].id === id; }
  /** The steps done since the saved state, oldest first; null when the saved state isn't behind now (it's a redo step's,
   *  or gone). */
  sinceSaved(): Step<T>[] | null {
    for (let p = this.at; p >= 0; p--) if ((p ? this.steps[p - 1].id : this.base) === this.savedAt) return this.steps.slice(p, this.at);
    return null;
  }
  /** Forgets every step: the state now is a new start (0), and it's the saved one. Ids are never given again. */
  clear() { this.steps = []; this.at = 0; this.base = 0; this.savedAt = 0; }
  /** The state `state` (taken when a save began) is the one on disk now. */
  markSaved(state = this.state) { this.savedAt = state; }
  /** The state last saved (see `state`). */
  get saved(): number { return this.savedAt; }
  get dirty(): boolean { return this.state !== this.savedAt; }
  get canUndo(): boolean { return this.at > 0; }
  get canRedo(): boolean { return this.at < this.steps.length; }
}

export class History {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private current: string;
  private saved: string;
  private group: unknown = undefined;
  private readonly limit: number;

  /** `take`: the editor's state as a string; `restore`: puts a taken state back (and re-renders). `limit`: how many
   *  undo steps are kept at most (the oldest go first); no limit by default. */
  constructor(private take: () => string, private restore: (state: string) => void, opts: { limit?: number } = {}) {
    this.current = this.saved = take();
    this.limit = opts.limit ?? Infinity;
  }

  /** Records the change since the last commit; false when nothing changed. */
  commit(group?: unknown): boolean {
    const next = this.take();
    if (next === this.current) return false;
    if (group === undefined || group !== this.group || !this.undoStack.length) {
      this.undoStack.push(this.current);
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
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

  /** The current state is what's on disk now; `state`: the one taken when the save began (an edit made while it was
   *  writing stays unsaved). */
  /** The state now, for `markSaved` once the save that took it ends. */
  mark(): string { return this.current; }
  markSaved(state?: string) { this.saved = state ?? this.current; this.group = undefined; }
  get dirty(): boolean { return this.current !== this.saved; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
}

/** The keys of Undo and Redo (Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z by default: lib/keybindings.ts UNDO_BINDINGS) anywhere in
 *  `el` run `undo`/`redo`, also in form fields (in a form the focus is nearly always in one): the focused field is
 *  blurred first, so a value typed but not yet committed becomes a step of its own. Code editors (contenteditable) keep
 *  their own undo. `commandsFor` is what a key is bound to (w3.keybindings.commandsFor). Returns the listener's
 *  remover. */
export function bindUndoKeys(el: HTMLElement, undo: () => void, redo: () => void, commandsFor: (e: KeyboardEvent) => readonly string[]): () => void {
  if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
  addKeyContext(el, UNDO_CONTEXT);
  const onKey = (e: KeyboardEvent) => {
    const step = undoStepOf(commandsFor(e));
    if (!step) return;
    const isUndo = step === "undo";
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
