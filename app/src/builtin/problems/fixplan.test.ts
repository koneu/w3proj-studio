import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseFolder, mergedValues, modelExists, modelFieldValue, planImports, planModelEdit, serialQueue, textureLacking } from "./fixplan";

const FIELDS = { model: "dfil", variations: "dvar" };
const entry = (base: string, model: string, extra: { field: string; type: string; level: number; data: number; value: number }[] = []) => ({ base, mods: [{ field: "dfil", type: "string", level: 0, data: 0, value: model }, ...extra] });
const docOf = (original: object[], custom: object[] = []) => JSON.stringify({ version: 3, original, custom });
const plan = (over: Record<string, unknown>) => planModelEdit({ kind: "w3d", base: "LCcb", id: "LCcb", model: "m\\New", variations: 1, fields: FIELDS, main: docOf([]), mainRaw: false, skin: null, ...over } as never);

test("the edit changes the one type it was made for and nothing else", () => {
  const a = entry("YOig", "iron"), b = entry("LCcb", "bridge");
  const before = JSON.stringify([a, b]);
  const { main } = plan({ base: "YOig", id: "YOig", main: docOf([b, a]) });
  assert.equal(main.original.find((o) => o.base === "YOig")!.mods!.find((m) => m.field === "dfil")!.value, "m\\New");
  // Control: the other type's entry is as it was, byte for byte.
  assert.equal(JSON.stringify(main.original.filter((o) => o.base === "LCcb")), JSON.stringify([b]));
  assert.notEqual(JSON.stringify(main.original), before);
});

test("a map with no object data gets a new file in the project's format", () => {
  const doc = plan({ main: null }).main;
  assert.equal(doc.format, "w3proj.objects/1");
  assert.equal(doc.version, 3);
});

test("a standard type becomes a modified original; a custom type keeps its own entry", () => {
  assert.deepEqual(plan({}).main.original.map((o) => o.base), ["LCcb"]);
  const custom = { base: "LCcb", id: "x001", mods: [] };
  const { main } = plan({ id: "x001", main: docOf([], [custom]) });
  assert.equal(main.original.length, 0);
  assert.equal(main.custom[0].mods![0].value, "m\\New");
  assert.throws(() => plan({ id: "x002", main: docOf([], [custom]) }), /not in/);
});

test("the skin file's own model field is changed too, or it would win", () => {
  const skin = docOf([entry("LCcb", "old", [{ field: "dvar", type: "int", level: 0, data: 0, value: 4 }])]);
  const r = plan({ variations: 1, skin });
  assert.equal(r.skin!.original[0].mods!.find((m) => m.field === "dfil")!.value, "m\\New");
  assert.equal(r.skin!.original[0].mods!.find((m) => m.field === "dvar")!.value, 1);
  // Control: a skin entry that sets no model is left alone.
  assert.equal(plan({ skin: docOf([{ base: "LCcb", mods: [{ field: "dnam", type: "string", value: "x" }] }]) }).skin, null);
});

