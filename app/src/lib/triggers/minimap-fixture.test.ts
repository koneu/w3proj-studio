// The mini map's made-up triggers (tests/fixtures/mini-map/map/triggers) have to be ones the editors can show: its
// variable entry in the trigger tree once named no variable ("Variable not found"), and its if/then/else used an
// invented function whose blocks showed as "Loop - Actions / Actions / Actions".

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fixturePath } from "../testhelpers/testutil";
import { branchLabels } from "./display";
import type { Eca } from "./wtg";

const TRIGGERS = () => join(fixturePath("mini-map"), "map", "triggers");

/** Every file of the mini map's trigger folders, relative to them. */
function files(dir = TRIGGERS(), base = ""): string[] {
  return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n), `${base}${n}/`) : [`${base}${n}`]));
}

test("the mini map: every variable entry of the trigger tree ($name in an order.txt) is a variable of its folder", () => {
  let entries = 0;
  for (const f of files().filter((p) => p.endsWith("order.txt"))) {
    const folder = f.slice(0, -"order.txt".length);
    const vars = readFileSync(join(TRIGGERS(), `${folder}variables.json`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).name as string);
    for (const line of readFileSync(join(TRIGGERS(), f), "utf8").split("\n").filter((l) => l.startsWith("$"))) {
      entries++;
      assert.ok(vars.includes(line.slice(1)), `${f}: ${line} names no variable of ${folder}variables.json`);
    }
  }
  assert.ok(entries > 0, "the fixture has a variable entry (control)");
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
  for (const f of files().filter((p) => p.endsWith(".gui.json"))) (JSON.parse(readFileSync(join(TRIGGERS(), f), "utf8")).ecas as Eca[]).forEach(visit);
  assert.ok(blocks >= 3, `the fixture has an if/then/else with its three blocks (control): ${blocks}`);
});
