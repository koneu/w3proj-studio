// The JSON Schemas of the unpacked map's JSON files (docs/schemas, README there) against the codecs they describe:
// each schema names the fields, types and required keys of its format definition (crates/w3proj/formats) or, for the
// formats defined in code, the keys its codec reads (crates/w3proj/src); the fixtures' files and samples of what
// unpack writes pass, broken samples fail, and (with the corpus and the release CLI) every file unpack and a terrain
// split write for the corpus maps passes.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import { corpusRequired, fixturePath, repoPath, skipOrFail } from "../testhelpers/testutil";
import { gameCli, mainCheckout } from "../testhelpers/gamefiles";
import { pathingOverridesText } from "../terrain/resize";

/** How a file holds what its schema is for: one JSON document, one per line (JSON Lines), or the JSON of a script
 *  file's first line (`// @w3proj {…}`, `-- @w3proj {…}` in Lua). */
type Mode = "json" | "lines" | "frontmatter";

/** Each schema (docs/schemas/<name>.schema.json) and the project files it is for: by name (`files`, any folder but
 *  .w3proj, case ignored) or by path (`path`, against "/" + the path relative to the project, "/" separators). `code`:
 *  a format defined in code (crates/w3proj/src), not by a definition (crates/w3proj/formats/<name>.json). */
interface Kind { name: string; files?: string[]; path?: RegExp; mode?: Mode; code?: true }
const SCHEMAS: Kind[] = [
  { name: "w3i", files: ["war3map.w3i.json"] },
  { name: "doodads", files: ["war3map.doo.json"] },
  { name: "units", files: ["war3mapunits.doo.json"] },
  { name: "regions", files: ["war3map.w3r.json"] },
  { name: "cameras", files: ["war3map.w3c.json"] },
  { name: "sounds", files: ["war3map.w3s.json"] },
  { name: "imports", files: ["war3map.imp.json", "war3campaign.imp.json"] },
  { name: "campaign", files: ["war3campaign.w3f.json"] },
  { name: "minimap", files: ["war3map.mmp.json"] },
  { name: "lights", files: ["war3map.w3l.json"] },
  { name: "objects", path: /\/map\/[^/]+\.(w3u|w3t|w3b|w3h|w3d|w3a|w3q)\.json$/i, code: true },
  { name: "object-folders", path: /\/map\/objects\/objects\.json$/i, code: true },
  { name: "object-file", path: /\/map\/objects\/(units|items|destructables|doodads|abilities|buffs|upgrades)\/(original|custom)\/[^/]+\.json$/i, code: true },
  { name: "terrain", path: /\/map\/terrain\/terrain\.json$/, code: true },
  { name: "terrain-doodads", path: /\/map\/terrain\/[^/]+\/doodads\.json$/, code: true },
  { name: "terrain-units", path: /\/map\/terrain\/[^/]+\/units\.json$/, code: true },
  { name: "terrain-regions", path: /\/map\/terrain\/[^/]+\/regions\.json$/, code: true },
  { name: "pathing", path: /\/\.w3proj\/pathing\.json$/, code: true },
  { name: "triggers", path: /\/map\/triggers\/triggers\.json$/, code: true },
  { name: "trigger-category", path: /\/map\/triggers\/.+\/_category\.json$/, code: true },
  { name: "trigger-gui", path: /\/map\/triggers\/.+\.gui\.json$/i, code: true },
  { name: "trigger-comment", path: /\/map\/triggers\/.+\.comment\.json$/i, code: true },
  { name: "trigger-variable", path: /\/map\/triggers\/(.+\/)?variables\.json$/, mode: "lines", code: true },
  // The header (header.j, header.lua at the top) has no frontmatter; every other script file of the tree may.
  { name: "trigger-frontmatter", path: /\/map\/triggers\/(?!header\.(j|lua)$).+\.(j|vjass|lua)$/i, mode: "frontmatter", code: true },
];
const DEFINED = SCHEMAS.filter((s) => !s.code);
const CODED = SCHEMAS.filter((s) => s.code);

type Json = Record<string, unknown>;
const schemaDir = () => repoPath("docs", "schemas");
const readSchema = (name: string): Json => JSON.parse(readFileSync(join(schemaDir(), `${name}.schema.json`), "utf8"));
/** A format definition: JSON whose comment lines start with `//` (format/mod.rs). */
const readDefinition = (name: string): Json =>
  JSON.parse(readFileSync(repoPath("crates", "w3proj", "formats", `${name}.json`), "utf8").split(/\r?\n/).filter((l) => !l.trimStart().startsWith("//")).join("\n"));

// Strict about keywords (a misspelt one is an error), not about Ajv's own wish for a `type` beside every `items` or
// `minimum`, or for a `properties` beside every `required` (the version conditions narrow and require what the main
// schema already describes). Every schema is added under its file name, so one can refer to another
// (`doodads.schema.json#/…`), as editors resolve it beside the file.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
let added = false;
const validator = (name: string): ValidateFunction => {
  if (!added) {
    for (const f of readdirSync(schemaDir()).filter((f) => f.endsWith(".schema.json"))) ajv.addSchema(JSON.parse(readFileSync(join(schemaDir(), f), "utf8")), f);
    added = true;
  }
  const v = ajv.getSchema(`${name}.schema.json`);
  if (!v) throw new Error(`no schema ${name}`);
  return v;
};
/** The schema's complaints about `doc`, as text; "" when it passes. */
const problems = (name: string, doc: unknown): string => {
  const v = validator(name);
  return v(doc) ? "" : ajv.errorsText(v.errors, { separator: "; " });
};

/** The schema for a project file (`rel`: its path relative to the project, either separator). */
function schemaFor(rel: string): Kind | undefined {
  const p = "/" + rel.split(sep).join("/");
  const inStore = p.includes("/.w3proj/");
  return SCHEMAS.find((s) => (s.path ? s.path.test(p) : !inStore && s.files!.includes(basename(p).toLowerCase())));
}

/** The JSON a file holds for its schema, each with where it is: the whole file, each line that isn't blank, or the
 *  frontmatter (none when the script file has no `@w3proj` line). Throws on what isn't JSON. */
