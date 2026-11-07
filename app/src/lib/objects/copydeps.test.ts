import assert from "node:assert/strict";
import { test } from "node:test";
import { planPaste, referencedBy, sameContent, withIdsReplaced, type Copied, type CopyMod, type HoldsIds, type PasteWorld } from "./copydeps";
import { idsUsedBy, replaceIds } from "./refs";

const mod = (field: string, value: string | number): CopyMod => ({ field, type: typeof value === "number" ? "int" : "string", value });
const obj = (ext: string, id: string, base: string, ...mods: CopyMod[]): Copied => ({ ext, object: { id, base, mods } });
/** Fields holding ids: the ones named like object lists. */
const holdsIds: HoldsIds = (_ext, field) => ["uabi", "uhab", "utra", "abuf", "ubui", "useu", "udep"].includes(field);

// The test map: hero H001 has ability A001, which uses buff B001; unit h002 trains unit h003.
const hero = obj("w3u", "H001", "Hpal", mod("unam", "Hero"), mod("uhab", "A001,AHhb"));
const ability = obj("w3a", "A001", "AHhb", mod("abuf", "B001"), mod("anam", "A001 is not an id field"));
const buff = obj("w3h", "B001", "Bfro");
const trainer = obj("w3u", "h002", "hbar", mod("utra", "h003"));
const trained = obj("w3u", "h003", "hfoo");
const customs = new Map([hero, ability, buff, trainer, trained].map((c) => [c.object.id!, c]));

test("a copy takes along what it refers to, however far, but only custom objects", () => {
  const along = referencedBy([hero], customs, holdsIds);
  assert.deepEqual(along.map((c) => c.object.id), ["A001", "B001"]);
  assert.deepEqual(referencedBy([trainer], customs, holdsIds).map((c) => c.object.id), ["h003"]);
  assert.deepEqual(referencedBy([buff], customs, holdsIds), []);
});

test("only fields that hold ids count, not any text that looks like an id", () => {
  const o = obj("w3u", "H009", "Hpal", mod("unam", "A001"), mod("uhab", "B001"));
  assert.deepEqual(referencedBy([o], customs, holdsIds).map((c) => c.object.id), ["B001"]);
  assert.deepEqual(idsUsedBy(o.object, new Set(["A001", "B001"])), ["A001", "B001"]);
});

test("objects that refer to each other, or to themselves, are taken once", () => {
  const a = obj("w3a", "A100", "AHhb", mod("abuf", "B100,A100"));
  const b = obj("w3h", "B100", "Bfro", mod("abuf", "A100"));
  const loop = new Map([a, b].map((c) => [c.object.id!, c]));
  assert.deepEqual(referencedBy([a], loop, holdsIds).map((c) => c.object.id), ["B100"]);
  assert.deepEqual(referencedBy([a, b], loop, holdsIds), []);
});

test("references in sets of a version 3 object count", () => {
  const sets: Copied = { ext: "w3u", object: { id: "H002", base: "Hpal", sets: [{ flag: 0, mods: [mod("uhab", "A001")] }] } };
  assert.deepEqual(referencedBy([sets], customs, holdsIds).map((c) => c.object.id), ["A001", "B001"]);
});

test("same content: ids and the order of fields don't matter, values do", () => {
  const a = { base: "hfoo", id: "h010", mods: [mod("unam", "x"), { field: "uhpm", type: "int", level: 0, value: 5 }] };
  const b = { base: "hfoo", id: "h777", end: "h777", mods: [{ field: "uhpm", type: "int", value: 5 }, mod("unam", "x")] };
  assert.equal(sameContent(a, b), true);
  assert.equal(sameContent(a, { ...b, mods: [mod("unam", "x"), { field: "uhpm", type: "int", value: 6 }] }), false);
  assert.equal(sameContent(a, { ...b, base: "hkni" }), false);
  assert.equal(sameContent(a, { ...b, mods: [mod("unam", "x")] }), false);
  const levelled = { base: "AHhb", mods: [{ field: "adur", type: "real", level: 1, value: 3 }] };
  assert.equal(sameContent(levelled, { base: "AHhb", mods: [{ field: "adur", type: "real", level: 2, value: 3 }] }), false);
  assert.equal(sameContent({ base: "x", sets: [{ flag: 1, mods: [mod("a", 1)] }] }, { base: "x", sets: [{ flag: 2, mods: [mod("a", 1)] }] }), false);
});

