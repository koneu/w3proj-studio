// The pure parts of we-compare.mjs: reading a spec, and comparing two versions of a file (the World Editor's save and
// Studio's) field by field, cell by cell or byte by byte. No process is started here; we-compare.test.mjs tests it.

import { dirname, isAbsolute, resolve } from "node:path";

const KINDS = ["auto", "parsed", "text", "bytes", "wpm"];
const STUDIO_STEPS = ["mcp", "eval", "sleep", "open", "terrain", "setting", "command"];

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

/** `${MAIN}` (the main checkout) and `${REPO}` (this checkout) in a path of a spec; relative paths are the spec's folder's. */
export function expandPath(p, specDir, vars) {
  const s = String(p).replace(/\$\{(\w+)\}/g, (all, name) => {
    if (!(name in vars)) throw new Error(`unknown \${${name}} in ${p} (known: ${Object.keys(vars).join(", ")})`);
    return vars[name];
  });
  return isAbsolute(s) ? s : resolve(specDir, s);
}

/** One World Editor step of a spec as the arguments we-drive takes: "--key d" or ["--key", "d"] or ["--wait-ready"]. */
function weStep(step, where) {
  const tokens = typeof step === "string" ? [step.slice(0, /\s/.test(step) ? step.search(/\s/) : step.length), ...(/\s/.test(step) ? [step.slice(step.search(/\s/)).trim()] : [])] : step;
  if (!Array.isArray(tokens) || !tokens.length || tokens.some((t) => typeof t !== "string") || tokens.length > 2 || !tokens[0].startsWith("--")) {
    throw new Error(`${where}: a World Editor step is "--step value" or ["--step", "value"], got ${JSON.stringify(step)}`);
  }
  if (["--map", "--start", "--save", "--close", "--wait-ready", "--compare-ready", "--compare-ready-unlit", "--look"].includes(tokens[0])) {
    throw new Error(`${where}: ${tokens[0]} is done by we-compare itself (the map, the wait for it, the save and the close)`);
  }
  return tokens;
}

function studioStep(step, where) {
  if (!isObject(step)) throw new Error(`${where}: a Studio step is an object, got ${JSON.stringify(step)}`);
  const keys = Object.keys(step).filter((k) => STUDIO_STEPS.includes(k));
  if (keys.length !== 1) throw new Error(`${where}: a Studio step has exactly one of ${STUDIO_STEPS.join(", ")}, got ${JSON.stringify(step)}`);
  const k = keys[0];
  const bad = Object.keys(step).filter((x) => x !== k && !(k === "mcp" && x === "args") && !(k === "command" && x === "args"));
  if (bad.length) throw new Error(`${where}: unknown ${bad.join(", ")} in a "${k}" step`);
  if (k === "mcp" && typeof step.mcp !== "string") throw new Error(`${where}: "mcp" is a tool name`);
  if (k === "eval" && typeof step.eval !== "string") throw new Error(`${where}: "eval" is JavaScript source`);
  if (k === "sleep" && !(Number.isFinite(step.sleep) && step.sleep >= 0)) throw new Error(`${where}: "sleep" is milliseconds`);
  if (k === "open" && typeof step.open !== "string") throw new Error(`${where}: "open" is a project file`);
  if (k === "setting" && !(Array.isArray(step.setting) && step.setting.length === 2 && typeof step.setting[0] === "string")) throw new Error(`${where}: "setting" is [key, value]`);
  if (k === "command" && typeof step.command !== "string") throw new Error(`${where}: "command" is a command id`);
  return step;
}

/**
 * Checks one spec (the parsed JSON) and fills in the defaults. `specDir` is its folder (relative paths), `vars` the
 * `${…}` values. Throws an Error naming what is wrong.
 *
 *   { "name": "…", "input": { "map": "x.w3x" } | { "new": { "name", "width", "height" }, "steps": [studio steps] },
 *     "we": { "mode": "sd|hd|de", "saveAccept": ["Warning"], "steps": ["--key d", …] },
 *     "studio": { "settings": { "key": value }, "steps": [{ "mcp": "tool", "args": {…} }, { "eval": "…" }, …] },
 *     "compare": ["war3map.w3i", { "file": "war3map.wpm", "as": "wpm", "expect": "differs" }], "limit": 20 }
 */