function documents(file: string, kind: Kind): { at: string; doc: unknown }[] {
  const text = readFileSync(file, "utf8");
  if ((kind.mode ?? "json") === "json") return [{ at: "", doc: JSON.parse(text) }];
  if (kind.mode === "lines") {
    return text.split("\n").map((l, i) => ({ l: l.replace(/\r$/, ""), i })).filter(({ l }) => l.trim() !== "").map(({ l, i }) => ({ at: `:${i + 1}`, doc: JSON.parse(l) }));
  }
  // As trigger_layout.rs split_frontmatter: after a BOM, the marker, then the end of the line, a space, a tab or `{`.
  const first = text.replace(/^\uFEFF/, "").split("\n")[0].replace(/\r$/, "");
  const marker = /\.lua$/i.test(file) ? "-- @w3proj" : "// @w3proj";
  if (!first.startsWith(marker) || !/^($|[ \t{])/.test(first.slice(marker.length))) return [];
  return [{ at: ":1", doc: JSON.parse(first.slice(marker.length).trim()) }];
}

test("docs/schemas holds one schema per format definition and one per code-defined format, each a valid draft 2020-12 schema", () => {
  const defs = readdirSync(repoPath("crates", "w3proj", "formats")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  const schemas = readdirSync(schemaDir()).filter((f) => f.endsWith(".schema.json")).map((f) => f.replace(/\.schema\.json$/, "")).sort();
  assert.deepEqual(DEFINED.map((s) => s.name).sort(), defs, "a schema for each definition");
  assert.deepEqual(schemas, SCHEMAS.map((s) => s.name).sort(), "the definitions' and the code-defined formats' schemas, nothing else");
  // The definitions' schemas share their $defs (copied, so each file stands alone for editors).
  const first = readSchema(defs[0]).$defs;
  for (const name of defs) assert.deepEqual(readSchema(name).$defs, first, `${name}: $defs differ from ${defs[0]}'s`);
  for (const name of schemas) {
    assert.equal(readSchema(name).$schema, "https://json-schema.org/draft/2020-12/schema", name);
    validator(name);
  }
});

/** What a definition node (format/mod.rs, node reference) must look like in its schema; differences go to `out`. */
function compare(node: Json, schema: Json | undefined, path: string, defs: Json, out: string[]): void {
  if (!schema) { out.push(`${path}: not in the schema`); return; }
  if (node.count !== undefined) {
    if (schema.type !== "array") { out.push(`${path}: a list in the definition, ${String(schema.type)} in the schema`); return; }
    if (typeof node.count === "number" && (schema.minItems !== node.count || schema.maxItems !== node.count)) out.push(`${path}: needs exactly ${node.count} items, schema says ${String(schema.minItems)} to ${String(schema.maxItems)}`);
    compare({ ...node, count: undefined }, schema.items as Json | undefined, `${path}[]`, defs, out);
    return;
  }
  const type = String(node.type);
  if (type === "list") { compare(node.item as Json, schema, path, defs, out); return; }
  if (type === "struct") {
    if (schema.type !== "object") { out.push(`${path}: a struct in the definition, ${String(schema.type)} in the schema`); return; }
    const fields = (node.fields as Json[]) ?? [];
    const props = (schema.properties ?? {}) as Record<string, Json>;
    const older = new Set(fields.flatMap((f) => (typeof f.was === "string" ? [f.was.replace(/\[\d+\]$/, "")] : [])));
    for (const f of fields) compare(f, props[String(f.name)], `${path}.${String(f.name)}`, defs, out);
    for (const p of Object.keys(props)) {
      if (!fields.some((f) => f.name === p) && !older.has(p) && !(path === "" && p === "format")) out.push(`${path}.${p}: in the schema, not in the definition`);
    }
    // Always written: no condition, no default, no older name, not a variant (those fall back to `prefer`).
    const required = fields.filter((f) => f.if === undefined && f.default === undefined && f.was === undefined && f.type !== "variant").map((f) => String(f.name));
    if (path === "") required.unshift("format");
    const said = ((schema.required as string[] | undefined) ?? []);
    if ([...required].sort().join() !== [...said].sort().join()) out.push(`${path || "(root)"}: required ${said.join(", ")}; the definition always has ${required.join(", ")}`);
    return;
  }
  if (type === "bytes") {
    if (schema.type !== "string" || schema.pattern !== `^[0-9a-fA-F]{${Number(node.size) * 2}}$`) out.push(`${path}: ${node.size} bytes need a hex string of ${Number(node.size) * 2} digits`);
    return;
  }
  const ref = `#/$defs/${type}`;
  if (schema.$ref === ref) return;
  // Alternatives, each of the type narrowed (w3i's `version`: 18, or 25 to 39).
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0 && schema.anyOf.every((b: Json) => b.$ref === ref)) return;
  // A narrower set of values (`version`'s enum), each of them a valid value of the type.
  const values = "const" in schema ? [schema.const] : Array.isArray(schema.enum) ? schema.enum : null;
  const one = ajv.compile({ $defs: defs, $ref: ref });
  if (!values || !values.every((v) => one(v))) out.push(`${path}: ${type} in the definition; the schema has neither ${ref} nor values of that type`);
}

for (const { name } of DEFINED) {
  test(`the ${name} schema has its definition's fields, types, fixed counts and always-written keys`, () => {
    const def = readDefinition(name), schema = readSchema(name);
    assert.equal((schema.properties as Record<string, Json>).format.const, def.jsonFormat, "format tag");
    const out: string[] = [];
    compare({ type: "struct", fields: def.fields }, schema, "", schema.$defs as Json, out);
    assert.deepEqual(out, []);
  });
}

test("the comparison with the definitions catches a schema that differs (control)", () => {
  const def = readDefinition("regions"), schema = readSchema("regions");
  const regionProps = () => (((schema.properties as Json).regions as Json).items as Json).properties as Record<string, Json>;
  regionProps().index = { $ref: "#/$defs/i32" };
  delete regionProps().sound;
  regionProps().extra = { $ref: "#/$defs/u8" };
  const out: string[] = [];
  compare({ type: "struct", fields: def.fields }, schema, "", schema.$defs as Json, out);
  assert.ok(out.some((p) => p.startsWith(".regions[].index:")), out.join("\n"));
  assert.ok(out.some((p) => p.startsWith(".regions[].sound:")), out.join("\n"));
  assert.ok(out.some((p) => p.startsWith(".regions[].extra:")), out.join("\n"));
});

// ---- the code-defined formats against their codecs' source

/** Reads a source file by its path from the repository root, as it is on disk. */
type ReadSource = (...path: string[]) => string;
const readSource: ReadSource = (...path) => readFileSync(repoPath(...path), "utf8");
/** The text with LF line ends: a Windows checkout (git autocrlf) has CRLF, and the readers below cut at "\n". */
const lf = (text: string) => text.replace(/\r\n?/g, "\n");
const rust = (file: string) => lf(readSource("crates", "w3proj", "src", file));
/** The part of `src` from `from` to the first `to` after it; throws when either isn't there (the codec changed). */
function part(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `codec source lacks ${JSON.stringify(from)}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b >= 0, `codec source lacks ${JSON.stringify(to)} after ${JSON.stringify(from)}`);
  return src.slice(a, b + to.length);
}
/** The quoted strings in the first match of `re`'s first group; throws when `re` doesn't match. */
function strings(src: string, re: RegExp): string[] {
  const m = re.exec(src);
  assert.ok(m, `codec source doesn't match ${re}`);
  return [...m[1].matchAll(/"([^"]*)"/g)].map((s) => s[1]);
}
/** The keys a serde struct reads (`pub struct <name> {…}` in `src`): JSON name, whether it may be left out, and
 *  whether the struct refuses other keys. */
function serdeStruct(src: string, name: string): { keys: string[]; required: string[]; closed: boolean } {
  const start = src.indexOf(`pub struct ${name} {`);
  assert.ok(start >= 0, `no struct ${name}`);
  const attrs = src.slice(src.lastIndexOf("\n\n", start), start);
  const camel = /rename_all = "camelCase"/.test(attrs);
  const body = src.slice(start, src.indexOf("\n}", start));
  const keys: string[] = [], required: string[] = [];
  let pending = "";
  for (const line of body.split("\n").slice(1).map((l) => l.trim())) {
    if (line.startsWith("#[serde(")) { pending += line; continue; }
    const f = /^pub (\w+): (.+),$/.exec(line);
    if (!f) continue;
    const rename = /rename = "([^"]+)"/.exec(pending)?.[1];
    const key = rename ?? (camel ? f[1].replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) : f[1]);
    keys.push(key);
    if (!/\bdefault\b/.test(pending) && !f[2].startsWith("Option<")) required.push(key);
    pending = "";
  }
  return { keys, required, closed: /deny_unknown_fields/.test(attrs) };
}

