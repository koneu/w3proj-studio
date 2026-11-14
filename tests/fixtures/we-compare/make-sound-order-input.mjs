// Makes sound-order.w3m (sound-order-sort.w3m is a copy: two specs of one run can not share a file name), the input map of tests/we-compare/sound-order*.json, from random-group.w3m (a map the editor
// saved): five imported-style sounds in a deliberately unsorted order, names with mixed case, different volumes
// (127, 100, 64, 3, 0), as the editor writes new sounds (Sound Editor, Studio's newSound).
//
//   node tests/fixtures/we-compare/make-sound-order-input.mjs <w3proj cli> <out.w3m>
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, out] = process.argv.slice(2).map((p) => (p ? resolve(p) : p));
if (!out) { console.error("usage: make-sound-order-input.mjs <w3proj cli> <out.w3m>"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
export const SOUNDS = [["gg_snd_Delta", "Sound\\Interface\\Error.ogg", 127], ["gg_snd_alpha", "Sound\\Interface\\MouseClick1.ogg", 100],
  ["gg_snd_Charlie", "Sound\\Interface\\Warning.ogg", 64], ["gg_snd_bravo", "Sound\\Interface\\QuestNew.ogg", 3],
  ["gg_snd_Echo", "Sound\\Interface\\QuestCompleted.ogg", 0]];
const sound = ([name, file, volume]) => ({
  name, file, variableName: name, dialogueTextKey: -1, dialogueText: "", speakerNameKey: -1, speakerName: "", unknown1: 0,
  speakerUnitType: "", facialAnimationLabel: "", facialAnimationGroupLabel: "", facialAnimationSetFile: "", unknown2: 1,
  eaxEffect: "DefaultEAXON", flags: 0, fadeInRate: 10, fadeOutRate: 10, volume, pitch: 1, pitchVariance: 0, priority: 8, channel: 0,
  minDistance: 0, maxDistance: 10000, distanceCutoff: 3000, coneInside: 0, coneOutside: 0, coneOutsideVolume: 0,
  coneOrientation: [0, 0, 0], assetLabel: "", assetFile: "",
});
const scratch = mkdtempSync(join(tmpdir(), "we-compare-sound-order-"));
try {
  const dir = join(scratch, "p");
  run("unpack", join(here, "random-group.w3m"), dir, "--game", "none");
  writeFileSync(join(dir, "map", "war3map.w3s.json"), JSON.stringify({ format: "w3proj.sounds/1", version: 3, sounds: SOUNDS.map(sound) }, null, 1));
  run("pack", dir, "-o", out, "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
