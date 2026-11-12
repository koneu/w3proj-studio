import { test } from "node:test";
import assert from "node:assert/strict";
import { isPreviewModel, MAX_PREVIEW, previewKey } from "./previewkind";

const file = (size: number, modified = 1) => ({ path: "map/a.mdx", size, modified });

test("only .mdx and .mdl (text) files get a model preview", () => {
  assert.ok(isPreviewModel("war3mapImported\\A.MDX"));
  assert.ok(isPreviewModel("war3mapImported\\A.Mdl"));
  assert.ok(!isPreviewModel("a.mdx.txt"));
  assert.ok(!isPreviewModel("a.mdlx"));
  assert.ok(!isPreviewModel("a.blp"));
  assert.ok(previewKey("a.mdl", file(10), "model"));
  assert.ok(previewKey("a.mdx", file(10), "model"));
  assert.equal(previewKey("a.txt", file(10), "model"), null);
  assert.notEqual(previewKey("a.mdl", file(10), "model"), previewKey("a.mdx", file(10), "model"), "a.mdl and a.mdx are different files");
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
