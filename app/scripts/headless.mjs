// The app's own code for the w3proj CLI to run in Node without the app (src/headless: `w3proj rebuild`), bundled into
// one file with esbuild.
//
//   node scripts/headless.mjs --out FILE   write the bundle (a release puts it next to the w3proj program as
//                                          w3proj-headless.mjs, where the CLI looks first)
//   node scripts/headless.mjs <job>        what the CLI runs in a checkout: bundles the code as it is now (kept in
//                                          target/headless under its hash, so an unchanged tree isn't written again)
//                                          and runs it with the job; the pipe to the CLI is the bundle's (ipc.ts)
//
// Bundling first means the CLI never runs older code than the checkout's: no step to forget after a change.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The bundle's text. */
export async function bundle() {
  const r = await build({
    entryPoints: [join(app, "src", "headless", "main.ts")],
    bundle: true, format: "esm", platform: "node", target: "node22", write: false, logLevel: "warning",
    // Bundled CommonJS packages that require Node's own modules need a require in an ES module.
    banner: { js: "import { createRequire as __w3projRequire } from 'node:module'; const require = __w3projRequire(import.meta.url);" },
  });
  return r.outputFiles[0].text;
}

/** Writes `text` to `file` in one step: a run started meanwhile never imports half a file. */
function writeWhole(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, file);
  } catch (e) {
    // Windows refuses a rename onto a file another run has just put there or still has open (EPERM/EACCES). Two
    // runs bundling the same tree write the same text, so a file that is there with that text is the result.
    const same = existsSync(file) && readFileSync(file, "utf8") === text;
    rmSync(tmp, { force: true });
    if (!same) throw e;
  }
}

const args = process.argv.slice(2);
if (args[0] === "--out") {
  if (!args[1]) throw new Error("--out needs a file");
  writeWhole(resolve(args[1]), await bundle());
} else if (args.length === 1) {
  const text = await bundle();
  const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
  const file = join(app, "..", "target", "headless", `w3proj-headless-${hash}.mjs`);
  if (!existsSync(file)) writeWhole(file, text);
  // The bundle reads its job from process.argv[2], which is this script's own argument.
  await import(pathToFileURL(file).href);
} else {
  console.error("usage: node scripts/headless.mjs --out FILE | <job as JSON>");
  process.exit(2);
}
