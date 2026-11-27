import assert from "node:assert/strict";
import { test } from "node:test";
import { newWai, NO_ID, parseWai, writeWai } from "../../lib/ai/wai";
import { waiFromText, waiToText } from "../../lib/ai/waitext";
import { describeAi, setAi } from "./tools";

test("get_ai shows a new AI as the AI Editor does", () => {
  const d = describeAi(newWai());
  assert.deepEqual([d.name, d.race, d.options.meleeGame, d.options.buyItems, d.workers.gold, d.heroes, d.heroChances.reduce((a, b) => a + b)],
    ["Just another Warcraft III AI", "human", true, false, "hpea", ["Hpal", "Hamg", "Hmkg"], 100]);
  assert.deepEqual(d.build[0], { id: "htow", kind: "unit", town: "Any" });
  assert.deepEqual(d.groups[0].units[0], { id: "1HIA", quantity: "All" });
  assert.deepEqual([d.waves, d.minimumForces], [[{ group: "All Units", delay: 0 }], "First Hero Only"]);
});

test("set_ai changes only what is given, and the file written reads back the same", () => {
  const ai = newWai();
  const changed = setAi(ai, {
    name: "Orc Rush", race: "orc", options: { heroesFlee: false, buyItems: true }, workers: { gold: "opeo", wood: "opeo", baseBuilding: "ogre", mineBuilding: "" },
    heroes: ["Obla", "Ofar", ""], heroChances: [50, 50, 0, 0, 0, 0],
    build: [{ id: "ogre" }, { id: "opeo", town: "main" }, { id: "Rome", kind: "upgrade" }, { id: "XEIA", town: 1 }, { id: "1HIA" }],
    initialDelay: 120, repeatWaves: 1,
  });
  assert.equal(changed, true);
  const back = describeAi(parseWai(writeWai(ai), () => 0));
  assert.deepEqual([back.name, back.race, back.options.heroesFlee, back.options.buyItems, back.options.meleeGame, back.heroes, back.heroChances, back.initialDelay],
    ["Orc Rush", "orc", false, true, true, ["Obla", "Ofar", ""], [50, 50, 0, 0, 0, 0], 120]);
  assert.deepEqual(back.workers, { gold: "opeo", wood: "opeo", baseBuilding: "ogre", mineBuilding: "" });
  assert.equal(ai.workers[3], NO_ID);
  assert.deepEqual(back.build, [{ id: "ogre", kind: "unit", town: "Any" }, { id: "opeo", kind: "unit", town: "Main" }, { id: "Rome", kind: "upgrade", town: "Any" },
    { id: "XEIA", kind: "expansion", town: "Exp 1" }, { id: "1HIA", kind: "unit", town: "Any" }]);
  assert.equal(back.harvest.length, 4, "what wasn't given stays");
  assert.equal(setAi(ai, { name: "Orc Rush", options: { buyItems: true } }), false, "the same again changes nothing");
});

test("what the AI Editor wouldn't take is refused", () => {
  const ai = newWai();
  const refuses = (args: Record<string, unknown>, why: RegExp) => assert.throws(() => setAi(structuredClone(ai), args), why);
  refuses({ race: "naga" }, /race must be one of: custom, human, orc, undead, nightelf/);
  refuses({ options: { flee: true } }, /"flee" isn't an AI option. They are: meleeGame, targetHeroes/);
  refuses({ options: { meleeGame: 1 } }, /options.meleeGame must be true or false/);
  refuses({ workers: { gold: "peasant" } }, /workers.gold must be an object id of four characters/);
  refuses({ workers: { lumber: "hpea" } }, /workers takes gold, wood, baseBuilding, mineBuilding/);
  refuses({ heroes: ["Hpal"] }, /three hero ids/);
  refuses({ heroChances: [50, 50, 50, 0, 0, 0] }, /add up to 100/);
  refuses({ skills: [["AHhb"]] }, /nine lists of ten/);
  refuses({ build: [{ id: "" }] }, /build\[0\].id must be an object id of four characters, like hpea\./);
  refuses({ build: [{ id: "hpea", count: 5 }] }, /takes id, kind and town, not count/);
  refuses({ build: [{ id: "hpea", town: "exp" }] }, /town must be "any", "main" or an expansion's number/);
  refuses({ build: [{ id: "1HIA", kind: "upgrade" }] }, /1HIA isn't an upgrade/);
  refuses({ initialDelay: -5 }, /Initial Delay must be a whole number from 0/);
  refuses({ repeatWaves: 5 }, /Repeat Waves must be a whole number from 0 to 1/);
  // A build list with conditions is the AI Editor's to change.
  const cond = newWai();
  cond.build[1].condIndex = 0;
  assert.throws(() => setAi(cond, { build: [{ id: "htow" }] }), /have conditions.*AI Editor/);
});

test("a .wai file goes through the edit list as text and comes back byte for byte", () => {
  const bytes = writeWai(newWai());
  const text = waiToText(bytes);
  assert.match(text, /^w3proj\.wai\.base64:/);
  assert.deepEqual(waiFromText(text), bytes);
  const big = Uint8Array.from({ length: 100_000 }, (_, i) => i % 256);
  assert.deepEqual(waiFromText(waiToText(big)), big);
  assert.throws(() => waiFromText("name = Orc Rush"), /isn't text: use set_ai/);
});
