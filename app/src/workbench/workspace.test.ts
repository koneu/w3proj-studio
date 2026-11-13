import test from "node:test";
import assert from "node:assert/strict";

// The backend is the Tauri IPC: a stand-in with one file list per project that answers what workspace.ts asks.
type F = { path: string; size: number; modified: number };
const A = "C:\\Users\\Konstantin\\a", B = "C:\\Users\\Konstantin\\b";
const backend = new Map<string, F[]>();
const calls = { projectFiles: 0 };
let gate: Promise<void> | null = null;
let filesGate: Promise<void> | null = null;
/** The directory reads fail. */
let failFiles = false;
let normalizeGate: Promise<void> | null = null;
/** Answers for a file written at once: what the listing then has. */
const holds = new Map<string, Promise<void>>();
/** Entries whose listing lags: the directory shows these values, the file itself has the true ones. */
const listingLag = new Map<string, { size: number; modified: number }>();
/** A write lands: the file has this size, and a time that follows from it. */
const land = (path: string, size: number) => {
  const p = path.replace(/\\/g, "/");
  for (const [root, list] of backend) {
    const r = root.replace(/\\/g, "/");
    if (!p.toLowerCase().startsWith(r.toLowerCase() + "/")) continue;
    const rel = p.slice(r.length + 1), stamp = { size, modified: 100 * size }, f = list.find((x) => x.path === rel);
    if (f) Object.assign(f, stamp); else list.push({ path: rel, ...stamp });
    return stamp;
  }
  return { size, modified: 100 * size };
};
const reset = () => {
  holds.clear();
  listingLag.clear();
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
        const seen = (backend.get(String(args.root)) ?? []).map((f) => ({ ...f, ...listingLag.get(f.path) }));
        if (filesGate) await filesGate;
        if (failFiles) throw "the folder can't be read";
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
        const stamp = land(String(args.path), String(args.text).length);
        const hold = holds.get(String(args.text));
        if (hold) await hold; // the write has landed, its answer comes late
        return stamp;
      }
      case "codec_write": return land(`${String(args.root)}/${String(args.path)}`, String(args.text).length);
      case "fs_write_bytes": return land(decodeURIComponent(options!.headers!.path), (args as unknown as Uint8Array).length);
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

test("with no project open, a full path still resolves (the settings file on Linux); a project path doesn't", () => {
  const { ws } = make();
  assert.equal(ws.resolve("C:\\Users\\u\\settings.json"), "C:\\Users\\u\\settings.json");
  assert.equal(ws.resolve("/home/u/.config/dev.w3proj.studio/settings.json"), "/home/u/.config/dev.w3proj.studio/settings.json");
  assert.throws(() => ws.resolve("map/war3map.j"), /no project is open/);
});

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