test("replacing ids keeps separators and only touches id fields", () => {
  assert.equal(replaceIds("A001, AHhb;B001", new Map([["A001", "A002"], ["B001", "B002"]])), "A002, AHhb;B002");
  const c = withIdsReplaced(hero, new Map([["A001", "A777"]]), holdsIds);
  assert.equal(c.mods!.find((m) => m.field === "uhab")!.value, "A777,AHhb");
  assert.equal(hero.object.mods!.find((m) => m.field === "uhab")!.value, "A001,AHhb", "the source is untouched");
  assert.equal(withIdsReplaced(ability, new Map([["A001", "A777"]]), holdsIds).mods!.find((m) => m.field === "anam")!.value, "A001 is not an id field");
});

/** A target map with these custom objects and game ids. */
function world(have: Copied[] = [], game: string[] = []): PasteWorld {
  const by = new Map(have.map((c) => [c.object.id!, c]));
  return {
    existing: (id) => by.get(id),
    game: (id) => game.includes(id),
    taken: new Set([...by.keys(), ...game]),
    allocate: (ext, _base, taken) => { for (let n = 0; ; n++) { const id = `${ext === "w3u" ? "h" : ext === "w3a" ? "A" : "B"}${String(n).padStart(3, "0")}`; if (!taken.has(id)) return id; } },
    holdsIds,
  };
}
const heroSet = () => ({ chosen: [hero], along: referencedBy([hero], customs, holdsIds) });
const idsOf = (p: ReturnType<typeof planPaste>) => p.writes.map((w) => `${w.ext}:${w.object.id}`);

test("pasting into a map that has none of it: the hero is new, what it refers to keeps its ids", () => {
  const p = planPaste(heroSet(), world(), "keep");
  assert.deepEqual(idsOf(p), ["w3u:h000", "w3a:A001", "w3h:B001"]);
  assert.deepEqual(p.conflicts, []);
  const written = p.writes[0].object;
  assert.equal(written.mods!.find((m) => m.field === "uhab")!.value, "A001,AHhb");
  assert.deepEqual(p.items.map((i) => i.fate), ["chosen", "add", "add"]);
});

test("the same objects already in the target are used, not pasted again", () => {
  const p = planPaste(heroSet(), world([structuredClone(ability), structuredClone(buff)]), "new");
  assert.deepEqual(idsOf(p), ["w3u:h000"]);
  assert.deepEqual(p.items.map((i) => i.fate), ["chosen", "same", "same"]);
  assert.deepEqual(p.conflicts, []);
});

test("other content under the same id is a conflict, settled by keeping, overwriting or new ids", () => {
  const other = obj("w3a", "A001", "AHhb", mod("abuf", "B001"), mod("aart", "different.blp"));
  const w = () => world([other, structuredClone(buff)]);
  const kept = planPaste(heroSet(), w(), "keep");
  assert.deepEqual(kept.conflicts, ["A001"]);
  assert.deepEqual(idsOf(kept), ["w3u:h000"]);
  assert.equal(kept.items[1].fate, "kept");
  const over = planPaste(heroSet(), w(), "overwrite");
  assert.deepEqual(idsOf(over), ["w3u:h000", "w3a:A001"]);
  assert.equal(over.writes[1].overwrites, "A001");
  const fresh = planPaste(heroSet(), w(), "new");
  assert.deepEqual(idsOf(fresh), ["w3u:h000", "w3a:A000"]);
  assert.equal(fresh.writes[0].object.mods!.find((m) => m.field === "uhab")!.value, "A000,AHhb", "the hero uses the new ability");
  assert.equal(fresh.writes[1].object.id, "A000");
  assert.equal(fresh.writes[1].overwrites, undefined);
});

