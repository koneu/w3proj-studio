// The Problems view's per-map ignore: .w3proj/problems-ignore.json. A report is named by its check and what it
// is about (a trigger's name, else its location and message), never by a line or position, so the entry still
// holds after edits. The file is sorted with fixed keys, so it diffs well in git. A rule is a named group
// (the bonus campaigns' quest library) that ignores every report it recognises, including ones that appear later.
// A file that is there but can't be read is never treated as empty (nothing is hidden, nothing written over it).

import type { Problem } from "../../extensions/services";

export const IGNORE_FILE = ".w3proj/problems-ignore.json";

export interface IgnoreEntry { check: string; about: string }
export interface IgnoreFile { version: 1; rules: string[]; items: IgnoreEntry[] }

/** The quest library every Orc bonus chapter of The Frozen Throne carries (OrcX01 ... OrcX03): triggers named
 *  "Quest <Name> Discovered / Update<N> / Completed / Failed" that nothing in the map runs. Found by reading
 *  those chapters' triggers; the editor's own scripts name none of them either. */
export const BONUS_QUEST_LIBRARY = "bonusQuestLibrary";
const QUEST_LIBRARY_NAME = /^Quest \S+ (Discovered|Update\d*|Completed|Failed)$/;

interface Rule { title: string; check: string; matches(about: string): boolean }
export const RULES: Record<string, Rule> = {
  [BONUS_QUEST_LIBRARY]: { title: "the bonus campaign quest library", check: "triggerNoEvents", matches: (about) => QUEST_LIBRARY_NAME.test(about) },
};

export const emptyIgnore = (): IgnoreFile => ({ version: 1, rules: [], items: [] });

/** What the report is about: the check's own subject (a trigger's name) if it gave one, else where and what. */
export const aboutOf = (p: Pick<Problem, "message" | "location" | "about">) => p.about ?? `${p.location ?? ""}\n${p.message}`;

/** The text of the file for `f`: sorted, no duplicates, stable key order. */
export function serializeIgnore(f: IgnoreFile): string {
  const seen = new Set<string>();
  const items = f.items.filter((i) => { const k = `${i.check}\n${i.about}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.check < b.check ? -1 : a.check > b.check ? 1 : a.about < b.about ? -1 : a.about > b.about ? 1 : 0))
    .map((i) => ({ check: i.check, about: i.about }));
  const rules = [...new Set(f.rules)].sort();
  return `${JSON.stringify({ version: 1, rules, items }, null, 2)}\n`;
}

/** Reads the file's text. Throws with the reason if it isn't an ignore file (so the caller leaves it alone). */
export function parseIgnore(text: string): IgnoreFile {
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { throw new Error(`it isn't valid JSON (${e instanceof Error ? e.message : String(e)})`); }
  const o = v as { version?: unknown; rules?: unknown; items?: unknown } | null;
  if (!o || typeof o !== "object" || Array.isArray(o) || o.version !== 1) throw new Error("it isn't a Problems ignore file (version 1)");
  if (!Array.isArray(o.rules) || !o.rules.every((r) => typeof r === "string")) throw new Error("its rules aren't a list of names");
  if (!Array.isArray(o.items) || !o.items.every((i) => !!i && typeof i === "object" && typeof (i as IgnoreEntry).check === "string" && typeof (i as IgnoreEntry).about === "string")) {
    throw new Error("its items aren't a list of {check, about}");
  }
  return { version: 1, rules: o.rules as string[], items: (o.items as IgnoreEntry[]).map((i) => ({ check: i.check, about: i.about })) };
}

export function isIgnored(f: IgnoreFile, check: string, about: string): boolean {
  if (f.rules.some((r) => RULES[r]?.check === check && RULES[r].matches(about))) return true;
  return f.items.some((i) => i.check === check && i.about === about);
}

/** `f` with these reports (of `check`) added. */
export function withIgnored(f: IgnoreFile, check: string, abouts: string[]): IgnoreFile {
  return { ...f, items: [...f.items, ...abouts.map((about) => ({ check, about }))] };
}

/** `f` without these reports; a rule that ignores one of them is dropped too, and the rest of its reports are
 *  written as single entries, so un-ignoring one report never un-ignores the others. */
export function withoutIgnored(f: IgnoreFile, check: string, about: string, others: string[] = []): IgnoreFile {
  const dropped = f.rules.filter((r) => RULES[r]?.check === check && RULES[r].matches(about));
  const kept = f.rules.filter((r) => !dropped.includes(r));
  const items = f.items.filter((i) => !(i.check === check && i.about === about));
  const extra = others.filter((o) => o !== about && dropped.some((r) => RULES[r].matches(o))).map((o) => ({ check, about: o }));
  return { version: 1, rules: kept, items: [...items, ...extra] };
}

/** Whether the quest library rule applies to some report of `reports` that isn't ignored already. */
export function questLibraryOffered(f: IgnoreFile, reports: { check: string; about: string }[]): boolean {
  return !f.rules.includes(BONUS_QUEST_LIBRARY) && reports.some((r) => RULES[BONUS_QUEST_LIBRARY].check === r.check && RULES[BONUS_QUEST_LIBRARY].matches(r.about));
}

export const ruleTitle = (rule: string) => RULES[rule]?.title ?? rule;
