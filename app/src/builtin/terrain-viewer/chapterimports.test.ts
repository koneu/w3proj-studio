import assert from "node:assert/strict";
import { test } from "node:test";
import { campaignCandidates } from "./chapterimports";

test("an archive path becomes nested parts below the campaign's map folder, in the order given", () => {
  const names = ["_HD.w3mod\\war3mapImported\\Hero.mdx", "war3mapImported\\Hero.mdx"];
  assert.deepEqual(campaignCandidates("/home/u/c", names, null), ["/home/u/c/map/_HD.w3mod/war3mapImported/Hero.mdx", "/home/u/c/map/war3mapImported/Hero.mdx"]);
  assert.deepEqual(campaignCandidates("C:\\c", ["Units\\a.blp"], null), ["C:\\c\\map\\Units\\a.blp"]);
  for (const c of campaignCandidates("/c", ["a\\b.blp"], null)) assert.ok(!c.includes("\\"));
});

test("the name on disk is used whatever the case; the exact name wins; an unlisted one is left out", () => {
  const listing = ["war3campImported/hero.mdx", "Units/A.mdx", "units/a.mdx", "_hd.w3mod/war3campimported/hero.mdx"];
  assert.deepEqual(campaignCandidates("/c", ["_HD.w3mod\\war3campImported\\Hero.mdx", "war3campImported\\HERO.MDX"], listing),
    ["/c/map/_hd.w3mod/war3campimported/hero.mdx", "/c/map/war3campImported/hero.mdx"]);
  assert.deepEqual(campaignCandidates("/c", ["units\\a.mdx", "UNITS\\A.MDX", "none\\x.blp"], listing), ["/c/map/units/a.mdx", "/c/map/Units/A.mdx"]);
});

test("a name that would lead out of the campaign's map folder is never a candidate", () => {
  // A model's texture path is the map author's text: "..\\..\\x.blp" must not become a file outside the campaign.
  for (const listing of [null, ["a.blp"], ["../../secret.blp"]]) {
    assert.deepEqual(campaignCandidates("/home/u/c", ["..\\..\\secret.blp", "a\\..\\..\\..\\x.blp", ".\\a.blp", "../../secret.blp"], listing), []);
  }
  assert.deepEqual(campaignCandidates("/c", ["a..b\\c.blp"], null), ["/c/map/a..b/c.blp"]);
});