export function parseSpec(raw, specDir, vars = {}, label = "spec") {
  if (!isObject(raw)) throw new Error(`${label}: a spec is an object`);
  const name = raw.name;
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`${label}: "name" is needed (letters, digits, . _ -; it names the folder)`);
  const where = `${label} (${name})`;
  const unknown = Object.keys(raw).filter((k) => !["name", "description", "input", "we", "studio", "compare", "limit"].includes(k));
  if (unknown.length) throw new Error(`${where}: unknown key ${unknown.join(", ")}`);
  const input = raw.input;
  if (!isObject(input)) throw new Error(`${where}: "input" is needed: { "map": … } or { "new": { name, width, height } }`);
  let parsedInput;
  if (typeof input.map === "string") {
    if (input.new || input.steps) throw new Error(`${where}: "input" is a map or a new map, not both`);
    parsedInput = { map: expandPath(input.map, specDir, vars) };
  } else if (isObject(input.new)) {
    const n = input.new;
    if (typeof n.name !== "string" || !Number.isInteger(n.width) || !Number.isInteger(n.height)) throw new Error(`${where}: input.new wants name, width and height`);
    parsedInput = { new: n, steps: (input.steps ?? []).map((s, i) => studioStep(s, `${where}: input.steps[${i}]`)) };
  } else throw new Error(`${where}: "input" needs "map" (a path) or "new"`);
  const we = raw.we ?? {};
  if (!isObject(we)) throw new Error(`${where}: "we" is an object`);
  if (we.mode !== undefined && !["sd", "hd", "de"].includes(we.mode)) throw new Error(`${where}: we.mode is sd, hd or de`);
  if (we.saveAccept !== undefined && !(Array.isArray(we.saveAccept) && we.saveAccept.every((t) => typeof t === "string" && t && !t.includes(",")))) throw new Error(`${where}: we.saveAccept is a list of dialog titles`);
  const studio = raw.studio ?? {};
  if (!isObject(studio)) throw new Error(`${where}: "studio" is an object`);
  if (studio.settings !== undefined && !isObject(studio.settings)) throw new Error(`${where}: studio.settings is an object`);
  const compare = (raw.compare ?? []).map((c, i) => {
    const e = typeof c === "string" ? { file: c } : c;
    if (!isObject(e) || typeof e.file !== "string" || !e.file || /[\\/]/.test(e.file)) throw new Error(`${where}: compare[${i}] is a file name of the map (no folders)`);
    if (e.as !== undefined && !KINDS.includes(e.as)) throw new Error(`${where}: compare[${i}].as is one of ${KINDS.join(", ")}`);
    if (e.expect !== undefined && !["match", "differs"].includes(e.expect)) throw new Error(`${where}: compare[${i}].expect is match or differs`);
    return { file: e.file, as: e.as ?? "auto", expect: e.expect ?? "match" };
  });
  if (!compare.length) throw new Error(`${where}: "compare" names at least one file`);
  const dup = compare.map((c) => c.file).filter((f, i, a) => a.indexOf(f) !== i);
  if (dup.length) throw new Error(`${where}: compare names ${dup[0]} twice`);
  if (raw.limit !== undefined && !(Number.isInteger(raw.limit) && raw.limit > 0)) throw new Error(`${where}: limit is a positive whole number`);
  return {
    name,
    description: raw.description ?? "",
    input: parsedInput,
    we: { mode: we.mode ?? "sd", saveAccept: we.saveAccept ?? [], steps: (we.steps ?? []).map((s, i) => weStep(s, `${where}: we.steps[${i}]`)) },
    studio: { settings: studio.settings ?? {}, steps: (studio.steps ?? []).map((s, i) => studioStep(s, `${where}: studio.steps[${i}]`)) },
    compare,
    limit: raw.limit ?? 10,
  };
}

/** A spec file's text: one spec or an array of them. Names must differ. */
export function parseSpecFile(text, file, vars = {}) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`${file}: not JSON: ${e.message}`); }
  const list = Array.isArray(raw) ? raw : [raw];
  const specs = list.map((r, i) => parseSpec(r, dirname(file), vars, `${file}${Array.isArray(raw) ? `[${i}]` : ""}`));
  const dup = specs.map((s) => s.name).filter((n, i, a) => a.indexOf(n) !== i);
  if (dup.length) throw new Error(`${file}: two specs are named ${dup[0]}`);
  return specs;
}

// ---------------------------------------------------------------- comparing

