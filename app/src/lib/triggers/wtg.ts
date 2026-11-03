// war3map.wtg (GUI triggers) and war3map.wct (custom script text).
//
// Reforged (marker 0x80000004, version 7) — all files of the game's 3.0 maps:
//   "WTG!", marker, version, 8 × (count, deleted count, deleted ids…) per item
//   type, u32 (2), variables, item count, items.
//   Variable: name, type, u32 (1), is array, array size, initialized,
//             initial value, id, parent id.
//   Item: u32 type, then
//     1 map / 2 library / 4 category: id, name, is comment, expanded, parent
//     8 trigger / 16 comment / 32 script: name, description, is comment, id,
//             enabled, custom text, initially off, run on init, parent, ECAs
//     64 variable: id, name, parent
// Classic (version 4 = Reign of Chaos, 7 = The Frozen Throne):
//   "WTG!", version, categories (index, name[, is comment]), u32 (2),
//   variables (name, type, u32, is array[, size], initialized, value),
//   triggers (name, description[, is comment], enabled, custom text,
//   initially off, run on init, category index, ECAs).
// ECA: kind (0 event, 1 condition, 2 action)[, branch for children], name,
//   enabled, parameters (count from TriggerData), [v7: child count, children].
// Parameter: type (-1 invalid, 0 preset, 1 variable, 2 function, 3 string),
//   value, has call [kind, name, has params, params, (v7) u32], has index [param].
//
// war3map.wct, Reforged: marker, version 1, comment, header script
// (length + text), then length + text for each GUI trigger (no count).
// Classic: version (0/1), [comment, header script,] count, texts.

import type { TriggerData } from "./triggerdata";

export interface Param {
  type: number;
  value: string;
  call?: Call;
  index?: Param;
}
export interface Call {
  kind: number;
  name: string;
  hasParams: boolean;
  params: Param[];
  /** v7: a u32 after the call (0 in all samples). */
  trailer?: number;
}
export interface Eca {
  kind: number;
  /** Children only: the branch they belong to (if/then/else: 0 if, 1 then, 2 else). */
  group?: number;
  name: string;
  enabled: boolean;
  params: Param[];
  children: Eca[];
}
export interface Variable {
  name: string;
  type: string;
  unknown: number;
  isArray: boolean;
  arraySize: number;
  initialized: boolean;
  initialValue: string;
  id: number;
  parent: number;
}
export type Item =
  | { type: 1 | 2 | 4; id: number; name: string; isComment: number; expanded: number; parent: number }
  | { type: 8 | 16 | 32; name: string; description: string; isComment: number; id: number; enabled: boolean; isCustom: boolean;
      initiallyOff: boolean; runOnInit: boolean; parent: number; ecas: Eca[] }
  | { type: 64; id: number; name: string; parent: number };
export type TriggerItem = Extract<Item, { type: 8 | 16 | 32 }>;

export interface TriggerFile {
  reforged: boolean;
  version: number;
  /** Reforged: per item type, how many exist and which ids were deleted. */
  counts: { count: number; deleted: number[] }[];
  /** The u32 after the counts / categories (2 in all samples). */
  unknown: number;
  variables: Variable[];
  /** Classic files are converted: categories become items (type 4, id = index), triggers point to them. */
  items: Item[];
}

const MARKER = 0x80000004;
const td = new TextDecoder();
const te = new TextEncoder();

class Reader {
  o = 0;
  private dv: DataView;
  constructor(private b: Uint8Array) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  i32() { const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
  str() {
    const e = this.b.indexOf(0, this.o);
    if (e < 0) throw new Error(`unterminated string at ${this.o}`);
    const s = td.decode(this.b.subarray(this.o, e));
    this.o = e + 1;
    return s;
  }
  bytes(n: number) { const s = this.b.subarray(this.o, this.o + n); this.o += n; return s; }
  get done() { return this.o >= this.b.length; }
}

class Writer {
  private parts: Uint8Array[] = [];
  private len = 0;
  private push(p: Uint8Array) { this.parts.push(p); this.len += p.length; }
  u32(v: number) { const p = new Uint8Array(4); new DataView(p.buffer).setUint32(0, v >>> 0, true); this.push(p); return this; }
  i32(v: number) { const p = new Uint8Array(4); new DataView(p.buffer).setInt32(0, v, true); this.push(p); return this; }
  str(s: string) { this.push(te.encode(s)); this.push(new Uint8Array(1)); return this; }
  bytes(b: Uint8Array) { this.push(b); return this; }
  done() { const out = new Uint8Array(this.len); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.length; } return out; }
}

