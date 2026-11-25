import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pruneBundles } from "./headless-prune.mjs";
import { scratchDir } from "../../tests/scratch.mjs";

test("pruneBundles removes old bundles of other hashes, keeps the current and recent ones", () => {
  const dir = join(scratchDir("headless-prune-"), "headless");
  mkdirSync(dir, { recursive: true });
  const put = (name, ageMs) => {
    const f = join(dir, name);
    writeFileSync(f, "x");
    const t = new Date(Date.now() - ageMs);
    utimesSync(f, t, t);
    return f;
  };
  const day = 86400000;
  const cur = put("w3proj-headless-aaaa1111.mjs", 5 * day);
  const old = put("w3proj-headless-bbbb2222.mjs", 2 * day);
  const recent = put("w3proj-headless-cccc3333.mjs", 60 * 1000);
  const other = put("notes.mjs", 5 * day);
  const removed = pruneBundles(dir, "w3proj-headless-aaaa1111.mjs");
  assert.deepEqual(removed, ["w3proj-headless-bbbb2222.mjs"]);
  assert.ok(existsSync(cur), "the current bundle stays even if old");
  assert.ok(!existsSync(old), "an old bundle of another hash goes");
  assert.ok(existsSync(recent), "a recently modified bundle stays");
  assert.ok(existsSync(other), "files that are not bundles stay");
  assert.deepEqual(pruneBundles(join(dir, "missing"), "x"), [], "a missing folder is no error");
});
