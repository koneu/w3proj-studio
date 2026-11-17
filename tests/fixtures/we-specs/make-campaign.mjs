// Makes tiny campaigns (.w3n) for the Campaign Editor checks: one chapter (flat.w3x, the World Editor's own new 64x64
// map) and, by the mode, campaign object data of its own.
//
//   node tests/fixtures/we-specs/make-campaign.mjs <w3proj cli> <game folder> [bare | objects | all] [--out DIR]
//
//   bare     tiny-bare.w3n: war3campaign.w3f only (as World Editor 3.0.1 writes a new campaign) and the chapter
//   objects  tiny-objects.w3n: also war3campaign.w3u (one custom footman h000 "Campaign Footman"), w3t, w3b, w3d, w3a,
//            w3h and w3q (empty tables), as the campaigns of the corpus hold them
//   all      both (default); DIR defaults to target/campaigns in the checkout
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [cli, game] = argv.slice(0, 2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-campaign.mjs <w3proj cli> <game folder> [bare | objects | all] [--out DIR]"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
let out = resolve(here, "..", "..", "..", "target", "campaigns"), mode = "all";
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === "--out") out = resolve(argv[++i]);
  else if (["bare", "objects", "all"].includes(argv[i])) mode = argv[i];
  else if (argv[i] !== "--allow-stale") throw new Error(`unknown argument ${argv[i]}`);
}
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
// Not flat.w3x: the editor that opens the chapter has that map open (its own name there)
const CHAPTER = "Chapter1.w3x";
const UNSET_Z = -1.8079578e38, UNSET_DENSITY = -1.7014118e38;
const info = () => ({
  format: "w3proj.campaign/1", version: 3, campaignVersion: 1, editorVersion: 7003,
  name: "Tiny Campaign", difficulty: "Normal", author: "Test", description: "One chapter",
  flags: 0, background: -1, backgroundPath: "", minimapPath: "", ambientSound: -1, ambientSoundPath: "",
  fogStyle: -1, fogStartZ: UNSET_Z, fogEndZ: UNSET_Z, fogDensity: UNSET_DENSITY, fogColor: [0, 0, 0, 0], race: 0,
  unknown3: [0xff000000, 0xff000000, 0xff000000, 0xff000000, 0xff000000, 0, 0],
  chapters: [{ flags: 1, chapter: "Chapter 1", title: "The Only One", map: CHAPTER }], mapOrder: [{ unknown: "", map: CHAPTER }],
});
const objects = (version, custom = []) => ({ format: "w3proj.objects/1", version, original: [], custom });
const footman = { base: "hfoo", id: "h000", mods: [{ field: "unam", type: "string", value: "Campaign Footman" }] };
const scratch = mkdtempSync(join(tmpdir(), "we-specs-campaign-"));
try {
  mkdirSync(out, { recursive: true });
  for (const kind of mode === "all" ? ["bare", "objects"] : [mode]) {
    const dir = join(scratch, kind);
    mkdirSync(join(dir, "map"), { recursive: true });
    mkdirSync(join(dir, "maps"), { recursive: true });
    writeFileSync(join(dir, "w3proj.toml"), 'format = 1\n\n[map]\nname = "Tiny Campaign"\nflags = 0\nmax_players = 1\n\n[archive]\nsector_size_shift = 3\n\n[pack]\n');
    writeFileSync(join(dir, "map", "war3campaign.w3f.json"), `${JSON.stringify(info(), null, 2)}\n`);
    if (kind === "objects") {
      // The unit table has a version 2 header (units and items: no level-dependent part); the others as the corpus's.
      writeFileSync(join(dir, "map", "war3campaign.w3u.json"), `${JSON.stringify(objects(2, [footman]), null, 2)}\n`);
      for (const ext of ["w3t", "w3b", "w3d", "w3h"]) writeFileSync(join(dir, "map", `war3campaign.${ext}.json`), `${JSON.stringify(objects(2), null, 2)}\n`);
      for (const ext of ["w3a", "w3q"]) writeFileSync(join(dir, "map", `war3campaign.${ext}.json`), `${JSON.stringify(objects(2), null, 2)}\n`);
    }
    run("unpack", join(here, "flat.w3x"), join(dir, "maps", CHAPTER), "--game", game);
    run("pack", dir, "-o", join(out, `tiny-${kind}.w3n`), "--force-stale");
    console.log(`made ${join(out, `tiny-${kind}.w3n`)}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
