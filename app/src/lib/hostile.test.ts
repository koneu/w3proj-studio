// What a map from a stranger can do to the parsers that run inside the app. A parser may refuse a
// damaged file; it must not hang, or use up the memory, because that takes the whole app down and
// no try/catch helps. So the rounds run in a child process the test can kill: the watchdog is the
// point, a loop in this process would just never come back, and running out of memory ends even a
// worker's whole process.
//
// W3_HOSTILE_SEEDS names a folder of real files (see targetsOf for what's taken from it); without
// it only the made-up seeds below run, as in CI. W3_HOSTILE_ROUNDS is the rounds per seed.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { parseWai } from "./ai/wai";
import { soundDurationMs } from "./audio/duration";
import { parseIni, parseSlk } from "./formats/text";
import { decodeImage } from "./image";
import { encodeBlp1Jpeg } from "./image/encode";
import { checkJass, emptyEnv, envFrom } from "./jass/check";
import { checkLua } from "./lua/check";
import { readLightMdl, readLightMdx } from "./model/dnclight";
import { uploadableLevels } from "./model/gltexture";
import { parseMdx, renameTextures } from "./model/mdx";
import { parseW3e } from "./terrain/w3e";
import { parseTriggerData } from "./triggers/triggerdata";
import { parseWct, parseWctText, parseWtg, writeWtg } from "./triggers/wtg";

/**
 * A single file may use this much processor time; past it the worker is killed and the file
 * reported. Processor time, not the clock: with other gates running the worker is held back, and a
 * parser that needs a second of work then takes many on the clock. A hang still burns it all.
 */
const LIMIT_MS = 4000;
/**
 * A single file may take this long on the clock, whatever the processor time says: a parser that
 * blocks without working (waiting on a lock, a read that never ends) burns none, and the process's
 * processor time still creeps up from the reporting thread itself. Generous, because the clock is
 * what other gates on the machine stretch.
 */
const CASE_WALL_MS = 120000;
/** How often the worker's second thread reports the process's processor time. */
const BEAT_MS = 50;
/** Fails like a hang: a parser that fills the heap takes the app with it. */
const HEAP_MB = 512;
/** Enough to see what's wrong; a parser that fails on everything shouldn't take hours. */
const MAX_FAILURES = 40;

const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
const triggers = parseTriggerData("[TriggerEvents]\nMapInitializationEvent=0,nothing\n[TriggerActions]\nSetVariable=0,AnyGlobal,Null\n");

/** Does what the app does with a file: reading it, then what comes right after. */
const TARGETS: Record<string, (b: Uint8Array) => unknown> = {
  image(b) {
    const m = decodeImage(b);
    if (m.blocks) uploadableLevels(m.blocks);
    for (let i = 0; i < Math.min(m.mipCount, 16); i++) m.mip(i);
  },
  mdx(b) {
    const m = parseMdx(b);
    // As the renderer does.
    Math.max(0, ...m.nodes.map((n, i) => (n ? i : 0)));
    renameTextures(b, (p) => p);
  },
  light(b) { readLightMdx(b); },
  lightText(b) { readLightMdl(latin1(b)); },
  w3e(b) { parseW3e(b); },
  wai(b) { parseWai(b, () => 1); },
  wtg(b) { parseWtg(b, triggers); },
  wct(b) { parseWct(b, 4); },
  wctText(b) { parseWctText(latin1(b)); },
  sound(b) { soundDurationMs(b); },
  jass(b) {
    const s = latin1(b);
    checkJass(s, emptyEnv());
    envFrom([s]);
  },
  lua(b) { checkLua(latin1(b)); },
  slk(b) { parseSlk(latin1(b)); },
  ini(b) { parseIni(latin1(b)); },
  triggerData(b) { parseTriggerData(latin1(b)); },
};

const TEXT = new Set(["lightText", "wctText", "jass", "lua", "slk", "ini", "triggerData"]);

