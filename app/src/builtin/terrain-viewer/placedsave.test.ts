import assert from "node:assert/strict";
import { test } from "node:test";
import { REQUIRES_TFT } from "../../lib/terrain/tftflag";
import type { Placed } from "./objects";
import { afterPlacedEdit, storedFlags, type PlacedEditAfter } from "./placedsave";

const footman = () => ({ id: "hfoo", player: 0, position: [0, 0, 0] }) as unknown as Placed;
const unitsDoc = (subversion: number) => { const units = [footman()]; return { doc: { version: 8, subversion, units } as Record<string, unknown>, list: units }; };
const info = (flags: number) => JSON.stringify({ flags, players: [], forces: [] });
const edit = (over: Partial<PlacedEditAfter> & Pick<PlacedEditAfter, "doc" | "list">): PlacedEditAfter => ({
  key: "units", infoText: info(0), startsBefore: null, flagsAfter: async (i) => i.flags, ...over,
});

test("an AI tool's units edit under flag 0x4000 writes subversion 11 with item tables and hero attributes, as the terrain view's save", async () => {
  const { doc, list } = unitsDoc(9);
  await afterPlacedEdit(edit({ doc, list, infoText: info(REQUIRES_TFT) }));
  assert.equal(doc.subversion, 11);
  const u = list[0] as unknown as Record<string, unknown>;
  assert.deepEqual([u.itemTable, u.strength, u.agility, u.intelligence], [-1, 0, 0, 0]);
});

test("the flag the edit's save sets counts: a placed tavern under a w3i without 0x4000 gives 11 too", async () => {
  const { doc, list } = unitsDoc(9);
  const w3i = await afterPlacedEdit(edit({ doc, list, flagsAfter: async (i) => i.flags | REQUIRES_TFT }));
  assert.equal(doc.subversion, 11);
  assert.equal(JSON.parse(w3i!).flags, REQUIRES_TFT);
});

test("without flag 0x4000, or with a w3i that can't be read, the units stay subversion 9", async () => {
  for (const infoText of [info(0), "{ not json", null]) {
    const { doc, list } = unitsDoc(9);
    await afterPlacedEdit(edit({ doc, list, infoText }));
    assert.equal(doc.subversion, 9, String(infoText));
    assert.equal("itemTable" in list[0], false);
  }
});

test("a ground tool's units go by the stored flags; a w3i missing or unreadable gives none", async () => {
  const reading = (text: string | null) => async (path: string) => { assert.equal(path, "map/war3map.w3i.json"); return text; };
  assert.equal(await storedFlags(reading(info(REQUIRES_TFT | 4))), REQUIRES_TFT | 4);
  for (const text of [null, "{ not json", "null", JSON.stringify({ flags: "x" })]) assert.equal(await storedFlags(reading(text)), undefined, String(text));
  assert.equal(await storedFlags(async () => { throw new Error("raw"); }), undefined);
});

test("a doodads edit leaves the doodads file alone under the flag", async () => {
  const doodads = [footman()], doc = { version: 8, subversion: 9, doodads } as Record<string, unknown>;
  await afterPlacedEdit(edit({ key: "doodads", doc, list: doodads, infoText: info(REQUIRES_TFT) }));
  assert.equal(doc.subversion, 9);
});
