// Helpers shared by the unit tests. The tests run bundled elsewhere (scripts/test.mjs, a folder under
// node_modules/.cache), so import.meta.url says nothing about the repository: files are found from where the run
// started (app/ for `npm test`, or anywhere inside the checkout) by walking up.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The first path `rel` (repository-relative, e.g. "tests", "fixtures", "mini-map") that exists, looking from the
 *  working directory up through its parents. Throws when there is none. */
export function repoPath(...rel: string[]): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, ...rel);
    if (existsSync(p)) return p;
    if (dirname(dir) === dir) throw new Error(`${rel.join("/")} not found from ${process.cwd()} or above`);
  }
}

/** A file under tests/fixtures, read when called (not when the test file loads). */
export const fixturePath = (...rel: string[]): string => repoPath("tests", "fixtures", ...rel);
export const readFixture = (...rel: string[]): string => readFileSync(fixturePath(...rel), "utf8");

/** Whether the run must fail rather than skip a test that needs the corpus (maps, game files, release CLI):
 *  W3PROJ_REQUIRE_CORPUS=1, set where those are expected to be there. */
export const corpusRequired = (): boolean => process.env.W3PROJ_REQUIRE_CORPUS === "1";

/** Skips the test for a missing corpus part, or fails it when W3PROJ_REQUIRE_CORPUS=1. */
export function skipOrFail(ctx: { skip: (why?: string) => void }, why: string): void {
  if (corpusRequired()) throw new Error(`W3PROJ_REQUIRE_CORPUS=1 but ${why}`);
  ctx.skip(why);
}

/** A seeded random source in [0, 1) (mulberry32; the multiplications are 32-bit, so every platform gets the same
 *  numbers): a failure replays from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Waits (letting other work run) until `cond` holds; throws after `ms`, so that a test whose signal never comes
 *  fails and does not hang. */
export async function waitUntil(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((r) => setImmediate(r));
  }
}
