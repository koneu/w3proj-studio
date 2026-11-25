import test from "node:test";
import assert from "node:assert/strict";
import type { Settings } from "../extensions/api";

// GameService with `game.fastTransfer`: the Tauri IPC is a stand-in that answers game_read and game_fast_transfer, and
// `fetch` a stand-in for the app's server (backend fastgame.rs), both counting what is asked.
const stored = new Map<string, Uint8Array>([
  ["units/unitdata.slk", new Uint8Array([1, 2, 3])],
  ["big.dds", Uint8Array.from({ length: 5000 }, (_, i) => (i * 31) & 255)],
]);
const lookup = (path: string) => stored.get(path.replace(/\\/g, "/").toLowerCase());
const ipc: { command: string; args: Record<string, unknown> }[] = [];
const fetched: URL[] = [];
let endpoint: unknown = { port: 50123, token: "0123456789abcdef0123456789abcdef" };
/** How the stand-in server answers: normally, refusing connections, 409 (the install not open there), 500, a body that breaks off. */
let server: "ok" | "down" | "409" | "500" | "broken body" = "ok";
const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.__TAURI_INTERNALS__ = {
  async invoke(command: string, args: Record<string, unknown>) {
    ipc.push({ command, args });
    if (command === "game_fast_transfer") {
      if (endpoint instanceof Error) throw endpoint.message;
      return args.on ? endpoint : null;
    }
    if (command !== "game_read") throw `unexpected ${command}`;
    const bytes = lookup(String(args.path));
    if (!bytes) throw `not found: ${args.path}`;
    return bytes.slice().buffer;
  },
  transformCallback: () => 1, unregisterCallback() {},
};
g.fetch = async (url: string, init: RequestInit) => {
  const u = new URL(url);
  fetched.push(u);
  assert.equal(init.credentials, "omit");
  if (server === "down") throw new TypeError("Failed to fetch");
  if (server === "409") return new Response("that install isn't open", { status: 409 });
  if (server === "500") return new Response("io: busy", { status: 500 });
  const path = u.searchParams.get("path")!;
  const bytes = lookup(path);
  if (!bytes) return new Response(`not found: ${path}`, { status: 404 });
  if (server === "broken body") return { status: 200, arrayBuffer: async () => { throw new TypeError("network error"); } } as unknown as Response;
  return new Response(bytes.slice(), { status: 200 });
};

const { GameService } = await import("./game");

function make(fast: boolean) {
  const values: Record<string, unknown> = { "game.installDir": "C:\\Games\\W3", "game.graphicsMode": "hd", "game.fastTransfer": fast };
  const listeners: ((key: string) => void)[] = [];
  const settings = {
    get: (key: string) => values[key],
    onDidChange: (l: (key: string) => void) => { listeners.push(l); return { dispose() {} }; },
  } as unknown as Settings;
  const set = (key: string, value: unknown) => { values[key] = value; listeners.forEach((l) => l(key)); };
  ipc.length = fetched.length = 0;
  server = "ok";
  endpoint = { port: 50123, token: "0123456789abcdef0123456789abcdef" };
  return { game: new GameService(settings), set };
}

const reads = () => ipc.filter((c) => c.command === "game_read").length;

test("off by default: no server is asked for and nothing is fetched", async () => {
  const { game } = make(false);
  assert.deepEqual([...await game.read("Units\\UnitData.slk")], [1, 2, 3]);
  assert.equal(fetched.length, 0);
  assert.deepEqual(ipc.map((c) => c.command), ["game_read"]);
  assert.equal(game.fastReads, 0);
});

