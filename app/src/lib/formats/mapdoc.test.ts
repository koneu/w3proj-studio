// The strings the map's files refer to (stringRefsInMap): TRIGSTR_ text anywhere, and the sounds' dialogue keys, which
// war3map.w3s holds as numbers. What isn't among them is what a save drops and where new strings start, so a sound's
// dialogue text must count, and a sounds file that can't be read must stop rather than count as none.

import assert from "node:assert/strict";
import { test } from "node:test";
import { stringRefsInMap } from "./mapdoc";
import type { W3Api } from "../../extensions/api";

const sounds = (keys: [number, number][]) => JSON.stringify({ format: "w3proj.sounds/1", version: 3,
  sounds: keys.map(([text, speaker], i) => ({ name: `gg_snd_${i}`, dialogueTextKey: text, speakerNameKey: speaker })) });

function fakeW3(files: Record<string, string>, decode?: (path: string) => string) {
  return {
    workspace: {
      readBytes: async (p: string) => new TextEncoder().encode(files[p]),
      project: () => ({ root: "/p" }),
    },
    backend: {
      invoke: async (cmd: string, args: { root: string; path: string }) => {
        if (cmd !== "codec_decode" || !decode) throw new Error(`no ${cmd}`);
        return decode(args.path);
      },
    },
  } as unknown as W3Api;
}

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

test("the sounds' dialogue keys count; -1 (none) doesn't", async () => {
  const files = {
    "map/war3map.w3i.json": JSON.stringify({ players: [{ name: "TRIGSTR_001" }] }),
    "map/war3map.w3s.json": sounds([[11, 12], [-1, -1], [30, -1]]),
  };
  assert.deepEqual(sorted(await stringRefsInMap(fakeW3(files), Object.keys(files))), [1, 11, 12, 30]);
});

test("a raw sounds file is read through its codec; one the codec can't read throws", async () => {
  const files = { "map/war3map.w3s": "binary", "map/war3map.j": "\"TRIGSTR_002\"" };
  let asked = "";
  const w3 = fakeW3(files, (p) => { asked = p; return sounds([[8, 9]]); });
  assert.deepEqual(sorted(await stringRefsInMap(w3, Object.keys(files))), [2, 8, 9]);
  assert.equal(asked, "map/war3map.w3s");
  await assert.rejects(stringRefsInMap(fakeW3(files), Object.keys(files)), /war3map\.w3s is kept raw and can't be read/);
});

test("a sounds document that isn't JSON throws rather than count as no keys", async () => {
  const files = { "map/war3map.w3s.json": "{ not json" };
  await assert.rejects(stringRefsInMap(fakeW3(files), Object.keys(files)), /war3map\.w3s\.json is there but can't be read/);
});