const show = (v) => {
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
  return s === undefined ? "(absent)" : s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

/**
 * Field by field difference of two parsed JSON documents: { equal, count, entries, diffs }. Every differing leaf is one
 * difference with its path (`doodads[3].angle`); a list of another length also counts its extra entries, one each
 * ("doodads[210]: WE absent, Studio {…}"). `entries` counts the differing elements of the top-level lists ({ list: { total, differing } }).
 * `a` is the World Editor's, `b` Studio's. `limit` is how many differences are kept in `diffs` (the count is all).
 */
export function diffJson(a, b, limit = 10) {
  const diffs = [];
  let count = 0;
  const entries = {};
  const add = (path, x, y) => { count++; if (diffs.length < limit) diffs.push({ path, we: x, studio: y }); };
  const walk = (x, y, path) => {
    if (Array.isArray(x) && Array.isArray(y)) {
      const n = Math.max(x.length, y.length);
      for (let i = 0; i < n; i++) {
        if (i >= x.length) add(`${path}[${i}]`, undefined, y[i]);
        else if (i >= y.length) add(`${path}[${i}]`, x[i], undefined);
        else walk(x[i], y[i], `${path}[${i}]`);
      }
    } else if (isObject(x) && isObject(y)) {
      for (const k of [...new Set([...Object.keys(x), ...Object.keys(y)])]) {
        if (!(k in x)) add(path ? `${path}.${k}` : k, undefined, y[k]);
        else if (!(k in y)) add(path ? `${path}.${k}` : k, x[k], undefined);
        else walk(x[k], y[k], path ? `${path}.${k}` : k);
      }
    } else if (!(x === y || (Number.isNaN(x) && Number.isNaN(y)))) add(path, x, y);
  };
  walk(a, b, "");
  // Entries of the top-level lists: how many of them differ (a list element is one entry, whatever fields differ).
  if (isObject(a) && isObject(b)) {
    for (const k of Object.keys(a)) {
      if (!Array.isArray(a[k]) || !Array.isArray(b[k])) continue;
      const total = Math.max(a[k].length, b[k].length);
      const indices = [];
      for (let i = 0; i < total; i++) if (JSON.stringify(a[k][i]) !== JSON.stringify(b[k][i])) indices.push(i);
      entries[k] = { total, differing: indices.length, indices: indices.slice(0, 50) };
    }
  }
  return { equal: count === 0, count, entries, diffs: diffs.map((d) => ({ ...d, text: `${d.path}: WE ${show(d.we)}, Studio ${show(d.studio)}` })) };
}

/** Bytes: { equal, count (differing positions, the extra length included), lengths, diffs (offsets) }. */
export function diffBytes(a, b, limit = 10) {
  const n = Math.min(a.length, b.length);
  const diffs = [];
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) { count++; if (diffs.length < limit) diffs.push({ offset: i, we: a[i], studio: b[i], text: `byte ${i} (0x${i.toString(16)}): WE 0x${a[i].toString(16).padStart(2, "0")}, Studio 0x${b[i].toString(16).padStart(2, "0")}` }); }
  }
  const extra = Math.abs(a.length - b.length);
  count += extra;
  if (extra && diffs.length < limit) diffs.push({ offset: n, text: `length: WE ${a.length} bytes, Studio ${b.length}` });
  return { equal: count === 0, count, lengths: [a.length, b.length], diffs };
}

/** The pathing map (war3map.wpm: "MP3W", version, width, height, one flag byte per cell): differing cells with x, y and the flags. */
export function diffWpm(a, b, limit = 10) {
  const head = (buf) => (buf.length >= 16 && buf.toString("latin1", 0, 4) === "MP3W" ? { version: buf.readUInt32LE(4), w: buf.readUInt32LE(8), h: buf.readUInt32LE(12) } : null);
  const ha = head(a), hb = head(b);
  if (!ha || !hb || ha.w !== hb.w || ha.h !== hb.h || a.length !== 16 + ha.w * ha.h || b.length !== 16 + hb.w * hb.h) {
    const r = diffBytes(a, b, limit);
    return { ...r, note: "not two pathing maps of one size: compared as bytes" };
  }
  const cells = ha.w * ha.h;
  const diffs = [];
  let count = 0;
  for (let i = 0; i < cells; i++) {
    const x = a[16 + i], y = b[16 + i];
    if (x !== y) {
      count++;
      if (diffs.length < limit) {
        const cx = i % ha.w, cy = Math.floor(i / ha.w);
        diffs.push({ cell: [cx, cy], we: x, studio: y, text: `cell (${cx}, ${cy}): WE 0x${x.toString(16).padStart(2, "0")}, Studio 0x${y.toString(16).padStart(2, "0")}` });
      }
    }
  }
  const versionDiffers = ha.version !== hb.version;
  if (versionDiffers) { count++; diffs.unshift({ text: `version: WE ${ha.version}, Studio ${hb.version}` }); }
  return { equal: count === 0, count, cells, size: [ha.w, ha.h], diffs: diffs.slice(0, limit) };
}

