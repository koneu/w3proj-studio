import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { isCampaignObjectFile, readCampaignObjects } from "./campaign";
import { isScriptInput } from "../script/guard";

/** The app's API over a campaign folder's files: a value of null is there but unreadable. */
function disk(files: Record<string, string | null>, decoded: Record<string, string> = {}) {
  const w3 = {
    workspace: {
      readText: async (p: string) => {
        if (!(p in files)) throw new Error(`${p}: No such file or directory (os error 2)`);
        if (files[p] === null) throw new Error(`${p}: Permission denied (os error 13)`);
        return files[p];
      },
    },
    backend: {
      invoke: async (command: string, args: { path: string; root?: string }) => {
        if (command === "fs_exists") return args.path in files;
        if (command === "codec_decode") {
          const text = decoded[`${args.root}|${args.path}`];
          if (text === undefined) throw new Error("no format definition reads it");
          return text;
        }
        throw new Error(`unexpected ${command}`);
      },
    },
  };
  return w3 as unknown as W3Api;
}

test("a campaign's object file: its JSON, else the raw file through its codec, else none", async () => {
  const json = disk({ "/c/map/war3campaign.w3u.json": '{"custom":[{"id":"h000"}]}' });
  assert.deepEqual(await readCampaignObjects(json, "/c", "w3u"), { custom: [{ id: "h000" }] });
  assert.equal(await readCampaignObjects(json, "/c", "w3u", true), null, "no Skin file");
  assert.equal(await readCampaignObjects(json, "/c", "w3t"), null);
  const raw = disk({ "/c/map/war3campaignSkin.w3a": "bytes" }, { "/c|map/war3campaignSkin.w3a": '{"custom":[]}' });
  assert.deepEqual(await readCampaignObjects(raw, "/c", "w3a", true), { custom: [] });
});

test("a campaign's object file that is there but can't be read throws, naming it", async () => {
  await assert.rejects(readCampaignObjects(disk({ "/c/map/war3campaign.w3u.json": null }), "/c", "w3u"), /war3campaign\.w3u\.json is there but can't be read.*Permission denied/);
  await assert.rejects(readCampaignObjects(disk({ "/c/map/war3campaign.w3u.json": "{ broken" }), "/c", "w3u"), /war3campaign\.w3u\.json is there but can't be read/);
  // A raw file no codec reads.
  await assert.rejects(readCampaignObjects(disk({ "/c/map/war3campaign.w3u": "bytes" }), "/c", "w3u"), /war3campaign\.w3u is there but can't be read/);
});

test("which saved files are a campaign's object files: in its own map folder only", () => {
  assert.ok(isCampaignObjectFile("/c/map/war3campaign.w3u.json", "/c"));
  assert.ok(isCampaignObjectFile("/c/map/war3campaignSkin.w3a", "/c/"));
  assert.ok(isCampaignObjectFile("C:\\Camp\\map\\war3campaign.w3t.json", "c:/camp"), "Windows: any case, either slash");
  assert.ok(!isCampaignObjectFile("/C/map/war3campaign.w3u.json", "/c"), "Linux tells case apart");
  assert.ok(!isCampaignObjectFile("/other/map/war3campaign.w3u.json", "/c"));
  assert.ok(!isCampaignObjectFile("/c/map/war3campaign.w3f.json", "/c"));
  assert.ok(!isCampaignObjectFile("/c/map/war3campaign.w3u.json", undefined));
});

test("the map script's inputs: a chapter's campaign's unit, item, ability and destructable data too", () => {
  for (const p of ["/c/map/war3campaign.w3u.json", "/c/map/war3campaignSkin.w3u", "/c/map/war3campaign.w3t.json", "/c/map/war3campaign.w3a", "/c/map/war3campaignSkin.w3b.json"]) assert.ok(isScriptInput(p, "/c"), p);
  for (const p of ["/c/map/war3campaign.w3q.json", "/c/map/war3campaign.w3h.json", "/c/map/war3campaignSkin.w3t.json", "/c/map/war3campaign.wts"]) assert.ok(!isScriptInput(p, "/c"), p);
  assert.ok(!isScriptInput("/c/map/war3campaign.w3u.json", undefined), "not a chapter");
  assert.ok(!isScriptInput("/d/map/war3campaign.w3u.json", "/c"), "another campaign's");
  assert.ok(isScriptInput("map/war3map.w3u.json", undefined), "the map's own as before");
});