/** Which targets a real file seeds, by its name. */
function targetsOf(name: string): string[] {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (["blp", "tga", "dds"].includes(ext)) return ["image"];
  if (ext === "mdx") return name.startsWith("dnc") ? ["light", "mdx"] : ["mdx"];
  if (ext === "mdl") return ["lightText"];
  if (ext === "wai") return ["wai"];
  if (ext === "w3e") return ["w3e"];
  if (ext === "wtg") return ["wtg"];
  if (ext === "wct") return ["wct"];
  if (["flac", "mp3", "wav", "ogg"].includes(ext)) return ["sound"];
  if (ext === "j") return ["jass"];
  if (ext === "lua") return ["lua"];
  if (ext === "slk") return ["slk"];
  if (ext === "txt") return ["ini", "triggerData"];
  return [];
}

interface Seed { target: string; name: string; bytes: Uint8Array }

function madeUpSeeds(): Seed[] {
  const out: Seed[] = [];
  const add = (target: string, name: string, bytes: Uint8Array) => out.push({ target, name, bytes });
  const text = (s: string) => new TextEncoder().encode(s);

  add("image", "blp jpeg", encodeBlp1Jpeg(16, 16, new Uint8Array(16 * 16 * 4).fill(128), 80, { alpha: true, mipmaps: true }));
  const tga = new Uint8Array(18 + 16);
  tga.set([0, 0, 2], 0); tga.set([2, 0, 2, 0, 32, 8], 12);
  add("image", "tga", tga);
  const blp = new Uint8Array(156 + 1024 + 4);
  blp.set(text("BLP1"), 0);
  new DataView(blp.buffer).setUint32(4, 1, true);
  new DataView(blp.buffer).setUint32(12, 2, true);
  new DataView(blp.buffer).setUint32(16, 2, true);
  new DataView(blp.buffer).setUint32(28, 156 + 1024, true);
  new DataView(blp.buffer).setUint32(92, 4, true);
  add("image", "blp palette", blp);
  const dds = new Uint8Array(128 + 16);
  dds.set(text("DDS "), 0);
  const d = new DataView(dds.buffer);
  d.setUint32(4, 124, true); d.setUint32(12, 4, true); d.setUint32(16, 4, true); d.setUint32(76, 32, true);
  d.setUint32(80, 4, true); dds.set(text("DXT1"), 84);
  add("image", "dds", dds);

  add("w3e", "terrain", w3eSeed());
  add("wtg", "one trigger", writeWtg({
    reforged: true, version: 7, unknown: 2, variables: [],
    counts: Array.from({ length: 8 }, (_, i) => ({ count: i === 3 ? 1 : 0, deleted: [] })),
    items: [{ type: 8, name: "Start", description: "", isComment: 0, id: 3, enabled: true, isCustom: false, initiallyOff: false, runOnInit: true, parent: -1,
      ecas: [{ kind: 0, name: "MapInitializationEvent", enabled: true, params: [], children: [] }] }],
  }));
  const wct = new Uint8Array(64);
  wct.set([4, 0, 0, 0x80, 1, 0, 0, 0], 0);
  add("wct", "empty", wct);
  add("wctText", "script", text("function f takes nothing returns nothing\nendfunction\n"));
  const wai = new Uint8Array(512);
  wai.set([2, 0, 0, 0, 120, 0], 0);
  add("wai", "empty", wai);
  add("mdx", "textures", mdxSeed());
  add("sound", "wav", wavSeed());

  // Files built to do damage, as they are. Each of these stopped the app once.
  const u32 = (b: Uint8Array, at: number, v: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(at, v, true);
  const copy = (b: Uint8Array, change: (c: Uint8Array) => void) => { const c = b.slice(); change(c); return c; };
  add("w3e", "bomb: 4 billion tiles", copy(w3eSeed(), (b) => u32(b, 13, 0xffffffff)));
  add("image", "bomb: DDS of 0 bits with 4 billion mips", copy(dds, (b) => { u32(b, 28, 0xffffffff); u32(b, 80, 0); u32(b, 88, 0); }));
  add("image", "bomb: TGA of 65535×65535", copy(tga, (b) => b.set([255, 255, 255, 255], 12)));
  add("image", "bomb: palettized BLP of 16384×16384", copy(blp, (b) => { u32(b, 12, 16384); u32(b, 16, 16384); }));
  add("mdx", "bomb: a node numbered 2 billion", mdxSeed(0x7ffffff0));
  // An object whose stated size is 0 sent the reader back to where the object began, for ever.
  for (const tag of ["ATCH", "PREM", "CORN"]) add("mdx", `loop: ${tag} object of size 0`, mdxObjectSeed(tag, 0));
  const wai2 = wai.slice();
  new DataView(wai2.buffer).setUint32(14, 0xffffffff, true);
  add("wai", "bomb: 4 billion workers", wai2);
  add("jass", "script", text("globals\n integer a = 1\nendglobals\nfunction f takes integer x returns integer\n if x > 0 then\n  return f(x - 1)\n endif\n return 0\nendfunction\n"));
  add("lua", "script", text("local function f(x)\n  if x > 0 then return f(x - 1) end\n  return { a = 1, [2] = 'x' }\nend\n"));
  add("slk", "table", text("ID;PWXL\nC;Y1;X1;K\"id\"\nC;X2;K\"a\"\nC;Y2;X1;K\"x\"\nC;X2;K1\nE\n"));
  add("ini", "sections", text("[a]\nb=1,2\n[c]\nd=\"x\"\n"));
  add("triggerData", "sections", text("[TriggerActions]\nSetVariable=0,AnyGlobal,Null\n"));
  return out;
}

/** A 2×2 terrain of version 11, one ground and one cliff type. */
function w3eSeed() {
  const b = new Uint8Array(13 + 8 + 8 + 16 + 4 * 7), d = new DataView(b.buffer);
  b.set(new TextEncoder().encode("W3E!"), 0);
  d.setUint32(4, 11, true);
  b[8] = 76;
  d.setUint32(13, 1, true);
  b.set(new TextEncoder().encode("Ldrt"), 17);
  d.setUint32(21, 1, true);
  b.set(new TextEncoder().encode("CLdi"), 25);
  d.setUint32(29, 2, true);
  d.setUint32(33, 2, true);
  return b;
}

/** MDLX, a version, one texture, one bone. */
function mdxSeed(boneId = 0) {
  const b = new Uint8Array(4 + 12 + 8 + 268 + 8 + 104), d = new DataView(b.buffer);
  b.set(new TextEncoder().encode("MDLXVERS"), 0);
  d.setUint32(8, 4, true);
  d.setUint32(12, 800, true);
  b.set(new TextEncoder().encode("TEXS"), 16);
  d.setUint32(20, 268, true);
  b.set(new TextEncoder().encode("a.blp"), 28);
  const bone = 4 + 12 + 8 + 268;
  b.set(new TextEncoder().encode("BONE"), bone);
  d.setUint32(bone + 4, 104, true);
  d.setUint32(bone + 8, 96, true);
  d.setUint32(bone + 8 + 84, boneId, true);
  d.setInt32(bone + 8 + 88, -1, true);
  return b;
}

/** MDLX, a version, and a chunk `tag` of one object that states `size` as its size, holding a node of its own. */
function mdxObjectSeed(tag: string, size: number) {
  const b = new Uint8Array(4 + 12 + 8 + 4 + 96), d = new DataView(b.buffer);
  b.set(new TextEncoder().encode("MDLXVERS"), 0);
  d.setUint32(8, 4, true);
  d.setUint32(12, 800, true);
  b.set(new TextEncoder().encode(tag), 16);
  d.setUint32(20, 4 + 96, true);
  d.setUint32(24, size, true);
  d.setUint32(28, 96, true);
  d.setInt32(28 + 88, -1, true);
  return b;
}

/** A WAV header with its fmt and data chunks. */
function wavSeed() {
  const b = new Uint8Array(44), d = new DataView(b.buffer);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WAVEfmt "), 8);
  d.setUint32(16, 16, true);
  d.setUint32(28, 44100, true);
  b.set(new TextEncoder().encode("data"), 36);
  return b;
}

// --- rounds ---------------------------------------------------------------------------------

const INTERESTING = [0, 1, 2, 0xff, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xffffffff, 0x40000000, 0x01000000];

function random(seed: number) {
  let s = seed >>> 0 || 1;
  return (n: number) => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s % n;
  };
}

