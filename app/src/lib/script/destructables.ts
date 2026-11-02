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
  doodads: DestructableJson[];
  /** Global name of a placement (gg_dest_ATg1_0118). */
  globalName: (d: DestructableJson) => string;
  /** Generated globals the triggers use. */
  referenced: Set<string>;
  /** war3map.w3i editorVersion: newer editors add pitch/roll (6117 seen) and a colour (7000). */
  editorVersion?: number;
}

/** Flag "fixed Z": the destructable keeps its height instead of following the ground. */
const FIXED_Z = 0x4;
/** Flag seen on v13 placements the script never creates (the game places them from war3map.doo). */
const GAME_PLACED = 0x2;

const deg = (rad: number) => fixed(Math.fround(Math.fround(rad) * Math.fround(180 / Math.PI)), 3);


/** The section body (without banner), or "" when no destructable is needed. */
export function destructablesSection(i: DestructablesInput): string {
  // By object id; ties keep the file order (not always the World Editor's, see OPEN_POINTS.md).
  const placed = i.doodads.map((d, index) => ({ d, index }))
    .filter(({ d, index }) => !(d.flags & GAME_PLACED) && (i.referenced.has(i.globalName(d)) || dropFunctionOf("Doodad", d, index)))
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
    // Editors from 7000 on also set the tint (where some placements store another one is open).
    if (color) lines.push(`    call SetDestructableVertexColor( ${v}, 255, 255, 255, 255 )`);
    if (!dead && d.life !== 100) lines.push(`    set life = GetDestructableLife( ${v} )`, `    call SetDestructableLife( ${v}, ${(d.life / 100).toFixed(2)} * life )`);
    const drops = dropFunctionOf("Doodad", d, index);
    if (drops) {
      lines.push("    set t = CreateTrigger(  )", `    call TriggerRegisterDeathEvent( t, ${v} )`, "    call TriggerAddAction( t, function SaveDyingWidget )",
        `    call TriggerAddAction( t, function ${drops} )`);
    }
  }
  lines.push("endfunction", "");
  return lines.join(EOL);
}
