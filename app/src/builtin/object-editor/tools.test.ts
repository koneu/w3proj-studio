// The object data tools (tools.ts) on the app's API around them: in a campaign project they work on war3campaign.*,
// in a chapter map on war3map.* with the campaign's objects listed beside the map's and refused for changes; and
// delete_object names what still uses the object, the map script and custom script triggers included.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, W3Api } from "../../extensions/api";
import type { FieldMeta, KindData } from "../../lib/objects/metadata";
import { describeUses, registerObjectTools, scriptLines } from "./tools";

const objects = (custom: object[], original: object[] = []) => JSON.stringify({ format: "w3proj.objects/1", version: 3, original, custom });
const mod = (field: string, value: unknown, type = "int") => ({ field, type, value });
const field = (id: string, valueType: string): FieldMeta => ({ id, label: id, valueType, repeat: 0, data: 0 }) as FieldMeta;
const FIELDS = [field("unam", "string"), field("uhpm", "int"), field("uabi", "string")];

/** The game's tables of a kind: units hfoo and hbar, nothing of other kinds. */
function kindData(kind: string): KindData {
  const units = kind === "w3u";
  return {
    kind, facetDefs: [], facets: () => ({}), fields: FIELDS, fieldById: new Map(FIELDS.map((f) => [f.id, f])),
    names: new Map(units ? [["hfoo", "Footman"], ["hbar", "Barracks"]] : []), searchText: () => "",
    baseIds: units ? ["hfoo", "hbar"] : kind === "w3a" ? ["AHbz"] : [], levels: () => 1, fieldsFor: () => FIELDS,
    defaultValue: (_b, f) => (f.id === "uhpm" ? "420" : undefined),
  };
}

/** A project at `root` with `files` (a value of null: there but unreadable), the MCP tools registered on it. */
function project(root: string, files: Record<string, string | null>) {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  /** `openRoot`: another project opened (the API answers for it); `beforeEdit`: runs as an edit starts. */
  const hooks: { openRoot?: string; beforeEdit?: () => void } = {};
  const none = { dispose() {} };
  const notFound = (p: string) => new Error(`${p}: No such file or directory (os error 2)`);
  const abs = (p: string) => (p.startsWith("/") ? p : `${root}/${p}`);
  const read = async (p: string) => {
    const k = abs(p);
    if (!(k in files)) throw notFound(p);
    if (files[k] === null) throw new Error(`${p}: Permission denied (os error 13)`);
    return files[k]!;
  };
  const w3 = {
    settings: { get: () => undefined },
    game: { readText: async () => "", list: async () => [] },
    services: {
      get: async () => ({
        // As the MCP edit service: the change reads, its texts are written all at once; false when nothing changed.
        async edit(_title: string, change: (read: (p: string) => Promise<string | null>) => Promise<{ path: string; text: string }[]>) {
          hooks.beforeEdit?.();
          const out = await change(async (p) => read(p).catch(() => null));
          let changed = false;
          for (const { path, text } of out) if (files[abs(path)] !== text) { files[abs(path)] = text; changed = true; }
          return changed;
        },
      }),
    },
    mcp: { registerTool: (name: string, f: (args: Record<string, unknown>) => Promise<unknown>) => { tools.set(name, f); return none; } },
    workspace: {
      project: () => ({ root: hooks.openRoot ?? root, name: "P", manifest: {}, default_output: "" }),
      files: () => Object.keys(files).filter((p) => p.startsWith(`${root}/`)).map((p) => ({ path: p.slice(root.length + 1), size: 1, modified: 1 })),
      resolve: abs,
      readText: read,
      readBytes: async (p: string) => new TextEncoder().encode(await read(p)),
    },
    backend: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "fs_exists") return abs(String(args.path)) in files;
        if (command === "objects_canonicalize") return args.text;
        if (command === "codec_decode") throw notFound(String(args.path));
        throw new Error(`unexpected ${command}`);
      },
    },
  };
  const ctx: ExtensionContext = { extensionId: "w3.objectEditor", extensionPath: null, subscriptions: [] };
  registerObjectTools(w3 as unknown as W3Api, ctx, {
    loadKind: async (kind) => kindData(kind),
    emptyFile: async () => ({ format: "w3proj.objects/1", version: 3, original: [], custom: [] }),
  });
  const call = (name: string, args: Record<string, unknown>) => tools.get(name)!(args);
  const doc = (path: string) => (files[abs(path)] ? JSON.parse(files[abs(path)]!) : null);
  return { files, call, doc, hooks };
}

