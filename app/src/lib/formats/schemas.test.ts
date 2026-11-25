// The JSON Schemas of the unpacked map's JSON files (docs/schemas, README there) against the codecs they describe:
// each schema names the fields, types and required keys of its format definition (crates/w3proj/formats), the
// mini-map's files and samples of what unpack writes pass, broken samples fail, and (with the corpus and the release
// CLI) every file unpack writes for the corpus maps passes.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import { corpusRequired, fixturePath, repoPath, skipOrFail } from "../testhelpers/testutil";
import { mainCheckout } from "../testhelpers/gamefiles";

/** Each schema (docs/schemas/<name>.schema.json), its format definition's name and the project files it is for. */
const SCHEMAS: { name: string; files: string[] }[] = [
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
];

type Json = Record<string, unknown>;
const schemaDir = () => repoPath("docs", "schemas");
const readSchema = (name: string): Json => JSON.parse(readFileSync(join(schemaDir(), `${name}.schema.json`), "utf8"));
/** A format definition: JSON whose comment lines start with `//` (format/mod.rs). */
const readDefinition = (name: string): Json =>
  JSON.parse(readFileSync(repoPath("crates", "w3proj", "formats", `${name}.json`), "utf8").split(/\r?\n/).filter((l) => !l.trimStart().startsWith("//")).join("\n"));

// Strict about keywords (a misspelt one is an error), not about Ajv's own wish for a `type` beside every `items` or
// `minimum`, or for a `properties` beside every `required` (the version conditions narrow and require what the main
// schema already describes).
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
const validators = new Map<string, ValidateFunction>();
const validator = (name: string): ValidateFunction => {
  let v = validators.get(name);
  if (!v) validators.set(name, (v = ajv.compile(readSchema(name))));
  return v;
};
/** The schema's complaints about `doc`, as text; "" when it passes. */
const problems = (name: string, doc: unknown): string => {
  const v = validator(name);
  return v(doc) ? "" : ajv.errorsText(v.errors, { separator: "; " });
};
/** The schema for a project file, by its name (case doesn't matter: maps differ in it). */
const schemaFor = (file: string) => SCHEMAS.find((s) => s.files.includes(basename(file).toLowerCase()))?.name;

test("docs/schemas holds one schema per format definition, each a valid draft 2020-12 schema with the same primitive types", () => {
  const defs = readdirSync(repoPath("crates", "w3proj", "formats")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  const schemas = readdirSync(schemaDir()).filter((f) => f.endsWith(".schema.json")).map((f) => f.replace(/\.schema\.json$/, "")).sort();
  assert.deepEqual(schemas, defs, "a schema for each definition, nothing else");
  assert.deepEqual(SCHEMAS.map((s) => s.name).sort(), defs);
  const first = readSchema(schemas[0]).$defs;
  for (const name of schemas) {
    const s = readSchema(name);
    assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema", name);
    assert.deepEqual(s.$defs, first, `${name}: $defs differ from ${schemas[0]}'s (they are copied so each file stands alone)`);
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

for (const { name } of SCHEMAS) {
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

/** Every project file under `dir` a schema is for (not inside .w3proj or .git). */
function schemaFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== ".w3proj" && e.name !== ".git") walk(p); }
      else if (schemaFor(p)) found.push(p);
    }
  };
  walk(dir);
  return found;
}

test("the mini-map's and the mini-campaign's files pass their schemas", () => {
  const files = [...schemaFiles(fixturePath("mini-map")), ...schemaFiles(fixturePath("mini-campaign"))];
  const seen = new Set(files.map((f) => schemaFor(f)));
  // Every schema has a file: the campaign info is in the mini-campaign (in a map it would make the map a campaign).
  for (const { name } of SCHEMAS) assert.ok(seen.has(name), `the mini-map or the mini-campaign has a ${name} file`);
  for (const f of files) assert.equal(problems(schemaFor(f)!, JSON.parse(readFileSync(f, "utf8"))), "", f);
});