/** A schema node by a path of keys (`$defs`, `properties`, `items`, …), resolving one local `$ref` at the end. */
function at(schema: Json, ...path: string[]): Json {
  let n: Json = schema;
  for (const k of path) {
    n = n[k] as Json;
    assert.ok(n, `schema has no ${path.join(".")}`);
  }
  return n;
}

/** One object of a code-defined schema against its codec: its keys (all it has, nothing more), the keys it always
 *  needs, and whether it refuses others (`additionalProperties: false` where the codec errs on an unknown key). */
interface Expect { schema: string; node: string[]; keys: string[]; required: string[]; closed: boolean }
function check(e: Expect, schema: Json, out: string[]): void {
  const n = at(schema, ...e.node);
  const where = `${e.schema}:${e.node.join(".") || "(root)"}`;
  const props = Object.keys((n.properties ?? {}) as Json).sort();
  if (props.join() !== [...e.keys].sort().join()) out.push(`${where}: keys ${props.join(", ")}; the codec reads ${[...e.keys].sort().join(", ")}`);
  const said = [...((n.required as string[] | undefined) ?? [])].sort();
  if (said.join() !== [...e.required].sort().join()) out.push(`${where}: required ${said.join(", ")}; the codec needs ${[...e.required].sort().join(", ")}`);
  if ((n.additionalProperties === false) !== e.closed) out.push(`${where}: ${e.closed ? "the codec refuses unknown keys, the schema allows them" : "the codec ignores unknown keys, the schema refuses them"}`);
}

/** What each code-defined schema must say, read from the codecs' source. */
function expectations(read: ReadSource = readSource): Expect[] {
  const out: Expect[] = [];
  const src = (file: string) => lf(read("crates", "w3proj", "src", file));
  const serde = (schema: string, node: string[], src: string, struct: string, extra: string[] = []) => {
    const s = serdeStruct(src, struct);
    out.push({ schema, node, keys: [...s.keys, ...extra], required: [...s.required, ...extra], closed: s.closed });
  };
  // Object data: serde structs (objdata.rs); unknown keys ignored.
  const obj = src("objdata.rs");
  serde("objects", [], obj, "ObjectFile");
  serde("objects", ["$defs", "object"], obj, "Object");
  serde("objects", ["$defs", "object", "properties", "sets", "items"], obj, "Set");
  serde("objects", ["$defs", "mod"], obj, "Mod");
  // The object folders (object_layout.rs): objects.json's keys as parse_root reads them, an object file's as
  // parse_object takes them off (its halves are serde's Half); unknown keys ignored.
  const ol = src("object_layout.rs");
  const halves = strings(ol, /pub const HALVES: \[&str; 2\] = \[([^\]]*)\]/);
  const rootPart = part(ol, "fn parse_root(", "\n}");
  const missing = (code: string) => [...code.matchAll(/has no \\"(\w+)\\""\)\)\)/g)].map((m) => m[1]);
  out.push({ schema: "object-folders", node: [], keys: [...rootPart.matchAll(/v\.get\("(\w+)"\)/g)].map((m) => m[1]), required: missing(rootPart), closed: false });
  out.push({ schema: "object-folders", node: ["properties", "files", "additionalProperties"], keys: halves, required: [], closed: false });
  const objectPart = part(ol, "fn parse_object(", "\n}");
  out.push({ schema: "object-file", node: [], keys: [...[...objectPart.matchAll(/id_of\(&mut m, "(\w+)"\)/g)].map((m) => m[1]), ...halves], required: missing(objectPart), closed: false });
  serde("object-file", ["$defs", "half"], ol, "Half");
  // terrain.json (terrain_layout.rs Layout::parse_unchecked, terrain_objects.rs Heads::parse): every key it lists is
  // needed, the optional ones are named where the object is read; unknown keys are errors.
  const tl = src("terrain_layout.rs"), to = src("terrain_objects.rs"), w3e = src("w3e.rs");
  const top = strings(tl, /const TOP: &\[&str\] *= *&\[([^\]]*)\]/);
  out.push({ schema: "terrain", node: [], keys: [...top, ...strings(tl, /object\(&doc, "the file", TOP, &\[([^\]]*)\]\)/)], required: top, closed: true });
  const corner = [...part(w3e, "const FIELD_NAMES", "];").matchAll(/\("[^"]+", "([^"]+)"\)/g)].map((m) => m[1]);
  out.push({ schema: "terrain", node: ["properties", "defaultCorner"], keys: corner, required: corner, closed: true });
  const doo = strings(tl, /const DOO: &\[&str\] = &\[([^\]]*)\]/);
  out.push({ schema: "terrain", node: ["properties", "dooHeader"], keys: doo, required: doo, closed: true });
  const sub = strings(tl, /const SUB: &\[&str\] = &\[([^\]]*)\]/);
  out.push({ schema: "terrain", node: ["properties", "subterrains", "items"], keys: sub, required: sub, closed: true });
  const heads = part(to, "pub(crate) fn parse(v: &Value, header: Option<&DooHeader>)", "Ok(Heads { doodads, units, regions })");
  out.push({ schema: "terrain", node: ["properties", "objects"], keys: strings(heads, /tl::object\(v, "objects", &\[\], &\[([^\]]*)\]\)/), required: [], closed: true });
  const need = strings(heads, /let mut need = vec!\[([^\]]*)\]/), skin = strings(heads, /tl::object\(v, &what, &need, &\[([^\]]*)\]\)/);
  const special = strings(heads, /doo\("doodads", &\[([^\]]*)\]\)/);
  out.push({ schema: "terrain", node: ["properties", "objects", "properties", "doodads"], keys: [...need, ...special, ...skin], required: [...need, ...special], closed: true });
  assert.match(heads, /doo\("units", &\[\]\)/);
  out.push({ schema: "terrain", node: ["properties", "objects", "properties", "units"], keys: [...need, ...skin], required: need, closed: true });
  const regions = strings(heads, /tl::object\(v, "objects.regions", &\[([^\]]*)\], &\[\]\)/);
  out.push({ schema: "terrain", node: ["properties", "objects", "properties", "regions"], keys: regions, required: regions, closed: true });
  // A subterrain's files: its lists, each needed, nothing else (terrain_objects.rs read_sub, Kind::keys of the flat
  // file and lists()).
  assert.match(to, /Kind::Doodads => &\[List::Main, List::Specials\]/);
  assert.match(part(to, "fn read_sub(", "\n}"), /has an unknown key/);
  out.push({ schema: "terrain-doodads", node: [], keys: ["doodads", "specials"], required: ["doodads", "specials"], closed: true });
  out.push({ schema: "terrain-units", node: [], keys: ["units"], required: ["units"], closed: true });
  out.push({ schema: "terrain-regions", node: [], keys: ["regions"], required: ["regions"], closed: true });
  // .w3proj/pathing.json: the keys the split terrain keeps (terrain_pathing.rs parse_json), the ones the app needs
  // (resize.ts validPathingOverrides); the app keeps keys of its own.
  const pathingKeys = strings(src("terrain_pathing.rs"), /!\[([^\]]*)\]\.contains\(&k\.as_str\(\)\)/);
  const valid = part(lf(read("app", "src", "lib", "terrain", "resize.ts")), "export function validPathingOverrides", "\n}");
  const pathingNeeds = [...valid.matchAll(/(?:Number\.isInteger|Array\.isArray)\(f\.(\w+)\)/g)].map((m) => m[1]);
  out.push({ schema: "pathing", node: [], keys: pathingKeys, required: pathingNeeds, closed: false });
  // The trigger folders (trigger_layout.rs): Obj::new lists the keys a file may have (others are errors); what is
  // needed is read with need_str or "is missing".
  const tr = src("trigger_layout.rs"), wtg = src("wtg.rs");
  const needed = (code: string) => [...new Set([...code.matchAll(/need_str\("(\w+)"\)|\\"(\w+)\\" is missing|has no \\"(\w+)\\"/g)].map((m) => m[1] ?? m[2] ?? m[3]))];
  const root = part(tr, "pub fn from_files_noted(", "let headers:");
  out.push({ schema: "triggers", node: [], keys: strings(root, /Obj::new\(&v, shown\.clone\(\), &\[([^\]]*)\]\)/), required: needed(part(root, "Obj::new(&v, shown.clone()", "let root =")).concat("format"), closed: true });
  const rootItem = part(root, "let root = match", "None => None");
  out.push({ schema: "triggers", node: ["properties", "root"], keys: strings(rootItem, /Obj::new\(r, at, &\[([^\]]*)\]\)/), required: needed(rootItem), closed: true });
  serde("triggers", ["properties", "counts", "items"], wtg, "Count");
  const category = part(tr, "pub(crate) fn parse_category(", "\n}");
  out.push({ schema: "trigger-category", node: [], keys: strings(category, /Obj::new\(&v, shown\.to_string\(\), &\[([^\]]*)\]\)/), required: needed(category), closed: true });
  const variable = part(tr, "pub(crate) fn parse_variable_line(", "\n}");
  assert.match(variable, /Obj::new\(&value, at\.to_string\(\), &VARIABLE_KEYS\)/);
  out.push({ schema: "trigger-variable", node: [], keys: strings(tr, /const VARIABLE_KEYS: \[&str; \d+\] = \[([^\]]*)\]/), required: needed(variable), closed: true });
  const triggerKeys = strings(tr, /const TRIGGER_KEYS: \[&str; \d+\] = \[([^\]]*)\]/);
  const item = part(tr, "pub(crate) fn read_item(", "\n}");
  const json = part(item, "if lower.ends_with(\".gui.json\")", "return Ok((o.u32(\"id\")?, t, text));");
  // A .gui.json has no isCustom and has wctText; a .comment.json has the trigger keys as they are.
  assert.match(json, /keys\.retain\(\|k\| \*k != "isCustom"\);\s*keys\.push\("wctText"\);/);
  out.push({ schema: "trigger-gui", node: [], keys: [...triggerKeys.filter((k) => k !== "isCustom"), "wctText"], required: needed(json), closed: true });
  out.push({ schema: "trigger-comment", node: [], keys: triggerKeys, required: needed(json), closed: true });
  const front = part(item, "let o = Obj::of(&meta", "Ok((o.u32(\"id\")?, t, Some(text)))");
  assert.match(front, /Obj::of\(&meta, format!\("\{shown\}:1"\), &TRIGGER_KEYS\)/);
  out.push({ schema: "trigger-frontmatter", node: [], keys: triggerKeys, required: needed(front), closed: true });
  serde("trigger-gui", ["$defs", "eca"], wtg, "Eca");
  serde("trigger-gui", ["$defs", "param"], wtg, "Param");
  serde("trigger-gui", ["$defs", "call"], wtg, "Call");
  return out;
}

