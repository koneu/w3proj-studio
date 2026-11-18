// Makes custom-tilesets-<list>-<flag>.w3x from flat.w3x (Lordaeron Summer; its own list is Ldrt Ldro Ldrg Lrok Lgrs Lgrd):
//
//   node tests/fixtures/we-specs/make-custom-tilesets.mjs <w3proj cli> <game folder> [name…]
//
// The ground is in vertical stripes, one per slot of the file's ground list (stripe x = slot, the last one takes the
// rest). The list is not the tileset's own one (another order, more or fewer tiles), the w3e flag "custom-tilesets" is
// 0 or 1: what the World Editor draws with 0 tells which slots it takes from the tileset's default list.
//   rev6: the six own tiles in reverse order      more9: those and Wsnw Bdsr Ndrt      few3: Lgrs Lrok Ldrt
//   more12: more9 and Nice Adrt Vgrs (slots 10 and 11 tell slot 0 from the own list taken round: Lgrs, Lgrd)
//   rev6c: rev6 with the w3e's cliff list the other way round (CLgr CLdi; flat.w3x has CLdi CLgr): which list the
//          editor's cliff type numbers follow
// Names given: only those lists are made (the others stay as they are).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFresh } from "../../binfresh.mjs";
import { modeArgs, requireValid } from "../../gen-args.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const [cli, game] = process.argv.slice(2, 4).map((p) => (p ? resolve(p) : p));
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const only = modeArgs();
if (!game) { console.error("usage: make-custom-tilesets.mjs <w3proj cli> <game folder> [name…]"); process.exit(2); }
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const LISTS = {
  rev6: ["Lgrd", "Lgrs", "Lrok", "Ldrg", "Ldro", "Ldrt"],
  more9: ["Lgrd", "Lgrs", "Lrok", "Ldrg", "Ldro", "Ldrt", "Wsnw", "Bdsr", "Ndrt"],
  more12: ["Lgrd", "Lgrs", "Lrok", "Ldrg", "Ldro", "Ldrt", "Wsnw", "Bdsr", "Ndrt", "Nice", "Adrt", "Vgrs"],
  few3: ["Lgrs", "Lrok", "Ldrt"],
  rev6c: ["Lgrd", "Lgrs", "Lrok", "Ldrg", "Ldro", "Ldrt"],
};
requireValid(only.every((n) => Object.hasOwn(LISTS, n)), `unknown list ${only.filter((n) => !Object.hasOwn(LISTS, n)).join(" ")}; usage: make-custom-tilesets.mjs <w3proj cli> <game folder> [${Object.keys(LISTS).join(" | ")}]…`);
/** The cliff list of the lists that change it. */
const CLIFFS = { rev6c: ["CLgr", "CLdi"] };
for (const [name, tiles] of Object.entries(LISTS)) {
  if (only.length && !only.includes(name)) continue;
  for (const flag of [0, 1]) {
    const scratch = mkdtempSync(join(tmpdir(), "we-specs-inputs-"));
    try {
      const dir = join(scratch, "map");
      run("unpack", join(here, "flat.w3x"), dir, "--game", game);
      const file = join(dir, "map", "war3map.w3e.txt");
      const lines = readFileSync(file, "utf8").split("\n");
      const set = (prefix, to) => {
        const at = lines.findIndex((l) => l.startsWith(prefix));
        if (at < 0) throw new Error(`no "${prefix}" line in the w3e text`);
        lines[at] = to;
      };
      set("custom-tilesets ", `custom-tilesets ${flag}`);
      set("ground ", `ground ${tiles.join(" ")}`);
      if (CLIFFS[name]) set("cliffs ", `cliffs ${CLIFFS[name].join(" ")}`);
      const at = lines.findIndex((l) => l.startsWith("[texture]"));
      const stripe = Math.floor(65 / tiles.length);
      const row = Array.from({ length: 65 }, (_, x) => Math.min(tiles.length - 1, Math.floor(x / stripe)).toString(16)).join("");
      lines.splice(at, 1, "[texture]", ...Array.from({ length: 65 }, () => row));
      writeFileSync(file, lines.join("\n"));
      run("pack", dir, "-o", join(here, `custom-tilesets-${name}-${flag}.w3x`), "--force-stale");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
