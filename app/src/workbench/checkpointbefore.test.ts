// lib/checkpoint.ts's checkpointBefore against the workbench's own command service (here, since lib
// may not import the workbench): a missing checkpoints extension goes on, a failing checkpoint
// asks, and only "Continue" goes on.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../extensions/api";
import { checkpointBefore } from "../lib/checkpoint";
import { CommandService } from "./commands";

function app(checkpoint: "works" | "fails" | "absent", answer?: string) {
  const commands = new CommandService();
  if (checkpoint !== "absent") commands.register("w3.checkpoints.create", async () => { if (checkpoint === "fails") throw new Error("disk full"); });
  const asked: string[] = [];
  const w3 = {
    commands: { execute: (id: string, ...a: unknown[]) => commands.execute(id, ...a) },
    window: { showWarning: async (m: string) => { asked.push(m); return answer; } },
  } as unknown as W3Api;
  return { w3, asked };
}

test("a checkpoint made: go on, nothing asked", async () => {
  const a = app("works");
  assert.equal(await checkpointBefore(a.w3, "Discard"), true);
  assert.deepEqual(a.asked, []);
});

test("no checkpoints extension: go on, as the callers promise ('where they're enabled')", async () => {
  const a = app("absent");
  assert.equal(await checkpointBefore(a.w3, "Discard"), true);
  assert.deepEqual(a.asked, []);
});

test("a checkpoint that fails asks; only Continue goes on", async () => {
  const stop = app("fails", "Cancel");
  assert.equal(await checkpointBefore(stop.w3, "Discard 2 changes"), false);
  assert.match(stop.asked[0], /disk full.*Discard 2 changes anyway/);
  assert.equal(await checkpointBefore(app("fails", undefined).w3, "Discard"), false, "the question closed");
  assert.equal(await checkpointBefore(app("fails", "Continue without a checkpoint").w3, "Discard"), true);
});
