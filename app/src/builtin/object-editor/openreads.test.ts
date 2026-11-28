import assert from "node:assert/strict";
import { test } from "node:test";
import { startOpenReads } from "./openreads";

/** A reader that records when it's asked and lands when told. */
function reader<T>(log: string[], name: string) {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const read = () => { log.push(name); return new Promise<T>((res, rej) => { resolve = res; reject = rej; }); };
  return { read, resolve: (v: T) => resolve(v), reject: (e: unknown) => reject(e) };
}

test("every read of an open is asked before the first lands", async () => {
  const asked: string[] = [];
  const main = reader<string>(asked, "main"), skin = reader<string | null>(asked, "skin"), wts = reader<string>(asked, "wts"), camp = reader<number | null>(asked, "campaign");
  const reads = startOpenReads({ main: main.read, skin: skin.read, wts: wts.read, campaign: camp.read });
  assert.deepEqual(asked, ["main", "skin", "wts", "campaign"], "all four started at once, none waited for another");
  main.resolve("m"); skin.resolve(null); wts.resolve("w"); camp.resolve(7);
  assert.equal(await reads.main, "m");
  assert.equal(await reads.skin, null);
  assert.equal(await reads.wts, "w");
  assert.deepEqual(await reads.campaign, { campaign: 7, error: null });
});

test("nothing to read for a file without a Skin file or a campaign", async () => {
  const asked: string[] = [];
  const main = reader<string>(asked, "main"), wts = reader<string>(asked, "wts");
  const reads = startOpenReads({ main: main.read, skin: null, wts: wts.read, campaign: null });
  assert.deepEqual(asked, ["main", "wts"]);
  main.resolve("m"); wts.resolve("");
  assert.equal(await reads.skin, null);
  assert.deepEqual(await reads.campaign, { campaign: null, error: null });
});

test("an unreadable strings file is absent for the editor; a campaign that fails says why and the open goes on", async () => {
  const asked: string[] = [];
  const main = reader<string>(asked, "main"), wts = reader<string>(asked, "wts"), camp = reader<number | null>(asked, "campaign");
  const reads = startOpenReads({ main: main.read, skin: null, wts: wts.read, campaign: camp.read });
  main.resolve("m"); wts.reject(new Error("locked")); camp.reject(new Error("campaign data is there but can't be read"));
  assert.equal(await reads.main, "m");
  assert.equal(await reads.wts, null);
  assert.deepEqual(await reads.campaign, { campaign: null, error: "campaign data is there but can't be read" });
});

test("a failing object file is the open's error, the Skin file's failure behind it is not left unhandled", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => { unhandled.push(e); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const asked: string[] = [];
    const main = reader<string>(asked, "main"), skin = reader<string | null>(asked, "skin"), wts = reader<string>(asked, "wts");
    const reads = startOpenReads({ main: main.read, skin: skin.read, wts: wts.read, campaign: null });
    main.reject(new Error("main broken")); skin.reject(new Error("skin broken")); wts.resolve("");
    await assert.rejects(reads.main, /main broken/);
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, [], "no rejection left unhandled");
    // With the object file fine, the Skin file's error is the one that comes.
    const m2 = reader<string>(asked, "main"), s2 = reader<string | null>(asked, "skin");
    const second = startOpenReads({ main: m2.read, skin: s2.read, wts: async () => "", campaign: null });
    m2.resolve("m"); s2.reject(new Error("skin broken"));
    assert.equal(await second.main, "m");
    await assert.rejects(second.skin, /skin broken/);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
