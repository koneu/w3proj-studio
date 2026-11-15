import test from "node:test";
import assert from "node:assert/strict";
import { unreadableProblems } from "./checks";

test("an unreadable chapter folder is named with its chapter, path and the system's reason", () => {
  const [p] = unreadableProblems([{ path: "maps/Forsaken04.w3x", error: "Keine Berechtigung (os error 13)" }]);
  assert.equal(p.severity, "error");
  assert.match(p.message, /chapter "Forsaken04\.w3x" can't be read \(Keine Berechtigung \(os error 13\)\)/);
  assert.equal(p.location, "maps/Forsaken04.w3x");
});

test("another unreadable folder is named by its path; none gives nothing", () => {
  const [p] = unreadableProblems([{ path: "map/sub", error: "denied" }]);
  assert.match(p.message, /The folder map\/sub can't be read/);
  assert.deepEqual(unreadableProblems([]), []);
});
