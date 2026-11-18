import assert from "node:assert/strict";
import { test } from "node:test";
import { meleeAfterSave, savedMelee, type MeleeFiles } from "./meleesave";
import { CUSTOM_TILESETS_FLAG, tilesetFlagAfter } from "./tilesetflag";
import { parseW3e, writeW3e, type Corner, type Terrain } from "./w3e";

// we-drive 2026-11-18 (tests/we-compare/tileset-flag-we.json): flat.w3x (flags 0x9c14) saved with custom tilesets on
// came back 0x9c1c, whatever its ground list held; with them off a stored 0x9c1c came back 0x9c14.
const FLAT = 0x9c14;

/** A 2 x 2 flat terrain, written and parsed again as a project's war3map.w3e is read. */
function terrain(customRaw: number): Terrain {
  const corners: Corner[] = Array.from({ length: 4 }, () => ({ layer: 2, ramp: false, height: 0, rawHeight: 0x2000, hasWater: false, water: -2137.6, texture: 0, variation: 0, cliffVariation: 0, cliffTexture: 0, blight: false, boundary: false, rawWater: 0, texExtra: 0 }));
  const t = { version: 11, tileset: "L", customTilesets: customRaw !== 0, customTilesetsRaw: customRaw, groundTiles: ["Ldrt"], cliffTiles: ["CLdi"], width: 2, height: 2, offsetX: 0, offsetY: 0, corners, trailer: new Uint8Array(0) } as unknown as Terrain;
  return parseW3e(writeW3e(t));
}

function files(map: Record<string, Uint8Array | Error>): MeleeFiles {
  const get = (p: string) => { const v = map[p]; return v === undefined || v instanceof Error ? Promise.reject(v ?? new Error(`not found: ${p}`)) : Promise.resolve(v); };
  return { files: () => Object.keys(map).map((path) => ({ path })), readText: (p) => get(p).then((v) => new TextDecoder().decode(v)), readBytes: get };
}

test("tilesetFlagAfter: 0x0008 follows the terrain's custom tilesets flag; unknown terrain leaves it", () => {
  assert.equal(CUSTOM_TILESETS_FLAG, 0x0008);
  assert.equal(tilesetFlagAfter(FLAT, terrain(1)), FLAT | 8);
  assert.equal(tilesetFlagAfter(FLAT | 8, terrain(0)), FLAT, "custom tilesets off clears it");
  assert.equal(tilesetFlagAfter(FLAT | 8, terrain(1)), FLAT | 8, "kept");
  assert.equal(tilesetFlagAfter(FLAT, terrain(0)), FLAT, "control: off stays off");
  assert.equal(tilesetFlagAfter(FLAT | 8, null), FLAT | 8, "no terrain: as it is");
  assert.equal(tilesetFlagAfter(FLAT, {}), FLAT, "a terrain without the value: as it is");
  assert.equal(tilesetFlagAfter(0x80000000 | 8, terrain(0)), 0x80000000, "the high bit stays a plain u32");
});

test("the save's flags (meleeAfterSave, savedMelee) carry 0x0008 from the terrain being saved or the project's", async () => {
  assert.equal(meleeAfterSave({ flags: FLAT }, [], { customConstants: false, terrain: terrain(1) }).flags, FLAT | 8);
  assert.equal(meleeAfterSave({ flags: FLAT | 8 }, [], { customConstants: false, terrain: terrain(0) }).flags, FLAT);
  assert.equal(meleeAfterSave({ flags: FLAT | 8 }, [], { customConstants: false, terrain: null }).flags, FLAT | 8, "ground unknown");
  // Not melee, with a reason the info tells (custom forces): the early path reads only the terrain of the project.
  const off = (FLAT & ~4) | 0x40;
  const w3e = (raw: number) => writeW3e(terrain(raw));
  assert.equal((await savedMelee(files({ "map/war3map.w3e": w3e(1) }), { flags: off }, [])).flags, off | 8);
  assert.equal((await savedMelee(files({ "map/war3map.w3e": w3e(0) }), { flags: off | 8 }, [])).flags, off);
  // Absent and unreadable terrain alike leave the bit as it is (not read as "custom tilesets off").
  assert.equal((await savedMelee(files({}), { flags: off | 8 }, [])).flags, off | 8, "no terrain file");
  assert.equal((await savedMelee(files({ "map/war3map.w3e": new Error("EACCES") }), { flags: off | 8 }, [])).flags, off | 8, "unreadable");
  assert.equal((await savedMelee(files({ "map/war3map.w3e": new Uint8Array([1, 2, 3]) }), { flags: off | 8 }, [])).flags, off | 8, "malformed");
  // The terrain given (the one being saved) wins over the project's.
  assert.equal((await savedMelee(files({ "map/war3map.w3e": w3e(0) }), { flags: off }, [], terrain(1))).flags, off | 8);
});
