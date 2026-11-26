import assert from "node:assert/strict";
import { test } from "node:test";
import { convertFlatTerrain, type OpenConversion } from "./layoutconvert";

/** A backend answering terrain_convert_on_open with `answer` (an Error: the call fails), and the calls it got. */
function backend(answer: OpenConversion | Error) {
  const calls: [string, unknown][] = [];
  const invoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push([cmd, args]);
    if (answer instanceof Error) throw answer;
    return answer as T;
  };
  return { invoke, calls };
}

function told(tell: (n: (s: "info" | "warning", m: string) => void) => void) {
  const got: [string, string][] = [];
  tell((s, m) => got.push([s, m]));
  return got;
}

test("a converted project is told once, as information; the open's path is passed on", async () => {
  const b = backend({ converted: [""], kept: [], message: "This project's terrain was in the old layout" });
  const tell = await convertFlatTerrain(b.invoke, "/p/w3proj.toml");
  assert.deepEqual(b.calls, [["terrain_convert_on_open", { path: "/p/w3proj.toml" }]]);
  assert.deepEqual(told(tell), [["info", "This project's terrain was in the old layout"]]);
});

test("a project that stayed flat is a warning; nothing to convert says nothing", async () => {
  const kept = await convertFlatTerrain(backend({ converted: [], kept: [["", "raw"]], message: "This project keeps its terrain" }).invoke, "/p");
  assert.deepEqual(told(kept), [["warning", "This project keeps its terrain"]]);
  const none = await convertFlatTerrain(backend({ converted: [], kept: [], message: null }).invoke, "/p");
  assert.deepEqual(told(none), []);
});

test("a check that fails doesn't stop the open, and says why", async () => {
  const tell = await convertFlatTerrain(backend(new Error("maps: permission denied")).invoke, "/p");
  const got = told(tell);
  assert.equal(got.length, 1);
  assert.equal(got[0][0], "warning");
  assert.match(got[0][1], /opens as it is: maps: permission denied/);
});
