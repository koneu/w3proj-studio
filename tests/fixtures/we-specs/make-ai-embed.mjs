// Makes a .wai with object data in it, as Studio's AI Editor writes one after "Import Custom Data" (lib/ai/wai.ts
// newWai, embedObjectData, writeWai), for opening in the World Editor's AI Editor:
//
//   node tests/fixtures/we-specs/make-ai-embed.mjs <data.w3o> <out.wai> [--hero ID]
//
// The AI is the new AI Studio makes; with --hero its hero list holds that (custom) hero id instead of Hpal. The editor's
// own export of that data: tests/fixtures/w3o/we-export-hillsbrad.w3o. The output is deterministic: the .wai names the .w3o by
// its file name and dates it 2000-01-01 00:00:00.
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { build } = createRequire(join(here, "../../../app/package.json"))("esbuild");
const [w3o, out] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--hero").map((p) => resolve(p));
const hero = process.argv.includes("--hero") ? process.argv[process.argv.indexOf("--hero") + 1] : null;
if (!out) { console.error("usage: make-ai-embed.mjs <data.w3o> <out.wai> [--hero ID]"); process.exit(2); }
const scratch = mkdtempSync(join(tmpdir(), "make-ai-embed-"));
try {
  const bundle = join(scratch, "wai.mjs");
  await build({ entryPoints: [join(here, "../../../app/src/lib/ai/wai.ts")], bundle: true, format: "esm", platform: "node", outfile: bundle, logLevel: "error" });
  const { newWai, embedObjectData, writeWai, editorDate, w3oOfKind } = await import(pathToFileURL(bundle).href);
  const ai = newWai();
  if (hero) ai.heroes = [hero, ...ai.heroes.slice(1)];
  // A .w3u (war3map.w3u, the unit table alone) is wrapped into a .w3o as Studio's Import Custom Data does.
  const bytes = new Uint8Array(readFileSync(w3o));
  // A fixed date and the file name alone as the path: the same input gives the same .wai on every run and machine (the
  // absolute path would put the user's folder names into the file).
  embedObjectData(ai, basename(w3o), editorDate(new Date(2000, 0, 1, 0, 0, 0)), w3o.endsWith(".w3u") ? w3oOfKind("w3u", bytes) : bytes);
  writeFileSync(out, writeWai(ai));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
