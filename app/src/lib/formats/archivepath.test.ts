// toArchiveName's shortcut for paths without escapes must give what the full decoding gives.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { toArchiveName, toProjectPath } from "./archivepath";

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

test("a component that starts with a byte-order mark keeps it, with and without escapes, as the packer does", () => {
  assert.equal(slow(`a/${BOM}b.mdx`), `a\\${BOM}b.mdx`);
  assert.equal(toArchiveName(`a/${BOM}b.mdx`), `a\\${BOM}b.mdx`);
  assert.equal(toArchiveName(`a/%EF%BB%BFb.mdx`), `a\\${BOM}b.mdx`);
  // A mark inside a name is kept by both.
  assert.equal(toArchiveName(`a/b${BOM}.mdx`), slow(`a/b${BOM}.mdx`));
});

/** tests/fixtures/archive-names.json, found from where the tests run (app/ or the repository). */
function archiveNames(): { roundTrip: { path: string; archive: string }[]; toArchive: { path: string; archive: string }[] } {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, "tests", "fixtures", "archive-names.json");
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
    if (dirname(dir) === dir) throw new Error("tests/fixtures/archive-names.json not found");
  }
}

test("the names the Rust side packs and unpacks (shared fixture) are the app's too", () => {
  const { roundTrip, toArchive } = archiveNames();
  // Control: the fixture has the cases this is about.
  assert.ok(roundTrip.filter((c) => c.path.includes(BOM)).length >= 4 && toArchive.length >= 2);
  for (const { path, archive } of roundTrip) {
    assert.equal(toArchiveName(path), archive, JSON.stringify(path));
    assert.equal(toProjectPath(archive), path, JSON.stringify(archive));
  }
  for (const { path, archive } of toArchive) assert.equal(toArchiveName(path), archive, JSON.stringify(path));
});

test("a character outside the Basic Multilingual Plane survives the full decoding, next to an escape", () => {
  const emoji = String.fromCodePoint(0x1f600), old = String.fromCodePoint(0x10348);
  assert.equal(toArchiveName(`war3mapImported/${emoji}%25${old}.mdx`), `war3mapImported\\${emoji}%${old}.mdx`);
  assert.equal(slow(`a/${emoji}.mdx`), `a\\${emoji}.mdx`);
  assert.ok(!slow(`${old}/b`).includes(REPLACEMENT));
});

test("for random paths without escapes or surrogates, the shortcut and the full decoding agree", () => {
  // Fixed seed (printed on failure), as every random test here.
  const seed = 20261107;
  let s = seed;
  const next = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pool = ["a", "Z", "0", "_", ".", " ", "/", "\\", "-", "é", "ß", "中", BOM, ZWSP, REPLACEMENT, NUL, DEL, NBSP];
  let marked = 0;
  for (let i = 0; i < 2000; i++) {
    let path = "";
    const length = 1 + Math.floor(next() * 24);
    for (let k = 0; k < length; k++) path += pool[Math.floor(next() * pool.length)];
    if (path.includes(BOM)) marked++;
    assert.equal(toArchiveName(path), slow(path), `seed ${seed}, path ${JSON.stringify(path)}`);
  }
  // Control: many paths with a byte-order mark went the short way too (none has a "%"), so the comparison reached them.
  assert.ok(marked > 500, `only ${marked} paths had a byte-order mark`);
});
