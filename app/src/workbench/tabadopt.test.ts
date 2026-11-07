import test from "node:test";
import assert from "node:assert/strict";
import { adoptOldTabKeys, mayBeSameFolder, tabsKey, type KeyValueStore } from "./tabmemory";
import { timeLimit } from "./timelimit";

const memory = (init: Record<string, string>): KeyValueStore => {
  const data = new Map(Object.entries(init));
  return { get length() { return data.size; }, key: (i) => [...data.keys()][i] ?? null, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
};
const normalise = async (p: string) => p.toLowerCase().replace("konsta~1", "Konstantin");
const ROOT = String.raw`C:\Users\Konstantin\p`;
const OFFLINE = String.raw`\\offline\share\unrelated`;

test("mayBeSameFolder: the same last name, or a short name", () => {
  assert.ok(mayBeSameFolder(String.raw`c:\users\konsta~1\p`, ROOT));
  assert.ok(mayBeSameFolder(String.raw`c:\users\konstantin\myproj~1`, String.raw`C:\Users\Konstantin\My Project`));
  assert.ok(!mayBeSameFolder(OFFLINE, ROOT));
  assert.ok(mayBeSameFolder(String.raw`c:\x\p\\`, ROOT), "a trailing separator doesn't matter");
});

test("only keys that may be this folder are asked about; an unrelated path is never touched", async () => {
  const asked: string[] = [];
  const spy = async (p: string) => { asked.push(p); return normalise(p); };
  const s = memory({ [tabsKey(String.raw`C:\Users\KONSTA~1\p`)]: "SAME LEAF", [tabsKey(OFFLINE)]: "OTHER" });
  assert.equal(await adoptOldTabKeys(s, ROOT, spy), 1);
  assert.equal(asked.length, 1);
  assert.equal(s.getItem(tabsKey(OFFLINE)), "OTHER");
});

test("nothing is asked when no old key exists (the normal open)", async () => {
  let asked = 0;
  await adoptOldTabKeys(memory({ [tabsKey(ROOT)]: "NOW" }), ROOT, async (p) => { asked++; return p; });
  assert.equal(asked, 0);
});

test("timeLimit: an answer that never comes is a rejection; a prompt one passes", async () => {
  await assert.rejects(timeLimit(new Promise<string>(() => {}), 20), /no answer/);
  assert.equal(await timeLimit(Promise.resolve("x"), 1000), "x");
  await assert.rejects(timeLimit(Promise.reject(new Error("boom")), 1000), /boom/);
});