function argCount(data: TriggerData, kind: number, name: string): number {
  const f = data.find(kind, name);
  if (!f) throw new Error(`unknown trigger function "${name}" (not in TriggerData.txt)`);
  return f.args.length;
}

function readParam(r: Reader, data: TriggerData, v7: boolean): Param {
  const p: Param = { type: r.i32(), value: r.str() };
  if (r.u32()) {
    const kind = r.u32(), name = r.str(), hasParams = r.u32() !== 0;
    const params = hasParams ? Array.from({ length: argCount(data, kind, name) }, () => readParam(r, data, v7)) : [];
    p.call = { kind, name, hasParams, params, ...(v7 ? { trailer: r.u32() } : {}) };
  }
  if (r.u32()) p.index = readParam(r, data, v7);
  return p;
}

function readEca(r: Reader, data: TriggerData, v7: boolean, child: boolean): Eca {
  const kind = r.u32();
  const group = child ? r.u32() : undefined;
  const name = r.str(), enabled = r.u32() !== 0;
  const params = Array.from({ length: argCount(data, kind, name) }, () => readParam(r, data, v7));
  const children = v7 ? Array.from({ length: r.u32() }, () => readEca(r, data, v7, true)) : [];
  return { kind, ...(group !== undefined ? { group } : {}), name, enabled, params, children };
}

export function parseWtg(buf: Uint8Array, data: TriggerData): TriggerFile {
  const r = new Reader(buf);
  if (td.decode(r.bytes(4)) !== "WTG!") throw new Error("not a trigger file (missing WTG! header)");
  const first = r.u32();
  if (first === MARKER) {
    const version = r.u32();
    const counts = Array.from({ length: 8 }, () => {
      const count = r.u32(), n = r.u32();
      return { count, deleted: Array.from({ length: n }, () => r.u32()) };
    });
    const unknown = r.u32();
    const variables = Array.from({ length: r.u32() }, (): Variable => ({
      name: r.str(), type: r.str(), unknown: r.u32(), isArray: r.u32() !== 0, arraySize: r.u32(), initialized: r.u32() !== 0,
      initialValue: r.str(), id: r.u32(), parent: r.i32(),
    }));
    const items = Array.from({ length: r.u32() }, (): Item => {
      const type = r.u32();
      if (type === 1 || type === 2 || type === 4) return { type, id: r.u32(), name: r.str(), isComment: r.u32(), expanded: r.u32(), parent: r.i32() };
      if (type === 8 || type === 16 || type === 32) {
        const name = r.str(), description = r.str(), isComment = r.u32(), id = r.u32();
        const enabled = r.u32() !== 0, isCustom = r.u32() !== 0, initiallyOff = r.u32() !== 0, runOnInit = r.u32() !== 0, parent = r.i32();
        const ecas = Array.from({ length: r.u32() }, () => readEca(r, data, true, false));
        return { type, name, description, isComment, id, enabled, isCustom, initiallyOff, runOnInit, parent, ecas };
      }
      if (type === 64) return { type, id: r.u32(), name: r.str(), parent: r.i32() };
      throw new Error(`unknown trigger item type ${type} at ${r.o - 4}`);
    });
    if (!r.done) throw new Error(`${buf.length - r.o} bytes after the trigger data`);
    return { reforged: true, version, counts, unknown, variables, items };
  }
  const version = first;
  if (version !== 4 && version !== 7) throw new Error(`unsupported trigger file version ${version}`);
  const v7 = version === 7;
  const items: Item[] = Array.from({ length: r.u32() }, () => {
    const id = r.u32(), name = r.str();
    return { type: 4 as const, id, name, isComment: v7 ? r.u32() : 0, expanded: 1, parent: -1 };
  });
  const unknown = r.u32();
  const variables = Array.from({ length: r.u32() }, (_, i): Variable => {
    const name = r.str(), type = r.str(), unknown = r.u32(), isArray = r.u32() !== 0;
    return { name, type, unknown, isArray, arraySize: v7 ? r.u32() : 1, initialized: r.u32() !== 0, initialValue: r.str(), id: i, parent: -1 };
  });
  for (let n = r.u32(), i = 0; i < n; i++) {
    const name = r.str(), description = r.str(), isComment = v7 ? r.u32() : 0;
    const enabled = r.u32() !== 0, isCustom = r.u32() !== 0, initiallyOff = r.u32() !== 0, runOnInit = r.u32() !== 0, parent = r.i32();
    const ecas = Array.from({ length: r.u32() }, () => readEca(r, data, v7, false));
    items.push({ type: 8, name, description, isComment, id: i, enabled, isCustom, initiallyOff, runOnInit, parent, ecas });
  }
  if (!r.done) throw new Error(`${buf.length - r.o} bytes after the trigger data`);
  return { reforged: false, version, counts: [], unknown, variables, items };
}

