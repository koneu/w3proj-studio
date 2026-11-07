import test from "node:test";
import assert from "node:assert/strict";

// The backend is the Tauri IPC: a stand-in with one file list per project that answers what workspace.ts asks.
type F = { path: string; size: number; modified: number };
const A = "C:\\Users\\Konstantin\\a", B = "C:\\Users\\Konstantin\\b";
const backend = new Map<string, F[]>();
const calls = { projectFiles: 0 };
let gate: Promise<void> | null = null;
const reset = () => {
  backend.set(A, [{ path: "war3map.j", size: 1, modified: 1 }]);
  backend.set(B, [{ path: "other.txt", size: 1, modified: 1 }]);
  calls.projectFiles = 0;
  gate = null;
};
const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.__TAURI_INTERNALS__ = {
  async invoke(command: string, args: Record<string, unknown>, options?: { headers?: Record<string, string> }) {
    switch (command) {
      case "project_open": return { root: args.path, name: "p" };
      case "project_files": calls.projectFiles++; return (backend.get(String(args.root)) ?? []).map((f) => ({ ...f }));
      case "project_folders": return [];
      case "path_normalize": return String(args.path).replace(/konsta~1/i, "Konstantin");
      case "fs_write_text": {
        if (gate) await gate;
        const path = String(args.path);
        for (const [root, list] of backend) {
          if (path.toLowerCase().startsWith(root.toLowerCase() + "\\")) {
            const rel = path.slice(root.length + 1).replace(/\\/g, "/");
            if (!list.some((f) => f.path === rel)) list.push({ path: rel, size: String(args.text).length, modified: 2 });
          }
        }
        return;
      }
      case "fs_write_bytes": {
        const path = decodeURIComponent(options!.headers!.path);
        for (const [root, list] of backend) {
          if (path.toLowerCase().startsWith(root.toLowerCase() + "\\")) list.push({ path: path.slice(root.length + 1).replace(/\\/g, "/"), size: (args as unknown as Uint8Array).length, modified: 2 });
        }
        return;
      }
      default: throw `unexpected ${command}`;
    }
  },
  transformCallback: () => 1, unregisterCallback() {},
};

const { WorkspaceService } = await import("./workspace");
const make = (recent: string[] = []) => {
  const saved: Record<string, unknown> = { recentProjects: recent };
  const ws = new WorkspaceService({ loadProject: async () => {}, get: (k: string, d: unknown) => saved[k] ?? d, set: async (k: string, v: unknown) => { saved[k] = v; } } as never);
  return { ws, saved };
};

test("a new file written into the project is listed at once, alone, and isn't an external change", async () => {
  reset();
  const { ws } = make();
  await ws.open(A);
  const reads = calls.projectFiles;
  let changed = 0;
  ws.onDidChange.on(() => changed++);
  await ws.writeText("map/Scripts/x.ai", "// ai");
  await new Promise((r) => setTimeout(r, 5)); // a refresh started by the write would be done by now
  assert.ok(ws.files().some((f) => f.path === "map/Scripts/x.ai"), "listed");
  assert.equal(calls.projectFiles, reads, "the project isn't walked again");
  assert.equal(changed, 1, "the Explorer is told");
  assert.equal((await ws.externalChanges()).size, 0, "our own write");
  await ws.writeBytes("map/Scripts/y.bin", new Uint8Array([1, 2, 3]));
  assert.equal(ws.files().find((f) => f.path === "map/Scripts/y.bin")?.size, 3);
});

test("a write doesn't hide what someone else changed meanwhile", async () => {
  reset();
  const { ws } = make();
  await ws.open(A);
  backend.get(A)!.push({ path: "by-git.txt", size: 5, modified: 3 });
  await ws.writeText("map/Scripts/x.ai", "// ai");
  await new Promise((r) => setTimeout(r, 5)); // a refresh started by the write would be done by now
  assert.deepEqual([...(await ws.externalChanges())], ["by-git.txt"]);
});

test("files outside the project, or in folders the list never has, aren't listed", async () => {
  reset();
  const { ws } = make();
  await ws.open(A);
  for (const p of ["D:\\elsewhere\\y.ai", "build/z.w3x", ".git/config", "node_modules/m.js"]) await ws.writeText(p, "z");
  assert.deepEqual(ws.files().map((f) => f.path), ["war3map.j"]);
  await ws.writeText("map/build/ok.txt", "z");
  assert.ok(ws.files().some((f) => f.path === "map/build/ok.txt"), "only the top-level folder is skipped");
});

test("a write that ends after a project switch leaves the new project alone", async () => {
  reset();
  const { ws } = make();
  await ws.open(A);
  let release!: () => void;
  gate = new Promise<void>((r) => { release = r; });
  const pending = ws.writeText("map/Scripts/x.ai", "// ai");
  await ws.open(B);
  gate = null;
  release();
  await pending;
  assert.deepEqual(ws.files().map((f) => f.path), ["other.txt"]);
  // The same path made by someone else in B is still noticed: nothing of A's write counts as B's own.
  backend.get(B)!.push({ path: "map/Scripts/x.ai", size: 9, modified: 5 });
  assert.deepEqual([...(await ws.externalChanges())], ["map/scripts/x.ai"]);
});