test("recent projects on Linux: folders that differ only in case are two projects, both kept", async () => {
  reset();
  const lower = "/home/u/maps/turtle", upper = "/home/u/maps/Turtle", other = "/home/u/maps/a\\b";
  backend.set(upper, []);
  const { ws, saved } = make([lower, "/home/u/maps/a/b", other, upper]);
  await ws.open(upper);
  await ws.recentsTidied();
  assert.deepEqual(saved.recentProjects, [upper, lower, "/home/u/maps/a/b", other]);
  // Control: the same root again is listed once, and on Windows case doesn't count.
  await ws.open(upper);
  await ws.recentsTidied();
  assert.deepEqual(saved.recentProjects, [upper, lower, "/home/u/maps/a/b", other]);
  const win = make([A.toUpperCase(), A.replace(/\\/g, "/")]);
  await win.ws.open(A);
  await win.ws.recentsTidied();
  assert.deepEqual(win.saved.recentProjects, [A]);
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

test("right after an open the project is there before its file list: filesReady waits for the list, files() is never the last project's", async () => {
  reset();
  const { ws } = make();
  await ws.open(B);
  const release = holdReads();
  const opening = ws.open(A);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ws.project()?.root, A, "the project is there");
  assert.equal(ws.filesComplete(), false);
  assert.deepEqual(ws.files(), [], "not B's files under A");
  let ready = false;
  const waiting = ws.filesReady().then(() => { ready = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ready, false, "waits while the list is read");
  release();
  await waiting;
  assert.deepEqual(ws.files().map((f) => f.path), ["war3map.j"], "every file listed once it resolves");
  assert.equal(ws.filesComplete(), true);
  await opening;
  await ws.filesReady(); // at once now
});

test("filesReady: a switch while the list is read waits for the new project's; a list that can't be read rejects; none open rejects", async () => {
  reset();
  const { ws } = make();
  const release = holdReads();
  const first = ws.open(A);
  await new Promise((r) => setTimeout(r, 5));
  const waiting = ws.filesReady();
  const second = ws.open(B);
  release();
  await waiting;
  assert.equal(ws.project()?.root, B);
  assert.deepEqual(ws.files().map((f) => f.path), ["other.txt"], "B's list, not A's late one");
  await Promise.all([first, second]);
  assert.deepEqual(ws.files().map((f) => f.path), ["other.txt"], "A's late list doesn't land on B");
  failFiles = true;
  try {
    await assert.rejects(ws.open(A));
    assert.equal(ws.filesComplete(), false);
    await assert.rejects(ws.filesReady(), /file list couldn't be read/);
  } finally {
    failFiles = false;
  }
  ws.close();
  await assert.rejects(ws.filesReady(), /No project is open/);
});

test("externalChanges while the first list after an open is read: it waits for it, and nothing is reported as changed", async () => {
  reset();
  const { ws } = make();
  backend.get(A)!.push({ path: "map/war3map.w3i", size: 9, modified: 9 });
  const release = holdReads();
  const opening = ws.open(A);
  await new Promise((r) => setTimeout(r, 5));
  let fired = 0;
  ws.onDidChange.on(() => fired++);
  const check = ws.externalChanges();
  await new Promise((r) => setTimeout(r, 5));
  release();
  assert.deepEqual([...(await check)], [], "the files the open is reading are no outside changes");
  await opening;
  assert.deepEqual(ws.files().map((f) => f.path).sort(), ["map/war3map.w3i", "war3map.j"]);
  // A real change afterwards still is one.
  backend.get(A)!.push({ path: "by-git.txt", size: 5, modified: 3 });
  assert.deepEqual([...(await ws.externalChanges())], ["by-git.txt"]);
  assert.ok(fired >= 1);
});

test("externalChanges after an open whose list couldn't be read: no \"before\", so nothing is reported; the list is read", async () => {
  reset();
  const { ws } = make();
  failFiles = true;
  try {
    await assert.rejects(ws.open(A));
  } finally {
    failFiles = false;
  }
  let fired = 0;
  ws.onDidChange.on(() => fired++);
  assert.deepEqual([...(await ws.externalChanges())], []);
  assert.deepEqual(ws.files().map((f) => f.path), ["war3map.j"]);
  assert.equal(ws.filesComplete(), true);
  assert.equal(fired, 1, "the Explorer is told the list is there");
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

const { backendInvoke } = await import("./trackedinvoke");
/** What another program does: the file has other contents; both the listing and the file show it. */
const outside = (path: string, size: number, modified: number) => {
  const f = backend.get(A)!.find((x) => x.path === path)!;
  Object.assign(f, { size, modified });
};

test("a save through codec_write (w3.backend.invoke) isn't reported on focus; a later outside change is", async () => {
  reset();
  const { ws } = make();
  await ws.open(A);
  const out = await backendInvoke<{ size: number }>(ws, "codec_write", { root: A, path: "war3map.j", text: "0123456789" });
  assert.equal(out.size, 10, "the caller still gets the backend's answer");
  assert.equal((await ws.externalChanges()).size, 0, "our own save");
  await backendInvoke(ws, "codec_write", { root: A, path: "map/new.doo", text: "abc" });
  assert.equal((await ws.externalChanges()).size, 0, "a new file made by it");
  assert.ok(ws.files().some((f) => f.path === "map/new.doo"));
  await backendInvoke(ws, "codec_write", { root: A, path: "war3map.j", text: "again!" });
  outside("war3map.j", 6, 123456); // the same size, another time
  assert.deepEqual([...(await ws.externalChanges())], ["war3map.j"]);
});

test("overlapping writes to one file: the one that started last keeps the last word", async () => {
  reset();
  const { ws } = make();
  await ws.open(A);
  let release!: () => void;
  holds.set("A", new Promise<void>((r) => { release = r; }));
  const first = ws.writeText("war3map.j", "A"); // lands first, answers last
  await new Promise((r) => setTimeout(r, 5));
  await ws.writeText("war3map.j", "BB"); // lands last
  release();
  await first;
  assert.equal((await ws.externalChanges()).size, 0, "the file is what the later write left");
  outside("war3map.j", 7, 777);
  assert.deepEqual([...(await ws.externalChanges())], ["war3map.j"], "and a change after both is seen");
});

test("a write under way counts as ours", async () => {
  reset();
  const { ws } = make();
  await ws.open(A);
  let release!: () => void;
  holds.set("AAAA", new Promise<void>((r) => { release = r; }));
  const writing = ws.writeText("war3map.j", "AAAA");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await ws.externalChanges()).size, 0, "the file already has the new contents, the answer isn't here yet");
  release();
  await writing;
});

test("a listing that lags behind the file doesn't make our own save look like an outside change", async () => {
  reset();
  const { ws } = make();
  await ws.open(A);
  await ws.writeText("war3map.j", "12345");
  listingLag.set("war3map.j", { size: 5, modified: 3 }); // the directory entry hasn't caught up with the file
  assert.equal((await ws.externalChanges()).size, 0);
  listingLag.clear();
  assert.equal((await ws.externalChanges()).size, 0, "nor when the listing catches up");
  await ws.writeText("war3map.j", "1234567");
  listingLag.set("war3map.j", { size: 3, modified: 3 });
  outside("war3map.j", 3, 3); // but when the file itself is not what we left, it is reported
  assert.deepEqual([...(await ws.externalChanges())], ["war3map.j"]);
});

/** A Linux project (its file system tells case apart) with two files that differ only in case. */
const LINUX_ROOT = "/home/u/maps/p";

test("on a case-sensitive file system two files that differ only in case are two files: a write to one isn't the other's", async () => {
  reset();
  backend.set(LINUX_ROOT, [{ path: "map/A.txt", size: 1, modified: 1 }, { path: "map/a.txt", size: 2, modified: 2 }]);
  const { ws } = make();
  await ws.open(LINUX_ROOT);
  await ws.writeText("map/a.txt", "hello");
  const entry = (p: string) => ws.files().find((f) => f.path === p);
  assert.deepEqual([entry("map/A.txt")?.size, entry("map/a.txt")?.size], [1, 5], "the written file's entry has the write, the other keeps its own");
  assert.equal((await ws.externalChanges()).size, 0, "our own write (control)");
  // Someone else changes the other one: that is reported, under its own name.
  Object.assign(backend.get(LINUX_ROOT)!.find((f) => f.path === "map/A.txt")!, { size: 9, modified: 900 });
  assert.deepEqual([...(await ws.externalChanges())], ["map/A.txt"]);
  assert.equal(ws.key("map/A.txt"), "map/A.txt", "the key editors match tabs by keeps the case");
  backend.delete(LINUX_ROOT);
});

test("on Windows a file's key ignores case, as its file system does", async () => {
  reset();
  const { ws } = make();
  await ws.open(A);
  assert.equal(ws.key("Map\\War3Map.J"), "map/war3map.j");
  await ws.writeText("WAR3MAP.J", "12345");
  assert.deepEqual(ws.files().map((f) => [f.path, f.size]), [["war3map.j", 5]], "the one file, by another spelling");
});