// What unpack wrote on real maps (values the made-up fixtures don't have), cut to one or two items: light_map.w3m (lights, imports),
// FiresOverEversong (a sound whose distanceCutoff is the largest 32-bit float, a version 3 camera) and
// CSW_Tides_Of_Darkness.w3n (campaign, version 2).
const SAMPLES: Record<string, Json> = {
  lights: { format: "w3proj.lights/1", magic: "W3L!", version: 3, terrainModel: "0009a69d-7244-4493-96d5-fa7af9e82fc9.mdl", unitModel: "2556ed83-50fe-44c4-a469-338f96fde125.mdl", terrainEnabled: 1, unitEnabled: 1, unknown: 0 },
  imports: { format: "w3proj.imports/1", version: 1, files: [{ flags: 29, path: "2556ed83-50fe-44c4-a469-338f96fde125.mdl" }, { flags: 21, path: "0009a69d-7244-4493-96d5-fa7af9e82fc9.mdl" }] },
  sounds: { format: "w3proj.sounds/1", version: 3, sounds: [{ name: "gg_snd_BloodElfTheme", file: "Sound/Music/mp3Music/BloodElfTheme.flac", eaxEffect: "HeroAcksEAX", flags: 14, fadeInRate: 0, fadeOutRate: 0, volume: 127, pitch: 4294967300, pitchVariance: 0.010000001, priority: 1000, channel: 4, minDistance: 100000, maxDistance: 100001, distanceCutoff: 3.4028235e+38, coneInside: 4294967300, coneOutside: 4294967300, coneOutsideVolume: -1, coneOrientation: [4294967300, 4294967300, 4294967300], variableName: "gg_snd_BloodElfTheme", assetLabel: "BloodElfTheme", assetFile: "Sound/Music/mp3Music/BloodElfTheme.flac", dialogueTextKey: -1, dialogueText: "", speakerNameKey: -1, speakerName: "", unknown1: 0, speakerUnitType: "", facialAnimationLabel: "", facialAnimationGroupLabel: "", facialAnimationSetFile: "", unknown2: 1 }] },
  cameras: { format: "w3proj.cameras/1", version: 3, cameras: [{ targetX: 11722.006, targetY: -13743.303, zOffset: 0, rotation: 268.1702, angleOfAttack: 312.36417, distance: 1272.2928, roll: 0, fieldOfView: 70, farZ: 10000, nearZ: 16, localPitch: 0, localYaw: 0, localRoll: 0, dofDistance: 0, dofScale: 0, posAbsoluteZ: 0, name: "Camera 001", trailer: 0 }] },
  campaign: { format: "w3proj.campaign/1", version: 2, campaignVersion: 6187, editorVersion: 6117, name: "TRIGSTR_001", difficulty: "TRIGSTR_002", author: "TRIGSTR_004", description: "TRIGSTR_005", flags: 3, background: -1, backgroundPath: "UI\\Glues\\CampaignScreen\\MENUORCTOD.webm", minimapPath: "UI\\Glues\\CSWBannerSquare.tga", ambientSound: -1, ambientSoundPath: "_HD.w3mod\\UI\\Glues\\CampaignScreen\\MENUORCTODAMB.mp3", fogStyle: -1, fogStartZ: 0, fogEndZ: 0, fogDensity: 0, fogColor: [0, 0, 0, 0], race: 1, unknown: [0], chapters: [{ flags: 3, chapter: "TRIGSTR_008", title: "TRIGSTR_009", map: "WC2OrcAct1.w3x" }], mapOrder: [{ unknown: "", map: "WC2OrcAct1.w3x" }] },
};

test("samples of what unpack writes on real maps pass their schemas", () => {
  for (const [name, doc] of Object.entries(SAMPLES)) assert.equal(problems(name, doc), "", name);
});

test("broken documents fail their schemas, and keys the codec doesn't know pass", () => {
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

test("every file unpack writes for the corpus maps passes its schema", { timeout: 20 * 60_000 }, async (ctx) => {
  // The commit tier (W3PROJ_GAME="") leaves the corpus to the corpus tier, as the game-file tests do.
  if (process.env.W3PROJ_GAME === "" && !corpusRequired()) { ctx.skip("the corpus part runs in the gate's corpus tier"); return; }
  const found = corpusAndCli();
  if (typeof found === "string") { skipOrFail(ctx, found); return; }
  const maps = corpusMaps(found.corpus);
  assert.ok(maps.length > 0, `no maps under ${found.corpus}`);
  const scratch = mkdtempSync(join(tmpdir(), "w3-schemas-"));
  const failures: string[] = [], counts = new Map<string, number>();
  try {
    let next = 0;
    const worker = async (slot: number) => {
      for (let i = next++; i < maps.length; i = next++) {
        const project = join(scratch, `p${slot}`);
        rmSync(project, { recursive: true, force: true });
        const r = await run(found.bin, ["unpack", "--game", "none", "--allow-incomplete", maps[i], project]);
        if (r.code !== 0) { failures.push(`${maps[i]}: unpack exit ${r.code}: ${r.err.trim()}`); continue; }
        for (const f of schemaFiles(project)) {
          const name = schemaFor(f)!;
          counts.set(name, (counts.get(name) ?? 0) + 1);
          let doc: unknown;
          try { doc = JSON.parse(readFileSync(f, "utf8")); } catch (e) { failures.push(`${maps[i]}: ${f.slice(project.length)}: not JSON: ${String(e)}`); continue; }
          const p = problems(name, doc);
          if (p) failures.push(`${maps[i]}: ${f.slice(project.length)}: ${p.slice(0, 400)}`);
        }
        rmSync(project, { recursive: true, force: true });
      }
    };
    await Promise.all([0, 1, 2, 3].map(worker));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.deepEqual(failures.slice(0, 30), [], `${failures.length} failures`);
  for (const { name } of SCHEMAS) assert.ok((counts.get(name) ?? 0) > 0, `the corpus gave no ${name} file`);
});