function writeParam(w: Writer, p: Param, v7: boolean) {
  w.i32(p.type).str(p.value).u32(p.call ? 1 : 0);
  if (p.call) {
    w.u32(p.call.kind).str(p.call.name).u32(p.call.hasParams ? 1 : 0);
    if (p.call.hasParams) for (const q of p.call.params) writeParam(w, q, v7);
    if (v7) w.u32(p.call.trailer ?? 0);
  }
  w.u32(p.index ? 1 : 0);
  if (p.index) writeParam(w, p.index, v7);
}

function writeEca(w: Writer, e: Eca, v7: boolean, child: boolean) {
  w.u32(e.kind);
  if (child) w.u32(e.group ?? 0);
  w.str(e.name).u32(e.enabled ? 1 : 0);
  for (const p of e.params) writeParam(w, p, v7);
  if (v7) {
    w.u32(e.children.length);
    for (const c of e.children) writeEca(w, c, v7, true);
  }
}

export function writeWtg(f: TriggerFile): Uint8Array {
  const w = new Writer().bytes(te.encode("WTG!"));
  const v7 = f.version === 7;
  const triggers = f.items.filter((i): i is TriggerItem => i.type === 8 || i.type === 16 || i.type === 32);
  if (f.reforged) {
    w.u32(MARKER).u32(f.version);
    for (const c of f.counts) { w.u32(c.count).u32(c.deleted.length); for (const d of c.deleted) w.u32(d); }
    w.u32(f.unknown).u32(f.variables.length);
    for (const v of f.variables) {
      w.str(v.name).str(v.type).u32(v.unknown).u32(v.isArray ? 1 : 0).u32(v.arraySize).u32(v.initialized ? 1 : 0).str(v.initialValue).u32(v.id).i32(v.parent);
    }
    w.u32(f.items.length);
    for (const it of f.items) {
      w.u32(it.type);
      if (it.type === 64) w.u32(it.id).str(it.name).i32(it.parent);
      else if (!("ecas" in it)) w.u32(it.id).str(it.name).u32(it.isComment).u32(it.expanded).i32(it.parent);
      else {
        w.str(it.name).str(it.description).u32(it.isComment).u32(it.id).u32(it.enabled ? 1 : 0).u32(it.isCustom ? 1 : 0)
          .u32(it.initiallyOff ? 1 : 0).u32(it.runOnInit ? 1 : 0).i32(it.parent).u32(it.ecas.length);
        for (const e of it.ecas) writeEca(w, e, true, false);
      }
    }
    return w.done();
  }
  const categories = f.items.filter((i) => i.type === 4) as Extract<Item, { type: 1 | 2 | 4 }>[];
  w.u32(f.version).u32(categories.length);
  for (const c of categories) { w.u32(c.id).str(c.name); if (v7) w.u32(c.isComment); }
  w.u32(f.unknown).u32(f.variables.length);
  for (const v of f.variables) {
    w.str(v.name).str(v.type).u32(v.unknown).u32(v.isArray ? 1 : 0);
    if (v7) w.u32(v.arraySize);
    w.u32(v.initialized ? 1 : 0).str(v.initialValue);
  }
  w.u32(triggers.length);
  for (const t of triggers) {
    w.str(t.name).str(t.description);
    if (v7) w.u32(t.isComment);
    w.u32(t.enabled ? 1 : 0).u32(t.isCustom ? 1 : 0).u32(t.initiallyOff ? 1 : 0).u32(t.runOnInit ? 1 : 0).i32(t.parent).u32(t.ecas.length);
    for (const e of t.ecas) writeEca(w, e, v7, false);
  }
  return w.done();
}

