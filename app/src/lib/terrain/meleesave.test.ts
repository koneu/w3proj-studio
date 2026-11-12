import assert from "node:assert/strict";
import { test } from "node:test";
import { meleeAfterSave, readMeleeFacts, savedMelee, startsUnderWater, type MeleeFiles } from "./meleesave";
import { writeW3e, type Corner, type Terrain } from "./w3e";

/** Rows from the north, a char per corner: `w` ground at -100 under water at 50, `.` dry ground at 0. */
function lake(rows: string[]): Terrain {
  const height = rows.length, width = rows[0].length;
  const corners: Corner[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const wet = rows[height - 1 - y][x] === "w";
    corners.push({ layer: 2, ramp: false, height: wet ? -100 : 0, rawHeight: (wet ? -100 : 0) * 4 + 0x2000, hasWater: wet, water: wet ? 50 : -2137.6, texture: 0, variation: 0, cliffVariation: 0, cliffTexture: 0, blight: false, boundary: false, rawWater: wet ? 0x2000 + 200 : 0, texExtra: 0 });
  }
  return { version: 11, tileset: "L", customTilesets: false, groundTiles: ["Ldrt"], cliffTiles: ["CLdi"], width, height, offsetX: 0, offsetY: 0, corners, trailer: new Uint8Array(0) } as unknown as Terrain;
}

/** A project's files: path → text, or an Error for a file that is there but can't be read. */
function files(map: Record<string, string | Uint8Array | Error>): MeleeFiles & { reads: string[] } {
  const reads: string[] = [];
  const get = (p: string) => {
    reads.push(p);
    const v = map[p];
    if (v === undefined) return Promise.reject(new Error(`not found: ${p}`));
    if (v instanceof Error) return Promise.reject(v);
    return Promise.resolve(v);
  };
  return {
    reads,
    files: () => Object.keys(map).map((path) => ({ path })),
    readText: (p) => get(p).then((v) => (typeof v === "string" ? v : new TextDecoder().decode(v))),
    readBytes: (p) => get(p).then((v) => (typeof v === "string" ? new TextEncoder().encode(v) : v)),
  };
}

const MELEE = 0x2fc14;
const start = (x: number, y: number) => ({ id: "sloc", player: 0, position: [x, y, 0] });

test("a start location under water is in an invalid position; one on dry ground isn't", () => {
  const t = lake(["ww..", "ww..", "ww.."]);
  assert.equal(startsUnderWater(t, [start(64, 64)]), true);
  assert.equal(startsUnderWater(t, [start(2 * 128 + 64, 64)]), false, "control: dry ground");
  assert.equal(startsUnderWater(t, [{ id: "hfoo", player: 0, position: [64, 64, 0] }]), false, "only start locations count");
  assert.equal(startsUnderWater(t, [{ id: "sloc", player: 0 }]), false, "no position");
});

test("the save's melee rules take the facts: constants, starts under water, a player's unit", () => {
  const t = lake(["ww..", "ww..", "ww.."]);
  const dry = { customConstants: false, terrain: t };
  assert.deepEqual(meleeAfterSave({ flags: MELEE }, [start(320, 64)], dry), { flags: MELEE, reasons: [] }, "control: nothing applies");
  assert.deepEqual(meleeAfterSave({ flags: MELEE }, [start(64, 64)], dry), { flags: MELEE & ~4, reasons: ["Start locations are in invalid positions"] });
  assert.deepEqual(meleeAfterSave({ flags: MELEE }, [start(320, 64)], { ...dry, customConstants: true }).reasons, ["Custom gameplay constants have been specified"]);
  assert.deepEqual(meleeAfterSave({ flags: MELEE }, [start(320, 64), { id: "hfoo", player: 0, position: [0, 0, 0] }], dry).reasons, ["Player-owned units have been placed"]);
  assert.deepEqual(meleeAfterSave({ flags: MELEE }, [start(64, 64)], { customConstants: false, terrain: null }).flags, MELEE, "unknown ground: no reason");
  assert.deepEqual(meleeAfterSave({ flags: MELEE & ~4 }, [start(64, 64)], dry), { flags: MELEE & ~4, reasons: [] }, "never back on");
});

test("the facts come from the project; missing and unreadable files set nothing", async () => {
  const t = lake(["ww..", "ww..", "ww.."]);
  const w3e = writeW3e(t);
  const set = await readMeleeFacts(files({ "map/war3mapMisc.txt": "[Misc]\nScaledAnimTime=75.0\n", "map/war3map.w3e": w3e }));
  assert.equal(set.customConstants, true);
  assert.equal(set.terrain?.width, 4);
  assert.equal(startsUnderWater(set.terrain!, [start(64, 64)]), true, "the saved ground, as written");
  // The file's name as the project has it (case differs on disk).
  assert.equal((await readMeleeFacts(files({ "map/War3MapMisc.txt": "[Misc]\nA=1\n" }))).customConstants, true);
  const none = await readMeleeFacts(files({}));
  assert.deepEqual(none, { customConstants: false, terrain: null });
  const broken = await readMeleeFacts(files({ "map/war3mapMisc.txt": new Error("EACCES"), "map/war3map.w3e": new Uint8Array([1, 2, 3]) }));
  assert.deepEqual(broken, { customConstants: false, terrain: null }, "unreadable: not known, so the flag stays");
  // The ground being saved wins over the project's.
  const given = await readMeleeFacts(files({ "map/war3map.w3e": new Uint8Array([1]) }), t);
  assert.equal(given.terrain, t);
});

test("nothing is read when the map isn't a melee map", async () => {
  const ws = files({ "map/war3mapMisc.txt": "[Misc]\nA=1\n" });
  assert.deepEqual(await savedMelee(ws, { flags: MELEE & ~4 }, []), { flags: MELEE & ~4, reasons: [] });
  assert.deepEqual(ws.reads, []);
  assert.equal((await savedMelee(ws, { flags: MELEE }, [])).flags, MELEE & ~4, "control: read when it is");
});
