// war3map.wtg / war3map.wct of a new map: the World Editor's default trigger,
// "Melee Initialization" in the category "Initialization", and no custom
// script. Both editors refuse maps without these files ("trigger data missing
// or invalid"). Layout of the Reforged files (marker 0x80000004), worked out
// from the game's melee maps, which carry exactly this default:
//
// wtg: "WTG!", marker, version 7, then (count, deleted count) per item
//      type (map, library, category, trigger, comment, script, variable, ?),
//      u32 2, variable count, item count, items. Item ids carry the type in
//      the high byte (category 0x02…, trigger 0x03…).
// wct: marker, version 1, comment, custom script length, trigger text count.
// World Editor 3.0.1's new map (editor 7003) names the root after the map file
// ("Untitled"), leaves the category collapsed and writes the comment below.

import type { TriggerData } from "./triggerdata";
import { parseWct, parseWtg, type CustomTextFile, type Item, type TriggerFile } from "./wtg";

/** The melee actions of the default trigger, in order. */
export const MELEE_ACTIONS = [
  "MeleeStartingVisibility", "MeleeStartingHeroLimit", "MeleeGrantHeroItems", "MeleeStartingResources",
  "MeleeClearExcessUnits", "MeleeStartingUnits", "MeleeStartingAI", "MeleeInitVictoryDefeat",
];

const MARKER = 0x80000004;

/** The custom script comment a new map gets (the same text in every game language). */
const WCT_COMMENT = "Enter map-specific custom script code below.  This text will be included in the map script after variables are declared and before any trigger code except Custom Script Item. Custom Script Item will merge into map script after globals variables declaration with the list order in trigger view.";

class Writer {
  private bytes: number[] = [];
  u32(v: number) { this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); return this; }
  raw(s: string) { this.bytes.push(...new TextEncoder().encode(s)); return this; }
  str(s: string) { this.raw(s).bytes.push(0); return this; }
  done() { return new Uint8Array(this.bytes); }
}

/** `root`: the trigger tree's root, named after the map file. */
export function defaultWtg(root = "Untitled"): Uint8Array {
  const w = new Writer().raw("WTG!").u32(MARKER).u32(7);
  // Items per type: the map itself, one category, one trigger.
  for (const count of [1, 0, 1, 1, 0, 0, 0, 0]) w.u32(count).u32(0);
  w.u32(2).u32(0).u32(3);
  const category = 0x02000000, trigger = 0x03000000;
  // The map (root): id, name, two flags, no parent.
  w.u32(1).u32(0).str(root).u32(0).u32(0).u32(0xffffffff);
  // Category: id, name, is comment, expanded, parent.
  w.u32(4).u32(category).str("Initialization").u32(0).u32(0).u32(0);
  // Trigger: name, description, is comment, id, enabled, custom text,
  // initially off, run on init, parent, then its events/conditions/actions.
  w.u32(8).str("Melee Initialization").str("Default melee game initialization for all players")
    .u32(0).u32(trigger).u32(1).u32(0).u32(0).u32(0).u32(category);
  w.u32(1 + MELEE_ACTIONS.length);
  // Each: kind (0 event, 2 action), function, enabled, child count.
  w.u32(0).str("MapInitializationEvent").u32(1).u32(0);
  for (const a of MELEE_ACTIONS) w.u32(2).str(a).u32(1).u32(0);
  return w.done();
}

export function defaultWct(): Uint8Array {
  return new Writer().u32(MARKER).u32(1).str(WCT_COMMENT).u32(0).u32(0).done();
}

/** The default trigger file as the project keeps it (war3map.wtg.json). Its functions take no
 *  arguments, so it is read without the game's TriggerData. */
export function defaultTriggerFile(root?: string): TriggerFile {
  return parseWtgWithoutArgs(defaultWtg(root));
}

/** A raw war3map.wtg read as if no function took arguments: right for the default trigger, and a file with arguments
 *  comes out garbled or throws (enough to tell it isn't the default, see isDefaultTriggers). */
export function parseWtgWithoutArgs(bytes: Uint8Array): TriggerFile {
  return parseWtg(bytes, { find: () => ({ args: [] }) } as unknown as TriggerData);
}

/**
 * Whether a trigger file holds nothing but the default: no variables, the category "Initialization" with the trigger
 * "Melee Initialization" in it, enabled, not custom text, its event and melee actions in order, all enabled and without
 * arguments. What the World Editor's save doesn't count as custom triggers (its WESTRING_NOTMELEE_CUSTOMTRIGGERS):
 * renaming the trigger, dropping an action or disabling it counted, its description didn't (we-drive saves of World
 * Editor 7003, 2026-11-09). Whatever wasn't tried (a renamed category, a trigger turned initially off) reads as not
 * the default, so it never makes a map melee by mistake.
 */
export function isDefaultTriggers(file: TriggerFile): boolean {
  if (file.variables.length) return false;
  const items = file.items.filter((i) => i.type !== 1);
  if (items.length !== 2) return false;
  const [category, trigger] = items[0].type === 4 ? items : [items[1], items[0]];
  if (category.type !== 4 || category.name !== "Initialization" || category.isComment) return false;
  if (trigger.type !== 8 || trigger.name !== "Melee Initialization" || trigger.parent !== category.id) return false;
  if (!trigger.enabled || trigger.isCustom || trigger.isComment || trigger.initiallyOff || trigger.runOnInit) return false;
  const want = [{ kind: 0, name: "MapInitializationEvent" }, ...MELEE_ACTIONS.map((name) => ({ kind: 2, name }))];
  return trigger.ecas.length === want.length && trigger.ecas.every((e, i) =>
    e.kind === want[i].kind && e.name === want[i].name && e.enabled && !e.params.length && !e.children.length);
}

/**
 * The World Editor's Reset Triggers ("Clear all triggers and reset to default?") on `file`: the default trigger and
 * its category, no variables, and no map header script (`custom`'s comment and version are kept). A Reforged file
 * keeps its version, its counts start again as a new map's; as World Editor 3.0.1 does (s.w3m reset and saved,
 * 2026-11-09), its root is named after the map file (`mapFile`, else the root keeps its name) and the category is
 * expanded. A classic file (versions 4 and 7 before Reforged) stays in its layout, with the category as index 0 and
 * the trigger in it.
 */
export function resetTriggers(file: TriggerFile, custom: CustomTextFile | null, mapFile?: string): { file: TriggerFile; custom: CustomTextFile } {
  const root = mapFile || file.items.find((i) => i.type === 1)?.name;
  const fresh = defaultTriggerFile(root);
  for (const it of fresh.items) if (it.type === 4) it.expanded = 1;
  const header = parseWct(defaultWct(), 1);
  const texts = [null];
  const customOut: CustomTextFile = custom ? { ...custom, header: header.header, texts } : { ...header, reforged: file.reforged, texts };
  if (file.reforged) return { file: { ...fresh, version: file.version }, custom: customOut };
  const melee = fresh.items.find((i) => i.type === 8)!;
  const items: Item[] = [
    { type: 4, id: 0, name: "Initialization", isComment: 0, expanded: 1, parent: -1 },
    { ...structuredClone(melee), id: 0, parent: 0 } as Item,
  ];
  return { file: { reforged: false, version: file.version, counts: [], unknown: file.unknown, variables: [], items }, custom: customOut };
}