test("the code-defined schemas have the keys their codecs read, the ones they need, and refuse unknown keys where the codecs do", () => {
  const out: string[] = [];
  const list = expectations();
  for (const e of list) check(e, readSchema(e.schema), out);
  assert.deepEqual(out, []);
  // Every code-defined schema is compared, and its format tag is the codec's.
  assert.deepEqual([...new Set(list.map((e) => e.schema))].sort(), CODED.map((s) => s.name).sort());
  const tag = (name: string) => ((readSchema(name).properties as Record<string, Json>).format ?? {}) as Json;
  assert.equal(tag("objects").const, /pub const FORMAT: &str = "([^"]+)"/.exec(rust("objdata.rs"))![1]);
  assert.equal(tag("terrain").const, /pub const FORMAT: &str = "([^"]+)"/.exec(rust("terrain_layout.rs"))![1]);
  assert.match(/pub const FORMAT: &str = "([^"]+)"/.exec(rust("object_layout.rs"))![1], new RegExp(String(tag("object-folders").pattern)));
  assert.equal(tag("pathing").const, /const FORMAT: &str = "([^"]+)"/.exec(rust("terrain_pathing.rs"))![1]);
  const triggers = /pub const FORMAT: &str = "([^"]+)"/.exec(rust("trigger_layout.rs"))![1];
  assert.match(triggers, new RegExp(String(tag("triggers").pattern)));
});

test("the codecs' source reads the same with CRLF line ends (a Windows checkout) as with LF", () => {
  const crlf: ReadSource = (...path) => readSource(...path).replace(/\r?\n/g, "\r\n");
  assert.ok(crlf("crates", "w3proj", "src", "wtg.rs").includes("\r\n\r\n"), "control: the CRLF text has CRLF blank lines");
  assert.deepEqual(expectations(crlf), expectations());
});

test("the comparison with the codecs catches a schema that differs (control)", () => {
  const list = expectations();
  const damaged = (name: string, damage: (s: Json) => void): string[] => {
    const s = readSchema(name);
    damage(s);
    const out: string[] = [];
    for (const e of list.filter((e) => e.schema === name)) check(e, s, out);
    return out;
  };
  const caught = (out: string[], needle: string) =>
    assert.ok(out.some((p) => p.includes(needle)), `expected a line with ${JSON.stringify(needle)}, got ${JSON.stringify(out)}`);
  caught(damaged("terrain", (s) => { delete at(s, "properties", "subterrains", "items", "properties").idRange; }), "subterrains.items: keys");
  caught(damaged("terrain", (s) => { delete at(s, "properties", "defaultCorner").additionalProperties; }), "defaultCorner: the codec refuses");
  caught(damaged("objects", (s) => { (at(s, "$defs", "mod").required as string[]).push("level"); }), "$defs.mod: required");
  caught(damaged("trigger-gui", (s) => { at(s, "properties").isCustom = { type: "boolean" }; }), "trigger-gui:(root): keys");
  caught(damaged("trigger-gui", (s) => { at(s, "$defs", "eca").additionalProperties = true; }), "$defs.eca: the codec refuses");
  caught(damaged("trigger-variable", (s) => { s.required = ["name"]; }), "required name; the codec needs name, type");
  caught(damaged("pathing", (s) => { s.additionalProperties = false; }), "the codec ignores unknown keys");
});

// ---- files

/** Every project file under `dir` a schema is for (not inside .git), with its path relative to `dir`. */
function schemaFiles(dir: string): { file: string; kind: Kind }[] {
  const found: { file: string; kind: Kind }[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== ".git") walk(p); continue; }
      const kind = schemaFor(relative(dir, p));
      if (kind) found.push({ file: p, kind });
    }
  };
  walk(dir);
  return found;
}

/** The problems of every file under `dir` (one line each; `only`: the files, by path relative to `dir`, "/"
 *  separators), and how many documents each schema met. */
