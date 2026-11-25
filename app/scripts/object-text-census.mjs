// Counts how maps store their object texts: for each map, the values of the fields the World Editor's save moves into
// war3map.wts (lib/formats/movetexts.ts MOVED_FIELDS), in the main object files and the Skin ones, as references
// (TRIGSTR_nnn), literal texts and empty texts; and whether its war3map.wts carries the editor's object comments
// ("// Units: h000 (Name), Tip (Tooltip - Basic)"), the mark of a save by a World Editor that moves them. Findings in
// docs/testing/object-text-strings.md.
//
//   node scripts/object-text-census.mjs <map or folder>... [--json FILE]
//
// Folders are searched as `w3proj verify` searches them (find-maps.mjs). Needs the release CLI (`cargo build --release`,
// or W3PROJ_BIN) and the installed game (W3PROJ_GAME, else .game-path). Unpacks into target/object-text-census/ and
// removes it in the end.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gamePath } from "../../tests/gamepath.mjs";
import { findMaps } from "./find-maps.mjs";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The editor's comment on an object string. */
const OBJECT_COMMENT = /^\/\/ (Units|Items|Destructibles|Doodads|Abilities|Buffs\/Effects|Upgrades): /m;
const KIND_FILE = /^war3map(Skin)?\.(w3[utbdahq])\.json$/;

/** One map's counts from its unpacked map/ folder: `moved` the fields that move. */
export function censusOf(mapDir, moved) {
  const out = { refs: 0, literal: 0, empty: 0, skinFiles: 0, otherRefs: 0, weComments: false, byField: {} };
  const wts = join(mapDir, "war3map.wts");
  if (existsSync(wts)) out.weComments = OBJECT_COMMENT.test(readFileSync(wts, "utf8"));
  for (const name of readdirSync(mapDir).sort()) {
    const m = KIND_FILE.exec(name);
    if (!m) continue;
    if (m[1]) out.skinFiles++;
    let doc;
    try { doc = JSON.parse(readFileSync(join(mapDir, name), "utf8")); } catch { continue; }
    for (const list of ["original", "custom"]) {
      for (const o of doc[list] ?? []) {
        const mods = o.sets ? o.sets.flatMap((s) => s.mods ?? []) : (o.mods ?? []);
        for (const mod of mods) {
          if (typeof mod.value !== "string") continue;
          const ref = /^TRIGSTR_\d+$/.test(mod.value);
          if (!moved.has(mod.field)) { if (ref) out.otherRefs++; continue; }
          const kind = ref ? "refs" : mod.value === "" ? "empty" : "literal";
          out[kind]++;
          const f = (out.byField[mod.field] ??= { refs: 0, literal: 0, empty: 0 });
          f[kind]++;
        }
      }
    }
  }
  return out;
}

async function main(argv) {
  const jsonAt = argv.indexOf("--json");
  const jsonOut = jsonAt >= 0 ? argv[jsonAt + 1] : null;
  const args = jsonAt >= 0 ? argv.filter((_, i) => i !== jsonAt && i !== jsonAt + 1) : argv;
  const maps = findMaps(args);
  if (!maps.length) throw new Error("usage: node scripts/object-text-census.mjs <map or folder>... [--json FILE]");
  const bin = process.env.W3PROJ_BIN ?? join(app, "..", "target", "release", process.platform === "win32" ? "w3proj.exe" : "w3proj");
  if (!existsSync(bin)) throw new Error(`${bin} not found: run cargo build --release first`);
  const game = gamePath();
  const root = join(app, "..", "target", "object-text-census");
  mkdirSync(root, { recursive: true });
  const tmp = mkdtempSync(join(root, "run-"));
  const rows = [];
  try {
    // Loaded here: the unit tests bundle this file, and esbuild doesn't bundle.
    const { build } = await import("esbuild");
    await build({
      stdin: { contents: `export { MOVED_FIELDS } from "./src/lib/formats/movetexts";`, resolveDir: app, loader: "ts" },
      bundle: true, format: "esm", platform: "node", outfile: join(tmp, "moved.mjs"), logLevel: "warning",
    });
    const { MOVED_FIELDS } = await import(pathToFileURL(join(tmp, "moved.mjs")).href);
    console.log(["map", "refs", "literal", "empty", "skinFiles", "weComments", "otherRefs"].join("\t"));
    for (const [n, map] of maps.entries()) {
      const dir = join(tmp, `p${n}`);
      try {
        execFileSync(bin, ["unpack", map, dir, "--game", game, "--allow-incomplete"], { stdio: "pipe" });
      } catch (e) {
        console.log(`skip ${map}: ${String(e.stderr ?? e).trim().split("\n").pop()}`);
        continue;
      }
      const c = censusOf(join(dir, "map"), MOVED_FIELDS);
      rows.push({ map, ...c });
      console.log([basename(map), c.refs, c.literal, c.empty, c.skinFiles, c.weComments ? "yes" : "no", c.otherRefs].join("\t"));
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 2) + "\n");
}

if (process.argv[1] && basename(process.argv[1]) === "object-text-census.mjs") await main(process.argv.slice(2));
