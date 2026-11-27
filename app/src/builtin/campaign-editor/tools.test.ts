import assert from "node:assert/strict";
import { test } from "node:test";
import { StringTable } from "../../lib/formats/wts";
import { describeCampaign, setCampaignInfo, type ToolCampaign } from "./tools";

const campaign = (): ToolCampaign => ({
  name: "TRIGSTR_001", difficulty: "Normal", author: "Me", description: "TRIGSTR_002", race: 0,
  chapters: [{ flags: 1, chapter: "Chapter 1", title: "TRIGSTR_003", map: "a.w3x" }, { flags: 0, chapter: "Chapter 2", title: "Second", map: "b.w3x" }],
  mapOrder: [{ unknown: "", map: "a.w3x" }, { unknown: "", map: "b.w3x" }],
});
const wts = "STRING 1\r\n{\r\nOld name\r\n}\r\n\r\nSTRING 2\r\n{\r\nA tale.\r\n}\r\n\r\nSTRING 3\r\n{\r\nFirst\r\n}\r\n";

test("campaign_info reads the texts through the string table", () => {
  assert.deepEqual(describeCampaign(campaign(), new StringTable(wts)), {
    name: "Old name", difficulty: "Normal", author: "Me", description: "A tale.", race: "human",
    chapters: [{ number: 1, chapter: "Chapter 1", title: "First", map: "a.w3x", shown: true }, { number: 2, chapter: "Chapter 2", title: "Second", map: "b.w3x", shown: false }],
    maps: ["a.w3x", "b.w3x"],
  });
  assert.equal(describeCampaign(campaign(), null).name, "TRIGSTR_001", "without a table the reference is all there is");
});

test("set_campaign_info changes a text where it is kept: in the string table for a reference, else in the campaign", () => {
  const info = campaign(), table = new StringTable(wts);
  const changed = setCampaignInfo(info, table, { name: "New name", author: "You", race: "undead", chapters: [{ number: 1, title: "The Start" }, { number: 2, title: "The End", shown: true }] });
  assert.equal(changed, true);
  assert.deepEqual([info.name, info.author, info.race, info.chapters[0].title, info.chapters[1].title, info.chapters[1].flags], ["TRIGSTR_001", "You", 2, "TRIGSTR_003", "The End", 1]);
  assert.equal(table.dirty, true);
  assert.match(table.serialize(), /STRING 1\r\n\{\r\nNew name\r\n\}[\s\S]*STRING 3\r\n\{\r\nThe Start\r\n\}/);
  // The same again changes nothing, in either file.
  const again = new StringTable(table.serialize());
  assert.equal(setCampaignInfo(info, again, { name: "New name", author: "You", race: "undead" }), false);
  assert.equal(again.dirty, false);
  // A reference the table doesn't have is replaced by the text itself.
  const lost = campaign();
  setCampaignInfo(lost, new StringTable(""), { name: "Plain" });
  assert.equal(lost.name, "Plain");
});

test("what isn't a text, a race or a chapter of the campaign is refused", () => {
  const info = campaign(), table = new StringTable(wts);
  assert.throws(() => setCampaignInfo(info, table, { name: 5 }), /name must be text/);
  assert.throws(() => setCampaignInfo(info, table, { race: "naga" }), /race must be one of: human, orc, undead, nightelf/);
  assert.throws(() => setCampaignInfo(info, table, { chapters: [{ number: 3, title: "x" }] }), /no chapter button 3; the campaign has 2/);
  assert.throws(() => setCampaignInfo(info, table, { chapters: [{ number: 1, map: "c.w3x" }] }), /not map\. Maps are added and removed in the Campaign Editor/);
  assert.throws(() => setCampaignInfo(info, table, { chapters: [{ number: 1, shown: "yes" }] }), /shown must be true or false/);
});
