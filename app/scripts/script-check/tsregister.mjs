// Lets plain Node import the app's TypeScript, whose imports have no extensions, and whose classes use constructor
// parameter properties: Node only strips types (Node 26 dropped --experimental-transform-types), so esbuild turns the
// TypeScript into JavaScript here.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {
        return next(specifier, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith("file:") || !/\.[cm]?ts$/.test(url)) return next(url, context);
    const file = fileURLToPath(url);
    const { code } = transformSync(readFileSync(file, "utf8"), { loader: "ts", format: "esm", target: "node26", sourcemap: "inline", sourcefile: file });
    return { format: "module", source: code, shortCircuit: true };
  },
});
