// The map script as the MCP tools tell about it.

import type { JassSymbol } from "../../lib/jass/env";

const SHOWN = 30;

interface Found { from: number; message: string; severity: string }

/** Errors first, each with what a reader needs to fix it without opening the script: the code at
 *  that line, and which trigger wrote the function around it. */
export function describeProblems(text: string, found: Found[], triggers: ReadonlyMap<string, string>) {
  const lines = text.split("\n");
  const inFunction = (line: number) => {
    for (let i = line; i >= 0; i--) {
      const m = /^\s*(?:constant\s+)?function\s+(\w+)/.exec(lines[i]);
      if (m) return m[1];
      if (/^\s*endfunction\b/.test(lines[i]) && i !== line) return null;
    }
    return null;
  };
  const items = [...found].sort((a, b) => Number(a.severity !== "error") - Number(b.severity !== "error") || a.from - b.from).map((d) => {
    const line = text.slice(0, d.from).split("\n").length;
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
