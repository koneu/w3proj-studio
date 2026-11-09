import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { createCampaign, type NewCampaignOptions } from "./newcampaign";

/** war3campaign.w3f of World Editor 3.0.1's (editor 7003) new campaign, unpacked by the campaign codec
 *  (we-drive, 2026-11-09: File > New Campaign, saved untouched; the archive held only this file). */
const EDITOR_NEW_CAMPAIGN = {
  format: "w3proj.campaign/1", version: 3, campaignVersion: 1, editorVersion: 7003,
  name: "Just another Warcraft III campaign", difficulty: "Normal", author: "Unknown", description: "Nondescript",
  flags: 0, background: -1, backgroundPath: "", minimapPath: "", ambientSound: -1, ambientSoundPath: "",
  fogStyle: -1, fogStartZ: -1.8079578e+38, fogEndZ: -1.8079578e+38, fogDensity: -1.7014118e+38, fogColor: [0, 0, 0, 0],
  race: 0, unknown3: [4278190080, 4278190080, 4278190080, 4278190080, 4278190080, 0, 0], chapters: [], mapOrder: [],
};
/** The New Campaign dialog's defaults: the editor's texts. */
const DEFAULTS = { name: "Just another Warcraft III campaign", difficulty: "Normal", author: "Unknown", description: "Nondescript" };

/** Runs createCampaign against a stand-in of the app: the files it writes (the canonicalized text is the JSON it sent). */
async function created(o: NewCampaignOptions): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const w3 = {
    backend: {
      invoke: async (cmd: string, args: { text?: string }) => (cmd === "codec_canonicalize" ? args.text : undefined),
    },
    workspace: {
      open: async () => {},
      project: () => ({ root: o.dir }),
      writeText: async (path: string, text: string) => { files.set(path, text); },
      refresh: async () => {},
    },
  } as unknown as W3Api;
  await createCampaign(w3, o);
  return files;
}

const f32Bits = (v: number) => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, true); return d.getUint32(0, true); };

test("a new campaign with the dialog's defaults is World Editor 3.0.1's new campaign, without a string table", async () => {
  const files = await created({ dir: "/x/c", ...DEFAULTS, race: 0 });
  assert.deepEqual([...files.keys()], ["map/war3campaign.w3f.json"]);
  const info = JSON.parse(files.get("map/war3campaign.w3f.json")!);
  assert.deepEqual(info, EDITOR_NEW_CAMPAIGN);
  // The unset fog values are the editor's f32 bit patterns.
  assert.deepEqual([info.fogStartZ, info.fogEndZ, info.fogDensity].map(f32Bits), [0xff080400, 0xff080400, 0xff000000]);
});

test("a new campaign stores its texts as they are and the chosen race", async () => {
  const files = await created({ dir: "/x/c", name: "My }\nCampaign", difficulty: "Hard", author: "Me", description: "Words", race: 3 });
  const info = JSON.parse(files.get("map/war3campaign.w3f.json")!);
  assert.deepEqual([info.name, info.difficulty, info.author, info.description, info.race], ["My }\nCampaign", "Hard", "Me", "Words", 3]);
});
