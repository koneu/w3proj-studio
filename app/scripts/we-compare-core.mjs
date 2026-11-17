// The pure parts of we-compare.mjs: reading a spec, and comparing two versions of a file (the World Editor's save and
// Studio's) field by field, cell by cell or byte by byte. No process is started here; we-compare.test.mjs tests it.

import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { doodadPlaces, minimapView, unitHeights, unitIds, w3eView } from "./we-compare-w3e.mjs";

const KINDS = ["auto", "parsed", "text", "text-exact", "text-set", "bytes", "wpm", "w3e", "w3e-spread", "w3e-variation", "unit-heights", "unit-ids", "doodad-places", "minimap"];
/** The kinds compared as JSON (diffJson): only these take "tolerance", "ignore" and "expectPaths". */
export const JSON_KINDS = ["parsed", "minimap", "w3e", "w3e-spread", "w3e-variation", "unit-heights", "unit-ids", "doodad-places"];
const STUDIO_STEPS = ["mcp", "eval", "sleep", "open", "terrain", "setting", "command", "ui"];
/** Folder names inside the work folder that are we-compare's own: a spec can't be named so (any case: Windows). */
export const RESERVED_NAMES = ["studio-app", "we-drive", "report.json", "we-compare.lock"];

// ---------------------------------------------------------------- the "ui" step's actions (we-compare-ui.mjs)

/** The World Editor's terrain view on its 1600x1000 display: positions of a "click" / "drag" must fall inside it. */
export const WE_VIEW = { left: 156, top: 79, width: 1184, height: 844 };
export const inWeView = (x, y) => Number.isFinite(x) && Number.isFinite(y) && x >= WE_VIEW.left && y >= WE_VIEW.top && x < WE_VIEW.left + WE_VIEW.width && y < WE_VIEW.top + WE_VIEW.height;

/** A "key" action's KeyboardEvent { key, code }: "d" is KeyD, "6" Digit6, "Numpad6" the key 6 on the number pad, " "
 *  Space; a named key (Escape, ArrowUp, Delete, F2) is its own code. `code` given in the action wins. */
export function uiKey(key, code) {
  const k = String(key);
  if (code !== undefined) return { key: k, code: String(code) };
  if (/^[a-z]$/i.test(k)) return { key: k, code: `Key${k.toUpperCase()}` };
  if (/^[0-9]$/.test(k)) return { key: k, code: `Digit${k}` };
  const pad = /^Numpad([0-9])$/.exec(k);
  if (pad) return { key: pad[1], code: k };
  if (k === " ") return { key: k, code: "Space" };
  return { key: k, code: k };
}

/** Checks a "ui" step's actions before anything runs: the kinds, the numbers, and that clicks and drags are inside the
 *  editor's terrain view (a point outside it would land on a panel in one editor and on nothing in the other). */
export function checkUiActions(actions, where = "ui") {
  const num = (v) => typeof v === "number" && Number.isFinite(v);
  for (const [i, act] of actions.entries()) {
    const [kind, ...a] = act;
    const bad = (m) => { throw new Error(`${where}[${i}] ${JSON.stringify(act)}: ${m}`); };
    if (["view", "tab", "tool", "texture", "cliff", "shape"].includes(kind)) { if (typeof a[0] !== "string") bad("wants a name"); }
    else if (kind === "size") { if (!num(a[0])) bad("wants a number"); }
    else if (kind === "sleep") { if (!(num(a[0]) && a[0] >= 0)) bad("wants milliseconds"); }
    else if (kind === "key") { if (typeof a[0] !== "string" || !a[0] || (a[1] !== undefined && typeof a[1] !== "string")) bad("wants a key (and a code)"); }
    else if (kind === "clickGround") { if (!(a.length >= 2 && a.length <= 3 && a.every(num))) bad("wants X, Y[, Z] world units"); }
    else if (kind === "click") { if (!(a.length === 2 && a.every(num))) bad("wants X, Y"); if (!inWeView(a[0], a[1])) bad("is outside the editor's terrain view (156,79 to 1340,923)"); }
    // A drag starts in the view; it may end past its edge (a box selection held on past it, edge-group-nudge), on the display.
    else if (kind === "drag") {
      if (!(a.length === 4 && a.every(num))) bad("wants X, Y, X2, Y2");
      if (!inWeView(a[0], a[1])) bad("starts outside the editor's terrain view (156,79 to 1340,923)");
      if (!(a[2] >= 0 && a[3] >= 0 && a[2] < 1600 && a[3] < 1000)) bad("ends outside the editor's 1600x1000 display");
    }
    else bad(`unknown ui action ${kind}`);
  }
}

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

