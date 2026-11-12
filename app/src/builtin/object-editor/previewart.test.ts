import { test } from "node:test";
import assert from "node:assert/strict";
import { ABILITY_ART, abilityArt, firstModel, previewTeam, previewTextures } from "./previewart";
import { skinTextures } from "../../lib/model/replaceable";

test("a tree's own texture is btxf under btxi, with .blp added when it has no extension", () => {
  assert.deepEqual(previewTextures({ texId: 31, texFile: "ReplaceableTextures\\AshenvaleTree\\AshenTree" }), { 31: "ReplaceableTextures\\AshenvaleTree\\AshenTree.blp" });
  assert.deepEqual(previewTextures({ texId: 11, texFile: "ReplaceableTextures\\Cliff\\Cliff1.blp" }), { 11: "ReplaceableTextures\\Cliff\\Cliff1.blp" });
  // The terrain view reads the same function.
  assert.deepEqual(previewTextures({ texId: 31, texFile: "A" }), skinTextures({ texId: 31, texFile: "A" }));
  // No id or no file: nothing replaced (control: the picks below do add).
  assert.deepEqual(previewTextures({ texId: -1, texFile: "x.blp" }), {});
  assert.deepEqual(previewTextures({ texId: 31, texFile: "" }), {});
});

test("a picked texture replaces the type's own at its id, or sets the id given", () => {
  const own = { texId: 31, texFile: "A.blp" };
  assert.deepEqual(previewTextures(own, { id: 31, path: "B.blp" }), { 31: "B.blp" });
  assert.deepEqual(previewTextures({ texId: -1, texFile: "" }, { id: 33, path: "B.blp" }), { 33: "B.blp" });
  assert.deepEqual(previewTextures(own, { id: 0, path: "B.blp" }), { 31: "A.blp" });
});

test("the player colour: the choice, else the type's own, else red; out of range is red", () => {
  assert.equal(previewTeam(5, 2), 5);
  assert.equal(previewTeam(null, 2), 2);
  assert.equal(previewTeam(null, undefined), 0);
  assert.equal(previewTeam(null, 24), 0);
  assert.equal(previewTeam(23, null), 23);
  assert.equal(previewTeam(-1, 7), 7);
  assert.equal(previewTeam(1.5, null), 0);
});

test("an ability's art: the chosen field with a model, else the first that has one", () => {
  const values: Record<string, string> = { acat: "", atat: "Abilities\\T.mdl,Other.mdl", aeat: "_", amat: "Abilities\\M.mdl" };
  const get = (id: string) => values[id] ?? "";
  assert.deepEqual(abilityArt(get), { id: "atat", path: "Abilities\\T.mdl" });
  assert.deepEqual(abilityArt(get, "amat"), { id: "amat", path: "Abilities\\M.mdl" });
  assert.deepEqual(abilityArt(get, "aeat"), { id: "atat", path: "Abilities\\T.mdl" }, "a chosen field without a model falls back");
  assert.equal(abilityArt(() => ""), null);
  assert.equal(firstModel(" , x"), null);
  assert.equal(new Set(ABILITY_ART.map((a) => a.id)).size, 6);
});