const CAMP = "/camp";
const CHAPTER = "/camp/maps/Chapter.w3x";
/** A campaign with c001 (named in its string table) and a change to hfoo's hit points, and a chapter map in it. */
const campaignFiles = (own: Record<string, string | null> = {}): Record<string, string | null> => ({
  [`${CAMP}/map/war3campaign.w3f.json`]: "{}",
  [`${CAMP}/map/war3campaign.w3u.json`]: objects([{ id: "c001", base: "hfoo", mods: [mod("unam", "TRIGSTR_001", "string")] }], [{ base: "hfoo", mods: [mod("uhpm", 500)] }]),
  [`${CAMP}/map/war3campaign.wts`]: "STRING 1\r\n{\r\nCampaign Grunt\r\n}\r\n",
  [`${CHAPTER}/map/war3map.w3i.json`]: "{}",
  ...own,
});

test("in a campaign project the tools work on war3campaign.*, never war3map.*", async () => {
  const p = project(CAMP, campaignFiles());
  const listed = await p.call("list_objects", { kind: "units" }) as { items: { id: string; name: string; campaign?: boolean }[] };
  assert.deepEqual(listed.items.map((o) => [o.id, o.name, !!o.campaign]), [["c001", "Campaign Grunt", false], ["hfoo", "Footman", false]]);
  const { id } = await p.call("create_object", { kind: "units", base: "hfoo", name: "New" }) as { id: string };
  assert.notEqual(id, "c001");
  await p.call("set_object_fields", { kind: "units", id: "c001", changes: [{ field: "uhpm", value: 900 }] });
  await p.call("delete_object", { kind: "units", id: "hfoo" });
  const after = p.doc("map/war3campaign.w3u.json");
  assert.deepEqual(after.custom.map((o: { id: string }) => o.id), ["c001", id]);
  assert.equal(after.custom[0].mods.find((m: { field: string }) => m.field === "uhpm").value, 900);
  assert.deepEqual(after.original, []);
  assert.equal(Object.keys(p.files).some((f) => /war3map\.w3u/.test(f)), false, "no war3map.w3u written in the campaign");
});

test("in a chapter map the campaign's objects are listed and shown, marked as the campaign's", async () => {
  const p = project(CHAPTER, campaignFiles({ [`${CHAPTER}/map/war3map.w3u.json`]: objects([{ id: "h000", base: "hbar", mods: [] }]) }));
  const listed = await p.call("list_objects", { kind: "units" }) as { items: { id: string; name: string; campaign?: boolean }[] };
  assert.deepEqual(listed.items.map((o) => [o.id, o.name, !!o.campaign]), [["h000", "Barracks", false], ["c001", "Campaign Grunt", true], ["hfoo", "Footman", true]]);
  const c001 = await p.call("get_object", { kind: "units", id: "c001" }) as { name: string; campaign?: boolean; custom: boolean; base?: string };
  assert.deepEqual([c001.name, c001.campaign, c001.custom, c001.base], ["Campaign Grunt", true, true, "hfoo"]);
});

test("in a chapter map changes go to war3map.*, and the campaign's custom objects are refused, naming where they're changed", async () => {
  const p = project(CHAPTER, campaignFiles());
  const before = p.files[`${CAMP}/map/war3campaign.w3u.json`];
  await assert.rejects(p.call("set_object_fields", { kind: "units", id: "c001", changes: [{ field: "uhpm", value: 1 }] }), /custom unit of the campaign \(war3campaign\.w3u\).*campaign project/);
  await assert.rejects(p.call("delete_object", { kind: "units", id: "c001" }), /campaign project/);
  // A new object doesn't take the campaign's id; it lands in the map.
  const { id } = await p.call("create_object", { kind: "units", base: "hfoo" }) as { id: string };
  assert.notEqual(id, "c001");
  assert.deepEqual(p.doc("map/war3map.w3u.json").custom.map((o: { id: string }) => o.id), [id]);
  assert.equal(p.files[`${CAMP}/map/war3campaign.w3u.json`], before, "the campaign's file is untouched");
});

test("a chapter's change to a game object the campaign changes compares with the campaign's value, not the game's", async () => {
  const p = project(CHAPTER, campaignFiles());
  // hfoo: 420 in the game, 500 by the campaign. Setting 420 in the chapter is a change.
  await p.call("set_object_fields", { kind: "units", id: "hfoo", changes: [{ field: "uhpm", value: 420 }] });
  assert.deepEqual(p.doc("map/war3map.w3u.json").original, [{ base: "hfoo", mods: [{ field: "uhpm", type: "int", value: 420 }] }]);
  const shown = await p.call("get_object", { kind: "units", id: "hfoo" }) as { changes: { value: unknown }[]; campaignChanges?: { value: unknown }[] };
  assert.deepEqual([shown.changes.map((c) => c.value), shown.campaignChanges?.map((c) => c.value)], [[420], [500]]);
});

