import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// TESTING.md is the short guide; what was measured lives in docs/testing/. Code, specs and scripts point into it by
// path and heading, so a moved file or a typo must fail here rather than leave readers at nothing.
const root = resolve(process.cwd(), ".."); // the tests run from app/ (scripts/test.mjs bundles them elsewhere)
const docsDir = join(root, "docs", "testing");

/** The relative markdown links of `text` (not URLs, not same-file anchors) that don't resolve from `dir`. */
export function brokenLinks(text, dir, exists = existsSync) {
  const bad = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1].split("#")[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    if (!exists(resolve(dir, target))) bad.push(m[1]);
  }
  return bad;
}

/** The `docs/testing/<name>.md` paths `text` names. */
export function mentionedDocs(text) {
  return [...text.matchAll(/docs\/testing\/[A-Za-z0-9_-]+\.md/g)].map((m) => m[0]);
}

test("brokenLinks: finds a link to nothing, passes a link to something (control)", () => {
  const have = new Set([resolve("/d", "a.md")]);
  const exists = (p) => have.has(p);
  assert.deepEqual(brokenLinks("[x](a.md) [y](b.md#h) [z](https://e.org/q) [w](#top)", "/d", exists), ["b.md#h"]);
});

test("every relative link in TESTING.md and docs/testing resolves", () => {
  const files = [join(root, "TESTING.md"), ...readdirSync(docsDir).filter((f) => f.endsWith(".md")).map((f) => join(docsDir, f))];
  for (const f of files) assert.deepEqual(brokenLinks(readFileSync(f, "utf8"), dirname(f)), [], f);
});

test("docs/testing/README.md lists every file of the folder, and only files that exist", () => {
  const readme = readFileSync(join(docsDir, "README.md"), "utf8");
  const linked = new Set([...readme.matchAll(/\]\(([A-Za-z0-9_-]+\.md)\)/g)].map((m) => m[1]));
  for (const f of readdirSync(docsDir).filter((n) => n.endsWith(".md") && n !== "README.md")) assert.ok(linked.has(f), `README.md lacks ${f}`);
  for (const f of linked) assert.ok(existsSync(join(docsDir, f)), `README.md lists ${f}, which is missing`);
});

test("every docs/testing/<file>.md named in the repo's sources exists", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 1 << 26 }).toString().split("\0")
    .filter((f) => /\.(mjs|ts|js|rs|py|c|json|md|yml)$/.test(f) && !f.startsWith("app/node_modules/") && existsSync(join(root, f)));
  let seen = 0;
  for (const f of files) {
    const text = readFileSync(join(root, f), "utf8");
    for (const d of mentionedDocs(text)) {
      seen++;
      assert.ok(existsSync(join(root, d)), `${f} names ${d}, which doesn't exist`);
    }
  }
  assert.ok(seen > 20, `only ${seen} mentions found: is the scan reading the files?`);
});
