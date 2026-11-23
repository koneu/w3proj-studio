// `w3proj check` names the graphics mode its checks ran under (the report's graphicsMode; the CLI prints it as the
// line "Graphics mode: sd|hd"), over the real backend on a copy of the mini map. The mode changes no row.

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { check } from "./check";
import { rustBackend } from "./rustbackend";
import { fixturePath, repoPath } from "../lib/testhelpers/testutil";

const cache = join(repoPath("app", "node_modules"), ".cache", "w3-checkmode-test");
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(join(cache, "run-"));
const backend = rustBackend();
test.after(async () => { await backend.stop(); rmSync(work, { recursive: true, force: true }); });

test("the check report names the graphics mode it ran under; the default is hd", async () => {
  const root = join(work, "p");
  cpSync(fixturePath("mini-map"), root, { recursive: true });
  backend.serve(root);
  const sd = await check({ root, only: ["problems"], settings: { "game.graphicsMode": "sd" } });
  assert.equal(sd.graphicsMode, "sd");
  const hd = await check({ root, only: ["problems"], settings: { "game.graphicsMode": "hd" } });
  assert.equal(hd.graphicsMode, "hd");
  const none = await check({ root, only: ["problems"], settings: {} });
  assert.equal(none.graphicsMode, "hd", "control: the app's default");
  assert.deepEqual(JSON.parse(JSON.stringify(sd)).graphicsMode, "sd", "it is in the JSON");
});
