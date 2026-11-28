import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { once } from "node:events";
import { test } from "node:test";
import { appAlive, findApp } from "./webdriver.mjs";

const linux = { skip: process.platform !== "linux" && "reads /proc" };

test("findApp finds a process below a root by its executable and appAlive sees it end", linux, async () => {
  // sh (the root) starts sleep (the "app") as its child: the tree and the executable name it, no pattern.
  const root = spawn("sh", ["-c", "sleep 30; true"], { stdio: "ignore" });
  try {
    let found = null;
    const exe = realpathSync(await which("sleep"));
    for (let i = 0; i < 50 && !found; i++) { found = findApp(root.pid, exe); if (!found) await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(found, "the child sleep was found below sh");
    assert.notEqual(found.pid, root.pid);
    assert.equal(findApp(root.pid, process.execPath), null, "another executable isn't there (control)");
    assert.equal(appAlive(found), true);
    process.kill(found.pid, "SIGKILL");
    await once(root, "exit");
    assert.equal(appAlive(found), false, "a killed process is gone");
  } finally {
    root.kill("SIGKILL");
  }
});

async function which(name) {
  const p = spawn("sh", ["-c", `command -v ${name}`], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  await once(p, "close");
  return out.trim();
}
