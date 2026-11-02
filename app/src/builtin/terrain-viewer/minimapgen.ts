// Gathers the minimap inputs (see minimap.ts) from the project and the game
// and encodes war3mapMap.blp.

import type { W3Api } from "../../extensions/api";
import { encodeBlp1Jpeg } from "../../lib/image/encode";
import { decodeImage } from "../../lib/image/index.ts";
import { parseSlk } from "../../lib/formats/text";
import { MINIMAP_SIZE, renderMinimap, type MinimapParams, type Rgb } from "./minimap";
import type { Placed } from "./objects";
import { pathOverrides, readMapJson } from "./pathmap";
import type { Terrain } from "../../lib/terrain/w3e";

/** Average colour of the first texture cell, by tile id (textures are shared). */
const tileColors = new Map<string, Promise<Rgb>>();

export async function buildMinimap(w3: W3Api, terrain: Terrain, doodads: Placed[],
  readFile: (path: string) => Promise<Uint8Array>, params?: Partial<MinimapParams>, quality = 80): Promise<Uint8Array> {
  const w3i = await readMapJson<{ cameraComplements?: number[] }>(w3, "war3map.w3i").catch(() => null);
  const m = w3i?.cameraComplements ?? [0, 0, 0, 0];

  const tileRows = new Map(parseSlk(await w3.game.readText("TerrainArt\\Terrain.slk")).map((r) => [r.tileID, r]));
  const colors = new Map<string, Rgb>();
  for (const id of terrain.groundTiles) {
    const row = tileRows.get(id);
    let c = tileColors.get(id);
    if (!c) {
      c = (async (): Promise<Rgb> => {
        if (!row) return [128, 128, 128];
        const path = `${row.dir}\\${row.file}.blp`;
        const mip = decodeImage(await readFile(path), path).mip(0);
        const cell = mip.height / 4, sum = [0, 0, 0];
        for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) for (let k = 0; k < 3; k++) sum[k] += mip.rgba[(y * mip.width + x) * 4 + k];
        return sum.map((s) => s / (cell * cell)) as Rgb;
      })().catch((): Rgb => [128, 128, 128]);
      tileColors.set(id, c);
    }
    colors.set(id, await c);
  }

  const water = parseSlk(await w3.game.readText("TerrainArt\\Water.slk"));
  const wrow = water.find((r) => r.waterID === `${terrain.tileset}Sha`) ?? water.find((r) => r.waterID === "LSha");
  const waterColor: Rgb = wrow ? [Number(wrow.mmRed), Number(wrow.mmGreen), Number(wrow.mmBlue)] : [0, 0, 192];

  // Doodads and destructables with their own minimap colour.
  const rows = new Map([
    ...parseSlk(await w3.game.readText("Doodads\\Doodads.slk")).map((r) => [r.doodID, r] as const),
    ...parseSlk(await w3.game.readText("Units\\DestructableData.slk")).map((r) => [r.DestructableID, r] as const),
  ]);
  const bases = new Map([...await pathOverrides(w3, "war3map.w3d", "dptx"), ...await pathOverrides(w3, "war3map.w3b", "bptx")]);
  const objects: { x: number; y: number; rgb: Rgb }[] = [];
  for (const d of doodads) {
    const r = rows.get(d.id) ?? rows.get(bases.get(d.id)?.base ?? "");
    if (r?.showInMM === "1" && r.useMMColor === "1") objects.push({ x: d.position[0], y: d.position[1], rgb: [Number(r.MMRed), Number(r.MMGreen), Number(r.MMBlue)] });
  }

  const rgba = renderMinimap({ terrain, margins: [m[0], m[1], m[2], m[3]], tileColor: (id) => colors.get(id) ?? [128, 128, 128], waterColor, objects, params });
  return encodeBlp1Jpeg(MINIMAP_SIZE, MINIMAP_SIZE, rgba, quality);
}
