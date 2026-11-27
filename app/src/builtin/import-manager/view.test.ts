import { test } from "node:test";
import assert from "node:assert/strict";
import { importRows, type ImportEntry } from "../../lib/imports";
import { nextSort, passes, sortRows, totals, typeOptions, type RowFacts } from "./view";

const e = (path: string): ImportEntry => ({ path, flags: 0 });
const entries = [e("b\\Zed.mdx"), e("_HD.w3mod\\b\\Zed.mdx"), e("a\\Pic.blp"), e("_HD.w3mod\\only\\Hd.blp"), e("c\\Snd.wav")];
const sizes: Record<string, number> = { "b\\Zed.mdx": 300, "_HD.w3mod\\b\\Zed.mdx": 500, "a\\Pic.blp": 40, "_HD.w3mod\\only\\Hd.blp": 7, "c\\Snd.wav": 1000 };
const facts = (): RowFacts[] => importRows(entries).map((row) => ({
  row, size: [row.classic, row.reforged, row.de].reduce((n, x) => n + (x ? sizes[x.path] : 0), 0) }));
const paths = (f: RowFacts[]) => f.map((x) => x.row.path);

test("sorting by path, type and size, and again reverses", () => {
  const f = facts();
  assert.deepEqual(paths(sortRows(f, { key: "path", dir: 1 })), ["a\\Pic.blp", "b\\Zed.mdx", "c\\Snd.wav", "only\\Hd.blp"]);
  assert.deepEqual(paths(sortRows(f, { key: "size", dir: 1 })), ["only\\Hd.blp", "a\\Pic.blp", "b\\Zed.mdx", "c\\Snd.wav"]);
  assert.deepEqual(paths(sortRows(f, { key: "size", dir: -1 })), ["c\\Snd.wav", "b\\Zed.mdx", "a\\Pic.blp", "only\\Hd.blp"]);
  assert.deepEqual(paths(sortRows(f, { key: "type", dir: 1 })).slice(0, 2), ["a\\Pic.blp", "only\\Hd.blp"]);
  assert.deepEqual(nextSort(null, "size"), { key: "size", dir: 1 });
  assert.deepEqual(nextSort({ key: "size", dir: 1 }, "size"), { key: "size", dir: -1 });
  assert.deepEqual(nextSort({ key: "size", dir: -1 }, "path"), { key: "path", dir: 1 });
});

test("sorting is a view: the list and the rows keep their order", () => {
  const f = facts();
  const before = paths(f);
  sortRows(f, { key: "size", dir: -1 });
  assert.deepEqual(paths(f), before);
  assert.deepEqual(paths(sortRows(f, null)), before);
});

test("filters by graphics mode and type", () => {
  const f = facts();
  assert.deepEqual(paths(f.filter((x) => passes(x, { mode: "reforged" }))), ["b\\Zed.mdx", "only\\Hd.blp"]);
  assert.deepEqual(paths(f.filter((x) => passes(x, { mode: "classic" }))), ["b\\Zed.mdx", "a\\Pic.blp", "c\\Snd.wav"]);
  assert.deepEqual(paths(f.filter((x) => passes(x, { type: "Image" }))), ["a\\Pic.blp", "only\\Hd.blp"]);
  assert.deepEqual(paths(f.filter((x) => passes(x, { type: "Image", mode: "reforged" }))), ["only\\Hd.blp"]);
  assert.equal(f.filter((x) => passes(x, {})).length, 4);
  assert.deepEqual(typeOptions(f.map((x) => x.row)), ["Image", "Model", "Sound"]);
});

test("totals count entries and bytes", () => {
  const f = facts();
  assert.deepEqual(totals(f), { entries: 5, size: 1847 });
  assert.deepEqual(totals(f.filter((x) => passes(x, { mode: "reforged" }))), { entries: 3, size: 807 });
});
