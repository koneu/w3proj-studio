// A trigger file's change as a summary over its text diff (map/triggers/…): for a GUI trigger which events,
// conditions and actions were added, removed or changed and what else of the trigger changed (its name, whether it is
// on, its comment); for a variables file which variables were added, removed or changed. A trigger's JSON diff is
// long and nested; this says what happened to the trigger.

interface Eca { kind: number; name: string; enabled?: boolean; params?: unknown[]; children?: Eca[]; group?: number }
interface Trigger { name?: string; description?: string; enabled?: boolean; initiallyOff?: boolean; runOnInit?: boolean; isComment?: number; ecas?: Eca[] }
interface Variable { name: string; type?: string; isArray?: boolean; arraySize?: number; initialized?: boolean; initialValue?: string }

/** What kind of trigger file a path is, or null: a GUI trigger, or a folder's variables. */
export function triggerFileKind(path: string): "gui" | "variables" | null {
  if (!/(^|\/)map\/triggers\//i.test(path)) return null;
  return /\.gui\.json$/i.test(path) ? "gui" : /(^|\/)variables\.json$/i.test(path) ? "variables" : null;
}

const KINDS = ["event", "condition", "action"] as const;
/** A line of a trigger with everything under it, as text to compare. */
const whole = (e: Eca) => JSON.stringify([e.name, e.enabled !== false, e.params ?? [], (e.children ?? []).map((c) => [c.group ?? 0, c.kind, c.name, c.enabled !== false, c.params ?? [], c.children ?? []])]);

export interface TriggerChange { what: "added" | "removed" | "changed" | "moved" | "switched"; kind: (typeof KINDS)[number]; name: string; note?: string }
export interface TriggerDiff { header: string[]; lines: TriggerChange[]; counts: Record<(typeof KINDS)[number], [number, number]> }

/** A GUI trigger before and after (either may be missing: a new or a deleted trigger). */
export function diffTrigger(before: Trigger | null, after: Trigger | null): TriggerDiff {
  const header: string[] = [];
  const say = (what: string, a: unknown, b: unknown) => { if (before && after && a !== b) header.push(`${what}: ${String(a)} → ${String(b)}`); };
  if (!before && after) header.push(`new trigger "${after.name ?? ""}"`);
  if (before && !after) header.push(`trigger "${before.name ?? ""}" deleted`);
  say("name", before?.name, after?.name);
  say("enabled", before?.enabled !== false, after?.enabled !== false);
  say("initially on", !before?.initiallyOff, !after?.initiallyOff);
  say("run on map initialization", !!before?.runOnInit, !!after?.runOnInit);
  if (before && after && (before.description ?? "") !== (after.description ?? "")) header.push("comment changed");
  const lines: TriggerChange[] = [];
  const counts = { event: [0, 0], condition: [0, 0], action: [0, 0] } as TriggerDiff["counts"];
  KINDS.forEach((kind, k) => {
    const a = (before?.ecas ?? []).filter((e) => e.kind === k), b = (after?.ecas ?? []).filter((e) => e.kind === k);
    counts[kind] = [a.length, b.length];
    // Lines that are the same whole are paired off first, in order; of the rest, those of one name are changes.
    const leftA = a.map((e) => ({ e, text: whole(e), used: false })), leftB = b.map((e) => ({ e, text: whole(e), used: false }));
    let moved = 0;
    leftB.forEach((y, j) => {
      const i = leftA.findIndex((x) => !x.used && x.text === y.text);
      if (i < 0) return;
      leftA[i].used = y.used = true;
      // The same line somewhere else among its kind.
      if (leftA.slice(0, i).filter((x) => !x.used).length !== leftB.slice(0, j).filter((x) => !x.used).length) moved++;
    });
    for (const y of leftB.filter((x) => !x.used)) {
      const x = leftA.find((c) => !c.used && c.e.name === y.e.name);
      if (!x) { lines.push({ what: "added", kind, name: y.e.name }); continue; }
      x.used = true;
      const onlySwitch = whole({ ...x.e, enabled: y.e.enabled }) === y.text;
      lines.push(onlySwitch ? { what: "switched", kind, name: y.e.name, note: y.e.enabled === false ? "turned off" : "turned on" } : { what: "changed", kind, name: y.e.name });
    }
    for (const x of leftA.filter((c) => !c.used)) lines.push({ what: "removed", kind, name: x.e.name });
    if (moved) lines.push({ what: "moved", kind, name: `${moved} ${kind}${moved === 1 ? "" : "s"}`, note: "in another place" });
  });
  return { header, lines, counts };
}

export interface VariableChange { what: "added" | "removed" | "changed"; name: string; note: string }

/** A variables file: a variable to a line, or one list. */
function variablesOf(text: string): Variable[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("[")) return JSON.parse(t) as Variable[];
  return t.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as Variable);
}
const typeOf = (v: Variable) => `${v.type ?? "?"}${v.isArray ? ` array (${v.arraySize ?? 1})` : ""}`;
const startOf = (v: Variable) => (v.initialized ? `starts as ${v.initialValue ?? ""}` : "no starting value");

/** The variables of a folder before and after, by name. */
export function diffVariables(before: string, after: string): VariableChange[] {
  const a = new Map(variablesOf(before).map((v) => [v.name, v])), b = new Map(variablesOf(after).map((v) => [v.name, v]));
  const out: VariableChange[] = [];
  for (const [name, v] of b) {
    const was = a.get(name);
    if (!was) { out.push({ what: "added", name, note: `${typeOf(v)}, ${startOf(v)}` }); continue; }
    const notes = [typeOf(was) !== typeOf(v) ? `${typeOf(was)} → ${typeOf(v)}` : "", startOf(was) !== startOf(v) ? `${startOf(was)} → ${startOf(v)}` : ""].filter(Boolean);
    if (notes.length) out.push({ what: "changed", name, note: notes.join("; ") });
  }
  for (const [name, v] of a) if (!b.has(name)) out.push({ what: "removed", name, note: typeOf(v) });
  return out;
}
