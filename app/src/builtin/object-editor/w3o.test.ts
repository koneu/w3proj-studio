// .w3o in the app: what goes in, what is merged, and the commands, on a made-up project. The
// binary layout itself is tested in Rust (crates/w3proj/src/w3o.rs).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import type { EditFile, EditObject } from "./objectedit";
import { describeImport, exportParts, onlyObjects, planImport } from "./w3o";
import { exportAllObjectData, exportObjects, importObjectData } from "./w3ofiles";

const mod = (field: string, value: string | number) => ({ field, type: typeof value === "number" ? "int" : "string", value });
const file = (version: number, original: EditObject[], custom: EditObject[]): EditFile => ({ format: "w3proj.objects/1", version, original, custom });
const unit = (id: string, name: string): EditObject => ({ base: "hfoo", id, mods: [mod("unam", name)] });
const std = (base: string, hp: number): EditObject => ({ base, mods: [mod("uhpm", hp)] });
const untouched: EditObject = { base: "hpea", mods: [] };
const bare = (base: string, id: string): EditObject => ({ base, id, mods: [] });
const old1 = (base: string, id: string): EditObject => ({ base, id, end: id, mods: [] });

test("export holds the kinds that have something, in file order, with a changed game object but not an untouched one", () => {
  const parts = exportParts({
    w3q: file(3, [], [bare("Rhme", "R000")]),
    w3u: file(3, [std("hfoo", 500), untouched], [unit("h000", "Mine")]),
    w3a: file(3, [untouched], []),
    w3t: null,
  }, () => null);
  assert.deepEqual(parts.map((p) => p.kind), ["w3u", "w3q"]);
  assert.deepEqual(parts[0].file.original.map((o) => o.base), ["hfoo"]);
  assert.equal(parts[0].file.custom[0].id, "h000");
});

test("texts of the map's string table go out as the text they stand for", () => {
  const parts = exportParts({ w3u: file(3, [], [unit("h000", "TRIGSTR_007")]) }, (v) => (v === "TRIGSTR_007" ? "Captain" : null));
  assert.equal(parts[0].file.custom[0].mods![0].value, "Captain");
});

test("onlyObjects keeps exactly the given objects", () => {
  const a = unit("h000", "A"), b = unit("h001", "B"), s = std("hfoo", 1);
  const f = file(3, [s, std("hpea", 2)], [a, b]);
  const one = onlyObjects(f, [b, s]);
  assert.deepEqual([one.custom.map((o) => o.id), one.original.map((o) => o.base)], [["h001"], ["hfoo"]]);
  assert.equal(one.version, 3);
});

test("importing merges by id and base, counts what was added and replaced", () => {
  const have = file(3, [std("hfoo", 400)], [unit("h000", "Old"), unit("h001", "Keep")]);
  const plan = planImport({ w3u: have, w3a: null }, [
    { kind: "w3u", file: file(3, [std("hfoo", 999), std("hkni", 5)], [unit("h000", "New"), unit("h002", "Extra")]) },
    { kind: "w3a", file: file(1, [], [old1("AHbz", "A000")]) },
  ]);
  const u = plan.writes[0];
  assert.deepEqual([u.added, u.replaced], [2, 2]);
  assert.deepEqual(u.file.custom.map((o) => [o.id, o.mods![0].value]), [["h000", "New"], ["h001", "Keep"], ["h002", "Extra"]]);
  assert.deepEqual(u.file.original.map((o) => [o.base, o.mods![0].value]), [["hfoo", 999], ["hkni", 5]]);
  assert.equal(have.custom[0].mods![0].value, "Old", "the map's own data isn't changed by planning");
  // A kind the map has nothing of takes the file's version.
  assert.equal(plan.writes[1].file.version, 1);
  assert.equal(describeImport(plan), "4 units (2 replaced), 1 abilities");
});