/** Damage of the kinds that break parsers: a wrong count, a cut-off end, a repeated piece. */
function damaged(src: Uint8Array, seed: number, text: boolean): Uint8Array {
  const r = random(seed);
  let b: Uint8Array = src.slice();
  for (let i = 1 + r(3); i > 0 && b.length; i--) {
    switch (r(text ? 5 : 4)) {
      case 0:
        for (let k = 1 + r(8); k > 0; k--) b[r(b.length)] = r(256);
        break;
      case 1: {
        if (b.length < 4) break;
        const at = r(b.length - 3), v = INTERESTING[r(INTERESTING.length)];
        new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(at, v, true);
        break;
      }
      case 2:
        b = b.subarray(0, r(b.length));
        break;
      case 3: {
        const from = r(b.length), to = Math.min(b.length, from + 1 + r(256)), at = r(b.length);
        const next = new Uint8Array(b.length + to - from);
        next.set(b.subarray(0, at)); next.set(b.subarray(from, to), at); next.set(b.subarray(at), at + to - from);
        b = next;
        break;
      }
      default: {
        // Text only: one piece many times, for what gets slow with nesting and length.
        const from = r(b.length), piece = b.subarray(from, Math.min(b.length, from + 1 + r(16)));
        const times = 2000 + r(20000), next = new Uint8Array(b.length + piece.length * times);
        next.set(b);
        for (let k = 0; k < times; k++) next.set(piece, b.length + k * piece.length);
        b = next;
      }
    }
  }
  return b;
}