test("a raw or unreadable file is refused before anything is written", () => {
  assert.throws(() => plan({ main: null, mainRaw: true }), /kept raw/);
  assert.throws(() => plan({ main: "{ not json" }), /can't be read/);
  assert.throws(() => plan({ main: "{}" }), /can't be read/);
  assert.throws(() => plan({ skin: "oops" }), /Skin/);
});

test("item models are named with .mdl, units and doodads without", () => {
  assert.equal(modelFieldValue("w3t", "a\\b"), "a\\b.mdl");
  assert.equal(modelFieldValue("w3t", "a\\b.mdx"), "a\\b.mdl");
  assert.equal(modelFieldValue("w3u", "a\\b"), "a\\b");
  assert.equal(modelFieldValue("w3d", "a\\b.mdl"), "a\\b");
});

test("imports: new names are added once; a raw list is flagged; garbage refused", () => {
  const r = planImports(null, null, ["a\\x.blp", "A\\X.blp"]);
  assert.deepEqual(r.doc.files, [{ flags: 21, path: "a\\x.blp" }]);
  const existing = JSON.stringify({ version: 1, files: [{ flags: 21, path: "a\\x.blp" }] });
  assert.equal(planImports(existing, null, ["a\\X.blp"]).doc.files.length, 1);
  assert.equal(planImports(null, existing, ["b"]).asRaw, true);
  assert.throws(() => planImports("{ nope", null, ["b"]), /can't be read/);
});

test("two models with one file name get two folders, the same conversion twice one", async () => {
  const map = new Map<string, Uint8Array>();
  const build = (bytes: number[]) => async (dir: string) => new Map([[`${dir}\\Tree0.mdx`, new Uint8Array(bytes)]]);
  const existing = async (a: string) => map.get(a.toLowerCase()) ?? null;
  const first = await chooseFolder("Tree", build([1]), existing);
  assert.equal(first.dir, "war3mapImported\\Classic\\Tree");
  for (const [k, v] of first.files) map.set(k.toLowerCase(), v);
  const other = await chooseFolder("Tree", build([2]), existing);
  assert.equal(other.dir, "war3mapImported\\Classic\\Tree_2");
  assert.equal((await chooseFolder("Tree", build([1]), existing)).dir, "war3mapImported\\Classic\\Tree");
});

test("fixes run one after the other, also after a failure", async () => {
  const q = serialQueue();
  const log: string[] = [];
  const task = (n: string, ms: number, fail = false) => () => new Promise<string>((res, rej) => {
    log.push(`start ${n}`);
    setTimeout(() => { log.push(`end ${n}`); fail ? rej(new Error(n)) : res(n); }, ms);
  });
  const a = q(task("a", 30, true)), b = q(task("b", 1));
  await assert.rejects(a);
  assert.equal(await b, "b");
  assert.deepEqual(log, ["start a", "end a", "start b", "end b"]);
});

test("variations: every numbered model has to be there", async () => {
  const files = new Set(["m\\x0.mdx", "m\\x1.mdx", "m\\y0.mdx"]);
  const exists = async (p: string) => files.has(p.toLowerCase());
  assert.equal(await modelExists("m\\X", 2, exists), true);
  assert.equal(await modelExists("m\\X.mdl", 2, exists), true);
  assert.equal(await modelExists("m\\X", 1, exists), false);
  assert.equal(await modelExists("m\\Y", 2, exists), false);
  assert.equal(await modelExists("m\\Z", 2, exists), false);
});

test("the variation count merges the main and the skin file", () => {
  const main = { original: [entry("A", "m", [{ field: "dvar", type: "int", level: 0, data: 0, value: 2 }])] };
  const skin = { original: [{ base: "A", mods: [{ field: "dvar", type: "int", value: 5 }] }], custom: [{ base: "A", id: "x001", mods: [{ field: "dvar", type: "int", value: 3 }] }] };
  const v = mergedValues([main, skin, null], "dvar");
  assert.equal(v.get("A"), "5");
  assert.equal(v.get("x001"), "3");
});

test("a texture the map has itself is not imported over; one both modes have is not imported", () => {
  const stored = (l: string | null, k: string) => l === null ? k === "textures/a.dds" : l === "_hd" && k === "textures/b.dds";
  const no = () => false;
  assert.equal(textureLacking(["Textures/A.dds"], no, ["_hd"], stored), false);
  assert.equal(textureLacking(["Textures/B.dds"], no, ["_hd"], stored), false);
  assert.equal(textureLacking(["Textures/B.dds"], no, ["_hd", "_de"], stored), true);
  assert.equal(textureLacking(["Textures/C.dds"], no, ["_hd"], stored), true);
  // Control: the map's own copy makes it present.
  assert.equal(textureLacking(["Textures/C.dds"], (p) => p === "Textures/C.dds", ["_hd"], stored), false);
});
