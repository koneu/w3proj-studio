// "Destructable Objects" of war3map.j: CreateAllDestructables creates only the
// destructables the script needs, those triggers refer to (gg_dest_…) and those
// that drop items; everything else the game places from war3map.doo itself.

import { fixed } from "./units";
import { dropFunctionOf } from "./drops";

const EOL = "\r\n";

export interface DestructableJson {
  id: string; variation: number; position: number[]; angle: number; scale: number[]; skinId?: string; flags: number;
  life: number; itemTable?: number; itemSets?: unknown[]; editorId: number; trailer?: number[];
}

export interface DestructablesInput {
  /** The numbers of the map's item tables. */
  itemTables?: ReadonlySet<number>;
  doodads: DestructableJson[];
  /** Global name of a placement (gg_dest_ATg1_0118). */
  globalName: (d: DestructableJson) => string;
  /** Generated globals the triggers use. */
  referenced: Set<string>;
  /** war3map.w3i editorVersion: newer editors add pitch/roll (6117 seen) and a colour (7000). */
  editorVersion?: number;
  /** The tint of a destructable type in the map's object data (lib/script/objects destructableTints); 255s without. */
  tint?: (id: string) => [number, number, number];
}

/** Flag "fixed Z": the destructable keeps its height instead of following the ground. */
const FIXED_Z = 0x4;
/** A destructable's flag "the game places it from war3map.doo": the World Editor's save sets it on every destructable
 *  its script doesn't create and clears it on those it does (scriptCreates). It follows the script, it isn't input:
 *  we-compare dest-flags (dest-tint-unref.w3x, given flags 0, 1, 2, 3, 4 and 6: no trigger naming them, the save wrote
 *  2, or 6 where it was 4; named by a trigger, 0, or 4, and the script created them, whatever the flags were). Bit 0
 *  (the playable-area flag, borderFlags) is another rule. On a plain doodad the same bit means "solid" (pathmap). */
export const GAME_PLACED = 0x2;

const deg = (rad: number) => fixed(Math.fround(Math.fround(rad) * Math.fround(180 / Math.PI)), 3);

/** What decides whether the map script creates a placed destructable. */
export type CreatesInput = Pick<DestructablesInput, "itemTables" | "globalName" | "referenced">;

/** Whether CreateAllDestructables creates the destructable `d` (at `index` in war3map.doo): a trigger names it, or it
 *  drops items. As the World Editor's, whatever its flags say. */
export function scriptCreates(i: CreatesInput, d: DestructableJson, index: number): boolean {
  return i.referenced.has(i.globalName(d)) || dropFunctionOf("Doodad", d, index, i.itemTables) !== undefined;
}

/** The flags the World Editor's save gives a placed object of war3map.doo: GAME_PLACED off where the script creates it
 *  (`created`), on where it doesn't, the other bits as they are. A plain doodad (`destructable` false) keeps its flags. */
export function followedFlags(flags: number, created: boolean, destructable: boolean): number {
  if (!destructable) return flags;
  return created ? flags & ~GAME_PLACED : flags | GAME_PLACED;
}

/** The objects of war3map.doo (`doodads`, in file order) whose flags the World Editor's save would set otherwise than
 *  they are, with the flags it would set (followedFlags, scriptCreates). `destructable`: whether a type is a
 *  destructable; an unknown type is left alone. */
export function flagsToFollow(i: CreatesInput, doodads: readonly DestructableJson[], destructable: (id: string) => boolean): { index: number; flags: number }[] {
  const out: { index: number; flags: number }[] = [];
  doodads.forEach((d, index) => {
    if (typeof d.flags !== "number") return;
    const flags = followedFlags(d.flags, scriptCreates(i, d, index), destructable(d.id));
    if (flags !== d.flags) out.push({ index, flags });
  });
  return out;
}

/** The flags the objects of a war3map.doo list should have, as flagsToFollow gives them for one script: what the Map
 *  Script extension hands the open terrain editor (command w3.terrain.followDestructableFlags). */
export type FollowFlags = (doodads: readonly DestructableJson[]) => { index: number; flags: number }[];

/** The section body (without banner), or "" when no destructable is needed. */
export function destructablesSection(i: DestructablesInput): string {
  // By object id; ties keep the file order (not always the World Editor's). Its flags don't decide (GAME_PLACED
  // follows the script, set by the save: flagsToFollow).
  const placed = i.doodads.map((d, index) => ({ d, index }))
    .filter(({ d, index }) => scriptCreates(i, d, index))
    .sort((a, b) => (a.d.id < b.d.id ? -1 : a.d.id > b.d.id ? 1 : a.index - b.index));
  if (!placed.length) return "";
  const ev = i.editorVersion ?? 0, pitchRoll = ev >= 6117, color = ev >= 7000;
  const lines = ["function CreateAllDestructables takes nothing returns nothing", "    local destructable d", "    local trigger t", "    local real life"];
  for (const { d, index } of placed) {
    const g = i.globalName(d);
    const v = i.referenced.has(g) ? g : "d";
    const z = d.flags & FIXED_Z;
    // Life 0: placed dead.
    const dead = d.life === 0;
    const fn = `BlzCreate${dead ? "Dead" : ""}Destructable${z ? "Z" : ""}WithSkin${pitchRoll ? "PitchRoll" : ""}${color ? "Color" : ""}`;
    const args = [`'${d.id}'`, fixed(d.position[0], 1), fixed(d.position[1], 1), ...(z ? [fixed(d.position[2], 1)] : []),
      deg(d.angle), ...(pitchRoll ? ["0.000", "0.000"] : []), fixed(d.scale[0], 3), String(d.variation), `'${d.skinId ?? d.id}'`,
      ...(color ? ["ConvertPlayerColor(24)"] : [])];
    lines.push(`    set ${v} = ${fn}( ${args.join(", ")} )`);
    // Editors from 7000 on also set the tint: the type's, as the map's object data has it.
    if (color) lines.push(`    call SetDestructableVertexColor( ${v}, ${(i.tint?.(d.id) ?? [255, 255, 255]).join(", ")}, 255 )`);
    if (!dead && d.life !== 100) lines.push(`    set life = GetDestructableLife( ${v} )`, `    call SetDestructableLife( ${v}, ${(d.life / 100).toFixed(2)} * life )`);
    const drops = dropFunctionOf("Doodad", d, index, i.itemTables);
    if (drops) {
      lines.push("    set t = CreateTrigger(  )", `    call TriggerRegisterDeathEvent( t, ${v} )`, "    call TriggerAddAction( t, function SaveDyingWidget )",
        `    call TriggerAddAction( t, function ${drops} )`);
    }
  }
  lines.push("endfunction", "");
  return lines.join(EOL);
}
