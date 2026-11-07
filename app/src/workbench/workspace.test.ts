import test from "node:test";
import assert from "node:assert/strict";

// The backend is the Tauri IPC: a stand-in with one file list per project that answers what workspace.ts asks.
type F = { path: string; size: number; modified: number };
const A = "C:\\Users\\Konstantin\\a", B = "C:\\Users\\Konstantin\\b";
const backend = new Map<string, F[]>();
const calls = { projectFiles: 0 };
let gate: Promise<void> | null = null;
let filesGate: Promise<void> | null = null;
let normalizeGate: Promise<void> | null = null;
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
      case "project_files": {
        calls.projectFiles++;
        // What the disk holds when the read starts; a held read answers with that, later.
        const seen = (backend.get(String(args.root)) ?? []).map((f) => ({ ...f }));
        if (filesGate) await filesGate;
        return seen;
      }
      case "project_folders": return [];
      case "fs_stat": {
        const path = String(args.path);
        for (const [root, list] of backend) {
          if (!path.toLowerCase().startsWith(root.toLowerCase() + "\\")) continue;
          const f = list.find((x) => x.path === path.slice(root.length + 1).replace(/\\/g, "/"));
          return f ? { size: f.size, modified: f.modified } : null;
        }
        return null;
      }
      case "path_normalize": if (normalizeGate) await normalizeGate; return String(args.path).replace(/konsta~1/i, "Konstantin");
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
const make = (recent: string[] = [], failSetAfter = Infinity) => {
  const saved: Record<string, unknown> = { recentProjects: recent };
  let sets = 0;
  const ws = new WorkspaceService({ loadProject: async () => {}, get: (k: string, d: unknown) => saved[k] ?? d, set: async (k: string, v: unknown) => { if (++sets > failSetAfter) throw new Error("disk full"); saved[k] = v; } } as never);
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

test("recent projects: another spelling of the opened root isn't listed twice", async () => {
  reset();
  const { ws, saved } = make(["C:\\Users\\KONSTA~1\\a", B, "c:\\users\\konsta~1\\b"]);
  await ws.open(A);
  await ws.recentsTidied();
  assert.deepEqual(saved.recentProjects, [A, B]);
});

/** Holds the next directory reads until the returned function is called. */
const holdReads = () => {
  let release!: () => void;
  filesGate = new Promise<void>((r) => { release = r; });
  return () => { filesGate = null; release(); };
};

test("a file written while externalChanges reads stays listed and isn't reported", async () => {
  reset();
  const { ws } = make();
  await ws.open(A);
  const release = holdReads();
  const checking = ws.externalChanges();
  await new Promise((r) => setTimeout(r, 5));
  await ws.writeText("map/Scripts/x.ai", "// ai"); // the read began before this file existed
  release();
  const changed = await checking;
  assert.equal(changed.size, 0, "not an external change");
  assert.ok(ws.files().some((f) => f.path === "map/Scripts/x.ai"), "still listed");
  assert.equal((await ws.externalChanges()).size, 0, "nor on the next check");
});

test("a file written while refresh reads stays listed, and isn't reported later", async () => {
  reset();
  const { ws } = make();
  await ws.open(A);
  const release = holdReads();
  const refreshing = ws.refresh();
  await new Promise((r) => setTimeout(r, 5));
  await ws.writeText("map/Scripts/x.ai", "// ai");
  release();
  await refreshing;
  assert.ok(ws.files().some((f) => f.path === "map/Scripts/x.ai"), "still listed");
  assert.equal((await ws.externalChanges()).size, 0);
});

test("a write during the read doesn't hide someone else's change from the same read", async () => {
  reset();
  const { ws } = make();
  await ws.open(A);
  backend.get(A)!.push({ path: "by-git.txt", size: 5, modified: 3 });
  const release = holdReads();
  const checking = ws.externalChanges();
  await new Promise((r) => setTimeout(r, 5));
  await ws.writeText("map/Scripts/x.ai", "// ai");
  release();
  assert.deepEqual([...(await checking)], ["by-git.txt"]);
});

const OFFLINE = "//offline/share/p";

test("opening a project doesn't wait for the recent list's paths to be resolved", async () => {
  reset();
  const { ws, saved } = make([B, OFFLINE]);
  let release!: () => void;
  normalizeGate = new Promise<void>((r) => { release = r; });
  const started = Date.now();
  await ws.open(A);
  assert.ok(Date.now() - started < 1000, "the open didn't wait for the disk");
  assert.deepEqual(saved.recentProjects, [A, B, OFFLINE], "listed as saved at once");
  normalizeGate = null;
  release();
  await ws.recentsTidied();
  assert.deepEqual(saved.recentProjects, [A, B, OFFLINE]);
});

test("a change by another program after our own write IS reported (different size)", async () => {
  reset();
  const { ws } = make();
  await ws.open(A);
  await ws.writeText("war3map.j", "// ours");
  const f = backend.get(A)!.find((x) => x.path === "war3map.j")!;
  f.size += 40; f.modified += 1000; // the other program saves, and focus returns
  assert.deepEqual([...(await ws.externalChanges())], ["war3map.j"]);
});

test("a same-size change at a new time after our own write IS reported", async () => {
  reset();
  const { ws } = make();
  await ws.open(A);
  await ws.writeText("war3map.j", "// ours");
  backend.get(A)!.find((x) => x.path === "war3map.j")!.modified += 5;
  assert.deepEqual([...(await ws.externalChanges())], ["war3map.j"]);
});

test("our own write of an existing file isn't reported, and the next check is quiet too", async () => {
  reset();
  const { ws } = make();
  await ws.open(A);
  await ws.writeText("war3map.j", "// ours, longer than before");
  assert.equal((await ws.externalChanges()).size, 0);
  assert.equal((await ws.externalChanges()).size, 0);
});

test("a stale tidy of the recent list (open A, B, A) writes nothing", async () => {
  reset();
  const SHORT_A = "C:\\Users\\KONSTA~1\\a", X = "//x/y/z";
  const { ws, saved } = make([SHORT_A, X]);
  let release!: () => void;
  normalizeGate = new Promise<void>((r) => { release = r; });
  await ws.open(A); // its tidy waits on the disk
  normalizeGate = null;
  await ws.open(B);
  await ws.open(A);
  await ws.recentsTidied();
  assert.deepEqual(saved.recentProjects, [A, B, X]);
  release(); // the first tidy ends now, with a list from before B was opened
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(saved.recentProjects, [A, B, X]);
});

test("a failing save of the tidied recent list is no unhandled rejection", async () => {
  reset();
  const seen: unknown[] = [];
  const on = (e: unknown) => seen.push(e);
  process.on("unhandledRejection", on);
  const { ws } = make(["C:\\Users\\KONSTA~1\\a"], 1); // the open's own save works, the tidy's fails
  await ws.open(A);
  await ws.recentsTidied();
  await new Promise((r) => setTimeout(r, 20));
  process.off("unhandledRejection", on);
  assert.deepEqual(seen, []);
});
