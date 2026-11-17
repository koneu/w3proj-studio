// Inputs for the import-list specs against the World Editor (tests/we-compare/import-modes.json, TESTING.md "Import
// lists and graphics modes"): flat.w3x (the editor's own new 64x64 map) with files of the game added to its import list
// under the paths a graphics mode reads, into <repo>/target/import-modes/ (not committed).
//
//   node tests/fixtures/we-specs/make-import-modes.mjs <w3proj cli> <game folder> [--out DIR]
//
//   import-modes-list    one import of every kind of path Studio's Import Manager writes: plain, _HD.w3mod\, _DE.w3mod\,
//                        _Teen.w3mod\ in the game's and in the lower case, _HD.w3mod\_Teen.w3mod\, _locales\enus.w3mod\,
//                        a plain import of a game path and its _HD.w3mod\ twin, a text file
//   import-modes-units   three units, each with a model that depends on the graphics mode:
//                        hfoo at (-400, 0) models war3mapImported\hdonly.mdx, which the map holds only below _HD.w3mod\
//                        (the game's HD Footman); hrif at (400, 0) the game's Rifleman, with the map's plain copy of
//                        Units\Human\Rifleman\Rifleman.mdx (the Easter Rabbit); hpea at (0, 400) models
//                        war3mapImported\both.mdx, held plain (the Easter Rabbit) and below _HD.w3mod\ (the HD Peasant);
//                        hmpr at (-300, -200) models war3mapImported\hdlower.mdx, held only as _hd.w3mod\ (lower case);
//                        hkni at (300, -200) models war3mapImported\deonly.mdx, held only below _DE.w3mod\ (both the HD Footman)
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const [cli, game] = argv.slice(0, 2).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-import-modes.mjs <w3proj cli> <game folder> [--out DIR]"); process.exit(2); }
requireFresh(cli, "cli");
let out = resolve(here, "..", "..", "..", "target", "import-modes");
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === "--out") out = resolve(argv[++i]);
  else if (argv[i] !== "--allow-stale") throw new Error(`unknown argument ${argv[i]}`);
}

const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
/** A file of the game by plain path, in an art set. */
const gameFile = (mode, path) => {
  const r = spawnSync(cli, ["game", "--install", game, "--mode", mode, "cat", path], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout.length) throw new Error(`w3proj game cat ${path}: ${r.stderr}`);
  return r.stdout;
};
const RABBIT = () => gameFile("sd", "Units/Critters/EasterRabbit/EasterRabbit.mdx");
const HD_FOOTMAN = () => gameFile("hd", "Units/Human/Footman/Footman.mdx");
const HD_PEASANT = () => gameFile("hd", "Units/Human/Peasant/peasant.mdx");

/** name -> [[archive path with \, flags, content]] */
export const MAPS = {
  "import-modes-list": () => {
    const m = RABBIT();
    return [
      ["war3mapImported\\plain.mdx", 21, m],
      ["_HD.w3mod\\war3mapImported\\hdonly.mdx", 13, m],
      ["_hd.w3mod\\war3mapImported\\hdlower.mdx", 13, m],
      ["war3mapImported\\both.mdx", 21, m],
      ["_HD.w3mod\\war3mapImported\\both.mdx", 13, m],
      ["_DE.w3mod\\war3mapImported\\deonly.mdx", 13, m],
      ["_Teen.w3mod\\war3mapImported\\teen.mdx", 21, m],
      ["_teen.w3mod\\war3mapImported\\teenlower.mdx", 21, m],
      ["_HD.w3mod\\_Teen.w3mod\\war3mapImported\\hdteen.mdx", 13, m],
      ["_locales\\enus.w3mod\\war3mapImported\\loc.mdx", 21, m],
      ["Units\\Human\\Rifleman\\Rifleman.mdx", 21, m],
      ["_HD.w3mod\\Units\\Human\\Rifleman\\Rifleman.mdx", 13, m],
      ["war3mapImported\\readme.txt", 21, Buffer.from("hello\r\n")],
    ];
  },
  "import-modes-units": () => [
    ["_HD.w3mod\\war3mapImported\\hdonly.mdx", 13, HD_FOOTMAN()],
    ["Units\\Human\\Rifleman\\Rifleman.mdx", 21, RABBIT()],
    ["war3mapImported\\both.mdx", 21, RABBIT()],
    ["_HD.w3mod\\war3mapImported\\both.mdx", 13, HD_PEASANT()],
    ["_hd.w3mod\\war3mapImported\\hdlower.mdx", 13, HD_FOOTMAN()],
    ["_DE.w3mod\\war3mapImported\\deonly.mdx", 13, HD_FOOTMAN()],
  ],
};

const MODELS = { "import-modes-units": [["hfoo", "war3mapImported\\hdonly.mdx", -400, 0], ["hrif", null, 400, 0], ["hpea", "war3mapImported\\both.mdx", 0, 400],
  ["hmpr", "war3mapImported\\hdlower.mdx", -300, -200], ["hkni", "war3mapImported\\deonly.mdx", 300, -200]] };

function make(name) {
  const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
  try {
    const dir = join(scratch, "map");
    run("unpack", join(here, "flat.w3x"), dir, "--game", game);
    const map = join(dir, "map");
    const files = MAPS[name]();
    for (const [path, , bytes] of files) {
      const file = join(map, ...path.split("\\"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
    writeFileSync(join(map, "war3map.imp.json"), JSON.stringify({ format: "w3proj.imports/1", version: 1, files: files.map(([path, flags]) => ({ flags, path })) }, null, 2));
    const units = MODELS[name];
    if (units) {
      const unitsFile = join(map, "war3mapUnits.doo.json");
      const doc = JSON.parse(readFileSync(unitsFile, "utf8"));
      const start = doc.units[0];
      let n = 1;
      for (const [id, , x, y] of units) {
        doc.units.push({ ...start, id, skinId: id, position: [x, y, 0], angle: 4.712389, player: 0, flags: 2, hp: -1, mana: -1, level: 1, targetAcquisition: -1, editorId: n++, trailer: [0, 0] });
      }
      writeFileSync(unitsFile, JSON.stringify(doc, null, 2));
      const original = units.filter(([, model]) => model).map(([id, model]) => ({ base: id, end: id, mods: [{ field: "umdl", type: "string", value: model }] }));
      writeFileSync(join(map, "war3map.w3u.json"), JSON.stringify({ format: "w3proj.objects/1", version: 3, original, custom: [] }, null, 2));
    }
    run("rebuild", dir, "--only", "wpm,shd,minimap", "--game", game);
    mkdirSync(out, { recursive: true });
    run("pack", dir, "-o", join(out, `${name}.w3x`), "--force-stale");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const name of Object.keys(MAPS)) make(name);
// The loose file the import-modes-import spec brings into the editor's Asset Manager and into Studio's Import Manager.
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "Rabbit.mdx"), RABBIT());
console.log(`made ${Object.keys(MAPS).length} maps in ${out}`);
