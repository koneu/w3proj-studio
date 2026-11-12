// The Problems checks and the import previews read a map's per-graphics-mode files in one order (lib/imports.ts
// modeNames; Classic the plain one, Reforged _HD.w3mod\ then plain, 3.0 _DE.w3mod\ then _HD.w3mod\ then plain).

import assert from "node:assert/strict";
import { test } from "node:test";
import { modeNames, sidePathOf, type Side } from "../../lib/imports";
import { mapModeHas } from "./lookup";

test("the import previews (modeNames) and the Problems lookup (mapModeHas) agree on which copies of a file a graphics mode reads", () => {
  const H = "war3mapImported\\Hero.mdx";
  const sides: [string, Side][] = [["", "classic"], ["_hd", "reforged"], ["_de", "de"]];
  let reading = 0;
  for (let mask = 0; mask < 8; mask++) {
    const have = sides.filter((_, i) => mask & (1 << i));
    const sets = new Set(have.map(([set]) => set));
    const owned = new Set(have.map(([, side]) => sidePathOf(H, side)));
    for (const [mode, layer] of [["sd", null], ["hd", "_hd"], ["de", "_de"]] as const) {
      const reads = modeNames(H, mode).some((n) => owned.has(n));
      if (reads) reading++;
      assert.equal(mapModeHas(sets, layer), reads, `${mode} with ${[...sets].map((s) => s || "plain").join("+") || "nothing"}`);
    }
  }
  // Control: the loop saw both answers (a check that never reads anything would agree too).
  assert.ok(reading > 0 && reading < 24, `${reading} of 24 combinations read a file`);
});
