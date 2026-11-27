// Makes target/mp3-durations/mp3-durations.w3x for the SetSoundDuration question (bugs.md "SetSoundDuration of an
// mp3 with a Xing header"; docs/testing/branch-rounds.md "Branch we-batch-5"): flat.w3x with every mp3 that a chapter
// script of the CSW Tides of Darkness campaign names in a CreateSound followed by SetSoundDuration, imported at the
// path the script names (from the campaign project's map/ folder), and one sound per file (gg_snd_M000 on, the file
// as the chapter's CreateSound names it). The World Editor's save with an audio device (we-drive --null-audio) writes
// its SetSoundDuration for each; `w3proj rebuild --only script` gives Studio's. Also writes durations.json: per sound
// its variable, path and the value the chapter script holds (the campaign author's editor).
//
//   node tests/fixtures/we-specs/make-mp3-durations.mjs <w3proj cli> <game folder> <CSW project folder> [--out DIR]
//        [--only N] [--allow-stale]
//   (the project folder is `w3proj unpack` of the campaign: map/ holds its imports, maps/<chapter>/map/war3map.j the
//   chapters' scripts; `w3proj unpack` of smoketest_maps/campaign/CSW_Tides_Of_Darkness.w3n here)
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [cli, game, campaign] = argv.slice(0, 3).map((p) => (p ? resolve(p) : p));
if (!campaign) { console.error("usage: make-mp3-durations.mjs <w3proj cli> <game folder> <CSW project folder> [--out DIR] [--only N]"); process.exit(2); }
requireFresh(cli, "cli");
let out = resolve(here, "..", "..", "..", "target", "mp3-durations");
let only = Infinity;
for (let i = 3; i < argv.length; i++) {
  if (argv[i] === "--out") out = resolve(argv[++i]);
  else if (argv[i] === "--only") only = Number(argv[++i]);
  else if (argv[i] !== "--allow-stale") throw new Error(`unknown argument ${argv[i]}`);
}
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};

// The chapters' CreateSound + SetSoundDuration pairs: a JASS string's \\ is one backslash.
const unescape = (s) => s.replace(/\\(.)/g, "$1");
const seen = new Map();
const chapters = join(campaign, "maps");
for (const ch of readdirSync(chapters).sort()) {
  const file = join(chapters, ch, "map", "war3map.j");
  if (!existsSync(file)) continue;
  const j = readFileSync(file, "utf8");
  const re = /set (gg_snd_\w+)\s*=\s*CreateSound\("((?:[^"\\]|\\.)+)".*\r?\n\s*call SetSoundDuration\(\s*\1\s*,\s*(\d+)\s*\)/g;
  for (const x of j.matchAll(re)) {
    const path = unescape(x[2]);
    if (/\.mp3$/i.test(path) && !seen.has(path.toLowerCase())) seen.set(path.toLowerCase(), { path, chapterMs: Number(x[3]), chapter: ch });
  }
}
const parts = (p) => p.split(/[\\/]/).filter(Boolean);
const list = [...seen.values()].filter((p) => existsSync(join(campaign, "map", ...parts(p.path)))).slice(0, only);
const scratch = mkdtempSync(join(tmpdir(), "we-mp3-durations-"));
try {
  const dir = join(scratch, "p");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const map = join(dir, "map");
  const sounds = [], files = [];
  list.forEach((p, k) => {
    const name = `gg_snd_M${String(k).padStart(3, "0")}`;
    p.variable = name;
    const target = join(map, ...parts(p.path));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(campaign, "map", ...parts(p.path)), target);
    files.push({ flags: 13, path: parts(p.path).join("\\") });
    sounds.push({
      name, file: p.path, eaxEffect: "DefaultEAXON", flags: 0, fadeInRate: 10, fadeOutRate: 10, volume: -1, pitch: 1.0,
      pitchVariance: 0.0, priority: 0, channel: 0, minDistance: 4294967296.0, maxDistance: 4294967296.0,
      distanceCutoff: 4294967296.0, coneInside: 4294967296.0, coneOutside: 4294967296.0, coneOutsideVolume: -1,
      coneOrientation: [4294967296.0, 4294967296.0, 4294967296.0], variableName: name, assetLabel: "", assetFile: p.path,
      dialogueTextKey: -1, dialogueText: "", speakerNameKey: -1, speakerName: "", unknown1: 0, speakerUnitType: "",
      facialAnimationLabel: "", facialAnimationGroupLabel: "", facialAnimationSetFile: "", unknown2: 0,
    });
  });
  writeFileSync(join(map, "war3map.w3s.json"), JSON.stringify({ format: "w3proj.sounds/1", version: 3, sounds }, null, 1));
  writeFileSync(join(map, "war3map.imp.json"), JSON.stringify({ format: "w3proj.imports/1", version: 1, files }, null, 1));
  rmSync(join(map, "war3map.j"), { force: true }); // the editor writes one, Studio's rebuild too
  mkdirSync(out, { recursive: true });
  run("pack", "--keep-objects", dir, "-o", join(out, "mp3-durations.w3x"), "--force-stale");
  writeFileSync(join(out, "durations.json"), JSON.stringify(list, null, 1));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`made ${join(out, "mp3-durations.w3x")} (${list.length} sounds)`);