function checkFiles(dir: string, counts = new Map<string, number>(), only: (rel: string) => boolean = () => true): string[] {
  const failures: string[] = [];
  for (const { file, kind } of schemaFiles(dir).filter(({ file }) => only(relative(dir, file).split(sep).join("/")))) {
    let docs: { at: string; doc: unknown }[];
    try { docs = documents(file, kind); } catch (e) { failures.push(`${relative(dir, file)}: not JSON: ${String(e)}`); continue; }
    for (const { at: where, doc } of docs) {
      counts.set(kind.name, (counts.get(kind.name) ?? 0) + 1);
      const p = problems(kind.name, doc);
      if (p) failures.push(`${relative(dir, file)}${where}: ${p.slice(0, 400)}`);
    }
  }
  return failures;
}

test("the fixtures' files pass their schemas", () => {
  const counts = new Map<string, number>();
  // The campaign info is in mini-campaign: in a map it would make the map a campaign.
  for (const f of ["mini-map", "mini-campaign", "trigger-folders", "object-folders"]) assert.deepEqual(checkFiles(fixturePath(f), counts), [], f);
  for (const name of ["w3i", "doodads", "units", "regions", "cameras", "sounds", "lights", "imports", "minimap", "campaign", "objects", "object-folders", "object-file", "triggers", "trigger-category", "trigger-gui", "trigger-comment", "trigger-variable", "trigger-frontmatter"]) {
    assert.ok((counts.get(name) ?? 0) > 0, `the fixtures have a ${name} file`);
  }
});

test("files are matched to their schemas by name and place", () => {
  const of = (rel: string) => schemaFor(rel)?.name;
  assert.equal(of("map/war3map.w3u.json"), "objects");
  assert.equal(of("map/war3mapSkin.w3a.json"), "objects");
  assert.equal(of("maps/Chapter1/map/war3map.W3T.json"), "objects");
  assert.equal(of("map/objects/objects.json"), "object-folders");
  assert.equal(of("map/objects/units/custom/H000~8.json"), "object-file");
  assert.equal(of("maps/Chapter1/map/objects/abilities/original/AHbz~c.json"), "object-file");
  assert.equal(of("map/objects/units/custom/order.txt"), undefined);
  assert.equal(of("map/Objects/InventoryItems/x.json"), undefined, "the game's Objects folder holds imports");
  assert.equal(of("map/terrain/terrain.json"), "terrain");
  assert.equal(of("map/terrain/west/doodads.json"), "terrain-doodads");
  assert.equal(of("map/terrain/west/units.json"), "terrain-units");
  assert.equal(of(join("map", "terrain", "west", "regions.json")), "terrain-regions");
  assert.equal(of(".w3proj/pathing.json"), "pathing");
  assert.equal(of(".w3proj/derived/war3map.mmp.json"), undefined, "the derived files' store isn't the project's files");
  assert.equal(of("map/triggers/triggers.json"), "triggers");
  assert.equal(of("map/triggers/Init/_category.json"), "trigger-category");
  assert.equal(of("map/triggers/_category.json"), undefined, "the root has triggers.json, no _category.json");
  assert.equal(of("map/triggers/Init/Melee.gui.json"), "trigger-gui");
  assert.equal(of("map/triggers/Note.comment.json"), "trigger-comment");
  assert.equal(of("map/triggers/variables.json"), "trigger-variable");
  assert.equal(of("map/triggers/Init/variables.json"), "trigger-variable");
  assert.equal(of("map/triggers/Init/Setup.j"), "trigger-frontmatter");
  assert.equal(of("map/triggers/Sys/Lib.lua"), "trigger-frontmatter");
  assert.equal(of("map/triggers/header.j"), undefined);
  assert.equal(of("map/triggers/header.lua"), undefined);
  assert.equal(of("map/triggers/Init/header.j"), "trigger-frontmatter", "a script named header in a folder is a script file");
  assert.equal(of("map/war3map.doo.json"), "doodads");
});

// What unpack wrote on real maps (values the made-up fixtures don't have, and the split terrain they lack), cut to one or two items: light_map.w3m (lights, imports; split with
// `w3proj terrain split`: terrain and its doodads and units), FiresOverEversong (a sound whose distanceCutoff is the
// largest 32-bit float, a version 3 camera) and CSW_Tides_Of_Darkness.w3n (campaign, version 2).
const SAMPLES: Record<string, Json> = {
  lights: { format: "w3proj.lights/1", magic: "W3L!", version: 3, terrainModel: "0009a69d-7244-4493-96d5-fa7af9e82fc9.mdl", unitModel: "2556ed83-50fe-44c4-a469-338f96fde125.mdl", terrainEnabled: 1, unitEnabled: 1, unknown: 0 },
  imports: { format: "w3proj.imports/1", version: 1, files: [{ flags: 29, path: "2556ed83-50fe-44c4-a469-338f96fde125.mdl" }, { flags: 21, path: "0009a69d-7244-4493-96d5-fa7af9e82fc9.mdl" }] },
  sounds: { format: "w3proj.sounds/1", version: 3, sounds: [{ name: "gg_snd_BloodElfTheme", file: "Sound/Music/mp3Music/BloodElfTheme.flac", eaxEffect: "HeroAcksEAX", flags: 14, fadeInRate: 0, fadeOutRate: 0, volume: 127, pitch: 4294967300, pitchVariance: 0.010000001, priority: 1000, channel: 4, minDistance: 100000, maxDistance: 100001, distanceCutoff: 3.4028235e+38, coneInside: 4294967300, coneOutside: 4294967300, coneOutsideVolume: -1, coneOrientation: [4294967300, 4294967300, 4294967300], variableName: "gg_snd_BloodElfTheme", assetLabel: "BloodElfTheme", assetFile: "Sound/Music/mp3Music/BloodElfTheme.flac", dialogueTextKey: -1, dialogueText: "", speakerNameKey: -1, speakerName: "", unknown1: 0, speakerUnitType: "", facialAnimationLabel: "", facialAnimationGroupLabel: "", facialAnimationSetFile: "", unknown2: 1 }] },
  cameras: { format: "w3proj.cameras/1", version: 3, cameras: [{ targetX: 11722.006, targetY: -13743.303, zOffset: 0, rotation: 268.1702, angleOfAttack: 312.36417, distance: 1272.2928, roll: 0, fieldOfView: 70, farZ: 10000, nearZ: 16, localPitch: 0, localYaw: 0, localRoll: 0, dofDistance: 0, dofScale: 0, posAbsoluteZ: 0, name: "Camera 001", trailer: 0 }] },
  campaign: { format: "w3proj.campaign/1", version: 2, campaignVersion: 6187, editorVersion: 6117, name: "TRIGSTR_001", difficulty: "TRIGSTR_002", author: "TRIGSTR_004", description: "TRIGSTR_005", flags: 3, background: -1, backgroundPath: "UI\\Glues\\CampaignScreen\\MENUORCTOD.webm", minimapPath: "UI\\Glues\\CSWBannerSquare.tga", ambientSound: -1, ambientSoundPath: "_HD.w3mod\\UI\\Glues\\CampaignScreen\\MENUORCTODAMB.mp3", fogStyle: -1, fogStartZ: 0, fogEndZ: 0, fogDensity: 0, fogColor: [0, 0, 0, 0], race: 1, unknown: [0], chapters: [{ flags: 3, chapter: "TRIGSTR_008", title: "TRIGSTR_009", map: "WC2OrcAct1.w3x" }], mapOrder: [{ unknown: "", map: "WC2OrcAct1.w3x" }] },
  terrain: {
    format: "w3proj.terrain/1", tileset: "L", customTilesets: 0, ground: ["Ldrt", "Ldro", "Ldrg", "Lrok", "Lgrs", "Lgrd"], cliffs: ["CLdi", "CLgr"], corners: [65, 65], offset: [-4096, -4096], w3eVersion: 12, trailer: "",
    defaultCorner: { height: 0, water: 0, waterBits: 0, texture: 0, textureBits: 0, variation: 4, cliffVariation: 0, cliffTexture: 15, layer: 2, flags: 0 },
    dooHeader: { doodadsVersion: 13, doodadsSubversion: 11, unitsVersion: 13, unitsSubversion: 9, skinIds: false },
    objects: { doodads: { magic: "W3do", specialVersion: 0 }, units: { magic: "W3do" }, regions: { version: 7 } },
    subterrains: [{ name: "main", folder: "main", x: 0, y: 0, w: 65, h: 65, idRange: [10000, 19999] }],
  },
  "terrain-doodads": { doodads: [{ id: "APct", variation: 0, position: [-23.982872, -16.428284, 0], angle: 1.1868238, scale: [1.0549028, 1.0549028, 1.0549028], skinId: "APct", preFlags: 4294967295, flags: 2, life: 255, itemTable: -1, itemSets: [], editorId: 4294967295, trailer: [0, 0, 0], extras: [] }], specials: [{ order: 3, id: "YTlc", z: 0, x: 7, y: 6 }] },
  "terrain-units": { units: [{ order: 1, id: "sloc", variation: 0, position: [-2176, 640, 0], angle: 4.712389, scale: [1, 1, 1], skinId: "sloc", preFlags: 4294967295, flags: 2, player: 0, unknown1: 0, unknown2: 0, hp: -1, mana: -1, itemSets: [], gold: 0, targetAcquisition: 0, level: 0, inventory: [], abilities: [], randomType: 0, randomLevel: "010000", randomClass: 0, color: -1, waygate: -1, editorId: 0, trailer: [0, 0], extras: [] }] },
  "terrain-regions": { regions: [{ left: -128, bottom: -64, right: 64, top: 64, name: "Middle", index: 0, weather: "0x00000000", sound: "", color: { blue: 255, green: 255, red: 255 }, trailer: [0, 0] }] },
};

