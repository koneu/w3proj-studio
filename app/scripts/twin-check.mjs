// Checks the TypeScript copies of the Rust codecs against the Rust ones on real maps:
// terrain (war3map.w3e.txt), custom script texts (war3map.wct.txt) and GUI triggers
// (war3map.wtg.json). For each map, `w3proj unpack` writes the Rust text; the TypeScript side
// must produce the same text from the archive file and the same bytes from the text.
//
//   node scripts/twin-check.mjs <map or folder>...
//
// Folders are searched for .w3x/.w3m files (campaigns are skipped). Needs the release CLI
// (`cargo build --release`, or W3PROJ_BIN) and the installed game for TriggerData.txt
// (W3PROJ_GAME, default C:\Program Files (x86)\Warcraft III).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = process.env.W3PROJ_BIN ?? join(app, "..", "target", "release", process.platform === "win32" ? "w3proj.exe" : "w3proj");
const game = process.env.W3PROJ_GAME ?? "C:\\Program Files (x86)\\Warcraft III";
if (!existsSync(bin)) throw new Error(`${bin} not found: run cargo build --release first`);

const maps = [];
const walk = (p) => {
  if (statSync(p).isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n));
  else if (/\.w3[xm]$/i.test(p)) maps.push(p);
};
process.argv.slice(2).forEach((p) => (statSync(p).isDirectory() ? walk(p) : maps.push(p)));
if (!maps.length) throw new Error("usage: node scripts/twin-check.mjs <map or folder>...");

const tmp = mkdtempSync(join(tmpdir(), "w3proj-twin-"));
await build({
  stdin: {
    contents: `export * from "./src/lib/terrain/w3etext"; export * from "./src/lib/triggers/wtg"; export { parseTriggerData } from "./src/lib/triggers/triggerdata";`,
    resolveDir: app,
    loader: "ts",
  },
  bundle: true, format: "esm", platform: "node", outfile: join(tmp, "twins.mjs"), logLevel: "warning",
});
const ts = await import(pathToFileURL(join(tmp, "twins.mjs")).href);
const data = ts.parseTriggerData(execFileSync(bin, ["game", "--install", game, "cat", "UI\\TriggerData.txt"], { encoding: "utf8", maxBuffer: 1 << 26 }));

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
/** Line number of the first difference, for the report. */
const firstDiff = (a, b) => {
  const x = a.split("\n"), y = b.split("\n");
  const i = x.findIndex((l, k) => l !== y[k]);
  return `line ${(i < 0 ? x.length : i) + 1}`;
};

let failed = 0, checked = 0;
for (const [n, map] of maps.entries()) {
  const dir = join(tmp, `p${n}`);
  try {
    execFileSync(bin, ["unpack", map, dir, "--game", game], { stdio: "pipe" });
  } catch (e) {
    console.log(`skip ${map}: ${String(e.stderr ?? e).trim().split("\n").pop()}`);
    continue;
  }
  const raw = (name) => new Uint8Array(execFileSync(bin, ["cat", map, name], { maxBuffer: 1 << 30 }));
  const text = (name) => { const p = join(dir, "map", name); return existsSync(p) ? readFileSync(p, "utf8") : null; };
  const problems = [];
  const check = (name, rustText, toText, fromText) => {
    if (rustText === null) return;
    const bytes = raw(name);
    const mine = toText(bytes);
    if (mine !== rustText) problems.push(`${name}: text differs from Rust's at ${firstDiff(mine, rustText)}`);
    else if (!sameBytes(fromText(rustText), bytes)) problems.push(`${name}: bytes from the text differ`);
    else checked++;
  };
  check("war3map.w3e", text("war3map.w3e.txt"), ts.w3eToText, ts.w3eFromText);
  const wtgJson = text("war3map.wtg.json");
  check("war3map.wtg", wtgJson, (b) => ts.writeWtgJson(ts.parseWtg(b, data)), (t) => ts.writeWtg(ts.parseWtgJson(t)));
  // Section names come from the triggers (comments only), as in the Rust unpack.
  const triggers = wtgJson === null ? null : ts.textTriggers(ts.parseWtgJson(wtgJson));
  check("war3map.wct", text("war3map.wct.txt"),
    (b) => ts.writeWctText(ts.parseWct(b, triggers?.length ?? 0), triggers?.map((t) => t.name) ?? []),
    (t) => ts.writeWct(ts.parseWctText(t)));
  if (problems.length) { failed++; problems.forEach((p) => console.log(`FAIL ${map} — ${p}`)); }
  rmSync(dir, { recursive: true, force: true });
}
rmSync(tmp, { recursive: true, force: true });
console.log(`${maps.length} maps, ${checked} files identical, ${failed} maps with differences`);
process.exitCode = failed ? 1 : 0;