/** `${MAIN}` (the main checkout) and `${REPO}` (this checkout) in a path of a spec; relative paths are the spec's folder's. */
export function expandPath(p, specDir, vars) {
  const s = String(p).replace(/\$\{(\w+)\}/g, (all, name) => {
    if (!(name in vars)) throw new Error(`unknown \${${name}} in ${p} (known: ${Object.keys(vars).join(", ")})`);
    return vars[name];
  });
  return isAbsolute(s) ? s : resolve(specDir, s);
}

/** `${NAME}` in a step's text replaced by `vars[NAME]` for the names `vars` has; any other `${…}` (a script's own
 *  template literal) stays as it is. `quote` makes a value fit into a JavaScript string literal (backslashes). */
export function expandText(text, vars, quote = false) {
  return String(text).replace(/\$\{(\w+)\}/g, (all, name) => (Object.hasOwn(vars, name) ? (quote ? JSON.stringify(String(vars[name])).slice(1, -1) : String(vars[name])) : all));
}

/** A path of this machine as the World Editor sees it: on Linux through Wine's Z: drive (we-drive's winePath). */
export const editorPath = (p, platform = process.platform) => (platform === "win32" ? p : `Z:${String(p).split("/").join("\\")}`);

/** The `${…}` names of `--type` text: `${REPO_WE}` and `${MAIN_WE}`, the checkouts as the editor's file dialogs take them. */
export const editorVars = (vars, platform = process.platform) =>
  Object.fromEntries(Object.entries(vars).filter(([k]) => k === "REPO" || k === "MAIN").map(([k, v]) => [`${k}_WE`, editorPath(v, platform)]));

/** One World Editor step of a spec as the arguments we-drive takes: "--key d" or ["--key", "d"] or ["--wait-ready"].
 *  A `--type` text gets `${REPO_WE}` / `${MAIN_WE}` (editorVars) filled in. */
function weStep(step, where, vars = {}) {
  const tokens = typeof step === "string" ? [step.slice(0, /\s/.test(step) ? step.search(/\s/) : step.length), ...(/\s/.test(step) ? [step.slice(step.search(/\s/)).trim()] : [])] : step;
  if (!Array.isArray(tokens) || !tokens.length || tokens.some((t) => typeof t !== "string") || tokens.length > 2 || !tokens[0].startsWith("--")) {
    throw new Error(`${where}: a World Editor step is "--step value" or ["--step", "value"], got ${JSON.stringify(step)}`);
  }
  if (["--map", "--start", "--save", "--close", "--wait-ready", "--compare-ready", "--compare-ready-unlit", "--look"].includes(tokens[0])) {
    throw new Error(`${where}: ${tokens[0]} is done by we-compare itself (the map, the wait for it, the save and the close)`);
  }
  return tokens[0] === "--type" && tokens.length === 2 ? [tokens[0], expandText(tokens[1], vars)] : tokens;
}