test("samples of what unpack and a terrain split write on real maps pass their schemas", () => {
  for (const [name, doc] of Object.entries(SAMPLES)) assert.equal(problems(name, doc), "", name);
});

test("what the app writes to .w3proj/pathing.json passes its schema, and so does what the split terrain writes", () => {
  // The app's writer (resize.ts), a key of its own kept; terrain_pathing.rs json_text's form.
  const app = JSON.parse(pathingOverridesText({ format: "w3proj.pathing/1", width: 16, height: 8, cells: [[7, 1, 2, 8], [3, 5, 0, 8]], note: "hand-painted" } as never));
  assert.equal(app.note, "hand-painted");
  assert.equal(problems("pathing", app), "");
  assert.equal(problems("pathing", JSON.parse(pathingOverridesText({ width: 0, height: 0, cells: [] }))), "");
  assert.equal(problems("pathing", JSON.parse("{\n  \"format\": \"w3proj.pathing/1\",\n  \"width\": 16,\n  \"height\": 8,\n  \"cells\": [\n    [6,2,2,8],\n    [15,7,2,0]\n  ]\n}\n")), "");
});

test("broken documents fail their schemas, and keys the codec doesn't know pass where it ignores them", () => {
  const regions = (): Json => JSON.parse(readFileSync(fixturePath("mini-map", "map", "war3map.w3r.json"), "utf8"));
  const region = (doc: Json) => (doc.regions as Json[])[0];
  const broken: [string, string, (d: Json) => void][] = [
    ["regions", "a region without its name", (d) => { delete region(d).name; }],
    ["regions", "a colour past a byte", (d) => { (region(d).color as Json).red = 256; }],
    ["regions", "a version the definition doesn't accept", (d) => { d.version = 6; }],
    ["regions", "a weather id of five letters", (d) => { region(d).weather = "RAlrx"; }],
    ["regions", "a coordinate as text", (d) => { region(d).left = "far left"; }],
    ["regions", "a version 7 region without its trailer", (d) => { d.version = 7; }],
    ["regions", "the zero character in a name", (d) => { region(d).name = "Mid\u0000dle"; }],
    ["regions", "another format's tag", (d) => { d.format = "w3proj.cameras/1"; }],
  ];
  for (const [name, what, damage] of broken) {
    const doc = regions();
    damage(doc);
    assert.notEqual(problems(name, doc), "", what);
  }
  const camera = (): Json => structuredClone(SAMPLES.cameras);
  const cam = (d: Json) => (d.cameras as Json[])[0];
  for (const [what, damage] of [
    ["a version 3 camera without its type", (d: Json) => { delete cam(d).trailer; }],
    ["a version 3 camera without its depth of field", (d: Json) => { delete cam(d).dofScale; }],
    ["a version 0 camera without local angles", (d: Json) => { d.version = 0; delete cam(d).localYaw; }],
    ["a float as hex of seven digits", (d: Json) => { cam(d).farZ = "f32:0x4f80000"; }],
    // Halfway between the largest float and 2^128 rounds to infinity, which the codec refuses.
    ["a float past the 32-bit range", (d: Json) => { cam(d).farZ = 3.4028235677973366e38; }],
  ] as const) {
    const doc = camera();
    damage(doc);
    assert.notEqual(problems("cameras", doc), "", what);
  }
  const campaign = structuredClone(SAMPLES.campaign);
  delete campaign.unknown;
  assert.notEqual(problems("campaign", campaign), "", "a version 2 campaign without its extra number");
  const sounds = structuredClone(SAMPLES.sounds);
  delete (sounds.sounds as Json[])[0].facialAnimationSetFile;
  assert.notEqual(problems("sounds", sounds), "", "a version 3 sound without a field of version 3");
  (sounds as Json).version = 2;
  assert.equal(problems("sounds", sounds), "", "version 2 has no facial animation");
  // What the codec reads too: an older name (`unknown` for the depth of field), version 0 without local angles, extra keys.
  const older = camera();
  const c = cam(older);
  c.unknown = [c.dofDistance, c.dofScale, c.posAbsoluteZ];
  delete c.dofDistance; delete c.dofScale; delete c.posAbsoluteZ;
  assert.equal(problems("cameras", older), "");
  const classic = camera();
  classic.version = 0; classic.localAngles = false;
  for (const k of ["localPitch", "localYaw", "localRoll", "dofDistance", "dofScale", "posAbsoluteZ", "trailer"]) delete cam(classic)[k];
  assert.equal(problems("cameras", classic), "");
  const extra = regions();
  extra.$schema = "../../docs/schemas/regions.schema.json";
  region(extra).note = "kept by nobody, refused by nobody";
  assert.equal(problems("regions", extra), "");
});

