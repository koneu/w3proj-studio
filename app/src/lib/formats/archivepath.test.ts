// toArchiveName's shortcut for paths without escapes must give what the full decoding gives.

import assert from "node:assert/strict";
import { test } from "node:test";
import { toArchiveName } from "./archivepath";

/** Characters that are invisible or easy to lose in the source, built from their codes. */
const BOM = String.fromCharCode(0xfeff), ZWSP = String.fromCharCode(0x200b), REPLACEMENT = String.fromCharCode(0xfffd);
const NUL = String.fromCharCode(0), DEL = String.fromCharCode(0x7f), NBSP = String.fromCharCode(0xa0);

/** The full decoding of a path, through the app's own code: an escape ("%25", a "%") in a last
 *  component of its own makes it take the slow way, and that component is cut off again. */
const slow = (path: string) => {
  const out = toArchiveName(`${path}/%25`);
  assert.ok(out.endsWith("\\%"));
  return out.slice(0, -2);
};

test("a component that starts with a byte-order mark loses it, with and without escapes", () => {
  assert.equal(slow(`a/${BOM}b.mdx`), "a\\b.mdx");
  assert.equal(toArchiveName(`a/${BOM}b.mdx`), slow(`a/${BOM}b.mdx`));
  // A mark inside a name is kept by both.
  assert.equal(toArchiveName(`a/b${BOM}.mdx`), slow(`a/b${BOM}.mdx`));
});

test("for random paths without escapes or surrogates, the shortcut and the full decoding agree", () => {
  // Fixed seed (printed on failure), as every random test here.
  const seed = 20261107;
  let s = seed;
  const next = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pool = ["a", "Z", "0", "_", ".", " ", "/", "\\", "-", "é", "ß", "中", BOM, ZWSP, REPLACEMENT, NUL, DEL, NBSP];
  let shortcut = 0;
  for (let i = 0; i < 2000; i++) {
    let path = "";
    const length = 1 + Math.floor(next() * 24);
    for (let k = 0; k < length; k++) path += pool[Math.floor(next() * pool.length)];
    if (!path.includes(BOM)) shortcut++;
    assert.equal(toArchiveName(path), slow(path), `seed ${seed}, path ${JSON.stringify(path)}`);
  }
  // Control: many of them went the short way, so the comparison reached it.
  assert.ok(shortcut > 500, `only ${shortcut} paths took the shortcut`);
});
