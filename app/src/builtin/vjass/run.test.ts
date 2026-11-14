// One JassHelper run (run.ts) against a fake backend: how its exit code and the files it left are read, and the run
// that exited 0 having written nothing (seen through Proton with another JassHelper in the prefix, 2026-11-14) is run
// again; one app runs one at a time.

import assert from "node:assert/strict";
import { test } from "node:test";
import { JASSHELPER_ATTEMPTS, runJassHelper, type RunIo, type ToolResult } from "./run";

/** A backend whose tool_run "runs" one scripted outcome per call: the files it writes into its folder and its result. */
function fakeIo(runs: { files: Record<string, string>; result: ToolResult }[]) {
  const files = new Map<string, string>();
  let dirs = 0, ran = 0;
  const io: RunIo = {
    async invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
      if (cmd === "tool_temp_dir") return `/tmp/tool-${++dirs}` as T;
      if (cmd === "fs_exists") {
        const p = String(args.path);
        return [...files.keys()].some((f) => f === p || f.startsWith(p + "/")) as T;
      }
      if (cmd === "tool_run") {
        const run = runs[ran++];
        if (!run) throw new Error("ran too often");
        for (const [name, text] of Object.entries(run.files)) files.set(`${String(args.cwd)}/${name}`, text);
        return run.result as T;
      }
      throw new Error(cmd);
    },
    async writeText(path, text) { files.set(path, text); },
    async sleep() { /* no wait */ },
    async readText(path) {
      const t = files.get(path);
      if (t === undefined) throw new Error(`${path}: No such file or directory (os error 2)`);
      return t;
    },
  };
  return { io, ran: () => ran };
}
const ok: ToolResult = { code: 0, stdout: "", stderr: "" };
const run = (io: RunIo) => runJassHelper(io, "jasshelper.exe", "script", "common", "blizzard", [], 60000);

test("a run that writes its output gives it, once", async () => {
  const f = fakeIo([{ files: { "output.j": "compiled", "logs/currentmapscript.j": "x" }, result: ok }]);
  assert.deepEqual(await run(f.io), { output: "compiled" });
  assert.equal(f.ran(), 1);
});

test("a run with errors gives its log, not run again", async () => {
  const f = fakeIo([{ files: { "logs/compileerrors.txt": "Line 1: Missing requirement: A" }, result: { ...ok, code: 1 } }]);
  const r = await run(f.io);
  assert.ok("log" in r && r.log.includes("Missing requirement"));
  assert.equal(f.ran(), 1);
});

test("a run that exited 0 having written nothing (no logs folder, or an empty one) is run again, in a new folder", async () => {
  const f = fakeIo([{ files: {}, result: ok }, { files: { "logs/currentmapscript.j": "x" }, result: ok }, { files: { "output.j": "compiled" }, result: ok }]);
  assert.deepEqual(await run(f.io), { output: "compiled" });
  assert.equal(f.ran(), 3);
});

test("nothing written every time is an error that says so, not a missing file", async () => {
  const f = fakeIo(Array.from({ length: JASSHELPER_ATTEMPTS }, (_, i) => ({ files: {}, result: { ...ok, stderr: `wine: try ${i + 1}` } })));
  await assert.rejects(run(f.io), new RegExp(`JassHelper exited without writing its output or its errors, ${JASSHELPER_ATTEMPTS} times \\(files in /tmp/tool-${JASSHELPER_ATTEMPTS}\\): wine: try ${JASSHELPER_ATTEMPTS}$`));
  assert.equal(f.ran(), JASSHELPER_ATTEMPTS);
});

test("a run ended for hanging with nothing written is made once more, then is an error", async () => {
  const hung: ToolResult = { code: -1, stdout: "", stderr: "", killed: "nothing happened for 60 s; ended after 60 s" };
  const twice = fakeIo([{ files: {}, result: hung }, { files: { "output.j": "compiled" }, result: ok }]);
  assert.deepEqual(await run(twice.io), { output: "compiled" });
  const never = fakeIo([{ files: {}, result: hung }, { files: {}, result: hung }]);
  await assert.rejects(run(never.io), /JassHelper didn't finish: nothing happened for 60 s; ended after 60 s, and wrote no result \(files in \/tmp\/tool-2\)/);
  assert.equal(never.ran(), 2);
});

test("errors written with exit code 0 are its errors, not run again", async () => {
  const f = fakeIo([{ files: { "logs/compileerrors.txt": "Line 2: Undeclared variable x" }, result: ok }]);
  const r = await run(f.io);
  assert.ok("log" in r && r.log.includes("Undeclared variable x"));
  assert.equal(f.ran(), 1);
});

test("two runs asked for at once run one after the other", async () => {
  let running = 0, most = 0;
  const f = fakeIo([{ files: { "output.j": "one" }, result: ok }, { files: { "output.j": "two" }, result: ok }]);
  const invoke = f.io.invoke.bind(f.io);
  f.io.invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    if (cmd !== "tool_run") return invoke<T>(cmd, args);
    most = Math.max(most, ++running);
    await new Promise((r) => setTimeout(r, 20));
    running--;
    return invoke<T>(cmd, args);
  };
  assert.deepEqual(await Promise.all([run(f.io), run(f.io)]), [{ output: "one" }, { output: "two" }]);
  assert.equal(most, 1);
});

test("a run that failed doesn't hold up the next", async () => {
  const bad = fakeIo([]);
  await assert.rejects(run(bad.io), /ran too often/);
  const f = fakeIo([{ files: { "output.j": "compiled" }, result: ok }]);
  assert.deepEqual(await run(f.io), { output: "compiled" });
});