test("broken documents of the code-defined formats fail their schemas; what their codecs read passes", () => {
  const fixture = (...p: string[]): Json => JSON.parse(readFileSync(fixturePath(...p), "utf8"));
  const objects = () => fixture("mini-map", "map", "war3map.w3u.json");
  const mod = (d: Json) => ((((d.original as Json[])[0]).mods as Json[])[0]);
  const triggers = () => fixture("trigger-folders", "map", "triggers", "triggers.json");
  const gui = () => fixture("mini-map", "map", "triggers", "Foo_Setup", "Foo_Init.gui.json");
  const eca = (d: Json, i = 1) => (d.ecas as Json[])[i];
  const sample = (name: string) => structuredClone(SAMPLES[name]);
  const sub = (d: Json) => (d.subterrains as Json[])[0];
  const corner = (d: Json) => d.defaultCorner as Json;
  const pathing = (): Json => ({ format: "w3proj.pathing/1", width: 4, height: 4, cells: [[1, 2, 3, 4]] });
  // The first lines of the fixtures' variables.json and Damage_Engine.j, through the test's own readers.
  const variable = (): Json => documents(fixturePath("trigger-folders", "map", "triggers", "variables.json"), SCHEMAS.find((s) => s.name === "trigger-variable")!)[0].doc as Json;
  const frontmatter = (): Json => documents(fixturePath("trigger-folders", "map", "triggers", "Systems", "Damage_Engine.j"), SCHEMAS.find((s) => s.name === "trigger-frontmatter")!)[0].doc as Json;
  const fails: [string, string, () => Json, (d: Json) => void][] = [
    ["objects", "a version the codec doesn't read", objects, (d) => { d.version = 4; }],
    ["objects", "an object without its base", objects, (d) => { delete (d.original as Json[])[0].base; }],
    ["objects", "an int change holding a real", objects, (d) => { Object.assign(mod(d), { type: "int", value: 1.5 }); }],
    ["objects", "an int change past 32 bits", objects, (d) => { Object.assign(mod(d), { type: "int", value: 2147483648 }); }],
    ["objects", "a real change past the 32-bit float range", objects, (d) => { Object.assign(mod(d), { type: "real", value: 1e39 }); }],
    ["objects", "a string change holding a number", objects, (d) => { mod(d).value = 7; }],
    ["objects", "a change of an unknown type", objects, (d) => { mod(d).type = "bool"; }],
    ["objects", "sets in version 2", objects, (d) => { d.version = 2; (d.original as Json[])[0].sets = [{ flag: 1, mods: [] }]; }],
    ["terrain", "an unknown key", () => sample("terrain"), (d) => { d.note = 1; }],
    ["terrain", "a w3e version the layout doesn't read", () => sample("terrain"), (d) => { d.w3eVersion = 13; }],
    ["terrain", "a tileset of two letters", () => sample("terrain"), (d) => { d.tileset = "LL"; }],
    ["terrain", "a tile id of five letters", () => sample("terrain"), (d) => { (d.ground as string[])[0] = "Ldrtx"; }],
    ["terrain", "an offset with a decimal point", () => sample("terrain"), (d) => { d.offset = [-4096.5, 0]; }],
    ["terrain", "a trailer of odd length", () => sample("terrain"), (d) => { d.trailer = "abc"; }],
    ["terrain", "a corner's cliff texture past 15", () => sample("terrain"), (d) => { corner(d).cliffTexture = 16; }],
    ["terrain", "a corner without its layer", () => sample("terrain"), (d) => { delete corner(d).layer; }],
    ["terrain", "texture bits in version 11", () => sample("terrain"), (d) => { d.w3eVersion = 11; corner(d).textureBits = 1; }],
    ["terrain", "no subterrain", () => sample("terrain"), (d) => { d.subterrains = []; }],
    ["terrain", "an empty subterrain", () => sample("terrain"), (d) => { sub(d).w = 0; }],
    ["terrain", "a folder with a slash", () => sample("terrain"), (d) => { sub(d).folder = "a/b"; }],
    ["terrain", "a folder ending in a dot", () => sample("terrain"), (d) => { sub(d).folder = "main."; }],
    ["terrain", "a blank subterrain name", () => sample("terrain"), (d) => { sub(d).name = "  "; }],
    ["terrain", "an empty list of id ranges", () => sample("terrain"), (d) => { sub(d).idRange = []; }],
    ["terrain", "an id range of three numbers", () => sample("terrain"), (d) => { sub(d).idRange = [1, 2, 3]; }],
    ["terrain", "objects without dooHeader", () => sample("terrain"), (d) => { delete d.dooHeader; }],
    ["terrain", "an unknown key in objects.units", () => sample("terrain"), (d) => { ((d.objects as Json).units as Json).version = 8; }],
    ["terrain-doodads", "no specials list", () => sample("terrain-doodads"), (d) => { delete d.specials; }],
    ["terrain-doodads", "an unknown key at the top", () => sample("terrain-doodads"), (d) => { d.version = 13; }],
    ["terrain-doodads", "a negative order", () => sample("terrain-doodads"), (d) => { (d.specials as Json[])[0].order = -1; }],
    ["terrain-doodads", "a doodad without its id", () => sample("terrain-doodads"), (d) => { delete (d.doodads as Json[])[0].id; }],
    ["terrain-units", "a unit whose position has two numbers", () => sample("terrain-units"), (d) => { (d.units as Json[])[0].position = [1, 2]; }],
    ["terrain-units", "a unit of random type 1 without its group", () => sample("terrain-units"), (d) => { (d.units as Json[])[0].randomType = 1; }],
    ["terrain-regions", "a region whose order is text", () => sample("terrain-regions"), (d) => { (d.regions as Json[])[0].order = "1"; }],
    ["terrain-regions", "the flat file's header", () => sample("terrain-regions"), (d) => { d.format = "w3proj.regions/1"; }],
    ["pathing", "a cell of three numbers", pathing, (d) => { (d.cells as number[][])[0].pop(); }],
    ["pathing", "a set past a byte", pathing, (d) => { (d.cells as number[][])[0][2] = 256; }],
    ["pathing", "a negative x", pathing, (d) => { (d.cells as number[][])[0][0] = -1; }],
    ["pathing", "a width with a fraction", pathing, (d) => { d.width = 4.5; }],
    ["pathing", "no cells", pathing, (d) => { delete d.cells; }],
    ["pathing", "another format", pathing, (d) => { d.format = "w3proj.pathing/2"; }],
    ["triggers", "a newer major format", triggers, (d) => { d.format = "w3proj.triggers/2"; }],
    ["triggers", "an unknown key", triggers, (d) => { d.note = ""; }],
    ["triggers", "no reforged flag", triggers, (d) => { delete d.reforged; }],
    ["triggers", "an unknown script mode", triggers, (d) => { d.script = "made"; }],
    ["triggers", "seven counters", triggers, (d) => { (d.counts as Json[]).pop(); }],
    ["triggers", "a root without its name", triggers, (d) => { delete (d.root as Json).name; }],
    ["trigger-category", "a folder of type 8", () => fixture("mini-map", "map", "triggers", "Foo_Setup", "_category.json"), (d) => { d.type = 8; }],
    ["trigger-gui", "a GUI trigger of type 16", gui, (d) => { d.type = 16; }],
    ["trigger-gui", "isCustom in a GUI trigger", gui, (d) => { d.isCustom = true; }],
    ["trigger-gui", "an ECA without its children", gui, (d) => { delete eca(d).children; }],
    ["trigger-gui", "an unknown key in a parameter", gui, (d) => { ((eca(d).params as Json[])[0]).note = 1; }],
    ["trigger-gui", "a called function without hasParams", gui, (d) => { delete (((eca(d).params as Json[])[1]).call as Json).hasParams; }],
    ["trigger-gui", "the zero character in a function's name", gui, (d) => { eca(d).name = "Is\u0000Ready"; }],
    ["trigger-comment", "a comment of type 8", () => fixture("mini-map", "map", "triggers", "Foo_Setup", "A_note.comment.json"), (d) => { d.type = 8; }],
    ["trigger-variable", "a variable without its type", variable, (d) => { delete d.type; }],
    ["trigger-variable", "a name of two lines", variable, (d) => { d.name = "a\nb"; }],
    ["trigger-variable", "an empty name", variable, (d) => { d.name = ""; }],
    ["trigger-variable", "an array size past 32 bits", variable, (d) => { d.arraySize = 4294967296; }],
    ["trigger-variable", "an unknown key", variable, (d) => { d.note = 1; }],
    ["trigger-frontmatter", "no type", frontmatter, (d) => { delete d.type; }],
    ["trigger-frontmatter", "a script file of type 16", frontmatter, (d) => { d.type = 16; }],
    ["trigger-frontmatter", "a custom-text trigger that isn't custom", frontmatter, (d) => { d.type = 8; d.isCustom = false; }],
  ];
  for (const [name, what, make, damage] of fails) {
    const doc = make();
    assert.equal(problems(name, doc), "", `${name}: what "${what}" starts from passes`);
    damage(doc);
    assert.notEqual(problems(name, doc), "", `${name}: ${what}`);
  }
  // What the codecs read too.
  const passes: [string, string, Json][] = [
    ["objects", "an original object without id and end, a real given as a whole number", { format: "w3proj.objects/1", version: 3, original: [{ base: "hfoo", mods: [{ field: "usca", type: "real", value: 2 }] }], custom: [], note: "ignored" }],
    ["objects", "sets in version 3, level and data", { format: "w3proj.objects/1", version: 3, original: [], custom: [{ base: "AHbz", id: "A000", sets: [{ flag: 1, mods: [{ field: "Hbz1", type: "unreal", level: 1, data: 1, value: 0.5, end: "0x00000000" }] }] }] }],
    ["terrain", "id ranges as a list, a non-integer offset as bits, no objects", Object.assign(sample("terrain"), { offset: ["bits:c5800001", -4096], objects: undefined, dooHeader: undefined, subterrains: [{ name: "main", folder: "main", x: 0, y: 0, w: 65, h: 65, idRange: [[10000, 19999], [30000, 39999]] }] })],
    ["pathing", "a file of an older version, without its format", { width: 4, height: 4, cells: [[0, 0, 1, 0]] }],
    ["triggers", "a classic tree: no root, no counts, a later minor format", { format: "w3proj.triggers/1.1", reforged: false, version: 4, wctVersion: 0 }],
    ["trigger-gui", "the least a GUI trigger needs", { name: "T" }],
    ["trigger-frontmatter", "a script item that isn't custom", { type: 32, name: "Lib", isCustom: false }],
  ];
  for (const [name, what, doc] of passes) assert.equal(problems(name, JSON.parse(JSON.stringify(doc))), "", `${name}: ${what}`);
});