/** Round 0 is the file itself. */
const bytesOf = (seed: Seed, round: number) => round ? damaged(seed.bytes, round * 2654435761, TEXT.has(seed.target)) : seed.bytes;

function allSeeds(): Seed[] {
  const seeds = madeUpSeeds(), dir = process.env.W3_HOSTILE_SEEDS;
  if (dir) for (const name of readdirSync(dir)) {
    for (const target of targetsOf(name)) seeds.push({ target, name, bytes: new Uint8Array(readFileSync(join(dir, name))) });
  }
  return seeds;
}

const ROUNDS = Number(process.env.W3_HOSTILE_ROUNDS ?? 60);

/**
 * The child's second thread. A parser stuck in a loop can't report anything itself, so this thread
 * says every BEAT_MS how much processor time the process has used: "cpu <ms>". When the parser is
 * done it is told (cell 0 is -1), says "done", and ends, and with it the process.
 * (No backslashes in here: it's a string of code for the thread.)
 */
const BEAT_THREAD = `
const { workerData } = require("node:worker_threads");
const { writeSync } = require("node:fs");
const cell = new Int32Array(workerData);
for (;;) {
  Atomics.wait(cell, 1, 0, ${BEAT_MS});
  if (Atomics.load(cell, 0) < 0) break;
  const u = process.cpuUsage();
  writeSync(1, "cpu " + Math.round((u.user + u.system) / 1000) + String.fromCharCode(10));
}
writeSync(1, "done" + String.fromCharCode(10));
`;

const cpuMs = () => {
  const u = process.cpuUsage();
  return Math.round((u.user + u.system) / 1000);
};

