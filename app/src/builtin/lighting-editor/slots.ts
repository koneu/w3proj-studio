// Which of war3map.w3l's two slots the Lighting Editor's "Terrain lighting" and "Unit lighting" edit. The codec names
// the slots terrainModel / terrainEnabled (the first) and unitModel / unitEnabled (the second), but the World Editor's
// Light Editor (Module > Light Editor) calls the first "Unit" and the second "Terrain": with its list set to Unit,
// Enable Custom Light writes the first slot; set to Terrain, the second; Both, both and the w3l's last u32 1 (we-drive,
// branch we-batch-3, 2026-11-20, flat.w3x, SD). Its game view lights the ground by the second slot and units, doodads
// and trees by the first (terrain-viewer/lighting.ts ownLightFile), so the labels follow the light.

export type LightKind = "terrain" | "unit";

/** The w3l keys of the slot that holds `kind`'s light. */
export function slotKeys(kind: LightKind): { model: "terrainModel" | "unitModel"; enabled: "terrainEnabled" | "unitEnabled" } {
  return kind === "terrain" ? { model: "unitModel", enabled: "unitEnabled" } : { model: "terrainModel", enabled: "terrainEnabled" };
}
