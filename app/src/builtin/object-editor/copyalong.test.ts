// Copying objects into a chapter map reads its campaign's objects too: their ids are taken. A campaign file
// whose presence can't be checked must stop it, not pass for "the campaign has none".

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { viewMap } from "./copyalong";

/** A chapter map of a campaign, on a made-up disk; the game's tables are empty. `locked`: paths fs_exists can't check. */
function chapter(files: Record<string, string>, locked: string[]) {
  const asked: string[] = [];
  const w3 = {
    settings: { get: () => undefined },
    game: { list: async () => [], readText: async () => "" },
    workspace: {
      project: () => ({ root: "/c/maps/One" }),
      readText: async (p: string) => { if (!(p in files)) throw new Error(`no ${p}`); return files[p]; },
    },
    backend: {
      invoke: async (cmd: string, a: { path: string }) => {
        if (cmd !== "fs_exists") throw new Error(`unexpected ${cmd}`);
        asked.push(a.path);
        if (locked.includes(a.path)) throw "Permission denied (os error 13)";
        return a.path in files;
      },
    },
  } as unknown as W3Api;
  return { w3, asked };
}

const CAMPAIGN_UNITS = "/c/map/war3campaign.w3u.json";
const units = (...ids: string[]) => JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [], custom: ids.map((id) => ({ id, base: "hfoo", fields: [] })) });

test("the campaign's objects are taken ids of a chapter map (control)", async () => {
  const { w3, asked } = chapter({ [CAMPAIGN_UNITS]: units("h001") }, []);
  const view = await viewMap(w3, undefined, "/c/maps/One");
  assert.ok(asked.includes(CAMPAIGN_UNITS), "the campaign's file was looked for");
  assert.ok(view.game.has("h001"), "the campaign's unit counts as taken");
});

test("a campaign file that can't be checked stops reading the map, naming it", async () => {
  const { w3 } = chapter({ [CAMPAIGN_UNITS]: units("h001") }, [CAMPAIGN_UNITS]);
  await assert.rejects(viewMap(w3, undefined, "/c/maps/One"), (e: Error) => {
    assert.match(e.message, /war3campaign\.w3u\.json/);
    assert.match(e.message, /can't be checked/);
    return true;
  });
});