/** Custom script text: the map header and one text per GUI trigger (in item order). */
export interface CustomTextFile {
  reforged: boolean;
  version: number;
  comment: string;
  /** null: no text stored (length 0); "" is stored as a lone terminating zero. */
  header: string | null;
  texts: (string | null)[];
}

/** Length-prefixed text; the stored length counts the terminating zero. */
function readText(r: Reader): string | null {
  const n = r.u32();
  if (!n) return null;
  const b = r.bytes(n);
  return td.decode(b[n - 1] === 0 ? b.subarray(0, n - 1) : b);
}
function writeText(w: Writer, s: string | null) {
  if (s === null) { w.u32(0); return; }
  const b = te.encode(s);
  w.u32(b.length + 1).bytes(b).bytes(new Uint8Array(1));
}

/** `triggers`: how many GUI triggers the wtg has (Reforged files store no count). */
export function parseWct(buf: Uint8Array, triggers: number): CustomTextFile {
  const r = new Reader(buf);
  const first = r.u32();
  if (first === MARKER) {
    const version = r.u32(), comment = r.str(), header = readText(r);
    const texts = Array.from({ length: triggers }, () => readText(r));
    if (!r.done) throw new Error(`${buf.length - r.o} bytes after the custom script`);
    return { reforged: true, version, comment, header, texts };
  }
  const version = first;
  const comment = version >= 1 ? r.str() : "", header = version >= 1 ? readText(r) : null;
  const texts = Array.from({ length: r.u32() }, () => readText(r));
  return { reforged: false, version, comment, header, texts };
}

export function writeWct(f: CustomTextFile): Uint8Array {
  const w = new Writer();
  if (f.reforged) w.u32(MARKER).u32(f.version).str(f.comment);
  else { w.u32(f.version); if (f.version >= 1) w.str(f.comment); }
  if (f.reforged || f.version >= 1) writeText(w, f.header);
  if (!f.reforged) w.u32(f.texts.length);
  for (const t of f.texts) writeText(w, t);
  return w.done();
}

// The project keeps war3map.wtg as JSON (map/war3map.wtg.json, the w3proj codec "wtg-json", see
// crates/w3proj/src/wtg.rs) when it could be read with the game's TriggerData.txt on unpack, else
// raw. The JSON is a TriggerFile with keys in a fixed order and the codec's layout (see layout()).
export const WTG_RAW = "map/war3map.wtg", WTG_JSON = "map/war3map.wtg.json";

/** The project's trigger file: the JSON form if there is one, else the raw file, else null. */
export function wtgPath(files: { path: string }[]): string | null {
  const has = (p: string) => files.some((f) => f.path.toLowerCase() === p);
  return has(WTG_JSON) ? WTG_JSON : has(WTG_RAW) ? WTG_RAW : null;
}

