// .w3o in the app: what goes in, what is merged, and the commands, on a made-up project. The
// binary layout itself is tested in Rust (crates/w3proj/src/w3o.rs).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { W3Api } from "../../extensions/api";
import type { EditFile, EditObject } from "./objectedit";
import { convertVersion, describeConversion, describeImport, exportParts, onlyObjects, planImport } from "./w3o";
import { exportAllObjectData, exportObjects, importObjectData } from "./w3ofiles";
import { forgetCheckpointsOffWarning } from "../../lib/checkpoint";
import { commandNotFound } from "../../lib/commanderror";

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

test("another object data version is converted to the map's, and the question says so", () => {
  const have = file(3, [], [unit("h000", "Old")]);
  const plan = planImport({ w3u: have, w3t: null }, [
    { kind: "w3t", file: file(3, [], [bare("ratf", "I000")]) },
    { kind: "w3u", file: file(1, [], [{ ...old1("hfoo", "h009"), mods: [mod("unam", "Older")] }]) },
  ]);
  const u = plan.writes.find((w) => w.kind === "w3u")!;
  assert.equal(u.file.version, 3);
  assert.deepEqual(u.file.custom.map((o) => [o.id, o.mods![0].value]), [["h000", "Old"], ["h009", "Older"]]);
  assert.deepEqual(plan.conversions, [{ kind: "w3u", from: 1, to: 3, dropped: 0, objects: [] }]);
  assert.equal(describeConversion("w3u", plan.conversions[0]), " The file's units are object data version 1, converted to the map's version 3.");
  // An empty file of the map doesn't hold the kind back: it takes the file's version, nothing converted.
  const empty = planImport({ w3u: file(3, [], []) }, [{ kind: "w3u", file: file(1, [], [old1("hfoo", "h009")]) }]);
  assert.equal(empty.writes[0].file.version, 1);
  assert.deepEqual(empty.conversions, []);
});

