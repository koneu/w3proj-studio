import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { loadKind } from "./metadata";

/** An SLK of a header row and rows. */
const slk = (header: string[], ...rows: string[][]) => {
  const lines = ["ID;PWXL;N;E"];
  for (const [y, row] of [header, ...rows].entries()) {
    for (const [x, v] of row.entries()) lines.push(`C;Y${y + 1};X${x + 1};K"${v}"`);
  }
  return [...lines, "E"].join("\n");
};

const META = ["ID", "field", "slk", "index", "repeat", "data", "type", "category", "displayName", "sort"];

/** A stand-in game; one for the whole file, as the profile files are read once per process. */
const files: Record<string, string> = {
  "Doodads\\DoodadMetaData.slk": slk(META,
    ["dvar", "numVar", "DoodadData", "-1", "0", "0", "int", "art", "Variations", "a1"],
    ["dfil", "file", "Profile", "-1", "0", "0", "model", "art", "Model", "a2"]),
  "Doodads\\Doodads.slk": slk(["doodID", "numVar", "category"], ["LTlt", "4", "D"], ["Yosh", "2", "D"]),
  "War3.w3mod:Doodads/DoodadSkins.txt": "[LTlt]\nskinType=doodad\nfile=Doodads\\LTlt.mdl\n[YOsh]\nskinType=doodad\nfile=Doodads\\Yosh.mdl\n",
  "Units\\AbilityBuffMetaData.slk": slk(META,
    ["fart", "Buffart", "Profile", "-1", "0", "0", "icon", "art", "Icon", "a1"],
    ["fnam", "EditorName", "Profile", "-1", "0", "0", "string", "text", "Name", "a2"]),
  "Units\\AbilityBuffData.slk": slk(["alias", "race"], ["BNss", "other"], ["Bexa", "other"], ["Bnon", "other"]),
  // Buffs share the ability skin table. Another kind's section spelled as a type in another case isn't the type's:
  // [yosh] isn't the doodad Yosh's, [BNON] not the buff Bnon's.
  "War3.w3mod:Units/AbilitySkin.txt": [
    "[yosh]", "skinType=ability", "file=Abilities\\Wrong.mdl",
    "[Bnss]", "skinType=buff", "buffart=Bnss.blp",
    "[Bexa]", "skinType=buff", "buffart=Exact.blp",
    "[BEXA]", "skinType=buff", "buffart=Upper.blp",
    "[BNON]", "skinType=ability", "buffart=Ability.blp",
  ].join("\n"),
  // The type's own spelling in a strings file still counts, for the fields it has.
  "War3.w3mod:_Locales/enUS.w3mod:Units/ItemAbilityStrings.txt": "[BNss]\neditorname=Sleep\n",
};
const w3 = {
  settings: { get: () => undefined },
  game: {
    list: async () => Object.keys(files).filter((p) => p.includes(":")),
    readText: async (path: string) => files[path] ?? "",
  },
} as unknown as W3Api;

test("doodads have defaults from Doodads.slk, which DoodadMetaData calls DoodadData", async () => {
  const kind = await loadKind(w3, "w3d");
  const dvar = kind.fieldById.get("dvar")!, dfil = kind.fieldById.get("dfil")!;
  assert.equal(kind.defaultValue("LTlt", dvar, 0), "4");
  assert.equal(kind.defaultValue("LTlt", dfil, 0), "Doodads\\LTlt.mdl");
  assert.equal(kind.defaultValue("Yosh", dvar, 0), "2");
});

test("a type's skin section spelled in another case gives its art", async () => {
  const kind = await loadKind(w3, "w3d");
  assert.equal(kind.defaultValue("Yosh", kind.fieldById.get("dfil")!, 0), "Doodads\\Yosh.mdl", "Yosh's section is [YOsh]");
});

test("another case is only looked for among the kind's own sections, after the own spelling", async () => {
  const kind = await loadKind(w3, "w3h");
  const fart = kind.fieldById.get("fart")!, fnam = kind.fieldById.get("fnam")!;
  assert.equal(kind.defaultValue("BNss", fart, 0), "Bnss.blp");
  assert.equal(kind.defaultValue("BNss", fnam, 0), "Sleep");
  assert.equal(kind.defaultValue("Bexa", fart, 0), "Exact.blp", "the own spelling wins over another case");
  assert.equal(kind.defaultValue("Bnon", fart, 0), undefined, "an ability's section isn't a buff's");
});