/** A TriggerFile as the codec writes it (same key order, so saves don't reorder the file). */
export function writeWtgJson(f: TriggerFile): string {
  const opt = <K extends string, V>(k: K, v: V | undefined) => (v === undefined ? {} : { [k]: v }) as { [P in K]?: V };
  const param = (p: Param): object => ({
    type: p.type, value: p.value,
    ...opt("call", p.call && { kind: p.call.kind, name: p.call.name, hasParams: p.call.hasParams, params: p.call.params.map(param), ...opt("trailer", p.call.trailer) }),
    ...opt("index", p.index && param(p.index)),
  });
  const eca = (e: Eca): object => ({ kind: e.kind, ...opt("group", e.group), name: e.name, enabled: e.enabled, params: e.params.map(param), children: e.children.map(eca) });
  const item = (i: Item): object => i.type === 64 ? { type: i.type, id: i.id, name: i.name, parent: i.parent }
    : "ecas" in i ? { type: i.type, name: i.name, description: i.description, isComment: i.isComment, id: i.id, enabled: i.enabled, isCustom: i.isCustom,
        initiallyOff: i.initiallyOff, runOnInit: i.runOnInit, parent: i.parent, ecas: i.ecas.map(eca) }
    : { type: i.type, id: i.id, name: i.name, isComment: i.isComment, expanded: i.expanded, parent: i.parent };
  return layout({
    reforged: f.reforged, version: f.version, counts: f.counts.map((c) => ({ count: c.count, deleted: c.deleted })), unknown: f.unknown,
    variables: f.variables.map((v) => ({ name: v.name, type: v.type, unknown: v.unknown, isArray: v.isArray, arraySize: v.arraySize, initialized: v.initialized,
      initialValue: v.initialValue, id: v.id, parent: v.parent })),
    items: f.items.map(item),
  }, "") + "\n";
}

/** The codec's layout: the file, triggers and ECAs (objects with items/ecas/children) one key per
 *  line, two-space indent; arrays of objects one element per line; everything else (parameters,
 *  variables, categories, counts) on one line. */
function layout(v: unknown, indent: string): string {
  const inner = indent + "  ";
  const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
  if (isObject(v) && ("items" in v || "ecas" in v || "children" in v)) {
    return `{\n${Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${layout(x, inner)}`).join(",\n")}\n${indent}}`;
  }
  if (Array.isArray(v) && v.some(isObject)) return `[\n${v.map((x) => inner + layout(x, inner)).join(",\n")}\n${indent}]`;
  return JSON.stringify(v);
}

export function parseWtgJson(text: string): TriggerFile {
  const f = JSON.parse(text) as TriggerFile;
  if (typeof f?.reforged !== "boolean" || !Array.isArray(f.items) || !Array.isArray(f.variables)) throw new Error("war3map.wtg.json isn't a trigger file");
  return f;
}

/** Reads the project's trigger file in either form (`path` from wtgPath). */
export async function readWtgFile(io: Pick<WctIO, "readText" | "readBytes">, path: string, data: () => Promise<TriggerData>): Promise<TriggerFile> {
  return path.toLowerCase().endsWith(".json") ? parseWtgJson(await io.readText(path)) : parseWtg(await io.readBytes(path), await data());
}

/** Writes the trigger file in the form `path` has. */
export async function writeWtgFile(io: Pick<WctIO, "writeText" | "writeBytes">, path: string, f: TriggerFile) {
  if (path.toLowerCase().endsWith(".json")) await io.writeText(path, writeWtgJson(f));
  else await io.writeBytes(path, writeWtg(f));
}

// The project keeps war3map.wct as text (map/war3map.wct.txt, the w3proj codec "wct-text", see
// crates/w3proj/src/wct.rs): a first line with version/layout/comment, then a marker line per
// section ("//== header ==", "//== trigger 3: Its Name ==", " (no text)" for a stored length 0;
// the name is a comment), each text followed by one line break. Line breaks are CRLF when any text uses them. Files the codec can't
// represent (texts that aren't UTF-8, or that contain a marker line) stay raw (map/war3map.wct).
export const WCT_RAW = "map/war3map.wct", WCT_TEXT = "map/war3map.wct.txt";

/** `names`: the text triggers' names (textTriggers order), written as comments in the markers. */
export function writeWctText(f: CustomTextFile, names: string[] = []): string {
  const withHeader = f.reforged || f.version >= 1;
  const all = [...(withHeader ? [f.header] : []), ...f.texts];
  const eol = all.some((t) => t?.includes("\r\n")) ? "\r\n" : "\n";
  let s = `//== war3map.wct: version ${f.version}${f.reforged ? ", reforged" : ""}${withHeader ? `, comment ${JSON.stringify(f.comment)}` : ""} ==${eol}`;
  const put = (name: string, t: string | null, label = "") => {
    s += `//== ${name}${t === null ? " (no text)" : ""}${label ? `: ${label.replace(/[\r\n]/g, " ")}` : ""} ==${eol}${t === null ? "" : t + eol}`;
  };
  if (withHeader) put("header", f.header);
  f.texts.forEach((t, k) => put(`trigger ${k}`, t, names[k]));
  return s;
}

