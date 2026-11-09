// Renaming what triggers refer to by generated globals (gg_trg_, gg_rct_, gg_cam_ and the like): the GUI
// parameters naming them, and script text (the map header, custom text triggers, Custom Script actions),
// where a global is replaced only as a whole identifier. All renames go in one pass, so names that swap
// places (A → B and B → A at once) end up swapped.

import { ident } from "../script/names";
import type { Param, TriggerFile } from "./wtg";

/** Old global → new global for renamed objects of one kind ("trg", "rct", "cam"); unchanged ones left out. */
export function globalRenames(kind: string, renames: Iterable<readonly [from: string, to: string]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [from, to] of renames) {
    const a = `gg_${kind}_${ident(from)}`, b = `gg_${kind}_${ident(to)}`;
    if (a !== b) out.set(a, b);
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Any of the names as a whole identifier. */
function wordsOf(names: Iterable<string>): RegExp | null {
  const list = [...names];
  if (!list.length) return null;
  return new RegExp(`(?<![A-Za-z0-9_])(?:${list.sort((a, b) => b.length - a.length).map(escape).join("|")})(?![A-Za-z0-9_])`, "g");
}

/** How often the old names appear in a text, as whole identifiers. */
export function countInText(text: string | null, renames: ReadonlyMap<string, string>): number {
  const re = wordsOf(renames.keys());
  return text && re ? text.match(re)?.length ?? 0 : 0;
}

/** The text with each old name replaced by its new one (whole identifiers only). */
export function renameInText(text: string, renames: ReadonlyMap<string, string>): string {
  const re = wordsOf(renames.keys());
  return re ? text.replace(re, (m) => renames.get(m) ?? m) : text;
}

type E = { name: string; params: Param[]; children: E[] };

/** The GUI parameters naming one of the old globals (variable parameters; nested calls and indexes too). */
export function globalParams(file: TriggerFile, renames: ReadonlyMap<string, string>): Param[] {
  const out: Param[] = [];
  const visit = (p: Param) => {
    if (p.type === 1 && renames.has(p.value)) out.push(p);
    p.call?.params.forEach(visit);
    if (p.index) visit(p.index);
  };
  const walk = (e: E) => { e.params.forEach(visit); e.children.forEach(walk); };
  for (const it of file.items) if ("ecas" in it) (it.ecas as E[]).forEach(walk);
  return out;
}

/** "Custom Script" actions' text parameters (script text inside GUI triggers). */
export function customScriptParams(file: TriggerFile): Param[] {
  const out: Param[] = [];
  const walk = (e: E) => { if (e.name === "CustomScriptCode" && e.params[0]) out.push(e.params[0]); e.children.forEach(walk); };
  for (const it of file.items) if ("ecas" in it) (it.ecas as E[]).forEach(walk);
  return out;
}

export interface RenameCount { gui: number; script: number }

/** How many GUI parameters and script uses the renames would change. `scripts`: the map header and
 *  custom texts. */
export function countRenames(file: TriggerFile, scripts: (string | null)[], renames: ReadonlyMap<string, string>): RenameCount {
  return {
    gui: globalParams(file, renames).length,
    script: scripts.reduce((n, s) => n + countInText(s, renames), 0) + customScriptParams(file).reduce((n, p) => n + countInText(p.value, renames), 0),
  };
}

/** Applies the renames to the GUI parameters, and with `withScripts` to the script texts (through `set`)
 *  and Custom Script actions. Returns what changed. */
export function applyRenames(file: TriggerFile, scripts: { get(): string | null; set(text: string): void }[], renames: ReadonlyMap<string, string>, withScripts: boolean): RenameCount {
  const params = globalParams(file, renames);
  for (const p of params) p.value = renames.get(p.value)!;
  let script = 0;
  if (withScripts) {
    for (const s of scripts) {
      const t = s.get(), n = countInText(t, renames);
      if (t !== null && n) { s.set(renameInText(t, renames)); script += n; }
    }
    for (const p of customScriptParams(file)) {
      const n = countInText(p.value, renames);
      if (n) { p.value = renameInText(p.value, renames); script += n; }
    }
  }
  return { gui: params.length, script };
}
