// The mini map's made-up triggers (tests/fixtures/mini-map) have to be ones the editors can show: its variable entry
// in the trigger tree once had id 5 where the variable had 2 ("Variable not found"), and its if/then/else used an
// invented function whose blocks showed as "Loop - Actions / Actions / Actions".

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { branchLabels } from "./display";
import { parseWtgJson, type Eca } from "./wtg";

/** The mini map's triggers, found from where the tests run (app/ or the repository). */
function fixture(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, "tests", "fixtures", "mini-map", "map", "war3map.wtg.json");
    if (existsSync(p)) return p;
    if (dirname(dir) === dir) throw new Error("tests/fixtures/mini-map not found");
  }
}
const file = parseWtgJson(readFileSync(fixture(), "utf8"));

test("the mini map: every variable entry of the trigger tree is a variable, in the same folder", () => {
  const entries = file.items.filter((i) => i.type === 64);
  assert.ok(entries.length > 0, "the fixture has a variable entry (control)");
  for (const e of entries) {
    const v = file.variables.find((x) => x.id === e.id);
    assert.ok(v, `the tree's entry ${e.name} (id ${e.id}) names no variable`);
    assert.equal(v.name, e.name);
    assert.equal(v.parent, e.parent, `${e.name}: the variable and its entry are in different folders`);
  }
});

test("the mini map: every block of a control-flow action has the World Editor's label", () => {
  let blocks = 0;
  const visit = (e: Eca) => {
    const groups = [...new Set(e.children.map((c) => c.group ?? 0))];
    if (groups.length) {
      const labels = branchLabels(e.name);
      for (const g of groups) {
        blocks++;
        assert.ok(labels[g], `${e.name}: block ${g} has no label (${labels.join(" / ")})`);
      }
    }
    e.children.forEach(visit);
  };
  for (const it of file.items) if ("ecas" in it) (it.ecas as Eca[]).forEach(visit);
  assert.ok(blocks >= 3, `the fixture has an if/then/else with its three blocks (control): ${blocks}`);
});
