// The World Editor's Copy As Text: a GUI trigger, or some of its lines, as the readable text the
// Trigger Editor shows, indented by nesting (four spaces a level), as it is pasted into forum posts:
//
//   Melee Initialization
//       Events
//           Map initialization
//       Conditions
//       Actions
//           Melee Game - Use melee time of day (for all players)
//
// Blocks list their branches ("If - Conditions", "Then - Actions", …) under their own line, empty
// branches too, as the Trigger Editor draws them.

import { branchLabels, ecaText, type DisplayContext } from "./display";
import { linesCustomText, triggerCustomText } from "../script/triggers";
import { ACTION, CONDITION, EVENT } from "./triggerdata";
import type { Eca, TriggerFile, TriggerItem } from "./wtg";

const INDENT = "    ";
const SECTIONS = [[EVENT, "Events"], [CONDITION, "Conditions"], [ACTION, "Actions"]] as const;

/** Blocks have child lists per branch (If/Then/Else, loops, And/Or). */
const isBlock = (e: Eca) => /Multiple$/.test(e.name);

/** A line's text; a function TriggerData doesn't know is named as stored, never an error. */
function lineText(e: Eca, ctx: DisplayContext): string {
  try { return ecaText(e, ctx); } catch { return e.name; }
}

function lines(e: Eca, ctx: DisplayContext, depth: number, out: string[]) {
  out.push(INDENT.repeat(depth) + lineText(e, ctx));
  if (!isBlock(e) && !e.children.length) return;
  const labels = branchLabels(e.name);
  const groups = new Set([...labels.keys(), ...e.children.map((c) => c.group ?? 0)]);
  for (const g of [...groups].sort((a, b) => a - b)) {
    out.push(INDENT.repeat(depth + 1) + (labels[g] ?? "Actions"));
    for (const c of e.children) if ((c.group ?? 0) === g) lines(c, ctx, depth + 2, out);
  }
}

/** Lines (with what they contain) as text, the first at `depth` levels of indentation; lines end with "\n". */
export function ecasAsText(ecas: readonly Eca[], ctx: DisplayContext, depth = 0): string {
  const out: string[] = [];
  for (const e of ecas) lines(e, ctx, depth, out);
  return out.map((l) => `${l}\n`).join("");
}

/** A GUI trigger as text: its name, then Events, Conditions and Actions with their lines. */
export function triggerAsText(t: TriggerItem, ctx: DisplayContext): string {
  let text = `${t.name}\n`;
  for (const [kind, label] of SECTIONS) {
    text += `${INDENT}${label}\n`;
    text += ecasAsText(t.ecas.filter((e) => e.kind === kind), ctx, 2);
  }
  return text;
}

/** What Copy As Text / Copy As Script needs of a trigger editor. */
export interface CopySource {
  display: DisplayContext;
  file: TriggerFile;
  language: "jass" | "lua";
  /** A custom text trigger's script. */
  customText(t: TriggerItem): string | null;
}

/** The text Copy As Text (`as` "text") or Copy As Script ("script") puts on the clipboard for the trigger `t`,
 *  or for its `lines` when there are any, with "\n" line ends; null when there is nothing of the kind:
 *  comments have neither, custom text has no GUI text (its script is its own text). */
export function copyAs(as: "text" | "script", src: CopySource, t: TriggerItem, lines: readonly Eca[] = []): string | null {
  if (t.type === 16 || t.isComment) return null;
  const gui = t.type === 8 && !t.isCustom;
  if (!gui) return as === "script" ? (src.customText(t) ?? "").replace(/\r\n?/g, "\n") : null;
  if (as === "text") return lines.length ? ecasAsText(lines, src.display) : triggerAsText(t, src.display);
  const input = { data: src.display.data, triggers: src.file, lua: src.language === "lua" };
  const script = lines.length ? linesCustomText(input, t, lines) : triggerCustomText(input, t);
  return script.replace(/\r\n?/g, "\n");
}
