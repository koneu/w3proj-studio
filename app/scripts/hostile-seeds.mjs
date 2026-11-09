// The hostile-input test (src/lib/hostile.test.ts) on real files, which can't be in the repository:
// takes a few small ones of each kind from the game and runs more rounds than CI does.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chosenGamePath } from "../../tests/gamepath.mjs";

const app = fileURLToPath(new URL("..", import.meta.url));
const bin = process.env.W3PROJ_BIN ?? join(app, "..", "target", "release", "w3proj");
const game = chosenGamePath();
const dir = join(app, "..", "target", "hostile-seeds");

/** Name here (its ending picks what reads it), the game's path, and how much of it. */
const FILES = [
  ["footman.mdx", "Units/Human/Footman/Footman.mdx"],
  ["tree.mdx", "Doodads/Terrain/LordaeronTree/LordaeronTree0.mdx"],
  ["fx.mdx", "Abilities/Spells/Human/Blizzard/BlizzardTarget.mdx"],
  ["dnc.mdx", "War3.w3mod:Environment/DNC/DNCAshenvale/DNCAshenValeUnit/DNCAshenValeUnit.mdx"],
  ["button.blp", "ReplaceableTextures/CommandButtons/BTNFootman.blp"],
  ["path.tga", "War3.w3mod:Campaign/ForsakenKingdom/HumanRE03.w3x/PathTextures/14x14Barn.tga"],
  ["hair.dds", "War3.w3mod:Doodads/Cinematic/ArthasIllidanFight/shadowMapHair0054.dds"],
  ["grunt.wai", "War3.w3mod:AI Scripts/GruntMaster.wai"],
  ["spike.flac", "War3.w3mod:_DE.w3mod:Abilities/Spells/Orc/SpikeBarrier/SpikeBarrierOn.flac"],
  ["common.j", "Scripts/common.j", 24000],
  ["blizzard.j", "Scripts/Blizzard.j", 24000],
  ["trig.txt", "UI/TriggerData.txt", 24000],
  ["unit.slk", "Units/UnitData.slk", 24000],
];

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
for (const [name, path, size] of FILES) {
  const bytes = execFileSync(bin, ["game", "cat", path, ...(game ? ["--install", game] : [])], { maxBuffer: 1 << 28 });
  writeFileSync(join(dir, name), size ? bytes.subarray(0, size) : bytes);
}

// Only the hostile test's file, bundled into a folder of its own: the whole suite would load every test file for
// one test, and its default folder is emptied by any other `npm test` in this checkout (the gate's unit tests).
const run = spawnSync(process.execPath, ["scripts/test.mjs", "src/lib/hostile.test.ts", "--test-name-pattern=damaged files"], {
  cwd: app,
  stdio: "inherit",
  env: { ...process.env, W3_HOSTILE_SEEDS: dir, W3_HOSTILE_ROUNDS: "1000", W3_TEST_OUT: join(app, "..", "target", "hostile-seeds-tests") },
});
process.exit(run.status ?? 1);
