import assert from "node:assert/strict";
import { test } from "node:test";
import { newEntry, type PlacedFile } from "./placement";
import type { Placed } from "./objects";

const file = (key: "doodads" | "units", version: number, subversion: number, more: Record<string, unknown> = {}, list: Placed[] = []): PlacedFile =>
  ({ name: key === "doodads" ? "war3map.doo" : "war3mapUnits.doo", key, doc: { version, subversion, [key]: list, ...more }, list, json: true, dirty: false });

test("a new map's empty doodad file takes its first doodad", () => {
  const f = file("doodads", 13, 11);
  const e = newEntry(f, "LTlt", [64, 128, 0]) as unknown as Record<string, unknown>;
  assert.equal(e.id, "LTlt");
  assert.equal(e.skinId, "LTlt");
  assert.deepEqual(e.position, [64, 128, 0]);
  assert.equal(e.life, 100);
  assert.equal(e.preFlags, 0xffffffff);
  assert.equal(e.editorId, 0xffffffff, "a v13 doodad's number is in its trailer");
  assert.deepEqual(e.trailer, [0, 0, 0]);
  assert.deepEqual(e.extras, []);
});

test("the second doodad continues from the first", () => {
  const f = file("doodads", 13, 11);
  f.list.push(newEntry(f, "LTlt", [0, 0, 0]));
  const e = newEntry(f, "LTlt", [64, 0, 0]) as unknown as { trailer: number[] };
  assert.deepEqual(e.trailer, [1, 0, 0]);
});

test("a blank entry has only what the version has", () => {
  const old = newEntry(file("doodads", 7, 9), "LTlt", [0, 0, 0]) as unknown as Record<string, unknown>;
  for (const k of ["skinId", "preFlags", "itemTable", "itemSets", "trailer", "extras"]) assert.ok(!(k in old), k);
  const v8 = newEntry(file("doodads", 8, 11), "LTlt", [0, 0, 0]) as unknown as Record<string, unknown>;
  assert.ok("itemSets" in v8 && !("skinId" in v8));
  assert.ok("skinId" in (newEntry(file("doodads", 8, 11, { skinIds: true }), "LTlt", [0, 0, 0]) as unknown as Record<string, unknown>));
  const v12 = newEntry(file("doodads", 12, 11), "LTlt", [0, 0, 0]) as unknown as { trailer: number[] };
  assert.equal(v12.trailer.length, 2);
});

test("an empty unit file takes a unit, with hero fields only where the layout has them", () => {
  const sub9 = newEntry(file("units", 13, 9), "hfoo", [0, 0, 0], 2) as unknown as Record<string, unknown>;
  assert.equal(sub9.player, 2);
  assert.equal(sub9.hp, -1);
  assert.ok(!("strength" in sub9) && !("itemTable" in sub9));
  const sub11 = newEntry(file("units", 8, 11), "hfoo", [0, 0, 0]) as unknown as Record<string, unknown>;
  assert.ok("strength" in sub11 && "itemTable" in sub11);
  assert.equal(sub11.level, 1);
});

test("a new unit copied from an uprooted Ancient isn't uprooted", () => {
  const ancient = { id: "eaow", variation: 0, position: [0, 0, 0], angle: 0, scale: [1, 1, 1], player: 1, playerFlags: 0x10000 } as Placed;
  const e = newEntry(file("units", 8, 11, {}, [ancient]), "eaow", [64, 0, 0]) as unknown as Record<string, unknown>;
  assert.equal("playerFlags" in e, false);
});