/** The release CLI (W3PROJ_BIN, else this checkout's or the main checkout's release build) and the corpus folder. */
function corpusAndCli(): { bin: string; corpus: string } | string {
  const where = mainCheckout();
  if (!where) return "not in a git checkout";
  const exe = `w3proj${process.platform === "win32" ? ".exe" : ""}`;
  const bin = [process.env.W3PROJ_BIN, join(where.repo, "target", "release", exe), join(where.main, "target", "release", exe)].find((p) => p && existsSync(p));
  const corpus = process.env.W3PROJ_CORPUS ?? join(where.main, "smoketest_maps");
  if (!bin) return "no release CLI (cargo build --release -p w3proj-cli)";
  if (!existsSync(corpus)) return `no corpus at ${corpus}`;
  return { bin, corpus };
}

/** The maps and campaigns under `dir`; folders that are projects already (a w3proj.toml) are left alone. */
function corpusMaps(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (existsSync(join(d, "w3proj.toml"))) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(w3x|w3m|w3n)$/i.test(e.name) && statSync(p).size > 0) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

const run = (bin: string, args: string[]) => new Promise<{ code: number | null; err: string }>((resolve) => {
  const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (b: Buffer) => { if (err.length < 4000) err += b.toString(); });
  child.on("error", (e) => resolve({ code: -1, err: e.message }));
  child.on("close", (code) => resolve({ code, err }));
});

test("every file unpack and a terrain split write for the corpus maps passes its schema", { timeout: 30 * 60_000 }, async (ctx) => {
  // The commit tier (W3PROJ_GAME="") leaves the corpus to the corpus tier, as the game-file tests do.
  if (process.env.W3PROJ_GAME === "" && !corpusRequired()) { ctx.skip("the corpus part runs in the gate's corpus tier"); return; }
  const found = corpusAndCli();
  if (typeof found === "string") { skipOrFail(ctx, found); return; }
  const maps = corpusMaps(found.corpus);
  assert.ok(maps.length > 0, `no maps under ${found.corpus}`);
  // With the game, unpack splits the triggers into folders (it needs the game's TriggerData); without it they stay raw.
  const game = gameCli()?.install[1];
  const scratch = mkdtempSync(join(tmpdir(), "w3-schemas-"));
  const failures: string[] = [], unsplit: string[] = [], counts = new Map<string, number>();
  try {
    let next = 0;
    const worker = async (slot: number) => {
      for (let i = next++; i < maps.length; i = next++) {
        const project = join(scratch, `p${slot}`);
        rmSync(project, { recursive: true, force: true });
        const r = await run(found.bin, ["unpack", "--game", game ?? "none", "--allow-incomplete", maps[i], project]);
        if (r.code !== 0) { failures.push(`${maps[i]}: unpack exit ${r.code}: ${r.err.trim()}`); continue; }
        // The flat files, then the same map split into one subterrain (a campaign has no terrain of its own; a map
        // whose placed objects stayed raw can't be split, and that is no schema's business).
        for (const f of checkFiles(project, counts)) failures.push(`${maps[i]}: ${f}`);
        if (existsSync(join(project, "map", "war3map.w3e.txt"))) {
          const split = await run(found.bin, ["terrain", "split", project]);
          if (split.code === 0) for (const f of checkFiles(project, counts, (rel) => rel.startsWith("map/terrain/"))) failures.push(`${maps[i]} (split): ${f}`);
          else unsplit.push(`${basename(maps[i])}: ${(split.err.trim().split("\n").pop() ?? "").replace(/^.*?: map\//, "map/").slice(0, 160)}`);
        }
        rmSync(project, { recursive: true, force: true });
      }
    };
    await Promise.all([0, 1, 2, 3].map(worker));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  ctx.diagnostic(`${maps.length} maps; documents per schema: ${[...counts].sort().map(([k, n]) => `${k} ${n}`).join(", ")}`);
  if (unsplit.length) ctx.diagnostic(`${unsplit.length} maps not split: ${unsplit.join("; ")}`);
  assert.deepEqual(failures.slice(0, 30), [], `${failures.length} failures`);
  // Every schema meets a file, but the pathing overrides (only the app's Pathing tool writes them), the flat object
  // files (unpack writes map/objects/; the flat form is the app's view of it and the fixtures') and, without the game,
  // the trigger folders.
  for (const { name } of SCHEMAS) {
    if (name === "pathing" || name === "objects" || (!game && (name === "triggers" || name.startsWith("trigger-")))) continue;
    assert.ok((counts.get(name) ?? 0) > 0, `the corpus gave no ${name} file`);
  }
});
