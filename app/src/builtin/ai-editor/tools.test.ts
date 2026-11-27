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

test("set_ai changes harvest and target priorities, attack groups, waves and the minimum forces", () => {
  const ai = newWai();
  assert.equal(setAi(ai, {
    harvest: [{ resource: "gold", workers: 5 }, { resource: "wood", town: "any", workers: "All NA" }, { resource: "gold", town: 1, workers: "all" }, { resource: "gold", town: "Mine 1", workers: 3 }],
    targets: [{ target: "Enemy - Major Assault" }, { target: "creep camp", creepLevels: [2, 6], flyers: true }, { target: "Creep Camp" }],
    groups: [
      { name: "Rush", units: [{ id: "hfoo", quantity: 4 }, { id: "1HIA" }, { id: "hrif", quantity: "All but 2" }, { id: "hkni", quantity: "2 - All" }, { id: "hmpr", quantity: "1 - 3" }] },
      { name: "All Units", units: [{ id: "hfoo", quantity: "All" }] },
    ],
    waves: [{ group: "Rush", delay: 60 }, { group: "All Units" }, { group: "Rush", delay: 30 }],
    minimumForces: "Rush", repeatWaves: 2,
  }), true);
  // Written and read again, as the AI Editor would open it.
  const read = parseWai(writeWai(ai), () => 0);
  const back = describeAi(read);
  assert.deepEqual(back.harvest, [{ resource: "gold", town: "Main", workers: "5" }, { resource: "wood", town: "Any", workers: "All NA" }, { resource: "gold", town: "Exp 1", workers: "All" },
    { resource: "gold", town: "Mine 1", workers: "3" }]);
  assert.deepEqual(back.targets, [{ target: "Enemy - Major Assault" }, { target: "Creep Camp", creepLevels: [2, 6], flyers: true }, { target: "Creep Camp", creepLevels: [0, 9], flyers: false }]);
  assert.deepEqual(back.groups, [
    { name: "Rush", units: [{ id: "hfoo", quantity: "4" }, { id: "1HIA", quantity: "All" }, { id: "hrif", quantity: "All but 2" }, { id: "hkni", quantity: "2 - All" }, { id: "hmpr", quantity: "1 - 3" }] },
    { name: "All Units", units: [{ id: "hfoo", quantity: "All" }] },
  ]);
  assert.deepEqual([back.waves, back.minimumForces, back.repeatWaves], [[{ group: "Rush", delay: 60 }, { group: "All Units", delay: 0 }, { group: "Rush", delay: 30 }], "Rush", 2]);
  // The entries as the AI Editor makes them.
  assert.deepEqual([read.harvest[0].type, read.targets[0].type, read.targets[0].creep, read.groups.map((g) => g.index)], [1, 2, undefined, [0, 1]]);
  // What get_ai shows goes back in unchanged.
  assert.equal(setAi(ai, { harvest: back.harvest.map((p) => ({ ...p, workers: /^\d+$/.test(p.workers) ? Number(p.workers) : p.workers })), targets: back.targets, groups: back.groups, waves: back.waves, minimumForces: back.minimumForces }), false);

  // New groups: the waves and the minimum forces follow the names that stay.
  assert.equal(setAi(ai, { groups: [{ name: "All Units", units: [] }, { name: "Rush", units: [{ id: "hfoo", quantity: 2 }] }, { name: "Late", units: [] }] }), true);
  const moved = describeAi(ai);
  assert.deepEqual([moved.waves.map((w) => w.group), moved.minimumForces, ai.waves.map((w) => w.group), ai.minForces], [["Rush", "All Units", "Rush"], "Rush", [1, 0, 1], 1]);
  // A group that waves use can't just go; with the waves given it can, and minimum forces fall back.
  assert.throws(() => setAi(structuredClone(ai), { groups: [{ name: "Late", units: [] }] }), /attack waves use the group Rush.*give waves too/);
  assert.throws(() => setAi(structuredClone(ai), { groups: [{ name: "Late", units: [] }], waves: [{ group: "Late" }] }), /Repeat Waves is 2, more than the 1 attack wave/);
  assert.equal(setAi(ai, { groups: [{ name: "Late", units: [] }], waves: [{ group: "Late", delay: 5 }], repeatWaves: 1 }), true);
  assert.deepEqual([describeAi(ai).waves, describeAi(ai).minimumForces], [[{ group: "Late", delay: 5 }], "First Hero Only"]);
});

test("harvest, targets, groups and waves the AI Editor wouldn't take are refused, and so are lists with conditions", () => {
  const ai = newWai();
  const refuses = (args: Record<string, unknown>, why: RegExp) => assert.throws(() => setAi(structuredClone(ai), args), why);
  refuses({ harvest: {} }, /harvest must be a list/);
  refuses({ harvest: [{ resource: "oil", workers: 1 }] }, /resource must be gold or wood/);
  refuses({ harvest: [{ resource: "gold" }] }, /workers must be a number from 1 to 100, "All" or "All NA"/);
  refuses({ harvest: [{ resource: "gold", workers: 0 }] }, /harvest\[0\].workers must be a whole number from 1 to 100/);
  refuses({ harvest: [{ resource: "gold", workers: 5, count: 1 }] }, /takes resource, town and workers, not count/);
  refuses({ targets: [{ target: "Enemy" }] }, /target must be one of: Common Alliance Target; /);
  refuses({ targets: [{ target: "Enemy - Any Town", flyers: true }] }, /belong to a Creep Camp target only/);
  refuses({ targets: [{ target: "Creep Camp", creepLevels: [5, 2] }] }, /maximum 2 is below the minimum 5/);
  refuses({ targets: [{ target: "Creep Camp", creepLevels: [1] }] }, /two numbers/);
  refuses({ groups: [{ name: "", units: [] }] }, /name must be text/);
  refuses({ groups: [{ name: "A", units: [] }, { name: "A", units: [] }], waves: [] , repeatWaves: 0 }, /two groups called A/);
  refuses({ groups: [{ name: "All Units", units: [{ id: "footman" }] }] }, /units\[0\].id must be an object id of four characters/);
  refuses({ groups: [{ name: "All Units", units: [{ id: "hfoo", quantity: "many" }] }] }, /quantity must be a number or one of "All"/);
  refuses({ groups: [{ name: "All Units", units: [{ id: "hfoo", quantity: "All but 0" }] }] }, /units kept back/);
  refuses({ groups: [{ name: "All Units", units: [{ id: "hfoo", quantity: "5 - 2" }] }] }, /maximum 2 is below the minimum 5/);
  refuses({ waves: [{ group: "Nobody" }] }, /waves\[0\].group must be the name of an attack group: All Units/);
  refuses({ waves: [{ group: "All Units", delay: -1 }] }, /waves\[0\].delay must be a whole number from 0/);
  refuses({ waves: [] }, /Repeat Waves is 1, more than the 0 attack waves/);
  refuses({ minimumForces: "Nobody" }, /minimumForces must be "First Hero Only" or the name of an attack group: All Units/);
  for (const [list, args, why] of [
    ["harvest", { harvest: [{ resource: "gold", workers: 5 }] }, /harvest priorities of this AI have conditions/],
    ["targets", { targets: [{ target: "Enemy - Any Town" }] }, /target priorities of this AI have conditions/],
  ] as const) {
    const cond = newWai();
    cond[list][0].condIndex = 0;
    assert.throws(() => setAi(cond, args), why);
  }
  const cond = newWai();
  cond.groups[0].units[0].condIndex = 0;
  assert.throws(() => setAi(cond, { groups: [{ name: "All Units", units: [] }] }), /attack groups' units of this AI have conditions/);
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