/**
 * The child's part: says "ready <cpu ms>" once it has loaded (its start-up isn't charged to the
 * first file), then from `start` on each case's number and the processor time before running it.
 */
function work(start: number) {
  const seeds = allSeeds(), total = seeds.length * ROUNDS;
  const cell = new Int32Array(new SharedArrayBuffer(8));
  new Worker(BEAT_THREAD, { eval: true, workerData: cell.buffer });
  writeSync(1, `ready ${cpuMs()}\n`);
  for (let c = start; c < total; c++) {
    writeSync(1, `${c} ${cpuMs()}\n`);
    const seed = seeds[Math.floor(c / ROUNDS)], round = c % ROUNDS;
    try {
      TARGETS[seed.target](bytesOf(seed, round));
    } catch { /* refusing a damaged file is right */ }
  }
  Atomics.store(cell, 0, -1);
}

interface Failure { seed: string; round: number; what: string }

/** One child from case `start` on: null if it got through them all, or where and how it stopped. */
function runFrom(start: number): Promise<{ at: number; what: string } | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${HEAP_MB}`, fileURLToPath(import.meta.url)], {
      env: { ...process.env, W3_HOSTILE_START: String(start), NODE_TEST_CONTEXT: undefined },
      stdio: ["ignore", "pipe", "ignore"],
    });
    // `since`: the process's processor time when the current case began, null until the child is
    // ready (its start-up has only the clock limit); `begun`: the clock then.
    let at = start, finished = false, begun = Date.now(), tail = "", killed = "", since: number | null = null;
    const kill = (why: string) => { if (!killed) { killed = why; child.kill("SIGKILL"); } };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = (tail + chunk).split("\n");
      tail = lines.pop()!;
      for (const line of lines) {
        const [word, value] = line.split(" ");
        if (word === "done") finished = true;
        else if (word === "cpu") {
          if (since !== null && Number(value) - since > LIMIT_MS) kill(`over ${LIMIT_MS} ms of processor time`);
        } else if (word === "ready") {
          since = Number(value);
          begun = Date.now();
        } else {
          at = Number(word);
          since = Number(value);
          begun = Date.now();
        }
      }
    });
    const watch = setInterval(() => {
      if (Date.now() - begun > CASE_WALL_MS) kill(`over ${CASE_WALL_MS} ms on the clock`);
    }, 500);
    child.on("close", (code) => {
      clearInterval(watch);
      if (finished) resolve(null);
      else resolve({ at, what: killed || `stopped with code ${code}: out of memory, or a crash` });
    });
  });
}

/** Runs all cases; after a child dies, the next one starts behind the case that did it. */
async function run(seeds: Seed[]): Promise<Failure[]> {
  const failures: Failure[] = [], total = seeds.length * ROUNDS;
  for (let start = 0; start < total;) {
    const end = await runFrom(start);
    if (!end) break;
    const s = seeds[Math.floor(end.at / ROUNDS)];
    failures.push({ seed: `${s.target}: ${s.name}`, round: end.at % ROUNDS, what: end.what });
    if (failures.length >= MAX_FAILURES) break;
    start = end.at + 1;
  }
  return failures;
}

if (process.env.W3_HOSTILE_CASE) {
  // To look at one failure: W3_HOSTILE_CASE="mdx: tree.mdx#2975", as the failure names it.
  const [name, round] = process.env.W3_HOSTILE_CASE.split("#");
  const seed = allSeeds().find((s) => `${s.target}: ${s.name}` === name)!;
  TARGETS[seed.target](bytesOf(seed, Number(round)));
} else if (process.env.W3_HOSTILE_START !== undefined) {
  work(Number(process.env.W3_HOSTILE_START));
} else {
  const seeds = allSeeds();
  test(`damaged files can't hang the app (${seeds.length} seeds, ${ROUNDS} rounds each)`, async () => {
    assert.deepEqual(await run(seeds), []);
  });
}