/** One Studio step; an `eval`'s `${REPO}` / `${MAIN}` become the checkouts' paths (quoted for a string literal). */
function studioStep(step, where, vars = {}) {
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
  if (k === "ui" && !(Array.isArray(step.ui) && step.ui.every((x) => Array.isArray(x) && x.length))) throw new Error(`${where}: "ui" is a list of actions, each a list (["tool", "Paint:"], ...: we-compare-ui.mjs)`);
  if (k === "ui") checkUiActions(step.ui, `${where}: ui`);
  if (k === "command" && typeof step.command !== "string") throw new Error(`${where}: "command" is a command id`);
  if (k === "eval") {
    const paths = Object.fromEntries(Object.entries(vars).filter(([n]) => n === "REPO" || n === "MAIN"));
    return { eval: expandText(step.eval, paths, true) };
  }
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
export function parseSpec(raw, specDir, vars = {}, label = "spec", { differsWithoutPaths = new Set() } = {}) {
  if (!isObject(raw)) throw new Error(`${label}: a spec is an object`);
  const name = raw.name;
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error(`${label}: "name" is needed (letters, digits, . _ -; it names the folder)`);
  if (RESERVED_NAMES.includes(name.toLowerCase())) throw new Error(`${label}: the name ${name} is one of we-compare's own folders (${RESERVED_NAMES.join(", ")})`);
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
    parsedInput = { new: n, steps: (input.steps ?? []).map((s, i) => studioStep(s, `${where}: input.steps[${i}]`, vars)) };
  } else throw new Error(`${where}: "input" needs "map" (a path) or "new"`);
  const we = raw.we ?? {};
  if (!isObject(we)) throw new Error(`${where}: "we" is an object`);
  if (we.mode !== undefined && !["sd", "hd", "de"].includes(we.mode)) throw new Error(`${where}: we.mode is sd, hd or de`);
  if (we.from !== undefined && !["input", "studio"].includes(we.from)) throw new Error(`${where}: we.from is input (the spec's map) or studio (the map Studio saved: does the editor open and re-save it unchanged?)`);
  if (we.saveAccept !== undefined && !(Array.isArray(we.saveAccept) && we.saveAccept.every((t) => typeof t === "string" && t && !t.includes(",")))) throw new Error(`${where}: we.saveAccept is a list of dialog titles`);
  const studio = raw.studio ?? {};
  if (!isObject(studio)) throw new Error(`${where}: "studio" is an object`);
  if (studio.settings !== undefined && !isObject(studio.settings)) throw new Error(`${where}: studio.settings is an object`);
  const compare = (raw.compare ?? []).map((c, i) => {
    const e = typeof c === "string" ? { file: c } : c;
    if (!isObject(e) || typeof e.file !== "string" || !e.file || /[\\/]/.test(e.file)) throw new Error(`${where}: compare[${i}] is a file name of the map (no folders)`);
    if (e.as !== undefined && !KINDS.includes(e.as)) throw new Error(`${where}: compare[${i}].as is one of ${KINDS.join(", ")}`);
    if (e.expect !== undefined && !["match", "differs"].includes(e.expect)) throw new Error(`${where}: compare[${i}].expect is match or differs`);
    if (e.tolerance !== undefined && !(Number.isFinite(e.tolerance) && e.tolerance >= 0)) throw new Error(`${where}: compare[${i}].tolerance is a number of 0 or more (numbers within it count as equal)`);
    if (e.ignore !== undefined && !(Array.isArray(e.ignore) && e.ignore.every((x) => typeof x === "string" && x))) throw new Error(`${where}: compare[${i}].ignore is a list of paths ("doodads[3].scale", "units[].itemTable")`);
    if (e.expectPaths !== undefined) {
      if (!(Array.isArray(e.expectPaths) && e.expectPaths.length && e.expectPaths.every((x) => typeof x === "string" && x))) throw new Error(`${where}: compare[${i}].expectPaths is a list of paths that must all differ ("players[].start")`);
      if (e.expect !== "differs") throw new Error(`${where}: compare[${i}].expectPaths goes with "expect": "differs"`);
    }
    const unknownKey = Object.keys(e).filter((k) => !["file", "as", "expect", "tolerance", "ignore", "expectPaths"].includes(k));
    if (unknownKey.length) throw new Error(`${where}: compare[${i}]: unknown key ${unknownKey.join(", ")}`);
    // A kind compared as text, bytes or cells has no use for these: refused, so a spec never believes it is applied.
    const kind = e.as ?? "auto";
    for (const opt of ["tolerance", "ignore", "expectPaths"]) {
      if (e[opt] !== undefined && kind !== "auto" && !JSON_KINDS.includes(kind)) throw new Error(`${where}: compare[${i}].${opt} has no effect on "as": "${kind}" (only on ${JSON_KINDS.join(", ")})`);
    }
    // "differs" on a JSON kind without expectPaths passes on ANY difference, also when the World Editor's steps never
    // applied: refused, except for the entries of tests/we-compare/differs-without-paths.json (written before the
    // rule; that list only shrinks).
    if (e.expect === "differs" && !e.expectPaths && takesPaths(kind, e.file) && differsWithoutPaths !== "any" && !differsWithoutPaths.has(`${name} ${e.file}`)) {
      throw new Error(`${where}: compare[${i}] (${e.file}) expects "differs" without "expectPaths": name the paths that must differ (any difference would pass, also a World Editor step that missed)`);
    }
    return { file: e.file, as: kind, expect: e.expect ?? "match", tolerance: e.tolerance ?? 0, ignore: e.ignore ?? [], ...(e.expectPaths ? { expectPaths: e.expectPaths } : {}) };
  });
  if (!compare.length) throw new Error(`${where}: "compare" names at least one file`);
  const dup = compare.map((c) => c.file.toLowerCase()).filter((f, i, a) => a.indexOf(f) !== i);
  if (dup.length) throw new Error(`${where}: compare names ${dup[0]} twice`);
  if (raw.limit !== undefined && !(Number.isInteger(raw.limit) && raw.limit > 0)) throw new Error(`${where}: limit is a positive whole number`);
  return {
    name,
    description: raw.description ?? "",
    input: parsedInput,
    we: { mode: we.mode ?? "sd", from: we.from ?? "input", saveAccept: we.saveAccept ?? [], steps: (we.steps ?? []).map((s, i) => weStep(s, `${where}: we.steps[${i}]`, editorVars(vars))) },
    studio: { settings: studio.settings ?? {}, steps: (studio.steps ?? []).map((s, i) => studioStep(s, `${where}: studio.steps[${i}]`, vars)) },
    compare,
    limit: raw.limit ?? 10,
  };
}

