// Checks map scripts against the game's own common.j and Blizzard.j. Args: <path to app/src/lib>
// <common.j> <Blizzard.j> <scripts…>. Prints each problem; the exit code is their number.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [lib, common, blizzard, ...scripts] = process.argv.slice(2);
const mod = (p: string) => import(pathToFileURL(lib + p).href);
const J = await mod("/jass/check.ts");
const { checkLua } = await mod("/lua/check.ts");
const env = J.envFrom([readFileSync(blizzard, "utf8")], J.envFrom([readFileSync(common, "utf8")]));
let problems = 0;
for (const file of scripts) {
  const text = readFileSync(file, "utf8");
  const found = file.endsWith(".lua") ? checkLua(text) : J.checkJass(text, env, { ordered: true });
  problems += found.length;
  for (const d of found.slice(0, 5)) {
    const line = text.slice(0, d.from).split("\n").length;
    console.error(`${file}:${line}: ${d.message} | ${text.split("\n")[line - 1].trim().slice(0, 90)}`);
  }
}
console.log(`${scripts.length} scripts checked, ${problems} problems`);
process.exit(Math.min(problems, 100));
