// The headless host `w3proj rebuild` runs the app's code in (src/headless): the frames of its pipe to the CLI, whose
// Rust side is crates/cli/src/rebuild.rs (`serve`, with its own tests), and the settings it runs with.

import test from "node:test";
import assert from "node:assert/strict";
import { waitUntil } from "../lib/testhelpers/testutil";

const disk = new Map<string, string>();
const writes: string[] = [];
const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.__TAURI_INTERNALS__ = {
  async invoke(command: string, args: Record<string, unknown>) {
    const path = String(args.path);
    switch (command) {
      case "fs_read_text":
        if (!disk.has(path)) throw `${path}: No such file or directory (os error 2)`;
        return disk.get(path);
      case "fs_exists": return disk.has(path);
      case "fs_write_text": writes.push(path); return { size: 0, modified: 0 };
      default: throw `unexpected ${command}`;
    }
  },
  transformCallback: () => 1, unregisterCallback() {},
};

const { FrameReader, frame, call, receive, settled } = await import("./ipc");
const { HeadlessSettings } = await import("./host");

test("frames split anywhere come out whole: a JSON line, and the raw bytes its len counts", () => {
  const body = new Uint8Array([0, 10, 13, 255, 10]);
  const stream = Buffer.concat([frame({ id: 1, ok: { a: "x\ny" } }), frame({ id: 2 }, body), frame({ id: 3, err: "no" })]);
  for (const step of [1, 2, 7, stream.length]) {
    const got: [Record<string, unknown>, Uint8Array | null][] = [];
    const reader = new FrameReader((m, b) => got.push([m, b]));
    for (let i = 0; i < stream.length; i += step) reader.push(stream.subarray(i, i + step));
    assert.equal(got.length, 3, `in pieces of ${step}`);
    assert.deepEqual(got[0], [{ id: 1, ok: { a: "x\ny" } }, null]);
    // Newlines in the body don't end it: its length does.
    assert.deepEqual(got[1][0], { id: 2, len: 5 });
    assert.deepEqual([...got[1][1]!], [...body]);
    assert.deepEqual(got[2], [{ id: 3, err: "no" }, null]);
  }
});

test("a finished job waits for the commands still running, also the ones their answers start, before it reports", async () => {
  // The frames go to a list here; the test runner's own output (it reports over stdout too) goes on.
  const sent: Record<string, unknown>[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: Uint8Array | string, ...rest: unknown[]) => {
    if (typeof chunk !== "string" && Buffer.from(chunk).subarray(0, 6).toString() === '{"id":') {
      new FrameReader((m) => sent.push(m)).push(chunk);
      return true;
    }
    return (write as (...a: unknown[]) => boolean).call(process.stdout, chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    // Work a job started without awaiting it (map-script's compare on the project opened again): a read, then one
    // more after its answer.
    const background = call("fs_read_text", { path: "a" }).then(() => call("fs_read_text", { path: "b" }));
    let done = false;
    const quiet = settled(5_000).then((v) => { done = true; return v; });
    await waitUntil(() => sent.length === 1, "the first read to be sent");
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(done, false, "a command waits for its answer");
    receive({ id: sent[0].id, ok: "x" }, null);
    await waitUntil(() => sent.length === 2, "the read its answer started to be sent");
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(done, false, "the command its answer started waits too");
    receive({ id: sent[1].id, ok: "y" }, null);
    assert.equal(await quiet, true);
    assert.equal(await background, "y");
    // Control: a command nobody answers holds it only up to the limit.
    void call("fs_read_text", { path: "c" }).catch(() => {});
    assert.equal(await settled(50), false);
    receive({ id: sent[2].id, ok: "z" }, null);
    assert.equal(await settled(50), true);
  } finally {
    process.stdout.write = write;
  }
});

test("an empty body is a body, not a missing one", () => {
  const got: (Uint8Array | null)[] = [];
  new FrameReader((_m, b) => got.push(b)).push(frame({ id: 1 }, new Uint8Array(0)));
  assert.equal(got.length, 1);
  assert.ok(got[0] instanceof Uint8Array && got[0].length === 0);
});

test("the CLI's settings win, the project's come next, a user-only setting isn't taken from the project, nothing is written", async () => {
  disk.clear(); writes.length = 0;
  const root = "/p";
  disk.set(`${root}/.w3proj/settings.json`, JSON.stringify({ "terrain.minimap.jpegQuality": 50, "game.installDir": "/project/says", "terrain.pathing.regenerate": false }));
  const s = new HeadlessSettings({ "game.installDir": "/cli/game", "terrain.pathing.regenerate": true });
  s.contribute("t", "T", {
    "terrain.minimap.jpegQuality": { type: "integer", default: 80 },
    "terrain.pathing.regenerate": { type: "boolean", default: true },
    "terrain.minimap.blurPasses": { type: "integer", default: 2 },
  });
  await s.loadProject(root);
  assert.equal(s.get("game.installDir"), "/cli/game");
  assert.equal(s.get("terrain.pathing.regenerate"), true, "the job's switch wins over the project's");
  assert.equal(s.get("terrain.minimap.jpegQuality"), 50, "the project's own");
  assert.equal(s.get("terrain.minimap.blurPasses"), 2, "the default");
  assert.equal(s.get("game.graphicsMode"), "hd", "the app's default");
  await s.set("recentProjects", [root]);
  assert.deepEqual(s.get("recentProjects"), [root]);
  assert.deepEqual(writes, [], "the user's settings file isn't the CLI's to write");
  // Control: without the CLI's value the project's is still not taken for a user-only setting.
  const plain = new HeadlessSettings({});
  await plain.loadProject(root);
  assert.notEqual(plain.get("game.installDir"), "/project/says");
});