/** Text by line: { equal, count (differing lines, the extra ones included), lines, diffs }. */
export function diffText(a, b, limit = 10) {
  const x = a.split(/\r?\n/), y = b.split(/\r?\n/);
  const n = Math.max(x.length, y.length);
  const diffs = [];
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) { count++; if (diffs.length < limit) diffs.push({ line: i + 1, text: `line ${i + 1}: WE ${show(x[i])}, Studio ${show(y[i])}` }); }
  }
  return { equal: count === 0, count, lines: [x.length, y.length], diffs };
}

/**
 * The comparison of one file: `kind` as the spec names it, `files` what was found: { we, studio } each a Buffer, a
 * parsed JSON value ({ json }), or null when the map has no such file. Returns { file, kind, status, ... } where status is
 * "MATCH", "DIFFERS" or "MISSING" (the file is absent in one or both).
 */
export function compareFile(file, kind, we, studio, limit = 10) {
  if (!we || !studio) {
    const only = !we && !studio ? "neither" : !we ? "Studio only" : "WE only";
    return { file, kind, status: !we && !studio ? "MISSING" : "DIFFERS", count: 1, diffs: [{ text: `the file is in ${only === "neither" ? "neither map" : only === "WE only" ? "the World Editor's save only" : "Studio's save only"}` }] };
  }
  let r;
  if (kind === "parsed") r = diffJson(we.json, studio.json, limit);
  else if (kind === "text") r = diffText(we.text, studio.text, limit);
  else if (kind === "wpm") r = diffWpm(we.bytes, studio.bytes, limit);
  else r = diffBytes(we.bytes, studio.bytes, limit);
  return { file, kind, status: r.equal ? "MATCH" : "DIFFERS", ...r };
}

/** What the kind "auto" means for a file: the codecs' form when the unpack made one (json), else by name. */
export function autoKind(file, unpackedAs) {
  if (unpackedAs === "json") return "parsed";
  if (/\.wpm$/i.test(file)) return "wpm";
  if (unpackedAs === "text" || /\.(j|lua|txt|wts|wct|ini)$/i.test(file)) return "text";
  return "bytes";
}

/** Whether a file's result is what its spec expected: a match, or a difference where the spec says it differs. */
export const asExpected = (f) => (f.expect === "differs" ? f.status === "DIFFERS" : f.status === "MATCH");

/** One spec's result as text: a line per file, then its first differences. */
export function formatReport(result, limit = 10) {
  const lines = [];
  const ok = !result.error && result.files.every(asExpected);
  lines.push(`${result.name}: ${result.error ? `ERROR ${result.error}` : ok ? "OK" : "UNEXPECTED"}${result.description ? `  (${result.description})` : ""}`);
  for (const f of result.files) {
    const expected = f.expect === "differs" ? (f.status === "DIFFERS" ? " (expected)" : " (expected to differ, but matches)") : "";
    let extent = "";
    const after = [];
    if (f.kind === "parsed" && f.status !== "MATCH" && f.entries) {
      const parts = Object.entries(f.entries).filter(([, v]) => v.differing).map(([k, v]) => `${v.differing} of ${v.total} ${k}`);
      extent = parts.length ? `, ${parts.join(", ")}` : "";
      for (const [k, v] of Object.entries(f.entries)) if (v.differing) after.push(`  differing ${k}: ${v.indices.join(", ")}${v.differing > v.indices.length ? ", ..." : ""}`);
    }
    if (f.kind === "wpm" && f.cells) extent = `, ${f.count} of ${f.cells} cells`;
    lines.push(`  ${f.file} [${f.kind}] ${f.status}${f.status === "DIFFERS" ? ` ${f.count} difference${f.count === 1 ? "" : "s"}${extent}` : ""}${expected}`);
    lines.push(...after);
    for (const d of (f.diffs ?? []).slice(0, limit)) lines.push(`    ${d.text}`);
    if (f.count > (f.diffs ?? []).length && f.diffs?.length) lines.push(`    ... and ${f.count - f.diffs.length} more`);
    if (f.note) lines.push(`    (${f.note})`);
  }
  return lines.join("\n");
}

