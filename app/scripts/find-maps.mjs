// The maps a corpus tool checks: maps given directly, and the .w3x/.w3m files found in given folders (sorted; campaigns
// are left out). Used by twin-check.mjs.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The maps named by `args` (files and folders), in order. */
export function findMaps(args) {
  const maps = [];
  const walk = (p) => {
    if (statSync(p).isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n));
    else if (/\.w3[xm]$/i.test(p)) maps.push(p);
  };
  args.forEach((p) => (statSync(p).isDirectory() ? walk(p) : maps.push(p)));
  return maps;
}
