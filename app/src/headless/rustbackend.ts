// The app's backend in a test: Tauri's IPC (`window.__TAURI_INTERNALS__.invoke`, which `@tauri-apps/api` calls) goes
// to `w3proj serve-backend <project>`, which answers with the same Rust as the app and `w3proj rebuild`
// (crates/backend, crates/cli/src/rebuild.rs Server), over the framed pipe of src/headless/ipc.ts. For tests whose
// point is the app's code over the real backend (a split terrain's flat files are the backend's: flatview.rs), where a
// fake backend in JavaScript would only prove the fake.
//
// The CLI: W3PROJ_BIN when set (the gate's corpus tier: the release build), else this checkout's debug build, made
// with cargo first (a no-op when it's up to date).

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { frame, FrameReader } from "./ipc";
import { repoPath } from "../lib/testhelpers/testutil";

let built: string | null = null;

/** The w3proj CLI to run (see the file's comment). */
export function cliBinary(): string {
  if (process.env.W3PROJ_BIN) return process.env.W3PROJ_BIN;
  if (built) return built;
  const repo = dirname(dirname(dirname(repoPath("crates", "cli", "Cargo.toml"))));
  const r = spawnSync("cargo", ["build", "--quiet", "--locked", "-p", "w3proj-cli", "--message-format=json"], { cwd: repo, encoding: "utf8", maxBuffer: 1 << 28, timeout: 30 * 60_000 });
  if (r.status !== 0) throw new Error(`cargo build -p w3proj-cli failed (${r.status ?? r.error}): ${r.stderr}`);
  for (const line of r.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const m = JSON.parse(line) as { reason?: string; target?: { kind?: string[]; name?: string }; executable?: string | null };
    if (m.reason === "compiler-artifact" && m.target?.kind?.includes("bin") && m.target.name === "w3proj" && m.executable) built = m.executable;
  }
  if (!built) throw new Error("cargo built w3proj-cli but named no w3proj executable");
  return built;
}

interface Server { root: string; child: ChildProcessWithoutNullStreams; pending: Map<number, { resolve(v: unknown): void; reject(e: unknown): void }> }

let next = 1;

/** The backend for a test: one `serve-backend` per project (`serve(root)`), each command sent to the one whose project
 *  holds its path (or root); `stop()` ends them all. Installs itself as Tauri's IPC. */
export function rustBackend() {
  const servers: Server[] = [];
  const bin = cliBinary();
  const norm = (p: string) => p.replace(/\\/g, "/");
  const serverFor = (args: Record<string, unknown>): Server => {
    const at = norm(String(args.root ?? args.path ?? args.from ?? ""));
    const s = servers.find((x) => at === norm(x.root) || at.startsWith(norm(x.root) + "/")) ?? servers[servers.length - 1];
    if (!s) throw new Error("no project is served (rustBackend().serve(root) first)");
    return s;
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.window ??= globalThis;
  g.__TAURI_INTERNALS__ = {
    invoke(cmd: string, args: unknown, options?: { headers?: Record<string, string> }) {
      let msg: Record<string, unknown>, body: Uint8Array | undefined, route: Record<string, unknown>;
      const id = next++;
      if (args instanceof Uint8Array) {
        // A raw body (fs_write_bytes): its other arguments come as headers.
        route = Object.fromEntries(Object.entries(options?.headers ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]));
        msg = { id, cmd, args: route };
        body = args;
      } else {
        route = (args ?? {}) as Record<string, unknown>;
        msg = { id, cmd, args: route };
      }
      const s = serverFor(route);
      return new Promise((resolve, reject) => {
        s.pending.set(id, { resolve, reject });
        s.child.stdin.write(frame(msg, body));
      });
    },
    transformCallback: () => 1, unregisterCallback() {}, convertFileSrc: (p: string) => p,
  };
  return {
    /** Starts a backend for the project at `root` (absolute). */
    serve(root: string) {
      const child = spawn(bin, ["serve-backend", root], { stdio: ["pipe", "pipe", "pipe"] });
      const s: Server = { root, child, pending: new Map() };
      let stderr = "";
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
      const reader = new FrameReader((m, b) => {
        const p = s.pending.get(Number(m.id));
        if (!p) return;
        s.pending.delete(Number(m.id));
        if (typeof m.err === "string") p.reject(m.err);
        else if (b) p.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
        else p.resolve(m.ok);
      });
      child.stdout.on("data", (c: Buffer) => reader.push(c));
      child.on("exit", (code) => {
        for (const p of s.pending.values()) p.reject(`w3proj serve-backend ended (${code}): ${stderr}`);
        s.pending.clear();
      });
      servers.push(s);
    },
    /** Ends every backend started. */
    async stop() {
      await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.child.on("exit", () => r()); s.child.stdin.end(); })));
    },
  };
}
