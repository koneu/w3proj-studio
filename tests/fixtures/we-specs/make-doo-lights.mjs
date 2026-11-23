// Inputs for tests/we-compare/doo-lights.json: which doodads the World Editor's save gives a light block in war3map.doo's
// `extras`, and with what values (lib/terrain/dooversion.ts). Into <repo>/target/doo-lights/:
//   node tests/fixtures/we-specs/make-doo-lights.mjs <w3proj cli> <game folder>
//   doo-lights.w3x  flat.w3x (the editor's own new 64x64 Lordaeron Summer map, war3map.doo version 13) with, every one
//                   with `extras` [] unless said, in a row from the west:
//     0  LOlp var 0     lamp post, its model's light white, intensity 11
//     1  LOlp var 1     the same, intensity 12 (the variation's own model)
//     2  YOlp var 0     a light whose intensity is animated (KLAI) over a fixed 0
//     3  LObz var 0     the same with a colour (0.976, 0.875, 0.192)
//     4  GRfc var 0     a colour whose channels times 255 are whole (147, 7)
//     5  ZOfp var 0     attenuation 200..400 (the others 80..200)
//     6  YOf1 var 0     a model with two lights
//     7  DTs0 var 0     a destructable whose model has two lights
//     8  LOtz var 0     torch, white, intensity 10
//     9  ZZys var 0     colour (0.667, 1, 0.396), intensity 8
//    10  LTlt var 0     a tree: no light in its model (control)
//    11  LTba var 0     a barricade: a destructable without a light (control)
//    12  LOlp var 0     with a light of its own (nine values of the dialog's range): kept?
//    13  LOlp var 1     with two lights of its own: kept?
//    14  D000           a custom doodad (war3map.w3d, based on LOth) whose model is war3mapImported\LightA.mdx: the game's
//                       TorchHuman.mdx (version 1800) with every fixed value of its light changed to another number
//    15  D001           the same based model war3mapImported\LightB.mdl: a version-800 text model of one light only
//    16  LOth var 0     torch, white, intensity 4 (LightA's original)
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const [cli, game] = process.argv.slice(2, 4).map((p) => (p ? resolve(p) : p));
if (!game) { console.error("usage: make-doo-lights.mjs <w3proj cli> <game folder>"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const env = { ...process.env, W3PROJ_GAME: game };
const run = (...args) => {
  const r = spawnSync(cli, args, { env, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout;
};
/** A float's bits as the u32 the codec keeps. */
const bits = (f) => { const b = Buffer.alloc(4); b.writeFloatLE(f); return b.readUInt32LE(0); };
const X = (i) => -4096 + 128 * i;
const doodad = (k, id, variation, x, y, more = {}) => ({
  id, variation, position: [x, y, 0], angle: (270 * Math.PI) / 180, scale: [1, 1, 1], skinId: id,
  preFlags: 4294967295, flags: 2, life: 100, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [k, 0, 0], extras: [], ...more,
});
const OWN = [0, 1, 0xff102030, ...[2.5, 3.5, 4.5, 0.125, 0.25, 0.375].map(bits)];
const OWN2 = [0, 0, 0xff405060, ...[6, 10, 20, 0.0005, 0, 0.00001].map(bits)];
const ROW = [
  ["LOlp", 0], ["LOlp", 1], ["YOlp", 0], ["LObz", 0], ["GRfc", 0], ["ZOfp", 0], ["YOf1", 0], ["DTs0", 0], ["LOtz", 0], ["ZZys", 0],
  ["LTlt", 0], ["LTba", 0], ["LOlp", 0, { extras: [OWN] }], ["LOlp", 1, { extras: [OWN, OWN2] }], ["D000", 0], ["D001", 0], ["LOth", 0],
];

/** TorchHuman.mdx with its one light's fixed values (after the node: type, a word, attenuation start and end, colour,
 *  intensity, ambient colour and intensity, shadow intensity, shadow casting start and end, quadratic and linear falloff,
 *  damping; version 1800's 72 bytes) all different. */
function lightA(mdx) {
  const v = new DataView(mdx.buffer, mdx.byteOffset, mdx.byteLength);
  for (let p = 4; p + 8 <= mdx.length;) {
    const tag = mdx.toString("latin1", p, p + 4), size = v.getUint32(p + 4, true);
    if (tag === "VERS" && v.getUint32(p + 8, true) !== 1800) throw new Error("TorchHuman.mdx isn't of version 1800");
    if (tag === "LITE") {
      const light = p + 8, nodeSize = v.getUint32(light + 4, true);
      const at = light + 4 + nodeSize;
      [50, 300, 0.25, 0.5, 0.75, 6.5, 0.1, 0.2, 0.3, 0.7, 0.6, 30, 90, 0.002, 0.03, 0.0004].forEach((f, i) => v.setFloat32(at + 8 + 4 * i, f, true));
      return mdx;
    }
    p += 8 + size;
  }
  throw new Error("TorchHuman.mdx has no light");
}
/** A version-800 text model of one light and nothing else (MDL colours are stored b, g, r). */
const LIGHT_B = `Version {
\tFormatVersion 800,
}
Model "LightB" {
\tNumLights 1,
\tBlendTime 150,
}
Sequences 1 {
\tAnim "Stand" {
\t\tInterval { 0, 1000 },
\t}
}
Light "Omni01" {
\tObjectId 0,
\tOmnidirectional,
\tstatic AttenuationStart 60,
\tstatic AttenuationEnd 250,
\tstatic Intensity 7.5,
\tstatic Color { 0.2, 0.4, 0.8 },
\tstatic AmbIntensity 0,
\tstatic AmbColor { 1, 1, 1 },
}
PivotPoints 1 {
\t{ 0, 0, 100 },
}
`;

const final = join(repo, "target", "doo-lights");
const out = `${final}.new`;
const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
try {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const dir = join(scratch, "lights");
  run("unpack", join(here, "flat.w3x"), dir, "--game", game);
  const map = join(dir, "map");
  mkdirSync(join(map, "war3mapImported"), { recursive: true });
  writeFileSync(join(map, "war3mapImported", "LightA.mdx"), lightA(run("game", "cat", "--mode", "sd", "Doodads/LordaeronSummer/Props/TorchHuman/TorchHuman.mdx")));
  writeFileSync(join(map, "war3mapImported", "LightB.mdl"), LIGHT_B);
  writeFileSync(join(map, "war3map.imp.json"), JSON.stringify({ format: "w3proj.imports/1", version: 1, files: [
    { flags: 13, path: "war3mapImported\\LightA.mdx" }, { flags: 13, path: "war3mapImported\\LightB.mdl" }] }, null, 2));
  const model = (file) => [{ field: "dfil", type: "string", value: file, level: 0, data: 0 }, { field: "dvar", type: "int", value: 1, level: 0, data: 0 }];
  writeFileSync(join(map, "war3map.w3d.json"), JSON.stringify({ format: "w3proj.objects/1", version: 3, original: [], custom: [
    { base: "LOth", id: "D000", mods: model("war3mapImported\\LightA.mdx") },
    { base: "LOth", id: "D001", mods: model("war3mapImported\\LightB.mdl") }] }, null, 2));
  const dooFile = join(map, "war3map.doo.json");
  const doo = JSON.parse(readFileSync(dooFile, "utf8"));
  // Four tiles apart on y = 0 from x = X(8); a lamp post's 2x2 pathing puts it on a corner + 32 as the editor does.
  doo.doodads = ROW.map(([id, variation, more], k) => doodad(k, id, variation, X(8 + 3 * k) + 32, 32, more));
  writeFileSync(dooFile, JSON.stringify(doo, null, 1));
  run("rebuild", dir, "--only", "wpm,shd,minimap", "--game", game);
  run("pack", dir, "-o", join(out, "doo-lights.w3x"), "--force-stale");
  rmSync(final, { recursive: true, force: true });
  renameSync(out, final);
  console.log(`made ${join(final, "doo-lights.w3x")}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
