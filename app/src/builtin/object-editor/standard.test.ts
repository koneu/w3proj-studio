import assert from "node:assert/strict";
import { test } from "node:test";
import { standardGroups } from "./standard";

const kind = {
  baseIds: ["hfoo", "ogru", "hkni", "nzzz"],
  facetDefs: [{ id: "race", label: "Race" }],
  facets: (id: string): Record<string, string> => ({ race: id[0] === "h" ? "Human" : id[0] === "o" ? "Orc" : "" }),
};

test("every game object is in one group, groups ordered by label", () => {
  assert.deepEqual(standardGroups(kind, new Set()), [
    { label: "—", ids: ["nzzz"] },
    { label: "Human", ids: ["hfoo", "hkni"] },
    { label: "Orc", ids: ["ogru"] },
  ]);
});

test("objects listed elsewhere are left out, and a group with nothing left goes", () => {
  assert.deepEqual(standardGroups(kind, new Set(["hfoo", "ogru", "nzzz"])), [{ label: "Human", ids: ["hkni"] }]);
});
