// The maps a corpus tool checks, found as `w3proj verify` finds them (crates/cli/src/main.rs `expand_maps`): maps given
// directly, and the .w3x/.w3m files found in given folders (sorted; campaigns are left out). Projects found below a
// given folder (folders holding w3proj.toml) are left out with what they packed: their build/ maps and checkpoints are
// outputs, not maps of their own. So are those outputs when they were written with Windows separators on Linux, where
// a backslash is part of the name (`<project>\build\checkpoints\….w3x` next to the project folder). A project folder
// given directly is searched. Used by twin-check.mjs.
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const MANIFEST = "w3proj.toml";

/** Whether a file is a project's output named with Windows separators: the part before the first `\` is a project. */
function misnamedProjectOutput(path) {
  const name = basename(path);
  const cut = name.indexOf("\\");
  return cut > 0 && existsSync(join(dirname(path), name.slice(0, cut), MANIFEST));
}

/** The maps named by `args` (files and folders), in order. */
export function findMaps(args) {
  const maps = [];
  const walk = (p, top) => {
    if (statSync(p).isDirectory()) {
      if (!top && existsSync(join(p, MANIFEST))) return;
      for (const n of readdirSync(p).sort()) {
        // A folder named build holds what packing wrote, not maps of the corpus (as `w3proj verify`).
        if (n.toLowerCase() === "build" && statSync(join(p, n)).isDirectory()) continue;
        walk(join(p, n), false);
      }
    } else if (/\.w3[xm]$/i.test(p) && !misnamedProjectOutput(p)) maps.push(p);
  };
  args.forEach((p) => (statSync(p).isDirectory() ? walk(p, true) : maps.push(p)));
  return maps;
}
