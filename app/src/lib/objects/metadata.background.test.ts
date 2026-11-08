// The object data's background loads (the Object Manager), apart from metadata.test.ts: the loaded
// data is kept for the module's life, and each test file runs in a module of its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { loadKind } from "./metadata";

test("a background load reads in the background until someone waits on the same kind: then what's still running is asked again as waited on", async () => {
  const asked: { path: string; background: boolean }[] = [];
  const pending: { path: string; go: () => void }[] = [];
  const w3 = {
    settings: { get: () => undefined },
    game: {
      list: async () => ["War3.w3mod:Units/ItemFunc.txt"],
      readText: (path: string, opts?: { background?: boolean }) => {
        asked.push({ path, background: opts?.background === true });
        return new Promise<string>((resolve) => { pending.push({ path, go: () => resolve("") }); });
      },
    },
  } as unknown as W3Api;
  const loading = loadKind(w3, "w3t", { background: true });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(asked.length >= 4 && asked.every((a) => a.background), `all background: ${JSON.stringify(asked)}`);
  // One lands before anyone waits: it isn't asked again.
  pending.find((p) => p.path === "Units\\ItemData.slk")!.go();
  await new Promise((r) => setTimeout(r, 0));
  const before = asked.length;
  const waited = loadKind(w3, "w3t");
  const again = asked.slice(before);
  assert.ok(again.length > 0 && again.every((a) => !a.background), `asked again as waited on: ${JSON.stringify(again)}`);
  assert.ok(!again.some((a) => a.path === "Units\\ItemData.slk"), "what landed isn't asked again");
  assert.ok(again.some((a) => a.path === "Units\\UnitMetaData.slk") && again.some((a) => a.path === "War3.w3mod:Units/ItemFunc.txt"), "the kind's own files and the shared ones");
  // Asked a third time: nothing more (it's already waited on).
  const third = asked.length;
  void loadKind(w3, "w3t");
  assert.equal(asked.length, third);
  for (const p of pending) p.go();
  assert.equal(await loading, await waited);
  assert.equal((await loading).kind, "w3t");
});

test("a kind someone waits on from the start reads as waited on", async () => {
  // The shared files were read by the test above (the module keeps them): only the kind's own are asked.
  const asked: { path: string; background: boolean }[] = [];
  const w3 = {
    settings: { get: () => undefined },
    game: {
      list: async () => [],
      readText: (path: string, opts?: { background?: boolean }) => { asked.push({ path, background: opts?.background === true }); return Promise.resolve(""); },
    },
  } as unknown as W3Api;
  await loadKind(w3, "w3q");
  assert.deepEqual(asked.map((a) => a.background), [false, false], `only the kind's own files, waited on: ${JSON.stringify(asked)}`);
});
