import assert from "node:assert/strict";
import { test } from "node:test";
import { ModeCache } from "./modecache";

test("values are kept per mode: the same key in another mode is made again, and each mode's value stays", async () => {
  const cache = new ModeCache<string>();
  let mode = "hd", made = 0;
  const get = () => cache.get(() => mode, "tile", async () => `${mode}-${++made}`);
  assert.equal(await get(), "hd-1");
  assert.equal(await get(), "hd-1", "kept");
  mode = "sd";
  assert.equal(await get(), "sd-2", "another mode: made again (the control: a cache by key alone gives hd-1)");
  mode = "hd";
  assert.equal(await get(), "hd-1", "the first mode's value is still there");
  assert.equal(made, 2);
});

test("a value whose mode changed while it was made isn't kept", async () => {
  const cache = new ModeCache<string>();
  let mode = "hd";
  let release!: (v: string) => void;
  const first = cache.get(() => mode, "k", () => new Promise<string>((r) => { release = r; }));
  mode = "sd";
  release("mixed");
  assert.equal(await first, "mixed", "the caller still gets it");
  await new Promise((r) => setTimeout(r, 0));
  mode = "hd";
  assert.equal(await cache.get(() => mode, "k", async () => "fresh"), "fresh", "made again, not the one read during the change");
  assert.equal(cache.size, 1);
});

test("a failed make is kept like a value (callers catch inside), and doesn't throw unhandled", async () => {
  const cache = new ModeCache<string | null>();
  const v = await cache.get(() => "hd", "k", async () => { throw new Error("no file"); }).catch(() => null);
  assert.equal(v, null);
});
