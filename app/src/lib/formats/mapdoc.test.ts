// The strings the map's files refer to (stringRefsInMap): TRIGSTR_ text anywhere, and the sounds' dialogue keys, which
// war3map.w3s holds as numbers. What isn't among them is what a save drops and where new strings start, so a sound's
// dialogue text must count, and a sounds file that can't be read must stop rather than count as none.

import assert from "node:assert/strict";
import { test } from "node:test";
import { stringNumbersTaken, stringRefsInMap } from "./mapdoc";
import { PRUNED_STRINGS_FILE, serializePrunedStrings } from "./prunedstrings";
import type { W3Api } from "../../extensions/api";

const sounds = (keys: [number, number][]) => JSON.stringify({ format: "w3proj.sounds/1", version: 3,
  sounds: keys.map(([text, speaker], i) => ({ name: `gg_snd_${i}`, dialogueTextKey: text, speakerNameKey: speaker })) });

function fakeW3(files: Record<string, string>, decode?: (path: string) => string) {
  return {
    workspace: {
      readBytes: async (p: string) => new TextEncoder().encode(files[p]),
      readText: async (p: string) => {
        if (!(p in files)) throw new Error(`${p}: No such file or directory (os error 2)`);
        return files[p];
      },
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

test("the numbers new strings go after: the references and the strings a drop recorded (the Sound Editor's keys)", async () => {
  const files: Record<string, string> = { "map/war3map.w3i.json": JSON.stringify({ players: [{ name: "TRIGSTR_001" }] }) };
  const paths = Object.keys(files);
  // The control: no record, only the references.
  assert.deepEqual(sorted(await stringNumbersTaken(fakeW3(files), paths)), [1]);
  files[PRUNED_STRINGS_FILE] = serializePrunedStrings(new Map([[40, "gone"], [3, "also gone"]]));
  assert.deepEqual(sorted(await stringNumbersTaken(fakeW3(files), paths)), [1, 3, 40]);
  files[PRUNED_STRINGS_FILE] = "{ not json";
  await assert.rejects(stringNumbersTaken(fakeW3(files), paths), /pruned-strings\.json isn't valid JSON/);
});

test("the numbers new strings go after: every number of the languages' tables too; one that can't be read throws", async () => {
  const de = "map/_Locales/deDE.w3mod/war3map.wts";
  const files: Record<string, string> = {
    "map/war3map.w3i.json": JSON.stringify({ players: [{ name: "TRIGSTR_001" }] }),
    "map/war3map.wts": "STRING 1\n{\nPlayer\n}\n\nSTRING 60\n{\nmain only, not referred to\n}\n",
    [de]: "STRING 1\n{\nSpieler\n}\n\nSTRING 50\n{\nnur deutsch\n}\n",
  };
  // The control: without the German table only the reference counts (war3map.wts itself is the caller's to count).
  assert.deepEqual(sorted(await stringNumbersTaken(fakeW3(files), ["map/war3map.w3i.json", "map/war3map.wts"])), [1]);
  assert.deepEqual(sorted(await stringNumbersTaken(fakeW3(files), Object.keys(files))), [1, 50]);
  const w3 = fakeW3(files);
  const ws = w3.workspace as { readText: (p: string) => Promise<string> };
  const plain = ws.readText;
  ws.readText = async (p) => {
    if (p === de) throw Object.assign(new Error("stream did not contain valid UTF-8"), { name: "NotUtf8Error" });
    return plain(p);
  };
  await assert.rejects(stringNumbersTaken(w3, Object.keys(files)), /deDE\.w3mod\/war3map\.wts is there but can't be read/);
});
