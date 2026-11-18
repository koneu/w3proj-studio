import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { loadMapLighting } from "./lighting";

/** A light model in MDL text with one directional light of a static colour (b, g, r, as MDL keeps colours). */
const lightMdl = (name: string, color: string) => [
  "Version {", "\tFormatVersion 800,", "}",
  `Model "${name}" {`, "\tNumLights 1,", "\tBlendTime 150,", "}",
  "Sequences 1 {", "\tAnim \"Stand\" {", "\t\tInterval { 333, 60333 },", "\t}", "}",
  "Light \"FDirectSun\" {", "\tDirectional,", "\tstatic Intensity 1,", `\tstatic Color { ${color} },`, "\tstatic AmbIntensity 0.2,", `\tstatic AmbColor { ${color} },`, "}",
].join("\n");

/** A project whose map files are `files` (by path under the project), with no game data. */
const fakeProject = (files: Record<string, string>) => ({
  workspace: {
    project: () => ({ root: "/p" }),
    readText: async (p: string) => { if (p in files) return files[p]; throw new Error(`no ${p}`); },
  },
  backend: { invoke: async () => { throw new Error("no backend"); } },
  game: { readText: async () => { throw new Error("no game"); }, read: async () => { throw new Error("no game"); } },
}) as unknown as W3Api;

// we-drive (branch we-compare-10, 2026-11-19, SD game view): cliff.w3m with war3map.w3l's first slot's sun and ambient
// one colour and the second's another lit the ground and the doodads in the second's colour and three footmen in the first's.
test("the map's own lighting: the ground by war3map.w3l's second slot, the units by its first, as the World Editor", async () => {
  const w3l = { terrainModel: "first.mdl", unitModel: "second.mdl", terrainEnabled: 1, unitEnabled: 1 };
  const load = (slots: Record<string, unknown>) => loadMapLighting(fakeProject({
    "map/war3map.w3l.json": JSON.stringify({ format: "w3proj.lights/1", magic: "W3L!", version: 3, ...slots, unknown: 0 }),
    "map/first.mdl": lightMdl("SlotOne", "1, 0.15, 0.15"),
    "map/second.mdl": lightMdl("SlotTwo", "0.15, 1, 0.15"),
  }), "L");
  const both = await load(w3l);
  assert.equal(both.terrain?.name, "SlotTwo");
  assert.equal(both.unit?.name, "SlotOne");
  assert.deepEqual(both.own, { terrain: true, unit: true });
  // A slot that's off or empty: the game's model for that part (none in this fake game).
  const secondOff = await load({ ...w3l, unitEnabled: 0 });
  assert.deepEqual([secondOff.terrain, secondOff.unit?.name], [null, "SlotOne"]);
  const firstEmpty = await load({ ...w3l, terrainModel: "" });
  assert.deepEqual([firstEmpty.terrain?.name, firstEmpty.unit], ["SlotTwo", null]);
});
