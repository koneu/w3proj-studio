// Building ground marks ("uber splats"): a unit type names one (UnitSkin.txt `uberSplat`, object
// data field `uubs`), Splats\UberSplatData.slk gives its texture, half-size (Scale), blend mode
// and colours. Buildings show the "middle" colour (start and end are for marks that appear and
// fade, like craters). The texture lies flat, draped over the ground around the building.

import type { W3Api } from "../../extensions/api";
import { parseSlk } from "../../lib/formats/text";
import { isUprooted } from "../../lib/terrain/owner";
import type { Placed, Skin } from "./objects";

export interface SplatDef {
  /** Texture path (.blp; the game may ship .dds). */
  texture: string;
  /** Half the side of the square, world units. */
  scale: number;
  /** 0 blend, 1 additive. */
  blend: number;
  /** r, g, b, a in 0–1. */
  color: [number, number, number, number];
}

export interface Splat { x: number; y: number; def: SplatDef }

/** Splats\UberSplatData.slk by name. */
export async function loadSplatTable(w3: W3Api): Promise<Map<string, SplatDef>> {
  const rows = parseSlk(await w3.game.readText("Splats\\UberSplatData.slk"));
  const out = new Map<string, SplatDef>();
  for (const r of rows) {
    if (!r.Name || !r.file) continue;
    const n = (k: string, d: number) => (r[k] === undefined || r[k] === "" ? d : Number(r[k]));
    out.set(r.Name, {
      texture: `${r.Dir}\\${r.file}.blp`,
      scale: n("Scale", 100),
      blend: n("BlendMode", 0),
      color: [n("MiddleR", 255) / 255, n("MiddleG", 255) / 255, n("MiddleB", 255) / 255, n("MiddleA", 255) / 255],
    });
  }
  return out;
}

/** The ground marks of placed units (buildings) whose type names one. An Ancient placed uprooted has none: it
 *  walks, its roots are out of the ground (the World Editor draws its root mark only rooted; we-drive, 2026-11-08). */
export function planSplats(units: Placed[], skins: Map<string, Skin>, table: Map<string, SplatDef>, baseOf: (id: string) => string | undefined): Splat[] {
  const out: Splat[] = [];
  for (const p of units) {
    if (isUprooted(p)) continue;
    const skin = skins.get(p.id) ?? skins.get(baseOf(p.id) ?? "");
    const def = skin?.uberSplat ? table.get(skin.uberSplat) : undefined;
    if (def) out.push({ x: p.position[0], y: p.position[1], def });
  }
  return out;
}
