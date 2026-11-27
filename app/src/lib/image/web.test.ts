import { test } from "node:test";
import assert from "node:assert/strict";
import { webImageKind } from "./web.ts";
import { encodePng } from "./png.ts";

test("PNG and JPEG are told apart by their signature, nothing else is one", async () => {
  const png = await encodePng(2, 2, new Uint8Array(16));
  assert.equal(webImageKind(png), "PNG");
  assert.equal(webImageKind(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 0x10)), "JPEG");
  assert.equal(webImageKind(new TextEncoder().encode("BLP1....")), null);
  assert.equal(webImageKind(new Uint8Array(0)), null);
  assert.equal(webImageKind(png.subarray(0, 7)), null);
});
