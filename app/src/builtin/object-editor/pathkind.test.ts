import assert from "node:assert/strict";
import { test } from "node:test";
import { PATH_KIND } from "./filepicker";

test("every path metadata type maps to the file kind its field takes", () => {
  for (const t of ["model", "modelList"]) assert.equal(PATH_KIND[t], "model", t);
  for (const t of ["icon", "texture", "pathingTexture", "shadowTexture"]) assert.equal(PATH_KIND[t], "image", t);
  // Control: a type that isn't a path gets no browser.
  // shadowImage and uberSplat name a shadow or splat, not a file.
  assert.equal(PATH_KIND["shadowImage"], undefined);
  assert.equal(PATH_KIND["uberSplat"], undefined);
  assert.equal(PATH_KIND["string"], undefined);
  assert.equal(PATH_KIND["unitSound"], undefined);
});
