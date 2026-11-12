import { test } from "node:test";
import assert from "node:assert/strict";
import { isPreviewModel, MAX_PREVIEW, previewKey } from "./previewkind";

const file = (size: number, modified = 1) => ({ path: "map/a.mdx", size, modified });

test("only .mdx files get a model preview", () => {
  assert.ok(isPreviewModel("war3mapImported\\A.MDX"));
  assert.ok(!isPreviewModel("a.mdl"));
  assert.ok(!isPreviewModel("a.mdx.txt"));
  assert.equal(previewKey("a.mdl", file(10), "model"), null);
  assert.ok(previewKey("a.mdx", file(10), "model"));
});

test("the size cap", () => {
  assert.ok(previewKey("a.mdx", file(MAX_PREVIEW), "model"));
  assert.equal(previewKey("a.mdx", file(MAX_PREVIEW + 1), "model"), null);
});

test("the key changes with the file's content and kind, not its path's case", () => {
  const k = previewKey("a.mdx", file(10), "model");
  assert.equal(previewKey("A.MDX", file(10), "model"), k);
  assert.notEqual(previewKey("a.mdx", file(10, 2), "model"), k);
  assert.notEqual(previewKey("a.mdx", file(11), "model"), k);
  assert.notEqual(previewKey("a.mdx", file(10), "image"), k);
});
