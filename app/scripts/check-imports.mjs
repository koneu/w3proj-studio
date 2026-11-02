// Keeps the module boundaries: a built-in extension may import its own files,
// src/lib (shared code), src/extensions (the API and service contracts) and
// workbench/dom — never another extension's files (use w3.services instead),
// and lib may not import extensions or the workbench.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const area = (file) => {
  const [top, name] = relative(src, file).split(sep);
  return top === "builtin" ? `builtin/${name}` : top;
};

const problems = [];
for (const file of walk(src).filter((f) => /\.ts$/.test(f))) {
  const from = area(file);
  for (const m of readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)[^"']*["'](\.[^"']+)["']/gm)) {
    const target = resolve(dirname(file), m[1]);
    const to = area(target);
    const rel = relative(src, target).split(sep).join("/");
    const ok = from.startsWith("builtin/")
      ? to === from || to === "lib" || to === "extensions" || rel === "workbench/dom"
      : from === "lib"
        ? to === "lib" || rel === "extensions/api"
        : true;
    if (!ok) problems.push(`${relative(src, file).split(sep).join("/")}: imports ${rel} (${from} → ${to})`);
  }
}
if (problems.length) {
  console.error(`Module boundary violations:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("module boundaries ok");
