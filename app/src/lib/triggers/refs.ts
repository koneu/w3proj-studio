// What GUI triggers refer to: generated globals (gg_…), object codes and variables.

import type { Param, TriggerFile } from "./wtg";

/** Triggers by what they refer to: gg_ globals, 4-character object codes, udg:<variable>. */
export function triggerRefs(file: TriggerFile): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (key: string, t: string) => { let s = out.get(key); if (!s) out.set(key, (s = new Set())); s.add(t); };
  for (const it of file.items) {
    if (!("ecas" in it) || it.type === 16) continue;
    const visitP = (p: Param) => {
      if (p.type === 1 && p.value) add(p.value.startsWith("gg_") ? p.value : `udg:${p.value}`, it.name);
      if (p.type === 3 && /^.{4}$/.test(p.value)) add(p.value, it.name);
      p.call?.params.forEach(visitP);
      if (p.index) visitP(p.index);
    };
    type E = { params: Param[]; children: E[] };
    const walk = (e: E) => { e.params.forEach(visitP); e.children.forEach(walk); };
    (it.ecas as E[]).forEach(walk);
  }
  return out;
}

/** Trigger references to things the map doesn't have. `known`: the map's gg_ names; variables
 *  come from the trigger file. Object codes aren't judged: a 4-letter value can be anything. */
export function missingRefs(refs: Map<string, Set<string>>, known: ReadonlySet<string>, variables: { name: string }[]): { ref: string; triggers: string[] }[] {
  const vars = new Set(variables.map((v) => v.name.toLowerCase()));
  const lowerKnown = new Set([...known].map((k) => k.toLowerCase()));
  return [...refs].filter(([ref]) => {
    if (ref.startsWith("gg_")) return !lowerKnown.has(ref.toLowerCase());
    return ref.startsWith("udg:") && !vars.has(ref.slice(4).toLowerCase());
  }).map(([ref, triggers]) => ({ ref, triggers: [...triggers].sort() }));
}