test("another object data version is refused, and then nothing at all is planned", () => {
  const have = file(3, [], [unit("h000", "Old")]);
  assert.throws(() => planImport({ w3u: have, w3t: null }, [
    { kind: "w3t", file: file(3, [], [bare("ratf", "I000")]) },
    { kind: "w3u", file: file(1, [], [old1("hfoo", "h009")]) },
  ]), /version 3, the file's version 1/);
  // An empty file of the map doesn't hold the kind back.
  assert.equal(planImport({ w3u: file(3, [], []) }, [{ kind: "w3u", file: file(1, [], [old1("hfoo", "h009")]) }]).writes[0].file.version, 1);
});

interface Options { unsaved?: string[]; confirm?: boolean; pick?: string | null; save?: string | null; w3o?: { kind: string; text: string }[] }

/** A project in memory with the backend calls the commands make. */
function fake(files: Record<string, string>, opts: Options = {}) {
  const fs = new Map(Object.entries(files));
  const log: string[] = [];
  const exported: { parts: { kind: string; text: string }[]; path: string }[] = [];
  const w3 = {
    workspace: {
      project: () => ({ name: "My Map", root: "C:\\p" }),
      files: () => [...fs.keys()].map((path) => ({ path, size: 1, modified: 0 })),
      readText: async (p: string) => { if (!fs.has(p)) throw new Error("no such file"); return fs.get(p)!; },
      writeText: async (p: string, t: string) => { log.push(`write ${p}`); fs.set(p, t); },
      refresh: async () => { log.push("refresh"); },
    },
    backend: {
      invoke: async (cmd: string, a: { parts?: { kind: string; text: string }[]; path?: string; text?: string }) => {
        if (cmd === "w3o_export") { exported.push({ parts: a.parts!, path: a.path! }); return null; }
        if (cmd === "w3o_import") return opts.w3o ?? [];
        if (cmd === "objects_canonicalize") return JSON.stringify(JSON.parse(a.text!), null, 2) + "\n";
        throw new Error(`backend ${cmd}`);
      },
    },
    editors: { unsavedPaths: () => opts.unsaved ?? [] },
    commands: { execute: async (id: string) => { log.push(`command ${id}`); } },
    window: {
      pickSaveFile: async () => (opts.save === undefined ? "C:\\out\\all" : opts.save),
      pickFile: async () => (opts.pick === undefined ? "C:\\in\\x.w3o" : opts.pick),
      confirm: async () => { log.push("confirm"); return opts.confirm ?? true; },
      showInfo: async () => undefined,
    },
  } as unknown as W3Api;
  return { w3, fs, log, exported };
}

const J = (f: EditFile) => JSON.stringify(f, null, 2);

test("Export All Object Data writes every kind the map has into one file, adding .w3o", async () => {
  const { w3, exported } = fake({
    "map/war3map.w3u.json": J(file(3, [std("hfoo", 1)], [unit("h000", "TRIGSTR_001")])),
    "map/war3map.w3a.json": J(file(3, [], [bare("AHbz", "A000")])),
    "map/war3map.w3t.json": J(file(3, [untouched], [])),
    "map/war3map.wts": "STRING 1\n{\nLieutenant\n}\n",
  });
  assert.equal(await exportAllObjectData(w3), "C:\\out\\all.w3o");
  assert.equal(exported.length, 1);
  assert.deepEqual(exported[0].parts.map((p) => p.kind), ["w3u", "w3a"]);
  const u = JSON.parse(exported[0].parts[0].text) as EditFile;
  assert.equal(u.custom[0].mods![0].value, "Lieutenant");
  assert.equal(u.original[0].base, "hfoo");
});

test("Export All is refused with unsaved object data or none at all, and cancelling writes nothing", async () => {
  await assert.rejects(exportAllObjectData(fake({ "map/war3map.w3u.json": J(file(3, [], [unit("h000", "x")])) }, { unsaved: ["map/war3map.w3u.json"] }).w3), /Save map\/war3map\.w3u\.json first/);
  await assert.rejects(exportAllObjectData(fake({ "map/war3map.w3u.json": J(file(3, [untouched], [])) }).w3), /no object data/);
  const c = fake({ "map/war3map.w3u.json": J(file(3, [], [unit("h000", "x")])) }, { save: null });
  assert.equal(await exportAllObjectData(c.w3), null);
  assert.equal(c.exported.length, 0);
});

test("Export Object writes the chosen objects only", async () => {
  const a = unit("h000", "A"), b = unit("h001", "B");
  const f = file(3, [], [a, b]);
  const { w3, exported } = fake({}, { save: "C:\\out\\one.W3O" });
  assert.equal(await exportObjects(w3, "w3u", f, [b], () => null), "C:\\out\\one.W3O");
  const sent = JSON.parse(exported[0].parts[0].text) as EditFile;
  assert.deepEqual(sent.custom.map((o) => o.id), ["h001"]);
  assert.equal(exported[0].parts[0].kind, "w3u");
  await assert.rejects(exportObjects(w3, "w3u", f, [], () => null), /Select an object/);
});

test("Import merges the file into the map's data after asking and a checkpoint", async () => {
  const { w3, fs, log } = fake({ "map/war3map.w3u.json": J(file(3, [], [unit("h000", "Old")])) }, {
    w3o: [{ kind: "w3u", text: J(file(3, [], [unit("h000", "New"), unit("h005", "Added")])) }, { kind: "w3t", text: J(file(3, [], [bare("ratf", "I000")])) }],
  });
  assert.equal(await importObjectData(w3), 3);
  const at = (s: string) => log.indexOf(s);
  assert.ok(at("confirm") >= 0 && at("confirm") < at("command w3.checkpoints.create"), "asked first");
  assert.ok(at("command w3.checkpoints.create") < at("write map/war3map.w3u.json"), "checkpoint before the first write");
  const u = JSON.parse(fs.get("map/war3map.w3u.json")!) as EditFile;
  assert.deepEqual(u.custom.map((o) => [o.id, o.mods![0].value]), [["h000", "New"], ["h005", "Added"]]);
  assert.equal((JSON.parse(fs.get("map/war3map.w3t.json")!) as EditFile).custom[0].id, "I000", "a kind the map had no file for is created");
});

test("Import changes nothing when declined, cancelled, unsaved, or of another version", async () => {
  const mine = J(file(3, [], [unit("h000", "Old")]));
  const w3o = [{ kind: "w3u", text: J(file(3, [], [unit("h000", "New")])) }];
  const declined = fake({ "map/war3map.w3u.json": mine }, { w3o, confirm: false });
  assert.equal(await importObjectData(declined.w3), 0);
  assert.deepEqual(declined.log.filter((l) => l.startsWith("write") || l.startsWith("command")), []);
  assert.equal(await importObjectData(fake({ "map/war3map.w3u.json": mine }, { w3o, pick: null }).w3), 0);
  await assert.rejects(importObjectData(fake({ "map/war3map.w3u.json": mine }, { w3o, unsaved: ["map/war3map.w3u.json"] }).w3), /Save or discard/);
  const other = fake({ "map/war3map.w3u.json": mine, "map/war3map.w3t.json": J(file(3, [], [bare("ratf", "I001")])) }, {
    w3o: [{ kind: "w3u", text: J(file(3, [], [unit("h009", "N")])) }, { kind: "w3t", text: J(file(1, [], [old1("ratf", "I000")])) }],
  });
  await assert.rejects(importObjectData(other.w3), /can't be mixed/);
  assert.equal(other.fs.get("map/war3map.w3u.json"), mine, "the kind that could be merged was not written either");
  assert.deepEqual(other.log.filter((l) => l.startsWith("write")), []);
});