test("down from version 3 an object keeps its flag-0 set; the other sets' fields are counted as left out", () => {
  const sets: EditObject = { base: "hfoo", id: "h001", sets: [{ flag: 0, mods: [mod("unam", "Sd")] }, { flag: 2, mods: [mod("unam", "Hd"), mod("uhpm", 9)] }] };
  const onlyFlagged: EditObject = { base: "hkni", sets: [{ flag: 1, mods: [mod("uhpm", 5)] }, { flag: 2, mods: [] }] };
  const plain: EditObject = { base: "hpea", id: "h002", mods: [mod("unam", "Plain")] };
  const plan = planImport({ w3u: file(1, [], [old1("hfoo", "h000")]) }, [{ kind: "w3u", file: file(3, [onlyFlagged], [sets, plain]) }]);
  const w = plan.writes[0].file;
  assert.equal(w.version, 1);
  const byId = (id: string) => w.custom.find((o) => o.id === id)!;
  assert.deepEqual(byId("h001"), { base: "hfoo", id: "h001", end: "h001", mods: [mod("unam", "Sd")] });
  assert.deepEqual(byId("h002"), { base: "hpea", id: "h002", end: "h002", mods: [mod("unam", "Plain")] });
  assert.deepEqual(w.original, [{ base: "hkni", end: "hkni", mods: [] }]);
  assert.deepEqual(plan.conversions, [{ kind: "w3u", from: 3, to: 1, dropped: 3, objects: ["h001", "hkni"] }]);
  assert.match(describeConversion("w3u", plan.conversions[0]), /version 3, converted to the map's version 1\. 3 fields of flagged sets .* left out: h001, hkni\./);
});

test("convertVersion: the same version is the same file; 1 and 2 differ only in the number; unknown versions are refused", () => {
  const f = file(2, [std("hfoo", 3)], [old1("hfoo", "h000")]);
  assert.equal(convertVersion(f, 2).file, f);
  assert.equal(convertVersion(f, 2).conversion, null);
  const one = convertVersion(f, 1);
  assert.deepEqual({ ...one.file, version: 2 }, { ...f, original: [{ ...std("hfoo", 3), end: "hfoo" }] });
  assert.equal(f.original[0].end, undefined, "the given file isn't changed");
  assert.throws(() => convertVersion(f, 4), /version 4/);
  assert.throws(() => convertVersion(file(7, [], []), 3), /version 7/);
});

interface Options { unsaved?: string[]; confirm?: boolean; pick?: string | null; save?: string | null; w3o?: { kind: string; text: string }[] }

/** A project in memory with the backend calls the commands make. */
function fake(files: Record<string, string>, opts: Options = {}) {
  const fs = new Map(Object.entries(files));
  const log: string[] = [];
  const asked: string[] = [];
  const exported: { parts: { kind: string; text: string }[]; path: string }[] = [];
  const w3 = {
    workspace: {
      project: () => ({ name: "My Map", root: "C:\\p" }),
      resolve: (p: string) => p,
      files: () => [...fs.keys()].map((path) => ({ path, size: 1, modified: 0 })),
      readText: async (p: string) => { if (!fs.has(p)) throw new Error("no such file"); return fs.get(p)!; },
      writeText: async (p: string, t: string) => { log.push(`write ${p}`); fs.set(p, t); },
      refresh: async () => { log.push("refresh"); },
    },
    backend: {
      invoke: async (cmd: string, a: { parts?: { kind: string; text: string }[]; path?: string; text?: string }) => {
        if (cmd === "fs_exists") return fs.has(a.path!) || fs.has(`${a.path}.json`);
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
      confirm: async (m: string) => { log.push("confirm"); asked.push(m); return opts.confirm ?? true; },
      showInfo: async () => undefined,
    },
  } as unknown as W3Api;
  return { w3, fs, log, exported, asked };
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

test("Import goes on with the Checkpoints extension off, and says once that no checkpoint was made", async () => {
  forgetCheckpointsOffWarning();
  const w3o = [{ kind: "w3u", text: J(file(3, [], [unit("h005", "Added")])) }];
  const { w3, fs, log } = fake({ "map/war3map.w3u.json": J(file(3, [], [unit("h000", "Old")])) }, { w3o });
  const warned: string[] = [];
  Object.assign(w3.commands, { execute: async (id: string) => { log.push(`command ${id}`); throw new Error(commandNotFound(id)); } });
  Object.assign(w3.window, { showWarning: async (m: string) => { warned.push(m); } });
  assert.equal(await importObjectData(w3), 1);
  assert.deepEqual((JSON.parse(fs.get("map/war3map.w3u.json")!) as EditFile).custom.map((o) => o.id), ["h000", "h005"]);
  assert.equal(await importObjectData(w3), 1, "a second import in the session");
  assert.equal(warned.length, 1, "said once");
  assert.match(warned[0], /Import Object Data went on without a checkpoint/);
  forgetCheckpointsOffWarning();
});

test("Import changes nothing when declined, cancelled or unsaved; another version is converted and named in the question", async () => {
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
  assert.equal(await importObjectData(other.w3), 2);
  assert.match(other.asked[0], /The file's items are object data version 1, converted to the map's version 3\./);
  const t = JSON.parse(other.fs.get("map/war3map.w3t.json")!) as EditFile;
  assert.deepEqual([t.version, t.custom.map((o) => o.id)], [3, ["I001", "I000"]]);
  // A version-3 file into a version-1 map: the flagged set's fields can't go along, and the question names them.
  const old = fake({ "map/war3map.w3u.json": J(file(1, [], [old1("hfoo", "h000")])) }, {
    w3o: [{ kind: "w3u", text: J(file(3, [], [{ base: "hfoo", id: "h001", sets: [{ flag: 0, mods: [mod("unam", "Sd")] }, { flag: 2, mods: [mod("unam", "Hd")] }] }])) }],
  });
  assert.equal(await importObjectData(old.w3), 1);
  assert.match(old.asked[0], /1 field of flagged sets \(Reforged's\) can't be held in version 1 and is left out: h001\./);
  const u = JSON.parse(old.fs.get("map/war3map.w3u.json")!) as EditFile;
  assert.deepEqual([u.version, u.custom[1]], [1, { base: "hfoo", id: "h001", end: "h001", mods: [mod("unam", "Sd")] }]);
});

import { mergeSkin } from "./w3o";

test("mergeSkin puts Skin fields into their objects, main's value first, and adds Skin-only objects when asked", () => {
  const main = file(3, [std("hfoo", 5)], [{ base: "hfoo", id: "h000", mods: [mod("unam", "Main name"), { field: "uico", type: "string", value: "main.blp" }] }]);
  const skin = file(3, [{ base: "hfoo", mods: [mod("unam", "Skin base name"), { field: "umdl", type: "string", value: "foot.mdx" }] }],
    [{ base: "hfoo", id: "h000", mods: [mod("unam", "Skin name"), { field: "uico", type: "string", value: "skin.blp" }, { field: "utip", type: "string", value: "Tip" }] }, { base: "hpea", id: "h001", mods: [mod("unam", "Only skin")] }]);
  const merged = mergeSkin(main, skin, { addSkinOnly: true });
  assert.deepEqual(merged.custom[0].mods!.map((m) => [m.field, m.value]), [["unam", "Main name"], ["uico", "main.blp"], ["utip", "Tip"]]);
  assert.deepEqual(merged.original[0].mods!.map((m) => [m.field, m.value]), [["uhpm", 5], ["unam", "Skin base name"], ["umdl", "foot.mdx"]]);
  assert.deepEqual(merged.custom.map((o) => o.id), ["h000", "h001"]);
  assert.equal(main.custom[0].mods!.length, 2, "main is not changed");
  assert.deepEqual(mergeSkin(main, skin, { addSkinOnly: false }).custom.map((o) => o.id), ["h000"]);
  assert.deepEqual(mergeSkin(main, null, { addSkinOnly: true }), main);
});

test("mergeSkin keeps levels apart, follows version 3 sets, and an end token that differs", () => {
  const lvl = (level: number, value: string) => ({ field: "atp1", type: "string", level, data: 0, value });
  const main = file(3, [], [{ base: "AHbz", id: "A000", sets: [{ flag: 0, mods: [lvl(1, "main1")] }] }]);
  const skin = file(3, [], [{ base: "AHbz", id: "A000", end: "A000", sets: [{ flag: 0, mods: [lvl(1, "skin1"), lvl(2, "skin2")] }] }]);
  const merged = mergeSkin(main, skin, { addSkinOnly: false });
  assert.deepEqual(merged.custom[0].sets![0].mods.map((m) => [m.level, m.value, m.end]), [[1, "main1", undefined], [2, "skin2", "A000"]]);
  // Nothing to put the fields in: an object with no mods of its own gets a list.
  assert.equal(mergeSkin(file(3, [], [{ base: "hfoo", id: "h000" }]), file(3, [], [unit("h000", "N")]), { addSkinOnly: false }).custom[0].mods![0].value, "N");
});

test("Export All Object Data takes the Skin file's fields, also for an object the main file lacks", async () => {
  const { w3, exported } = fake({
    "map/war3map.w3u.json": J(file(3, [], [bare("hfoo", "h000")])),
    "map/war3mapSkin.w3u.json": J(file(3, [], [unit("h000", "TRIGSTR_001"), unit("h001", "Skin only")])),
    "map/war3map.wts": "STRING 1\n{\nLieutenant\n}\n",
  });
  await exportAllObjectData(w3);
  const u = JSON.parse(exported[0].parts[0].text) as EditFile;
  assert.deepEqual(u.custom.map((o) => [o.id, o.mods![0].value]), [["h000", "Lieutenant"], ["h001", "Skin only"]]);
  // A kind that only the Skin file has is exported too.
  const only = fake({ "map/war3mapSkin.w3t.json": J(file(3, [], [{ base: "ratf", id: "I000", mods: [mod("unam", "Item")] }])) });
  await exportAllObjectData(only.w3);
  assert.deepEqual(only.exported[0].parts.map((p) => p.kind), ["w3t"]);
});

test("Export Object takes the Skin fields of the chosen objects only", async () => {
  const a = bare("hfoo", "h000"), b = bare("hfoo", "h001");
  const { w3, exported } = fake({ "map/war3mapSkin.w3u.json": J(file(3, [], [unit("h000", "Named"), unit("h001", "Other"), unit("h002", "Unchosen")])) });
  await exportObjects(w3, "w3u", file(3, [], [a, b]), [a], () => null);
  const sent = JSON.parse(exported[0].parts[0].text) as EditFile;
  assert.deepEqual(sent.custom.map((o) => [o.id, o.mods?.[0]?.value]), [["h000", "Named"]]);
});

test("an object file that is there but can't be read stops Export All and Import instead of passing for empty", async () => {
  const good = J(file(3, [], [unit("h000", "x")]));
  const ex = fake({ "map/war3map.w3u.json": good, "map/war3map.w3a.json": "{ broken" });
  await assert.rejects(exportAllObjectData(ex.w3), /war3map\.w3a\.json is there but can't be read/);
  assert.equal(ex.exported.length, 0, "no half export reported as success");
  const skinBroken = fake({ "map/war3map.w3u.json": good, "map/war3mapSkin.w3u.json": "nope" });
  await assert.rejects(exportAllObjectData(skinBroken.w3), /war3mapSkin\.w3u\.json/);

  const w3o = [{ kind: "w3u", text: J(file(3, [], [unit("h009", "N")])) }];
  const im = fake({ "map/war3map.w3u.json": "{ broken" }, { w3o });
  await assert.rejects(importObjectData(im.w3), /war3map\.w3u\.json is there but can't be read/);
  assert.equal(im.fs.get("map/war3map.w3u.json"), "{ broken", "the unreadable file is not overwritten");
  assert.deepEqual(im.log.filter((l) => l.startsWith("write") || l.startsWith("command")), []);
});

test("the question names ids that an imported object takes from an object of another base", async () => {
  const mine = J(file(3, [], [unit("h000", "Mine"), { base: "hpea", id: "h003", mods: [] }]));
  const w3o = [{ kind: "w3u", text: J(file(3, [], [{ base: "hkni", id: "h000", mods: [] }, { base: "hpea", id: "h003", mods: [] }])) }];
  const f = fake({ "map/war3map.w3u.json": mine }, { w3o });
  await importObjectData(f.w3);
  assert.match(f.asked[0], /h000 \(hfoo becomes hkni\)/);
  assert.doesNotMatch(f.asked[0], /h003/, "same base is the same object");
  const calm = fake({ "map/war3map.w3u.json": mine }, { w3o: [{ kind: "w3u", text: J(file(3, [], [unit("h007", "N")])) }] });
  await importObjectData(calm.w3);
  assert.doesNotMatch(calm.asked[0], /already used/);
});

test("mergeSkin puts a Skin set's fields into the set with the same flag", () => {
  const f = (flag: number, value: string) => ({ field: "unam", type: "string", value, level: flag });
  const main = file(3, [], [{ base: "hfoo", id: "h000", sets: [{ flag: 0, mods: [] }, { flag: 1, mods: [] }] }]);
  const skin = file(3, [], [{ base: "hfoo", id: "h000", sets: [{ flag: 1, mods: [f(1, "one")] }, { flag: 0, mods: [f(0, "zero")] }] }]);
  const merged = mergeSkin(main, skin, { addSkinOnly: false }).custom[0].sets!;
  assert.deepEqual(merged.map((s) => s.mods.map((m) => m.value)), [["zero"], ["one"]]);
});

import { describeSkin, pruneSkin } from "./w3o";

test("pruneSkin takes out the fields the import sets, for the objects it holds, and leaves the rest", () => {
  const skin = file(3, [{ base: "hfoo", mods: [mod("unam", "STALE BASE"), mod("utip", "keep tip")] }],
    [{ base: "hfoo", id: "h000", mods: [mod("unam", "STALE NAME"), mod("uico", "old.blp")] }, { base: "hfoo", id: "h001", mods: [mod("unam", "Other object")] }]);
  const incoming = file(3, [{ base: "hfoo", mods: [mod("unam", "New base")] }], [{ base: "hfoo", id: "h000", mods: [mod("unam", "New name")] }]);
  const { file: pruned, dropped } = pruneSkin(skin, incoming);
  assert.equal(dropped, 2);
  assert.deepEqual(pruned.custom[0].mods!.map((m) => m.field), ["uico"]);
  assert.deepEqual(pruned.custom[1].mods!.map((m) => m.field), ["unam"], "an object the import doesn't hold is untouched");
  assert.deepEqual(pruned.original[0].mods!.map((m) => m.field), ["utip"]);
  assert.equal(skin.custom[0].mods!.length, 2, "the file handed in is not changed");
  // A field of another level is another field.
  const lvl = (level: number) => ({ field: "atp1", type: "string", level, data: 0, value: "t" });
  const a = pruneSkin(file(3, [], [{ base: "AHbz", id: "A000", mods: [lvl(1), lvl(2)] }]), file(3, [], [{ base: "AHbz", id: "A000", mods: [lvl(2)] }]));
  assert.deepEqual(a.file.custom[0].mods!.map((m) => m.level), [1]);
  // Sets are pruned in every set.
  const sets = pruneSkin(file(3, [], [{ base: "AHbz", id: "A000", sets: [{ flag: 0, mods: [lvl(1)] }, { flag: 1, mods: [lvl(1)] }] }]), file(3, [], [{ base: "AHbz", id: "A000", mods: [lvl(1)] }]));
  assert.equal(sets.dropped, 2);
});

test("Import drops the stale Skin fields in the same write, and says so in the question", async () => {
  const f = fake({
    "map/war3map.w3u.json": J(file(3, [], [unit("h000", "Old")])),
    "map/war3mapSkin.w3u.json": J(file(3, [], [{ base: "hfoo", id: "h000", mods: [mod("unam", "STALE NAME"), mod("uico", "keep.blp")] }])),
  }, { w3o: [{ kind: "w3u", text: J(file(3, [], [unit("h000", "New")])) }] });
  await importObjectData(f.w3);
  const skin = JSON.parse(f.fs.get("map/war3mapSkin.w3u.json")!) as EditFile;
  assert.deepEqual(skin.custom[0].mods!.map((m) => m.field), ["uico"]);
  assert.equal((JSON.parse(f.fs.get("map/war3map.w3u.json")!) as EditFile).custom[0].mods![0].value, "New");
  assert.match(f.asked[0], /1 field of war3mapSkin\.w3u that the import sets are dropped/);
  const at = (s: string) => f.log.indexOf(s);
  assert.ok(at("command w3.checkpoints.create") < at("write map/war3mapSkin.w3u.json"), "after the checkpoint");
  // Nothing in the Skin file to drop: it is not written, and the question says nothing of it.
  const calm = fake({ "map/war3map.w3u.json": J(file(3, [], [unit("h000", "Old")])), "map/war3mapSkin.w3u.json": J(file(3, [], [bare("hfoo", "h777")])) },
    { w3o: [{ kind: "w3u", text: J(file(3, [], [unit("h000", "New")])) }] });
  await importObjectData(calm.w3);
  assert.deepEqual(calm.log.filter((l) => l.startsWith("write")), ["write map/war3map.w3u.json"]);
  assert.doesNotMatch(calm.asked[0], /Skin/);
  assert.equal(describeSkin({ writes: [], conflicts: [], skins: [], conversions: [] }), "");
});

test("a corrupt Skin file refuses the import and nothing is written", async () => {
  const f = fake({ "map/war3map.w3u.json": J(file(3, [], [unit("h000", "Old")])), "map/war3mapSkin.w3u.json": "{ broken" },
    { w3o: [{ kind: "w3u", text: J(file(3, [], [unit("h000", "New")])) }] });
  await assert.rejects(importObjectData(f.w3), /war3mapSkin\.w3u\.json is there but can't be read/);
  assert.deepEqual(f.log.filter((l) => l.startsWith("write") || l.startsWith("command") || l === "confirm"), []);
});

test("mergeSkin keeps the main object's end token, and flagged Skin sets stay sets", () => {
  const main = file(3, [], [{ base: "hfoo", id: "h000", end: "h000", mods: [mod("unam", "N")] }]);
  const noEnd = mergeSkin(main, file(3, [], [{ base: "hfoo", id: "h000", mods: [mod("uico", "i.blp")] }]), { addSkinOnly: false });
  assert.equal(noEnd.custom[0].end, "h000");
  assert.equal(noEnd.custom[0].mods![1].end, undefined, "it inherits the object's");
  const sameEnd = mergeSkin(main, file(3, [], [{ base: "hfoo", id: "h000", end: "h000", mods: [mod("uico", "i.blp")] }]), { addSkinOnly: false });
  assert.equal(sameEnd.custom[0].mods![1].end, undefined, "the same end token is not written again");
  const otherEnd = mergeSkin(main, file(3, [], [{ base: "hfoo", id: "h000", end: "h111", mods: [mod("uico", "i.blp")] }]), { addSkinOnly: false });
  assert.equal(otherEnd.custom[0].mods![1].end, "h111", "a different one stays with its field");
  // The main object has plain mods, the Skin object two flagged sets.
  const lvl = (value: string) => ({ field: "atp1", type: "string", level: 1, data: 0, value });
  const skin = file(3, [], [{ base: "AHbz", id: "A000", sets: [{ flag: 0, mods: [lvl("zero")] }, { flag: 1, mods: [lvl("one")] }] }]);
  const merged = mergeSkin(file(3, [], [{ base: "AHbz", id: "A000", mods: [{ field: "anam", type: "string", value: "Name" }] }]), skin, { addSkinOnly: false }).custom[0];
  assert.equal(merged.mods, undefined);
  assert.deepEqual(merged.sets!.map((s) => [s.flag, s.mods.map((m) => m.value)]), [[0, ["Name", "zero"]], [1, ["one"]]]);
  // A flag the main object's sets lack becomes a set of its own instead of landing in the first.
  const two = mergeSkin(file(3, [], [{ base: "AHbz", id: "A000", sets: [{ flag: 0, mods: [] }, { flag: 2, mods: [] }] }]), skin, { addSkinOnly: false }).custom[0].sets!;
  assert.deepEqual(two.map((s) => [s.flag, s.mods.length]), [[0, 1], [2, 0], [1, 1]]);
});