/** A spec file's text: one spec or an array of them. Names must differ. */
export function parseSpecFile(text, file, vars = {}, options = {}) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new Error(`${file}: not JSON: ${e.message}`); }
  const list = Array.isArray(raw) ? raw : [raw];
  const specs = list.map((r, i) => parseSpec(r, dirname(file), vars, `${file}${Array.isArray(raw) ? `[${i}]` : ""}`, options));
  const dup = duplicateName(specs);
  if (dup) throw new Error(`${file}: two specs are named ${dup}`);
  return specs;
}

/** Whether a compare entry of this kind can name expectPaths: the JSON kinds, and "auto" on a file auto doesn't take as
 *  text or a pathing map (it is then the codecs' JSON or bytes; we-compare can't know which before the run). */
export const takesPaths = (kind, file) => JSON_KINDS.includes(kind) || (kind === "auto" && autoKind(file, null) === "bytes");

/** The file of the "differs" entries without expectPaths that are let through, under the checkout `repoDir`. */
export const differsAllowlistPath = (repoDir) => join(repoDir, "tests", "we-compare", "differs-without-paths.json");
/** The allowlist (its "entries", each "spec-name file") as a Set, for parseSpec's `differsWithoutPaths`. */
export function readDiffersAllowlist(repoDir) {
  const raw = JSON.parse(readFileSync(differsAllowlistPath(repoDir), "utf8"));
  if (!Array.isArray(raw.entries) || !raw.entries.every((e) => typeof e === "string" && / /.test(e))) throw new Error(`${differsAllowlistPath(repoDir)}: "entries" is a list of "spec-name file"`);
  return new Set(raw.entries);
}

/**
 * The make-*.mjs generator (`gens`: [{ name, text }]) that writes the input map `map`, or null: only for a map under
 * <repo>/target/. The generator names its output folder and the file, either literally or as a template
 * (`melee-valid-${name}.w3x`): then the template's fixed prefix and suffix fit the file and the case name between them
 * appears in the generator.
 */
export function generatorOf(map, repoDir, gens) {
  const rel = relative(join(repoDir, "target"), map);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const folder = basename(dirname(map));
  const file = basename(map);
  const templated = (g) => [...g.matchAll(/([\w.-]*)\$\{[^}]+\}([\w.-]*)/g)].some(([, pre, post]) => {
    if (!pre && !post) return false;
    if (!file.startsWith(pre) || !file.endsWith(post) || file.length <= pre.length + post.length) return false;
    return g.includes(file.slice(pre.length, file.length - post.length));
  });
  return gens.find((g) => g.text.includes(folder) && (g.text.includes(file) || templated(g.text)))?.name ?? null;
}

/** Every settings key a spec changes in Studio: its studio.settings and its "setting" steps (input and studio). */
export function settingKeys(spec) {
  const steps = [...(spec.input.steps ?? []), ...spec.studio.steps];
  return [...new Set([...Object.keys(spec.studio.settings), ...steps.filter((s) => s.setting).map((s) => s.setting[0])])];
}

/**
 * The files `w3proj verify` (unpack, pack in memory, compare) says don't come back the same, from its output:
 * { mismatched: [names] } for "FAIL <map> — mismatched: a, b", { error } for another FAIL, {} for none.
 */
export function verifyOutcome(stdout) {
  const fail = String(stdout).split("\n").find((l) => l.startsWith("FAIL "));
  if (!fail) return {};
  const m = /— mismatched: (.*)$/.exec(fail);
  return m ? { mismatched: m[1].split(",").map((s) => s.trim()).filter(Boolean) } : { error: fail.replace(/^FAIL .*? — /, "").trim() };
}

/**
 * The "parsed" results of a spec checked against the World Editor's save surviving the codecs: a file whose unpack and
 * pack don't give its bytes back is compared through a codec that loses or changes something, so its MATCH can't be
 * trusted: ERROR, naming it. `verify` is verifyOutcome's result; other results are returned as they are.
 */
