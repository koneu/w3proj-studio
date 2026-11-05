import assert from "node:assert/strict";
import { test } from "node:test";
import { lfsSize } from "./git";

test("LFS pointers give the file's real size", () => {
  const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 271253\n";
  assert.equal(lfsSize(pointer), 271253);
  assert.equal(lfsSize("size 12\n"), null);
  assert.equal(lfsSize(null), null);
});
