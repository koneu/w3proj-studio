// Where a text editor was in its file (kept with the project's open tabs): the selection and the first line in sight.

export interface TextViewState { anchor: number; head: number; top: number }

/** A remembered state for a text of `length` characters and `lines` lines, or null when it isn't one. The file may
 *  have changed since (another program, a sync): positions past its end go to its end. */
export function textViewIn(state: unknown, length: number, lines: number): TextViewState | null {
  if (!state || typeof state !== "object") return null;
  const { anchor, head, top } = state as Record<string, unknown>;
  const pos = (v: unknown, max: number, min = 0) => (typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(Math.floor(v), max)) : null);
  const a = pos(anchor, length), h = pos(head, length), t = pos(top, lines, 1);
  return a === null || h === null || t === null ? null : { anchor: a, head: h, top: t };
}