export function applyRoundtrip(files, verify) {
  if (!verify.mismatched && !verify.error) return files;
  return files.map((f) => {
    if (f.kind !== "parsed" || f.status === "ERROR" || f.status === "MISSING") return f;
    const why = verify.error ? `the World Editor's save didn't go through unpack and pack: ${verify.error}` : verify.mismatched.some((n) => n.toLowerCase() === f.file.toLowerCase()) ? "the World Editor's save of this file doesn't come back the same from the codecs (w3proj verify): the parsed compare can't see what they lose" : null;
    return why ? { ...f, status: "ERROR", count: 1, diffs: [{ text: why }, ...(f.diffs ?? [])] } : f;
  });
}

/** The first name two specs share, any case (each names a folder, and Windows' folders don't tell case apart), or null. */
export function duplicateName(specs) {
  const names = specs.map((s) => s.name.toLowerCase());
  const i = names.findIndex((n, j) => names.indexOf(n) !== j);
  return i < 0 ? null : specs[i].name;
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
 *
 * `tolerance` is a number, or a function of the path giving one (the minimap: its blocks only). `ignore` and
 * `expectPaths` are path patterns (pathPattern). Also returned: `ignoreUnmatched`, the ignore patterns that name no path
 * of either document (a typo, or a field that is gone: it ignores nothing); with `expectPaths`, `expectMissing` (the
 * expected paths that don't differ) and `unexpected` ({ count, paths }: differences outside them).
 */
export function diffJson(a, b, limit = 10, tolerance = 0, ignore = [], expectPaths = []) {
  const diffs = [];
  let count = 0;
  const entries = {};
  const tol = typeof tolerance === "function" ? tolerance : () => tolerance;
  // Two numbers within `tolerance` of each other are the same (a known, bounded difference of the two editors).
  const same = (x, y, path) => x === y || (Number.isNaN(x) && Number.isNaN(y)) || (typeof x === "number" && typeof y === "number" && Math.abs(x - y) <= tol(path));
  // `ignore`: paths whose differences don't count (a known, named difference): "doodads[3].scale" (with everything below
  // it), "units[].itemTable" ([] is any index).
  const ignored = ignore.map(pathPattern);
  const unseen = new Set(ignored.keys());
  const see = (path) => { if (path) for (const i of unseen) if (ignored[i].test(path)) unseen.delete(i); };
  // Every path of a value that only one side has (for `ignoreUnmatched`).
  const seeAll = (v, path) => {
    if (!unseen.size) return;
    see(path);
    if (Array.isArray(v)) v.forEach((e, i) => seeAll(e, `${path}[${i}]`));
    else if (isObject(v)) for (const k of Object.keys(v)) seeAll(v[k], path ? `${path}.${k}` : k);
  };
  const expected = expectPaths.map(pathPattern);
  const expectHit = new Set();
  const unexpected = { count: 0, paths: [] };
  const paths = [];
  const add = (path, x, y) => {
    seeAll(x, path);
    seeAll(y, path);
    if (ignored.some((re) => re.test(path))) return;
    count++;
    paths.push(path);
    if (diffs.length < limit) diffs.push({ path, we: x, studio: y });
    if (expected.length) {
      const hits = expected.flatMap((re, i) => (re.test(path) ? [i] : []));
      for (const i of hits) expectHit.add(i);
      if (!hits.length) { unexpected.count++; if (unexpected.paths.length < limit) unexpected.paths.push(path); }
    }
  };
  const walk = (x, y, path) => {
    if (unseen.size) see(path);
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
    } else if (!same(x, y, path)) add(path, x, y);
  };
  walk(a, b, "");
  // Entries of the top-level lists: how many of them differ (a list element is one entry, whatever fields differ).
  if (isObject(a) && isObject(b)) {
    for (const k of Object.keys(a)) {
      if (!Array.isArray(a[k]) || !Array.isArray(b[k])) continue;
      const hit = new Set();
      for (const p of paths) if (p.startsWith(`${k}[`)) hit.add(Number(p.slice(k.length + 1, p.indexOf("]", k.length))));
      const indices = [...hit].sort((m, n) => m - n);
      entries[k] = { total: Math.max(a[k].length, b[k].length), differing: indices.length, indices: indices.slice(0, 50) };
    }
  }
  return {
    equal: count === 0, count, entries, diffs: diffs.map((d) => ({ ...d, text: `${d.path}: WE ${show(d.we)}, Studio ${show(d.studio)}` })),
    ignoreUnmatched: [...unseen].map((i) => ignore[i]),
    ...(expected.length ? { expectMissing: expectPaths.filter((p, i) => !expectHit.has(i)), unexpected } : {}),
  };
}

/** A path pattern of "ignore" / "expectPaths" as a RegExp: "doodads[3].scale" is that path and everything below it,
 *  "units[].itemTable" has [] for any index; every other character is itself. */
export function pathPattern(p) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${p.split("[]").map(escape).join("\\[\\d+\\]")}(?:$|[.[])`);
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

/** Text by line: { equal, count (differing lines, the extra ones included), lines, diffs }. `exact`: lines are split at
 *  LF only, so a CR stays part of its line and CRLF against LF differs (text-exact: specs that pin line endings). */
export function diffText(a, b, limit = 10, exact = false) {
  const split = (t) => (exact ? t.split("\n") : t.split(/\r?\n/));
  const x = split(a), y = split(b);
  const n = Math.max(x.length, y.length);
  const diffs = [];
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) { count++; if (diffs.length < limit) diffs.push({ line: i + 1, text: `line ${i + 1}: WE ${show(x[i])}, Studio ${show(y[i])}` }); }
  }
  return { equal: count === 0, count, lines: [x.length, y.length], diffs };
}

/**
 * Text as a set of lines, order ignored (the editor writes some lists, such as the items of CreateAllItems, in an order
 * the saved files don't keep): the lines only one side has, each counted with its multiplicity.
 */
export function diffTextSet(a, b, limit = 10) {
  const x = a.split(/\r?\n/), y = b.split(/\r?\n/);
  const left = new Map();
  for (const l of x) left.set(l, (left.get(l) ?? 0) + 1);
  const diffs = [];
  let count = 0;
  const add = (side, l, n) => { count += n; if (diffs.length < limit) diffs.push({ text: `${side} only${n > 1 ? ` (x${n})` : ""}: ${show(l)}` }); };
  for (const l of y) { const n = left.get(l) ?? 0; if (n > 0) left.set(l, n - 1); else add("Studio", l, 1); }
  for (const [l, n] of left) if (n > 0) add("WE", l, n);
  return { equal: count === 0, count, lines: [x.length, y.length], diffs };
}

/**
 * The comparison of one file: `kind` as the spec names it (resolved, not "auto"), `we` and `studio` what was found:
 * each { bytes }, { text } or a parsed JSON value ({ json }), or null when the map has no such file. Returns
 * { file, kind, status, ... } where status is
 *   "MATCH"    no difference that counts;
 *   "DIFFERS"  a real difference of values (diffJson, diffText, diffWpm, diffBytes);
 *   "MISSING"  the file is absent in one or both saves (never what "expect": "differs" means);
 *   "ERROR"    the comparison can't be made (an option the kind doesn't use; see also compareEntry's load errors).
 * `limit`, `tolerance`, `ignore`, `expectPaths` as the spec's compare entry has them.
 */
export function compareFile(file, kind, we, studio, limit = 10, tolerance = 0, ignore = [], expectPaths = []) {
  if (!we || !studio) {
    const where = !we && !studio ? "neither map" : !we ? "Studio's save only" : "the World Editor's save only";
    return { file, kind, status: "MISSING", count: 1, diffs: [{ text: `the file is in ${where}` }] };
  }
  if (!JSON_KINDS.includes(kind)) {
    const used = [tolerance > 0 && "tolerance", ignore.length && "ignore", expectPaths.length && "expectPaths"].filter(Boolean);
    if (used.length) return { file, kind, status: "ERROR", count: 1, diffs: [{ text: `${used.join(", ")} has no effect on a file compared as ${kind} (only on ${JSON_KINDS.join(", ")})` }] };
  }
  let r;
  // The JSON kinds: the codecs' JSON (parsed) and the reduced tables of we-compare-w3e.mjs (w3e…, unit-…, doodad-places,
  // minimap), field by field; "ignore" names known differences ("header.ground"), "tolerance" bounds numbers. The
  // minimap's tolerance is for its block colours only: its size is compared exactly.
  if (JSON_KINDS.includes(kind)) r = diffJson(we.json, studio.json, limit, kind === "minimap" ? (path) => (path.startsWith("blocks.") ? tolerance : 0) : tolerance, ignore, expectPaths);
  else if (kind === "text") r = diffText(we.text, studio.text, limit);
  else if (kind === "text-exact") r = diffText(we.text, studio.text, limit, true);
  else if (kind === "text-set") r = diffTextSet(we.text, studio.text, limit);
  else if (kind === "wpm") r = diffWpm(we.bytes, studio.bytes, limit);
  else r = diffBytes(we.bytes, studio.bytes, limit);
  return { file, kind, status: r.equal ? "MATCH" : "DIFFERS", ...r };
}

/**
 * One file of a map for a compare kind, from a reader of an unpacked map (we-compare.mjs `reader`: has, listed,
 * unpackedAs, json, text, bytes). null when the map has no such file; throws when it has one that can't be read as
 * the kind wants (a w3e that is cut short, a file that didn't unpack as JSON): that is never "absent".
 */
export function loadSide(r, file, kind, decodeImage) {
  if (!r.has(file) && !r.listed(file)) return null;
  const json = () => {
    if (r.unpackedAs(file) !== "json") throw new Error(`${file} is in the map but the unpack made no JSON of it (${r.unpackedAs(file) ?? "not unpacked"})`);
    return r.json(file);
  };
  if (kind === "w3e" || kind === "w3e-spread" || kind === "w3e-variation") return { json: w3eView(kind, r.bytes(file)) };
  if (kind === "unit-heights") return { json: unitHeights(json()) };
  if (kind === "doodad-places") return { json: doodadPlaces(json()) };
  if (kind === "unit-ids") return { json: unitIds(json()) };
  if (kind === "parsed") return { json: json() };
  if (kind === "minimap") {
    if (!decodeImage) throw new Error("no image decoder for the minimap kind");
    return { json: minimapView(decodeImage(new Uint8Array(r.bytes(file)), file).mip(0)) };
  }
  if (kind === "text" || kind === "text-set") return { text: r.text(file) };
  // The file's own bytes from the map (its line endings as saved) when the map holds it; a file only the unpack makes
  // (war3map.wct.txt) is read as the unpack wrote it.
  if (kind === "text-exact") return { text: r.listed(file) ? Buffer.from(r.bytes(file)).toString("utf8") : r.text(file) };
  return { bytes: r.bytes(file) };
}

/**
 * One "compare" entry of a spec (parsed: { file, as, expect, tolerance, ignore, expectPaths }) on the two saves' readers:
 * the kind worked out, both sides loaded, compared. A side that can't be loaded gives status "ERROR" naming it.
 */
export function compareEntry(c, weReader, studioReader, { limit = 10, decodeImage } = {}) {
  let kind = c.as;
  const base = { file: c.file, expect: c.expect, ...(c.expectPaths ? { expectPaths: c.expectPaths } : {}) };
  const sides = [["the World Editor's save", weReader], ["Studio's save", studioReader]];
  let loaded;
  try {
    if (kind === "auto") {
      const [a, b] = sides.map(([, r]) => r.unpackedAs(c.file));
      kind = autoKind(c.file, a === "json" && b === "json" ? "json" : a ?? b);
    }
  } catch (e) {
    return { ...base, kind, status: "ERROR", count: 1, diffs: [{ text: `reading the saves: ${e.message}` }] };
  }
  try {
    loaded = sides.map(([who, r]) => {
      try { return loadSide(r, c.file, kind, decodeImage); } catch (e) { throw new Error(`${who}: ${e.message}`); }
    });
  } catch (e) {
    return { ...base, kind, status: "ERROR", count: 1, diffs: [{ text: e.message }] };
  }
  return { ...base, ...compareFile(c.file, kind, loaded[0], loaded[1], limit, c.tolerance, c.ignore, c.expectPaths ?? []) };
}

/** What the kind "auto" means for a file: the codecs' form when the unpack made one (json), else by name. */
export function autoKind(file, unpackedAs) {
  if (unpackedAs === "json") return "parsed";
  if (/\.wpm$/i.test(file)) return "wpm";
  if (unpackedAs === "text" || /\.(j|lua|txt|wts|wct|ini)$/i.test(file)) return "text";
  return "bytes";
}

/**
 * Whether a file's result is what its spec expected: a match, or a difference where the spec says it differs (with
 * `expectPaths`: every one of them differs and nothing else does). MISSING and ERROR are never as expected.
 * `strictIgnore`: an ignore pattern that names no path makes it unexpected too (else it is only a warning).
 */
export function asExpected(f, { strictIgnore = false } = {}) {
  if (strictIgnore && f.ignoreUnmatched?.length) return false;
  if (f.expect !== "differs") return f.status === "MATCH";
  if (f.status !== "DIFFERS") return false;
  return !f.expectMissing?.length && !f.unexpected?.count;
}

/**
 * The run's verdict from its spec results ({ error, files, notCompared }): { ok, code, unexpected (a test per result) }.
 * Exit codes: 0 every file as expected, 1 a file not as expected (or MISSING), 2 something couldn't run (a spec's
 * error, a file's ERROR), 3 nothing was compared (--no-we: Studio's side only), never "ok".
 */
export function runOutcome(results, { strictIgnore = false } = {}) {
  const unexpected = (r) => Boolean(r.error || r.notCompared || r.files.some((f) => !asExpected(f, { strictIgnore })));
  const ok = results.length > 0 && !results.some(unexpected);
  const code = results.some((r) => r.error || r.files.some((f) => f.status === "ERROR")) ? 2
    : results.some((r) => !r.notCompared && unexpected(r)) ? 1
      : results.some((r) => r.notCompared) ? 3 : ok ? 0 : 1;
  return { ok, code, unexpected };
}

/**
 * What one we-drive process did for its `n` specs, from its JSON output lines (`outs`, parsed): per spec `error` (null
 * when its save was made) and `rerun`, the indices of the specs that never ran because the process stopped at an earlier
 * one's failure (they go to the next process; a spec that was saved, or failed itself, is not run again).
 */
export function weOutcome(n, outs) {
  // Which spec each line belongs to: the --map lines start one.
  let at = -1;
  const state = Array.from({ length: n }, () => ({ saved: false, failure: null, warning: null, stopped: false }));
  for (const o of outs) {
    if (o.step === "--map" && !o.error) { at = Math.min(at + 1, n - 1); continue; }
    const i = Math.max(at, 0);
    // A crash while closing the editor after the spec's save (the known one on close after Light Ranges): the saved
    // file is whole (the save had finished), so it is a warning, not a failure; the process stopped there.
    if (o.step === "--close" && o.crashed && o.closed && !o.error && state[i].saved && !state[i].failure) {
      state[i].warning ??= `the World Editor crashed while closing, after the save (${o.message ?? "crashed"})`;
      state[i].stopped = true;
    } else if (o.error || o.crashed) state[o.step === "--map" ? Math.min(at + 1, n - 1) : i].failure ??= o.error ?? "the World Editor crashed";
    else if (o.step === "--save") { if (o.saved) state[i].saved = true; else state[i].failure ??= `the save didn't finish: ${JSON.stringify(o.dialogs ?? o.timeout ?? "")}`; }
    else if (o.step === "--wait-ready" && o.ready === false) state[i].failure ??= `the map wasn't shown: ${JSON.stringify(o.dialogs ?? o.reason ?? "")}`;
  }
  // Where the process stopped: a failure, a spec without its save, or a crash on close after a save.
  const stopAt = state.findIndex((s) => s.failure || !s.saved || s.stopped);
  const rerun = [];
  const errors = state.map((s, i) => {
    if (s.failure) return `World Editor: ${s.failure}`;
    if (s.saved) return null;
    if (i > stopAt) { rerun.push(i); return null; }
    return "World Editor: no save (the run stopped before it)";
  });
  return { errors, rerun, warnings: state.map((s) => (s.warning ? `World Editor: ${s.warning}` : null)) };
}

