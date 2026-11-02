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

/** The melee actions of the default trigger, in order. */
export const MELEE_ACTIONS = [
  "MeleeStartingVisibility", "MeleeStartingHeroLimit", "MeleeGrantHeroItems", "MeleeStartingResources",
  "MeleeClearExcessUnits", "MeleeStartingUnits", "MeleeStartingAI", "MeleeInitVictoryDefeat",
];

const MARKER = 0x80000004;

class Writer {
  private bytes: number[] = [];
  u32(v: number) { this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); return this; }
  raw(s: string) { this.bytes.push(...new TextEncoder().encode(s)); return this; }
  str(s: string) { this.raw(s).bytes.push(0); return this; }
  done() { return new Uint8Array(this.bytes); }
}

export function defaultWtg(): Uint8Array {
  const w = new Writer().raw("WTG!").u32(MARKER).u32(7);
  // Items per type: the map itself, one category, one trigger.
  for (const count of [1, 0, 1, 1, 0, 0, 0, 0]) w.u32(count).u32(0);
  w.u32(2).u32(0).u32(3);
  const category = 0x02000000, trigger = 0x03000000;
  // The map (root): id, name, two flags, no parent.
  w.u32(1).u32(0).str("").u32(0).u32(0).u32(0xffffffff);
  // Category: id, name, is comment, expanded, parent.
  w.u32(4).u32(category).str("Initialization").u32(0).u32(1).u32(0);
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
  return new Writer().u32(MARKER).u32(1).str("").u32(0).u32(0).done();
}
