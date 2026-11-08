// war3map.wts on real maps: what the string table reads from every .wts in the map corpus and the
// game's own maps (including their _Locales copies), compared with the reference rule (the first
// line that starts `}` ends a block). Lists every file whose result differs and checks that each
// difference is a recovered block: a string the reference swallowed into its neighbour, with the
// text of every other string unchanged and no string lost. It also checks that a table which was
// not edited serializes to the file's own bytes, and that editing one string keeps every other.
//
//   W3PROJ_GAME=<install> node scripts/wts-corpus.mjs [corpus-folder]
//
// The extracted files are cached in target/wts-corpus (W3_WTS_CACHE); delete it to extract again.
// Exit code 1 when a difference is anything but a recovered block.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chosenGamePath } from "../../tests/gamepath.mjs";

const app = fileURLToPath(new URL("..", import.meta.url));
const root = join(app, "..");
const bin = process.env.W3PROJ_BIN ?? join(root, "target", "release", "w3proj" + (process.platform === "win32" ? ".exe" : ""));
const game = chosenGamePath();
const cache = process.env.W3_WTS_CACHE ?? join(root, "target", "wts-corpus");
const corpus = process.argv[2] ?? process.env.W3PROJ_CORPUS;
const run = (...args) => execFileSync(bin, args, { maxBuffer: 1 << 29, stdio: ["ignore", "pipe", "ignore"] });
const LF = String.fromCharCode(10), CR = String.fromCharCode(13);

/** The wts files inside one map or campaign: [name in the map, bytes]. */
function wtsOf(map) {
  const out = [];
  let listing;
  try { listing = run("ls", map).toString("utf8"); } catch { return out; }
  for (const line of listing.split(LF).slice(1)) {
    const name = line.replace(CR, "").trim().split(/\s+/).slice(3).join(" ");
    if (!/\.wts$/i.test(name)) continue;
    try { out.push([name, run("cat", map, name)]); } catch { /* unreadable: not ours to judge */ }
  }
  return out;
}

function extract() {
  if (existsSync(join(cache, "done"))) return;
  mkdirSync(cache, { recursive: true });
  const maps = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.w3[xmn]$/i.test(e.name)) maps.push([`corpus/${relative(corpus, p)}`, p]);
      else if (/\.wts$/i.test(e.name)) maps.push([`corpus/${relative(corpus, p)}`, null, readFileSync(p)]);
    }
  };
  if (corpus) walk(corpus);
  const tmp = join(cache, "tmp.w3");
  let n = 0;
  // one map at a time: the temporary file is reused
  const take = (id, map, raw) => {
    for (const [name, bytes] of map ? wtsOf(map) : [["", raw]]) {
      const k = String(n++).padStart(5, "0");
      writeFileSync(join(cache, k + ".wts"), bytes);
      writeFileSync(join(cache, k + ".id"), id + "!" + name);
    }
  };
  for (const [id, path, raw] of maps) take(id, path, raw);
  if (game) {
    const ls = run("game", "ls", "", "--install", game).toString("utf8").split(LF);
    for (const path of ls.map((l) => l.replace(CR, "")).filter((l) => /\.w3[xmn]$/i.test(l))) {
      writeFileSync(tmp, run("game", "cat", path, "--install", game));
      take("game/" + path.replace(/^War3\.w3mod:/, ""), tmp);
    }
  }
  writeFileSync(join(cache, "done"), String(n));
}

extract();

// The reference rule, frozen here: what wts.ts read before the unclosed-block fix.
const REF = /(STRING\s+(\d+)\s*(?:\/\/[^\n]*\n\s*)*\{\r?\n)([\s\S]*?)(\r?\n\})/g;
const reference = (text) => {
  const m = new Map();
  for (const x of text.matchAll(REF)) m.set(Number(x[2]), x[3]);
  return m;
};

const out = join(cache, "wts.bundle.mjs");
await build({ entryPoints: [join(app, "src/lib/formats/wts.ts")], bundle: true, format: "esm", outfile: out, logLevel: "silent" });
const { StringTable } = await import(pathToFileURL(out).href + "?" + Date.now());

const files = readdirSync(cache).filter((f) => f.endsWith(".wts")).sort();
let same = 0, changed = 0, bad = 0, recovered = 0, lost = 0, strings = 0, notIdentical = 0, editLost = 0;
const lines = [];
for (const f of files) {
  const id = readFileSync(join(cache, f.replace(/wts$/, "id")), "utf8");
  const text = readFileSync(join(cache, f)).toString("utf8");
  const a = reference(text);
  const table = new StringTable(text);
  const b = new Map(table.entries());
  strings += a.size;
  if (table.serialize() !== text) notIdentical++;
  const diff = [];
  for (const [n, v] of a) {
    if (!b.has(n)) { lost++; diff.push(`LOST ${n}`); }
    else if (b.get(n) !== v) {
      // allowed: the reference text swallowed the next block, the new one is only its start
      const rest = v.slice(b.get(n).length);
      const ok = v.startsWith(b.get(n)) && rest.startsWith("}");
      diff.push(ok ? `cut ${n}` : `CHANGED ${n}`);
    }
  }
  for (const [n] of b) {
    if (a.has(n)) continue;
    recovered++;
    // a recovered string must have been swallowed: its header is inside a string the reference read
    const swallowed = [...a.values()].some((v) => new RegExp(`(^|\\n)STRING\\s+${n}\\s`).test(v));
    diff.push(swallowed ? `new ${n}` : `NEW-NOT-SWALLOWED ${n}`);
  }
  // editing every string of a changed file: nothing else may move
  if (diff.length) {
    const t = new StringTable(text);
    for (const [n, v] of b) t.set(n, v + "!");
    const back = new Map(new StringTable(t.serialize()).entries());
    for (const [n, v] of b) if (back.get(n) !== v + "!") { editLost++; diff.push(`EDIT ${n}`); }
    if (back.size !== b.size) { editLost++; diff.push("EDIT size"); }
  }
  if (!diff.length) { same++; continue; }
  changed++;
  const cuts = diff.filter((d) => d.startsWith("cut")).length, news = diff.filter((d) => d.startsWith("new")).length;
  const fine = diff.every((d) => d.startsWith("cut") || d.startsWith("new")) && cuts > 0 && news >= cuts;
  if (!fine) bad++;
  lines.push(`${fine ? "ok " : "BAD"} ${id}: ${diff.join(", ")}`);
}
console.log(lines.join(LF));
console.log(`${LF}${files.length} wts files, ${strings} strings in the reference reading`);
console.log(`unchanged ${same}, changed ${changed} (${bad} not a plain recovered block), recovered strings ${recovered}, lost strings ${lost}`);
console.log(`untouched table not byte-identical: ${notIdentical}; strings lost after editing every string: ${editLost}`);
process.exit(bad || lost || notIdentical || editLost ? 1 : 0);