test("a reused object that refers to one given a new id isn't the same any more and gets one too", () => {
  const otherBuff = obj("w3h", "B001", "Bfro", mod("fnam", "different"));
  const p = planPaste(heroSet(), world([structuredClone(ability), otherBuff]), "new");
  assert.deepEqual(p.conflicts, ["B001"]);
  assert.deepEqual(idsOf(p), ["w3u:h000", "w3a:A000", "w3h:B000"]);
  const a = p.writes.find((w) => w.ext === "w3a")!.object;
  assert.equal(a.mods!.find((m) => m.field === "abuf")!.value, "B000");
  assert.equal(p.items[1].fate, "renamed");
  assert.match(p.items[1].reason ?? "", /new id/);
  // Keeping the target's buff leaves the ability alone.
  const kept = planPaste(heroSet(), world([structuredClone(ability), otherBuff]), "keep");
  assert.deepEqual(idsOf(kept), ["w3u:h000"]);
});

test("an id a game object or another kind has can't be overwritten: the object gets a new id", () => {
  const p = planPaste(heroSet(), world([], ["A001"]), "overwrite");
  assert.deepEqual(p.conflicts, [], "nothing to ask: there is no choice");
  assert.deepEqual(idsOf(p), ["w3u:h000", "w3a:A000", "w3h:B001"]);
  assert.match(p.items[1].reason ?? "", /game object/);
  const wrongKind = planPaste(heroSet(), world([obj("w3u", "B001", "hfoo")]), "keep");
  assert.deepEqual(idsOf(wrongKind), ["w3u:h000", "w3a:A001", "w3h:B000"]);
  assert.match(wrongKind.items[2].reason ?? "", /another kind/);
});

test("new ids are not ids that other pasted objects keep", () => {
  // The target has A000 free, but an object from the copy keeps A000; the hero's copy must not take it.
  const keeps = obj("w3a", "A000", "AHhb");
  const set = { chosen: [obj("w3a", "A050", "AHhb", mod("abuf", "A000"))], along: [keeps] };
  const p = planPaste(set, world(), "keep");
  assert.deepEqual(idsOf(p), ["w3a:A001", "w3a:A000"]);
});

test("a chain: the unit that trains another unit comes with it, and pasting twice reuses it", () => {
  const set = { chosen: [trainer], along: referencedBy([trainer], customs, holdsIds) };
  const first = planPaste(set, world(), "keep");
  assert.deepEqual(idsOf(first), ["w3u:h000", "w3u:h003"]);
  const target = world([{ ext: "w3u", object: first.writes[1].object }]);
  const second = planPaste(set, target, "keep");
  assert.deepEqual(idsOf(second), ["w3u:h000"]);
});

test("map pieces: the types come under their own ids, the picked ones not forced to change", () => {
  const set = { chosen: [trainer], along: [trained] };
  const p = planPaste(set, world(), "keep", false);
  assert.deepEqual(idsOf(p), ["w3u:h002", "w3u:h003"]);
  const clash = planPaste(set, world([obj("w3u", "h002", "hkni")]), "new", false);
  assert.deepEqual(clash.conflicts, ["h002"]);
  assert.equal(clash.renames.get("h002"), "h000");
  assert.deepEqual(idsOf(clash), ["w3u:h000", "w3u:h003"]);
});

test("a standard object's changes come as a new object and nothing refers to it", () => {
  const std: Copied = { ext: "w3u", object: { base: "hfoo", mods: [mod("utra", "h003")] } };
  const p = planPaste({ chosen: [std], along: [trained] }, world(), "keep");
  assert.deepEqual(idsOf(p), ["w3u:h000", "w3u:h003"]);
  assert.equal(p.items[0].from, undefined);
});

test("what refers back to a copied object follows it to its new id, even if the target has the same", () => {
  // The copy is A100, which uses B100; B100 refers back to A100. The target already has B100 as it is.
  const a = obj("w3a", "A100", "AHhb", mod("abuf", "B100"));
  const b = obj("w3h", "B100", "Bfro", mod("abuf", "A100"));
  const p = planPaste({ chosen: [a], along: [b] }, world([structuredClone(b)]), "keep");
  assert.deepEqual(p.conflicts, []);
  assert.deepEqual(idsOf(p), ["w3a:A000", "w3h:B000"]);
  assert.equal(p.writes[1].object.mods!.find((m) => m.field === "abuf")!.value, "A000");
  assert.equal(p.writes[0].object.mods!.find((m) => m.field === "abuf")!.value, "B000");
});
