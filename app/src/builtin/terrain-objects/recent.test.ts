import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRecent, RECENT_LIMIT, withRecent, type RecentPlaced } from "./recent";

const e = (id: string, kind = "w3u", random?: RecentPlaced["random"]): RecentPlaced => ({ kind, id, label: id.toUpperCase(), ...(random ? { random } : {}) });

test("the last placed come first, each once, five at most", () => {
  let list: RecentPlaced[] = [];
  for (const id of ["a", "b", "c", "d", "e", "f"]) list = withRecent(list, e(id));
  assert.deepEqual(list.map((r) => r.id), ["f", "e", "d", "c", "b"]);
  assert.equal(list.length, RECENT_LIMIT);
  list = withRecent(list, e("c"));
  assert.deepEqual(list.map((r) => r.id), ["c", "f", "e", "d", "b"], "one placed again moves to the head");
  // The same random object set differently is another one.
  const two = withRecent(withRecent([], e("uDNR", "w3u", { what: "unit", by: "level", level: 1 })), e("uDNR", "w3u", { what: "unit", by: "level", level: 2 }));
  assert.equal(two.length, 2);
});

test("what is stored and isn't a list of entries is left out", () => {
  assert.deepEqual(parseRecent(null), []);
  assert.deepEqual(parseRecent("{"), []);
  assert.deepEqual(parseRecent("5"), []);
  assert.deepEqual(parseRecent(JSON.stringify([e("a"), null, { id: 3 }, e("b")])).map((r) => r.id), ["a", "b"]);
});
