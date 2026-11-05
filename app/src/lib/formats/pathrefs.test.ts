import assert from "node:assert/strict";
import { test } from "node:test";
import { countPathRefs, replacePathRefs, samePathRef } from "./pathrefs";

test("JSON (escaped backslashes), keeping the reference's case of the rest", () => {
  const json = '{"field":"umdl","value":"war3mapImported\\\\Hero.mdl"},{"field":"uico","value":"War3mapImported\\\\BTNHero.blp"}';
  assert.equal(countPathRefs(json, "war3mapImported\\Hero.mdx"), 1);
  assert.equal(replacePathRefs(json, "war3mapImported\\Hero.mdx", "Units\\Knight.mdx"),
    '{"field":"umdl","value":"Units\\\\Knight.mdl"},{"field":"uico","value":"War3mapImported\\\\BTNHero.blp"}');
  assert.equal(replacePathRefs(json, "war3mapimported\\btnhero.blp", "Icons\\BTNKnight.blp"),
    '{"field":"umdl","value":"war3mapImported\\\\Hero.mdl"},{"field":"uico","value":"Icons\\\\BTNKnight.blp"}');
});

test("scripts and plain text: \\\\, \\ and / separators", () => {
  const jass = 'call AddSpecialEffect("war3mapImported\\\\fx\\\\Boom.mdx", x, y)';
  assert.equal(replacePathRefs(jass, "war3mapImported\\fx\\Boom.mdx", "fx\\Bang.mdx"), 'call AddSpecialEffect("fx\\\\Bang.mdx", x, y)');
  assert.equal(replacePathRefs("Art=war3mapImported/fx/Boom.mdl", "war3mapImported\\fx\\Boom.mdx", "fx\\Bang.mdx"), "Art=fx/Bang.mdl");
  assert.equal(replacePathRefs("Bitmap \"war3mapImported\\Skin.blp\"", "war3mapImported\\Skin.blp", "Skin2.blp"), "Bitmap \"Skin2.blp\"");
});

test("only whole paths: no longer names, no other folders", () => {
  const text = '"war3mapImported\\\\Hero.mdl" "war3mapImported\\\\Hero_portrait.mdl" "Units\\\\war3mapImported\\\\Hero.mdl" "war3mapImported\\\\Hero.mdl2"';
  assert.equal(countPathRefs(text, "war3mapImported\\Hero.mdx"), 1);
  assert.equal(countPathRefs("Hero.blp Hero.blp.bak xHero.blp", "Hero.blp"), 1);
});

test("models without an extension (doodad and destructable object data)", () => {
  const model = "war3mapImported\\Fx\\Chest.mdx";
  const json = '{"field":"bfil","value":"war3mapImported\\\\Fx\\\\Chest"}';
  assert.equal(countPathRefs(json, model), 1);
  assert.equal(replacePathRefs(json, model, "Art\\Box.mdx"), '{"field":"bfil","value":"Art\\\\Box"}');
  assert.equal(countPathRefs("Art=war3mapImported/Fx/Chest\r\nNext=1", model), 1);
  assert.equal(countPathRefs("Art=war3mapImported/Fx/Chest", model), 1);
  // A folder of that name and longer names aren't that model.
  for (const other of ["Chest\\\\Lid.blp", "Chest_portrait", "Chest-2", "Chest 2", "Chest.blp"]) {
    assert.equal(countPathRefs(`"war3mapImported\\\\Fx\\\\${other}"`, model), 0, other);
  }
  // A model at the archive root: its bare name is only a word.
  assert.equal(countPathRefs('"Chest" Chest', "Chest.mdx"), 0);
  assert.equal(countPathRefs('"Chest.mdl"', "Chest.mdx"), 1);
  // Textures have no such form.
  assert.equal(countPathRefs('"war3mapImported\\\\Fx\\\\Chest"', "war3mapImported\\Fx\\Chest.blp"), 0);
});

test("samePathRef", () => {
  assert.ok(samePathRef("war3mapImported/Hero.MDL", "War3mapImported\\hero.mdx"));
  assert.ok(!samePathRef("a\\b.blp", "a\\c.blp"));
});
