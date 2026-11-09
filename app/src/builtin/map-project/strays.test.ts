// What a project just opened is checked for: stray files of an older version (moved only when the user says so)
// and map files whose names differ only in case.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import { caseClashes, checkOpenedProject, strayQuestion, type Stray } from "./strays";

const ROOT = "/home/u/maps/Turtle";
const stray = (file: string, kind: Stray["kind"]): Stray => ({ path: `/home/u/maps/Turtle\\build\\checkpoints\\${file}`, shown: `Turtle\\build\\checkpoints\\${file}`, rel: `build/checkpoints/${file}`, kind });

test("the question names what can be moved, what is a copy and what stays; with nothing to do it only offers the list", () => {
  assert.equal(strayQuestion([]), null);
  const q = strayQuestion([stray("a.w3x", "move"), stray("b.w3x", "move"), stray("c.w3x", "duplicate"), stray("d.w3x", "conflict")])!;
  assert.match(q.message, /4 files of this project have a "\\" in their name/);
  assert.match(q.message, /2 files can be moved where they belong; 1 file is a copy/);
  assert.match(q.message, /1 file can't be moved/);
  assert.match(q.message, /count toward the number kept \(checkpoints\.keep\)/, "moved checkpoints may be removed as old ones: said");
  assert.doesNotMatch(strayQuestion([{ ...stray("a.w3x", "move"), rel: "map/a.w3x" }])!.message, /checkpoints\.keep/);
  assert.deepEqual(q.actions, ["Move and delete copies", "Leave them", "Show list"]);
  assert.deepEqual(strayQuestion([stray("a.w3x", "move")])!.actions[0], "Move them");
  assert.deepEqual(strayQuestion([stray("a.w3x", "conflict")])!.actions, ["Show list"]);
});

test("map files that differ only in case are found on a case-sensitive root, not on Windows, and not outside map/", () => {
  const files = ["map/Notes.txt", "map/notes.txt", "map/war3map.j", "README.md", "readme.md"];
  assert.deepEqual(caseClashes(files, ROOT), [["map/Notes.txt", "map/notes.txt"]]);
  assert.deepEqual(caseClashes(files, "C:\\maps\\Turtle"), []);
  assert.deepEqual(caseClashes(["map/a.txt"], ROOT), []);
});

/** A made-up app: the backend's strays, the user's answer, and what was asked and done. */
function app(strays: Stray[], answer: string | undefined, opts: { fail?: string[]; switchTo?: string } = {}) {
  const log: string[] = [];
  let root = ROOT;
  const w3 = {
    workspace: {
      project: () => ({ root }),
      files: () => [],
      refresh: async () => { log.push("refresh"); },
    },
    backend: {
      invoke: async (cmd: string, a: { root: string; path?: string }) => {
        if (cmd === "project_strays") return strays;
        if (cmd === "project_fix_stray") {
          log.push(`fix ${a.path}`);
          if (opts.fail?.includes(a.path!)) throw "differs";
          return strays.find((s) => s.path === a.path)!.kind === "move" ? "moved" : "deleted";
        }
        throw new Error(cmd);
      },
    },
    window: {
      showWarning: async (m: string) => { log.push(`warn ${m}`); if (opts.switchTo) root = opts.switchTo; return answer; },
      showInfo: async (m: string) => { log.push(`info ${m}`); return undefined; },
    },
  } as unknown as W3Api;
  const out = { append: () => {}, clear: () => {}, show: () => { log.push("show"); } };
  return { w3, out, log };
}

test("stray files are moved only when the user says so, and only those that can be", async () => {
  const strays = [stray("a.w3x", "move"), stray("b.w3x", "duplicate"), stray("c.w3x", "conflict")];
  const left = app(strays, "Leave them");
  await checkOpenedProject(left.w3, ROOT, left.out);
  assert.equal(left.log.filter((l) => l.startsWith("fix")).length, 0, "left alone");
  const dismissed = app(strays, undefined);
  await checkOpenedProject(dismissed.w3, ROOT, dismissed.out);
  assert.equal(dismissed.log.filter((l) => l.startsWith("fix")).length, 0, "a dismissed question moves nothing");
  const moved = app(strays, "Move and delete copies");
  await checkOpenedProject(moved.w3, ROOT, moved.out);
  assert.deepEqual(moved.log.filter((l) => l.startsWith("fix")), [`fix ${strays[0].path}`, `fix ${strays[1].path}`]);
  assert.ok(moved.log.includes("refresh"));
  assert.ok(moved.log.some((l) => l === "info 1 file moved, 1 copy deleted."), moved.log.join(" | "));
});

test("a failed move is reported, and nothing is done once another project is open", async () => {
  const strays = [stray("a.w3x", "move"), stray("b.w3x", "move")];
  const failing = app(strays, "Move them", { fail: [strays[0].path] });
  await checkOpenedProject(failing.w3, ROOT, failing.out);
  assert.equal(failing.log.filter((l) => l.startsWith("fix")).length, 2, "the next one is still tried");
  assert.ok(failing.log.some((l) => /^warn 1 file moved; 1 file left as it was: .*a\.w3x: differs/.test(l)), failing.log.join(" | "));
  const switched = app(strays, "Move them", { switchTo: "/home/u/maps/Other" });
  await checkOpenedProject(switched.w3, ROOT, switched.out);
  assert.equal(switched.log.filter((l) => l.startsWith("fix") || l === "refresh").length, 0, "the answer came after a switch: nothing moved");
});
