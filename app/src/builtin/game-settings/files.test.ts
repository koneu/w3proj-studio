import assert from "node:assert/strict";
import { test } from "node:test";
import { CAMPAIGN_FILES, MAP_FILES, settingsFiles, settingsOf } from "./files";

test("a campaign project edits the campaign's files, a map project the map's", () => {
  assert.deepEqual(settingsFiles(["map/war3map.w3i.json", "map/war3map.wts"]), MAP_FILES);
  assert.deepEqual(settingsFiles(["map/war3campaign.w3f.json", "maps/a.w3x/map/war3map.w3i.json"]), CAMPAIGN_FILES);
  // Any case and either slash; a chapter's campaign file deeper down doesn't make the project a campaign.
  assert.deepEqual(settingsFiles(["Map\\War3Campaign.w3f.json"]), CAMPAIGN_FILES);
  assert.deepEqual(settingsFiles(["maps/x/map/war3campaign.w3f.json"]), MAP_FILES);
  assert.equal(CAMPAIGN_FILES.misc, "map/war3campaignMisc.txt");
  assert.equal(CAMPAIGN_FILES.skin, "map/war3campaignSkin.txt");
});

test("an editor's mode and string table follow its file", () => {
  assert.deepEqual(settingsOf("map/war3mapMisc.txt"), { mode: "misc", wts: "map/war3map.wts", campaign: false });
  assert.deepEqual(settingsOf("map/war3mapSkin.txt"), { mode: "skin", wts: "map/war3map.wts", campaign: false });
  assert.deepEqual(settingsOf("map/war3campaignMisc.txt"), { mode: "misc", wts: "map/war3campaign.wts", campaign: true });
  assert.deepEqual(settingsOf("map/War3CampaignSkin.txt"), { mode: "skin", wts: "map/war3campaign.wts", campaign: true });
  // A game file opened read-only keeps its own folder.
  assert.deepEqual(settingsOf("game:x/war3campaignSkin.txt").wts, "game:x/war3campaign.wts");
});