export function parseWctText(s: string): CustomTextFile {
  const firstEnd = s.indexOf("\n");
  const first = /^\/\/== war3map\.wct: version (\d+)(, reforged)?(?:, comment (".*"))? ==\r?$/.exec(s.slice(0, firstEnd));
  if (firstEnd < 0 || !first) throw new Error("war3map.wct.txt: the first line isn't a war3map.wct line");
  const eol = s[firstEnd - 1] === "\r" ? "\r\n" : "\n";
  const f: CustomTextFile = { reforged: !!first[2], version: Number(first[1]), comment: first[3] ? JSON.parse(first[3]) : "", header: null, texts: [] };
  const body = s.slice(firstEnd + 1);
  const marks: { start: number; from: number; name: string; has: boolean }[] = [];
  // Trigger markers may carry the trigger's name (a comment); the header's can't.
  const re = /^\/\/== (header|trigger \d+)( \(no text\))?(: .*)? ==\r?(?:\n|$)/gm;
  for (let m; (m = re.exec(body));) {
    if (m[1] === "header" && m[3]) continue;
    marks.push({ start: m.index, from: m.index + m[0].length, name: m[1], has: !m[2] });
  }
  if ((marks[0]?.start ?? body.length) !== 0) throw new Error("war3map.wct.txt: text before the first section");
  let header = false;
  marks.forEach((m, k) => {
    const chunk = body.slice(m.from, marks[k + 1]?.start ?? body.length);
    if (m.has && !chunk.endsWith(eol)) throw new Error(`war3map.wct.txt: ${m.name} doesn't end with a line break`);
    if (!m.has && chunk) throw new Error(`war3map.wct.txt: text after "${m.name} (no text)"`);
    const t = m.has ? chunk.slice(0, -eol.length) : null;
    if (m.name === "header") {
      if (k !== 0) throw new Error("war3map.wct.txt: the header isn't first");
      header = true;
      f.header = t;
    } else {
      if (m.name !== `trigger ${f.texts.length}`) throw new Error(`war3map.wct.txt: ${m.name} where trigger ${f.texts.length} was expected`);
      f.texts.push(t);
    }
  });
  if (header !== (f.reforged || f.version >= 1)) throw new Error("war3map.wct.txt: the header section doesn't match the version");
  return f;
}

/** Project file access for war3map.wct (a workspace). */
export interface WctIO {
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  writeText(path: string, text: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  delete(path: string): Promise<void>;
}

/** The project's custom script texts (text form, else the raw file); null if there are none.
 *  `triggers`: the wtg's text trigger count (a raw Reforged file stores none). */
export async function readWctFile(io: WctIO, triggers: number): Promise<CustomTextFile | null> {
  const text = await io.readText(WCT_TEXT).catch(() => null);
  if (text !== null) return parseWctText(text);
  const bytes = await io.readBytes(WCT_RAW).catch(() => null);
  return bytes ? parseWct(bytes, triggers) : null;
}

/** Writes the custom script texts in text form, or raw if the text form wouldn't read back the
 *  same; the other form is removed. `names`: see writeWctText. */
export async function writeWctFile(io: WctIO, f: CustomTextFile, names: string[] = []) {
  const text = writeWctText(f, names);
  let same = false;
  try {
    const back = parseWctText(text);
    same = back.reforged === f.reforged && back.version === f.version && back.comment === f.comment
      && (f.reforged || f.version >= 1 ? back.header === f.header : true)
      && back.texts.length === f.texts.length && back.texts.every((t, k) => t === f.texts[k]);
  } catch { /* raw */ }
  if (same) await io.writeText(WCT_TEXT, text);
  else await io.writeBytes(WCT_RAW, writeWct(f));
  await io.delete(same ? WCT_RAW : WCT_TEXT).catch(() => {});
}

/** The GUI triggers of a file, in the order their custom texts are stored. */
export function textTriggers(f: TriggerFile): TriggerItem[] {
  return f.items.filter((i): i is TriggerItem => i.type === 8 || i.type === 32);
}
