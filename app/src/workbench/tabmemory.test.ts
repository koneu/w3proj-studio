import test from "node:test";
import assert from "node:assert/strict";
import { adoptOldTabKeys, tabsKey, type KeyValueStore } from "./tabmemory";

const memory = (init: Record<string, string>): KeyValueStore => {
  const data = new Map(Object.entries(init));
  return { get length() { return data.size; }, key: (i) => [...data.keys()][i] ?? null, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};
const LONG = String.raw`C:\Users\Konstantin\p`, SHORT = String.raw`C:\Users\KONSTA~1\p`;
// The backend's answer: the short name is the long one.
const normalise = async (p: string) => p.toLowerCase().replace("konsta~1", "Konstantin");

test("the key ignores a trailing slash and case", () => {
  assert.equal(tabsKey(LONG + "\\"), tabsKey(LONG.toLowerCase()));
});

test("on Linux two folders differing only in case are two projects; a trailing slash still doesn't count", () => {
  assert.notEqual(tabsKey("/home/u/maps/MyMap"), tabsKey("/home/u/maps/mymap"));
  assert.equal(tabsKey("/home/u/maps/MyMap/"), tabsKey("/home/u/maps/MyMap"));
  assert.equal(tabsKey("/"), "w3.openEditors:/");
});

test("tabs saved under the 8.3 spelling are adopted by the long one, once", async () => {
  const other = String.raw`w3.openEditors:c:\other`;
  const s = memory({ [tabsKey(SHORT)]: "S", [other]: "O", unrelated: "U" });
  assert.equal(await adoptOldTabKeys(s, LONG, normalise), 1);
  assert.equal(s.getItem(tabsKey(LONG)), "S");
  assert.equal(s.getItem(tabsKey(SHORT)), null);
  assert.equal(s.getItem(other), "O", "another project stays");
  assert.equal(await adoptOldTabKeys(s, LONG, normalise), 0);
});

test("tabs already saved under the new key aren't overwritten by old ones", async () => {
  const s = memory({ [tabsKey(SHORT)]: "OLD", [tabsKey(LONG)]: "NEW" });
  assert.equal(await adoptOldTabKeys(s, LONG, normalise), 0);
  assert.equal(s.getItem(tabsKey(LONG)), "NEW");
  assert.equal(s.getItem(tabsKey(SHORT)), "OLD", "an old key that wasn't moved stays");
});

test("a failing normalise keeps the old key", async () => {
  const s = memory({ [tabsKey(SHORT)]: "S" });
  await adoptOldTabKeys(s, LONG, async () => { throw new Error("no"); });
  assert.equal(s.getItem(tabsKey(SHORT)), "S");
});
