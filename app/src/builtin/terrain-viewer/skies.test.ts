import assert from "node:assert/strict";
import { test } from "node:test";
import { skyList } from "./skies";

const data = "[TileSets]\nA=x\n\n[SkyModels]\n\n00=Environment\\Sky\\BlizzardSky\\BlizzardSky.mdl,WESTRING_SKYMODEL_SKY08\r\n01=Environment\\Sky\\Sky\\SkyLight.mdl,WESTRING_NOT_THERE\n\n[Next]\n02=Other\\Thing.mdl,WESTRING_SKYMODEL_SKY08\n";
const strings = "WESTRING_SKYMODEL_SKY08=&Blizzard Sky\r\nOTHER=x\n";

test("the list comes from its own section, with the World Editor's names", () => {
  assert.deepEqual(skyList(data, strings), [
    { path: "Environment\\Sky\\BlizzardSky\\BlizzardSky.mdl", name: "Blizzard Sky" },
    { path: "Environment\\Sky\\Sky\\SkyLight.mdl", name: "SkyLight" },
  ]);
});

test("no list, no skies", () => {
  assert.deepEqual(skyList("[Other]\n", strings), []);
});
