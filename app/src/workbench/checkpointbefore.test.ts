// lib/checkpoint.ts's checkpointBefore against the workbench's own command service (here, since lib
// may not import the workbench): a missing checkpoints extension goes on, a failing checkpoint
// asks, and only "Continue" goes on.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../extensions/api";
import { checkpointBefore, checkpointIfOn, checkpointOrStop, forgetCheckpointsOffWarning } from "../lib/checkpoint";
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

test("checkpointIfOn: made, it says nothing; without the extension it goes on and warns once a session; a failure stops", async () => {
  forgetCheckpointsOffWarning();
  const on = app("works");
  assert.equal(await checkpointIfOn(on.w3, "Delete Invalid Objects"), true);
  assert.deepEqual(on.asked, []);
  const off = app("absent");
  assert.equal(await checkpointIfOn(off.w3, "Delete Invalid Objects"), false);
  assert.equal(await checkpointIfOn(off.w3, "Import Object Data"), false);
  assert.equal(off.asked.length, 1, "once per session");
  assert.match(off.asked[0], /Delete Invalid Objects went on without a checkpoint: the Checkpoints extension is off/);
  // Another caller in the same session (another extension's api) stays quiet too.
  const other = app("absent");
  assert.equal(await checkpointIfOn(other.w3, "Replace Internal Sound"), false);
  assert.deepEqual(other.asked, []);
  const failing = app("fails");
  await assert.rejects(checkpointIfOn(failing.w3, "Delete Invalid Objects"), /disk full/);
  assert.deepEqual(failing.asked, []);
  forgetCheckpointsOffWarning();
});

test("checkpointOrStop (map shrink, AI tools' big changes): without the extension it goes on with the one-time warning; a failure stops with 'Nothing changed'", async () => {
  forgetCheckpointsOffWarning();
  assert.equal(await checkpointOrStop(app("works").w3, "Shrinking the map"), true);
  const off = app("absent");
  assert.equal(await checkpointOrStop(off.w3, "Shrinking the map"), false);
  assert.equal(await checkpointOrStop(off.w3, "An AI tool's change"), false);
  assert.equal(off.asked.length, 1, "once per session");
  assert.match(off.asked[0], /Shrinking the map went on without a checkpoint/);
  // Shared with checkpointIfOn's callers: one warning a session for all of them.
  const other = app("absent");
  assert.equal(await checkpointIfOn(other.w3, "Delete Invalid Objects"), false);
  assert.deepEqual(other.asked, []);
  const failing = app("fails");
  await assert.rejects(checkpointOrStop(failing.w3, "Shrinking the map"), /^Error: Nothing changed: the checkpoint failed \(disk full\)\.$/);
  assert.deepEqual(failing.asked, []);
  forgetCheckpointsOffWarning();
});

test("a checkpoint that fails asks; only Continue goes on", async () => {
  const stop = app("fails", "Cancel");
  assert.equal(await checkpointBefore(stop.w3, "Discard 2 changes"), false);
  assert.match(stop.asked[0], /disk full.*Discard 2 changes anyway/);
  assert.equal(await checkpointBefore(app("fails", undefined).w3, "Discard"), false, "the question closed");
  assert.equal(await checkpointBefore(app("fails", "Continue without a checkpoint").w3, "Discard"), true);
});
