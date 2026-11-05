import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeLossless, encodeLossless } from "./lossless";

const te = new TextEncoder();
const back = (b: Uint8Array) => assert.deepEqual(encodeLossless(decodeLossless(b)), b);

test("UTF-8 stays as it is, a leading BOM too", () => {
  for (const s of ["", "plain", "Größe", "한국어", "中文", "😀"]) {
    assert.equal(decodeLossless(te.encode(s)), s);
    assert.deepEqual(encodeLossless(s), te.encode(s));
  }
  back(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]));
});

test("code pages come back byte for byte", () => {
  // "한국" in CP949, "中文" in GBK, a broken sequence, one cut off at the end.
  for (const b of [[0xc7, 0xd1, 0xb1, 0xb9], [0xd6, 0xd0, 0xce, 0xc4], [0x61, 0xff, 0x62], [0x61, 0xe4, 0xb8]]) back(new Uint8Array(b));
  assert.equal(decodeLossless(new Uint8Array([0x61, 0xff])), "a\u{10ffff}");
});

test("what UTF-8 forbids isn't taken for text", () => {
  for (const b of [[0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe0, 0x80, 0x80]]) {
    assert.equal(decodeLossless(new Uint8Array(b)).length, b.length * 2, "every byte escaped (two UTF-16 units each)");
    back(new Uint8Array(b));
  }
});

test("the escapes themselves survive", () => back(te.encode("\u{10ff80}x\u{10ffff}")));

test("any bytes at all", () => {
  let x = 0x2545f491;
  for (let len = 0; len < 400; len++) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
      // Often the lead and continuation bytes UTF-8 is made of.
      bytes[i] = x & 1 ? (x >>> 8) & 0xff : 0xf4 - ((x >>> 8) & 0x3f);
    }
    back(bytes);
  }
});

test("the same as the Rust side: its characters for the same bytes", () => {
  assert.equal(decodeLossless(new Uint8Array([0xc7, 0xd1, 0x41])), "\u{10ffc7}\u{10ffd1}A");
});
