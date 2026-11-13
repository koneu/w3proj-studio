import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { joinPath } from "../../lib/paths";
import { mapObjectData } from "./projectfiles";

test("a chapter map's object data: the campaign's main and Skin files, then the map's own", async () => {
  // Curse of the Forsaken's war3campaignSkin.w3b frees IOt0's fixed rotation (bfxr -1): left out, the doodad rules
  // would turn its placed IOt0 to 270.
  const campaign = joinPath("campaigns", "Forsaken");
  const root = joinPath(campaign, "maps", "Forsaken08.w3x");
  const object = (base: string, field: string, value: number) => JSON.stringify({ original: [{ base, mods: [{ field, value }] }], custom: [] });
  const files: Record<string, string> = {
    [joinPath(campaign, "map", "war3campaign.w3b.json")]: object("ITtg", "bfxr", 90),
    [joinPath(campaign, "map", "war3campaignSkin.w3b.json")]: object("IOt0", "bfxr", -1),
    "map/war3map.w3b.json": object("LTlt", "bfxr", 0),
  };
  const w3 = {
    workspace: {
      project: () => ({ root }),
      files: () => [{ path: "map/war3map.w3b.json" }],
      readText: async (p: string) => { if (p in files) return files[p]; throw new Error(`not found: ${p}`); },
    },
  } as unknown as W3Api;
  const { art, unread } = await mapObjectData(w3);
  assert.deepEqual(art.map((a) => [a.kind, a.original?.[0]?.base]), [["w3b", "ITtg"], ["w3b", "IOt0"], ["w3b", "LTlt"]]);
  assert.deepEqual(unread, []);
});
