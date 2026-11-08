// The map script as the MCP tools tell about it.

import type { JassSymbol } from "../../lib/jass/env";

const SHOWN = 30;

interface Found { from: number; message: string; severity: string }

/** Counts the steps describeProblems takes (lines looked at, binary search rounds): for a test that
 *  pins the work as linear in the script's size. */
export interface Work { steps: number }

/** Offset of each line's first character (line 1 at index 0). */
function lineStarts(text: string, work?: Work): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) {
    starts.push(i + 1);
    if (work) work.steps++;
  }
  return starts;
}

/** The 1-based line holding `offset`, as `text.slice(0, offset).split("\n").length` counts it: the
 *  last line start at or before the offset (an offset past the end is on the last line). */
function lineAt(starts: readonly number[], offset: number, work?: Work): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    if (work) work.steps++;
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const FUNCTION_LINE = /^\s*(?:constant\s+)?function\s+(\w+)/;
const ENDFUNCTION_LINE = /^\s*endfunction\b/;

/** Errors first, each with what a reader needs to fix it without opening the script: the code at
 *  that line, and which trigger wrote the function around it. */
export function describeProblems(text: string, found: Found[], triggers: ReadonlyMap<string, string>, work?: Work) {
  const lines = text.split("\n");
  const starts = lineStarts(text, work);
  // The function a line belongs to, found in one pass over the lines up to the last one asked about:
  // `before[i]` is the function open at line i counting an `endfunction` there as closing it.
  const before: (string | null)[] = [];
  const opening = (i: number) => FUNCTION_LINE.exec(lines[i])?.[1] ?? null;
  const closedBy = (i: number) => {
    for (let j = before.length; j <= i; j++) {
      if (work) work.steps++;
      before.push(opening(j) ?? (ENDFUNCTION_LINE.test(lines[j]) ? null : (before[j - 1] ?? null)));
    }
    return before[i];
  };
  // The line's own `function` names it; an `endfunction` on the line itself still belongs to the function.
  const inFunction = (line: number) => opening(line) ?? (line > 0 ? closedBy(line - 1) : null);
  const items = [...found].sort((a, b) => Number(a.severity !== "error") - Number(b.severity !== "error") || a.from - b.from).map((d) => {
    const line = lineAt(starts, d.from, work);
    const fn = inFunction(line - 1), trigger = fn ? triggers.get(fn) : undefined;
    return { severity: d.severity, message: d.message, line, code: lines[line - 1]?.trim() ?? "", ...(fn ? { function: fn } : {}), ...(trigger ? { trigger } : {}) };
  });
  return { errors: items.filter((i) => i.severity === "error").length, warnings: items.filter((i) => i.severity !== "error").length, problems: items.slice(0, SHOWN) };
}

const API_KINDS = new Set(["native", "function", "global", "constant", "type"]);

/** The game's names matching a filter: exact first, then those starting with it. */
export function findSymbols(all: JassSymbol[], filter: string, kind?: string) {
  const wanted = filter.toLowerCase();
  const rank = (name: string) => (name === wanted ? 0 : name.startsWith(wanted) ? 1 : 2);
  return all
    .filter((s) => API_KINDS.has(s.kind) && (!kind || s.kind === kind) && s.name.toLowerCase().includes(wanted))
    .sort((a, b) => rank(a.name.toLowerCase()) - rank(b.name.toLowerCase()) || a.name.localeCompare(b.name))
    .map((s) => ({ name: s.name, kind: s.kind, signature: s.detail }));
}