test("a chapter whose campaign object data can't be read fails, never passes for a campaign without objects", async () => {
  const p = project(CHAPTER, campaignFiles({ [`${CAMP}/map/war3campaign.w3u.json`]: null }));
  await assert.rejects(p.call("list_objects", { kind: "units" }), /war3campaign\.w3u\.json is there but can't be read/);
  await assert.rejects(p.call("create_object", { kind: "units", base: "hfoo" }), /isn't known which ids it uses/);
  await assert.rejects(p.call("set_object_fields", { kind: "units", id: "c001", changes: [{ field: "uhpm", value: 1 }] }), /campaign's can't be read/);
});

test("delete_object names what still uses the object: map script, custom scripts, GUI triggers, objects, placed ones", async () => {
  const root = "/map";
  const wtg = { reforged: true, version: 7, counts: [], unknown: 0, variables: [], items: [
    { type: 8, name: "Spawn", description: "", isComment: false, id: 1, enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent: 0,
      ecas: [{ kind: 2, name: "CreateNUnitsAtLoc", enabled: true, params: [{ type: 3, value: "h000" }], children: [] }] },
    { type: 8, name: "Setup", description: "", isComment: false, id: 2, enabled: true, isCustom: true, initiallyOff: false, runOnInit: false, parent: 0, ecas: [] },
  ] };
  const p = project(root, {
    [`${root}/map/war3map.w3u.json`]: objects([{ id: "h000", base: "hfoo", mods: [] }, { id: "h001", base: "hbar", mods: [mod("uabi", "h000,Aloc", "string")] }]),
    [`${root}/map/war3map.j`]: "function main takes nothing returns nothing\n  call CreateUnit( p, 'h000', 0, 0, 0 )\nendfunction\n",
    [`${root}/map/war3map.wtg.json`]: JSON.stringify(wtg),
    [`${root}/map/war3map.wct.txt`]: "//== war3map.wct: version 1, comment \"\" ==\n//== header ==\n\n//== trigger 0: Spawn ==\n\n//== trigger 1: Setup ==\nset u = CreateUnit( p, 'h000', 0, 0, 0 )\n",
    [`${root}/map/war3mapUnits.doo.json`]: JSON.stringify({ units: [{ id: "h000" }, { id: "hfoo" }, { id: "h000" }] }),
    [`${root}/map/war3map.doo.json`]: null,
  });
  const said = await p.call("delete_object", { kind: "units", id: "h000" }) as string;
  assert.match(said, /^Removed h000\./);
  assert.match(said, /war3map\.j \(line 2\)/);
  assert.match(said, /the custom script of Setup/);
  assert.match(said, /the trigger Spawn/);
  assert.match(said, /the object h001 \(units\)/);
  assert.match(said, /2 placed objects/);
  // There but unreadable: said, not taken for "nothing there".
  assert.match(said, /Not checked.*war3map\.doo/);
  // Control: an object nothing names.
  const quiet = await p.call("delete_object", { kind: "units", id: "h001" }) as string;
  assert.match(quiet, /Nothing in the project names it|Not checked/);
  assert.doesNotMatch(quiet, /still named/);
});

test("a project opened while an edit waited isn't edited with the old project's file", async () => {
  const p = project(CAMP, campaignFiles());
  const before = p.files[`${CAMP}/map/war3campaign.w3u.json`];
  // The chapter opens while create_object waits for its turn: war3campaign.w3u must not land in the chapter.
  p.hooks.beforeEdit = () => { p.hooks.openRoot = CHAPTER; };
  await assert.rejects(p.call("create_object", { kind: "units", base: "hfoo" }), /Another project was opened meanwhile/);
  assert.equal(Object.keys(p.files).some((f) => f.startsWith(`${CHAPTER}/map/war3campaign`)), false);
  assert.equal(p.files[`${CAMP}/map/war3campaign.w3u.json`], before);
});

test("script lines: rawcodes and FourCC strings, whole ids only", () => {
  assert.deepEqual(scriptLines("a 'h000'\nFourCC(\"h000\")\n'h0001' h000\nx", "h000"), [1, 2]);
  assert.equal(describeUses("h000", { objects: [], placed: 0, guiTriggers: [], customScripts: [], mapScript: [], unchecked: [] }), "");
});
