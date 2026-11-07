import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// codec_write saves a project file in the backend. Every save must go through `w3.backend.invoke`, which
// the workbench routes via the workspace (trackedinvoke.ts); a direct invoke would make the save look like
// a change by another program on the next focus.
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const src = join(process.cwd(), "src");

test("no code calls codec_write other than through w3.backend.invoke", () => {
  const files = walk(src).filter((f) => /\.ts$/.test(f) && !/\.test\.ts$/.test(f));
  const found: string[] = [];
  for (const f of files) {
    readFileSync(f, "utf8").split(/\r?\n/).forEach((line, i) => {
      if (!line.includes("codec_write") || /^\s*(\/\/|\*|\/\*)/.test(line)) return;
      const ok = line.includes('w3.backend.invoke("codec_write"') || f.endsWith("trackedinvoke.ts");
      found.push(`${f.slice(src.length + 1)}:${i + 1} ${ok ? "ok" : "DIRECT"}`);
    });
  }
  assert.ok(found.length >= 9, `the known callers are seen (${found.length})`);
  assert.deepEqual(found.filter((x) => x.endsWith("DIRECT")), []);
});

test("the workbench gives extensions the tracking invoke", () => {
  const wb = readFileSync(join(src, "workbench", "workbench.ts"), "utf8");
  assert.ok(wb.includes("backendInvoke(wb.workspace, command, args)"));
});