/** One spec's result as text: a line per file, then its first differences. */
export function formatReport(result, limit = 10, { strictIgnore = false } = {}) {
  const lines = [];
  const ok = !result.error && !result.notCompared && result.files.every((f) => asExpected(f, { strictIgnore }));
  const head = result.error ? `ERROR ${result.error}` : result.notCompared ? "NOT COMPARED (--no-we: Studio's side only, nothing was compared)" : ok ? "OK" : "UNEXPECTED";
  lines.push(`${result.name}: ${head}${result.description ? `  (${result.description})` : ""}`);
  for (const w of result.warnings ?? []) lines.push(`  warning: ${w}`);
  for (const f of result.files) {
    let expected = "";
    if (f.expect === "differs") {
      if (f.status === "MATCH") expected = " (expected to differ, but matches)";
      else if (f.status !== "DIFFERS") expected = " (expected to differ: a missing or unreadable file is not a difference)";
      else if (f.expectMissing?.length || f.unexpected?.count) expected = " (not the expected difference)";
      else expected = " (expected)";
    }
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
    if (f.expectMissing?.length) lines.push(`    expected to differ but don't: ${f.expectMissing.join(", ")}`);
    if (f.unexpected?.count) lines.push(`    ${f.unexpected.count} difference${f.unexpected.count === 1 ? "" : "s"} outside expectPaths: ${f.unexpected.paths.join(", ")}${f.unexpected.count > f.unexpected.paths.length ? ", ..." : ""}`);
    if (f.ignoreUnmatched?.length) lines.push(`    ${strictIgnore ? "error" : "warning"}: ignore names no path of either file: ${f.ignoreUnmatched.join(", ")}`);
  }
  return lines.join("\n");
}

