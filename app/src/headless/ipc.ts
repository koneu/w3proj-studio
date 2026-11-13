// The app's backend, for its own code running in Node without the app (`w3proj rebuild`): Tauri's IPC
// (`window.__TAURI_INTERNALS__.invoke`, which `@tauri-apps/api` calls) goes over this process's stdin and stdout to
// the w3proj CLI that started it, which answers each command with the same Rust as the app (crates/backend).
//
// The pipe, one message per frame: a JSON line, then as many raw bytes as its `len` says (binary bodies and answers
// go as they are, not as JSON number arrays).
//   to the CLI    {"id":1,"cmd":"game_read","args":{…}}       {"id":2,"cmd":"fs_write_bytes","args":{"path":…},"len":N}
//                 {"done":{…}}                                  (the job's report; the CLI prints it)
//   from the CLI  {"id":1,"len":N} + N bytes                    {"id":2,"ok":<JSON>}      {"id":3,"err":"message"}
//
// stdout belongs to the pipe: console output goes to stderr instead (see `install`).

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** Splits a byte stream into frames: a JSON line, then `len` raw bytes when it has one. */
export class FrameReader {
  private buf = Buffer.alloc(0);
  private head: { msg: Record<string, unknown>; len: number } | null = null;

  constructor(private onFrame: (msg: Record<string, unknown>, body: Uint8Array | null) => void) {}

  push(chunk: Uint8Array) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (!this.head) {
        const nl = this.buf.indexOf(10);
        if (nl < 0) return;
        const msg = JSON.parse(this.buf.subarray(0, nl).toString("utf8")) as Record<string, unknown>;
        this.buf = this.buf.subarray(nl + 1);
        const len = typeof msg.len === "number" ? msg.len : -1;
        if (len < 0) { this.onFrame(msg, null); continue; }
        this.head = { msg, len };
      }
      if (this.buf.length < this.head.len) return;
      const body = new Uint8Array(this.buf.subarray(0, this.head.len));
      this.buf = this.buf.subarray(this.head.len);
      const { msg } = this.head;
      this.head = null;
      this.onFrame(msg, body);
    }
  }
}

/** One frame as bytes. */
export function frame(msg: Record<string, unknown>, body?: Uint8Array): Uint8Array {
  const head = Buffer.from(`${JSON.stringify(body ? { ...msg, len: body.length } : msg)}\n`, "utf8");
  return body ? Buffer.concat([head, body]) : head;
}

let next = 1;
const pending = new Map<number, Pending>();

/** Sends a command to the CLI; resolves with its answer (an ArrayBuffer for binary ones), rejects with its error text,
 *  as Tauri's invoke does. */
export function call(cmd: string, args: unknown, options?: { headers?: Record<string, string> }): Promise<unknown> {
  const id = next++;
  let msg: Record<string, unknown>, body: Uint8Array | undefined;
  if (args instanceof Uint8Array) {
    // A raw body (fs_write_bytes): its other arguments come as headers.
    const headers = Object.fromEntries(Object.entries(options?.headers ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]));
    msg = { id, cmd, args: headers };
    body = args;
  } else {
    msg = { id, cmd, args: args ?? {} };
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.stdout.write(frame(msg, body));
  });
}

/** The job's report to the CLI; the process ends once it is written. */
export function finish(report: unknown): Promise<never> {
  return new Promise(() => process.stdout.write(frame({ done: report }), () => process.exit(0)));
}

/** Takes over Tauri's IPC and stdout. Before anything calls the backend. */
export function install() {
  const reader = new FrameReader((msg, body) => {
    const p = pending.get(Number(msg.id));
    if (!p) return;
    pending.delete(Number(msg.id));
    if (typeof msg.err === "string") p.reject(msg.err);
    else if (body) p.resolve(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    else p.resolve(msg.ok);
  });
  process.stdin.on("data", (c: Buffer) => reader.push(c));
  // The CLI went away: nothing can be answered any more.
  process.stdin.on("end", () => {
    for (const p of pending.values()) p.reject("the w3proj CLI closed the pipe");
    pending.clear();
  });
  const toStderr = (...a: unknown[]) => { process.stderr.write(`${a.map((x) => (typeof x === "string" ? x : String(x))).join(" ")}\n`); };
  console.log = console.info = console.warn = console.error = console.debug = toStderr;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window ??= globalThis;
  g.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: unknown, options?: { headers?: Record<string, string> }) => call(cmd, args, options),
    transformCallback: () => 0,
    unregisterCallback: () => {},
    convertFileSrc: (p: string) => p,
  };
}