test("on: reads go to the server with its token, the install, mode, tileset and path, and give game_read's bytes", async () => {
  const { game } = make(true);
  const big = await game.read("big.dds", "L");
  assert.deepEqual([...big], [...stored.get("big.dds")!]);
  assert.deepEqual([...await game.read("Units\\UnitData.slk")], [1, 2, 3]);
  assert.equal(reads(), 0, "no game_read");
  assert.equal(game.fastReads, 2);
  assert.equal(ipc.filter((c) => c.command === "game_fast_transfer").length, 1, "the server is asked for once");
  const u = fetched[0];
  assert.equal(u.origin, "http://127.0.0.1:50123");
  assert.equal(u.pathname, "/0123456789abcdef0123456789abcdef/read");
  assert.deepEqual(Object.fromEntries(u.searchParams), { install: "C:\\Games\\W3", mode: "hd", path: "big.dds", tileset: "L" });
  assert.equal(fetched[1].searchParams.get("path"), "Units\\UnitData.slk");
  assert.equal(fetched[1].searchParams.has("tileset"), false);
  // Control: the same reads by game_read give the same bytes.
  const { game: plain } = make(false);
  assert.deepEqual([...await plain.read("big.dds", "L")], [...big]);
});

test("a missing file is an answer: the same error as game_read, remembered, no fallback", async () => {
  const { game } = make(true);
  await assert.rejects(game.read("Units\\Nope.slk"), (e) => e === "not found: Units\\Nope.slk");
  assert.equal(reads(), 0);
  assert.deepEqual(game.backendMisses, ["Units\\Nope.slk"]);
  await assert.rejects(game.read("Units\\Nope.slk"));
  assert.equal(fetched.length, 1, "remembered as missing");
});

test("the port closed or blocked: the read falls back to game_read, and later reads go there straight away", async () => {
  const { game } = make(true);
  server = "down";
  assert.deepEqual([...await game.read("Units\\UnitData.slk")], [1, 2, 3]);
  assert.equal(reads(), 1);
  assert.equal(game.fastFallbacks, 1);
  assert.deepEqual([...await game.read("big.dds")], [...stored.get("big.dds")!]);
  assert.equal(fetched.length, 1, "not tried again");
  assert.equal(reads(), 2);
  // reload tries the server again.
  server = "ok";
  game.reload();
  await game.read("big.dds");
  assert.equal(fetched.length, 2);
  assert.equal(game.fastReads, 1);
});

test("409, 500 or a broken body fall back for that read only; the server is still tried next time", async () => {
  for (const kind of ["409", "500", "broken body"] as const) {
    const { game } = make(true);
    server = kind;
    assert.deepEqual([...await game.read("Units\\UnitData.slk")], [1, 2, 3], kind);
    assert.equal(reads(), 1, kind);
    server = "ok";
    assert.deepEqual([...await game.read("big.dds")], [...stored.get("big.dds")!], kind);
    assert.equal(reads(), 1, `${kind}: the next read used the server`);
    assert.deepEqual([game.fastReads, game.fastFallbacks], [1, 1], kind);
  }
});

test("no server to be had (headless, an old backend): game_read", async () => {
  const { game } = make(true);
  endpoint = new Error("w3proj rebuild has no backend command \"game_fast_transfer\"");
  assert.deepEqual([...await game.read("Units\\UnitData.slk")], [1, 2, 3]);
  assert.equal(fetched.length, 0);
  assert.equal(reads(), 1);
});

test("turning the setting off stops the server and reads go to game_read; on again asks for it again", async () => {
  const { game, set } = make(true);
  await game.read("Units\\UnitData.slk");
  set("game.fastTransfer", false);
  assert.deepEqual(ipc.at(-1), { command: "game_fast_transfer", args: { on: false } });
  game.reload();
  await game.read("Units\\UnitData.slk");
  assert.equal(fetched.length, 1);
  assert.equal(reads(), 1);
  set("game.fastTransfer", true);
  game.reload();
  await game.read("Units\\UnitData.slk");
  assert.equal(fetched.length, 2);
  assert.equal(ipc.filter((c) => c.command === "game_fast_transfer" && c.args.on === true).length, 2);
});
