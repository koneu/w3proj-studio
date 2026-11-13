// A campaign's chapter map finds files in the campaign's own files too, which are listed in the
// background: the checks that ask "is this file in the map?" have to wait for that list, a list
// that can't be read must not pass for an empty one, and results found while another project was
// opened must not be shown for it. Whether there is a campaign, and its files, are known or the
// checks fail saying why; a file is read from where it is (the chapter's folder or the campaign's).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileInfo, W3Api } from "../../extensions/api";
import type { Problem, ProblemsService } from "../../extensions/services";
import { builtinChecks } from "./checks";
import { activate } from "./index";
import { findCampaign, knownPlacedTypes } from "./invalid";
import { FileLookup } from "./lookup";
import { mapChecks } from "./mapchecks";
import { joinPath } from "../../lib/paths";

const CHAPTER = "/camp/maps/Chapter 1";
const IMPORTED = "war3mapImported\\camp.blp";

interface Options {
  /** The campaign's file list, as project_files_partial gives it: a list, or an Error it fails with. */
  campaign?: FileInfo[] | Error;
  /** The campaign's folders project_files_partial couldn't read (and skipped). */
  unreadable?: { path: string; error: string }[];
  /** What asking whether war3campaign.w3f is there fails with (else it answers). */
  existsError?: Error;
  /** The chapter map's own files besides war3map.imp.json, with their bytes. */
  own?: Record<string, Uint8Array>;
  /** Files on disk outside the project (full paths), with their bytes. */
  disk?: Record<string, Uint8Array>;
  /** Whether the campaign folder holds war3campaign.w3f (else it's no campaign). */
  isCampaign?: boolean;
  /** The chapter map's import list (war3map.imp). */
  imports?: { flags: number; path: string }[];
  /** More of the chapter map's documents (project path → JSON text). */
  docs?: Record<string, string>;
}

/** A chapter map's project whose campaign file list arrives only when `release()` is called. */
function chapter(opts: Options = {}) {
  const campaign = opts.campaign ?? [{ path: "map/war3mapImported/camp.blp", size: 1, modified: 1 }];
  let open: { root: string } | null = { root: CHAPTER };
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const asked: string[] = [];
  const docs: Record<string, string> = {
    "map/war3map.imp.json": JSON.stringify({ files: opts.imports ?? [{ flags: 10, path: IMPORTED }] }),
    ...opts.docs,
  };
  const services = new Map<string, unknown>();
  const tools = new Map<string, (args: unknown) => Promise<unknown>>();
  const none = { dispose() {} };
  const w3 = {
    workspace: {
      project: () => (open ? { root: open.root, name: "ch", manifest: {}, default_output: "" } : null),
      files: () => [{ path: "map/war3map.imp.json", size: 1, modified: 1 }, ...Object.keys(opts.own ?? {}).map((path) => ({ path, size: 1, modified: 1 }))],
      filesReady: async () => {},
      resolve: (p: string) => `${open?.root}/${p}`,
      readText: async (p: string) => { if (p in docs) return docs[p]; throw new Error(`no ${p}`); },
      readBytes: async (p: string) => { const b = opts.own?.[p]; if (b) return b; throw new Error(`no ${p}`); },
      onDidChange: () => none,
    },
    backend: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "fs_exists") {
          if (opts.existsError) throw opts.existsError;
          return (opts.isCampaign ?? true) && String(args.path) === "/camp/map/war3campaign.w3f.json";
        }
        if (command === "project_files_partial") {
          asked.push(String(args.root));
          await released;
          if (campaign instanceof Error) throw campaign;
          return { files: campaign, unreadable: opts.unreadable ?? [] };
        }
        throw new Error(`${command}: not in this test`);
      },
      readBytes: async (p: string) => { const b = opts.disk?.[p]; if (b) return b; throw new Error(`no ${p}`); },
    },
    game: {
      list: async () => [],
      read: async (p: string) => { throw new Error(`no ${p}`); },
      readText: async (p: string) => { throw new Error(`no ${p}`); },
      resolve: async () => null,
      resolveMany: async (paths: string[]) => paths.map(() => null),
    },
    settings: { get: () => undefined },
    statusBar: { add: () => ({ text: "", tooltip: "", dispose() {} }) },
    services: { provide: (id: string, impl: unknown) => { services.set(id, impl); return none; } },
    mcp: { registerTool: (name: string, f: (args: unknown) => Promise<unknown>) => { tools.set(name, f); return none; } },
    commands: { register: () => none },
    views: { register: () => none, refresh() {}, show: async () => {} },
    window: { showError() {}, showInfo() {} },
  } as unknown as W3Api;
  const imports = builtinChecks(w3).find((c) => c.id === "imports")!;
  const sounds = mapChecks(w3).find((c) => c.id === "soundFiles")!;
  return {
    w3, imports, sounds, release, asked, tools,
    service: () => services.get("w3.problems") as ProblemsService,
    switchTo: (root: string | null) => { open = root ? { root } : null; },
  };
}

/** Lets the pending promise callbacks run (the check gets as far as it can without the list). */
const settle = () => new Promise((r) => setTimeout(r, 10));

/** Runs the imports check, releasing the campaign list only after the check had time to finish without it. */
async function runImports(app: ReturnType<typeof chapter>): Promise<Problem[]> {
  const run = app.imports.run();
  await settle();
  app.release();
  return run;
}

test("the imports check waits for the campaign's file list: a file only the campaign has is not missing", async () => {
  const app = chapter();
  const found = await runImports(app);
  assert.deepEqual(app.asked, ["/camp"], "the campaign's files were never listed");
  assert.deepEqual(found.map((p) => p.message), []);
});

test("control: a file neither the map, the campaign nor the game has is reported, also after the wait", async () => {
  const app = chapter({ campaign: [{ path: "map/war3mapImported/other.blp", size: 1, modified: 1 }] });
  const found = await runImports(app);
  assert.deepEqual(found.map((p) => p.message), [`${IMPORTED} is listed but its file is missing (also not in the campaign's files)`]);
});

// CSW Tides of Darkness, chapter WC2Orc01: its object data names 36 files (Duck, WarTent's Tent, Corpsewind, …) that
// neither the chapter, the campaign (.w3n listfile and unpacked folder), nor the game's storage (all root names,
// stored locally or not) has. They are really missing; the problem has to say the campaign was looked in too.
const SOUNDS = JSON.stringify({ sounds: [
  { name: "gg_snd_Camp", file: "Sound\\Camp.wav" },
  { name: "gg_snd_Duck", file: "CSW\\Units\\Critters\\Duck\\Quack.wav" },
] });

test("a chapter's file only the campaign has isn't reported; one nowhere says the campaign's files were looked in too", async () => {
  const app = chapter({ campaign: [{ path: "map/Sound/Camp.flac", size: 1, modified: 1 }], docs: { "map/war3map.w3s.json": SOUNDS } });
  const run = app.sounds.run();
  await settle();
  app.release();
  assert.deepEqual((await run).map((p) => p.message), ["CSW\\Units\\Critters\\Duck\\Quack.wav not found (neither in the map, its campaign's files nor in the game)"]);
  // The object data's and interface art's problems take the same wording.
  const lookup = new FileLookup(app.w3);
  await lookup.whenReady();
  assert.equal(lookup.notFound("Corpsewind.mdl"), "Corpsewind.mdl not found (neither in the map, its campaign's files nor in the game)");
});

test("control: a map that is no chapter says only the map and the game, and reports what a campaign would have had", async () => {
  const app = chapter({ isCampaign: false, campaign: [{ path: "map/Sound/Camp.flac", size: 1, modified: 1 }], docs: { "map/war3map.w3s.json": SOUNDS } });
  const found = (await app.sounds.run()).map((p) => p.message);
  assert.deepEqual(found, [
    "Sound\\Camp.wav not found (neither in the map nor in the game)",
    "CSW\\Units\\Critters\\Duck\\Quack.wav not found (neither in the map nor in the game)",
  ]);
  // The other checks' wording comes from the same place.
  const lookup = new FileLookup(app.w3);
  await lookup.whenReady();
  assert.equal(lookup.hasCampaign(), false);
  assert.equal(lookup.notFound("Corpsewind.mdl"), "Corpsewind.mdl not found (neither in the map nor in the game)");
});

test("a campaign file list that can't be read fails the check, naming why, instead of counting as empty", async () => {
  const app = chapter({ campaign: new Error("Permission denied (os error 13)") });
  await assert.rejects(runImports(app), (e: Error) => {
    assert.match(e.message, /campaign's files .*\/camp.* couldn't be listed/);
    assert.match(e.message, /Permission denied/);
    return true;
  });
  // The lookup itself says so too, for every way it's asked.
  const again = chapter({ campaign: new Error("Permission denied (os error 13)") });
  const lookup = new FileLookup(again.w3);
  again.release();
  await assert.rejects(lookup.whenReady(), /couldn't be listed/);
  await assert.rejects(lookup.exists(IMPORTED, "file"), /couldn't be listed/);
  await assert.rejects(lookup.prefetch([[IMPORTED, "file"]]), /couldn't be listed/);
});

test("a folder called maps without war3campaign.w3f two up is no campaign: its files aren't listed", async () => {
  const app = chapter({ isCampaign: false });
  const found = await runImports(app);
  assert.deepEqual(app.asked, [], "the folder above was listed as if it were a campaign");
  assert.deepEqual(found.map((p) => p.message), [`${IMPORTED} is listed but its file is missing`]);
});

test("list_problems names a check that failed, instead of leaving it out", async () => {
  const app = chapter({ campaign: new Error("Permission denied (os error 13)") });
  activate(app.w3, { extensionId: "w3.problems", extensionPath: null, subscriptions: [] });
  app.release();
  const listed = await app.tools.get("list_problems")!({}) as Problem[];
  const failed = listed.find((p) => p.location === "Imported files");
  assert.ok(failed, `no entry for the failed imports check in ${JSON.stringify(listed)}`);
  assert.equal(failed.severity, "error");
  assert.match(failed.message, /check failed: .*couldn't be listed/);
});

test("results found while the campaign list was awaited aren't shown once another project is open", async () => {
  const app = chapter({ campaign: [] });
  activate(app.w3, { extensionId: "w3.problems", extensionPath: null, subscriptions: [] });
  const run = app.service().run();
  await settle();
  app.switchTo("/other");
  app.release();
  assert.deepEqual(await run, []);
  assert.deepEqual(app.service().problems(), [], "the old project's problems are shown for the new one");
});

test("list_problems asked after another project was opened checks that one, not answering with the old run's nothing", async () => {
  const app = chapter();
  activate(app.w3, { extensionId: "w3.problems", extensionPath: null, subscriptions: [] });
  // A run starts for the chapter map and waits for its campaign's file list.
  const first = app.service().run();
  await settle();
  // Another project is opened (no campaign above it), and a client asks.
  app.switchTo("/other");
  const listing = app.tools.get("list_problems")!({}) as Promise<Problem[]>;
  await settle();
  app.release();
  assert.deepEqual(await first, [], "the chapter map's run gave results for the project opened since");
  const listed = await listing;
  assert.deepEqual(listed.map((p) => p.message), [`${IMPORTED} is listed but its file is missing`], "list_problems answered for a project it never checked");
});

test("a run asked for (as Build does) after another project was opened checks that one too", async () => {
  const app = chapter();
  activate(app.w3, { extensionId: "w3.problems", extensionPath: null, subscriptions: [] });
  const first = app.service().run();
  await settle();
  app.switchTo("/other");
  const second = app.service().run();
  await settle();
  app.release();
  assert.deepEqual(await first, []);
  assert.deepEqual((await second).map((p) => p.message), [`${IMPORTED} is listed but its file is missing`], "Build would pack a project that was never checked");
});

test("list_problems says so when the project changes during its own run, instead of answering with nothing", async () => {
  const app = chapter({ campaign: [] });
  activate(app.w3, { extensionId: "w3.problems", extensionPath: null, subscriptions: [] });
  const listing = app.tools.get("list_problems")!({}) as Promise<Problem[]>;
  await settle();
  app.switchTo("/other");
  app.release();
  await assert.rejects(listing, /project changed while it was being checked/);
});

test("control: list_problems for the project the run is for joins it and answers with its problems", async () => {
  const app = chapter({ campaign: [] });
  activate(app.w3, { extensionId: "w3.problems", extensionPath: null, subscriptions: [] });
  const listing = app.tools.get("list_problems")!({}) as Promise<Problem[]>;
  await settle();
  app.release();
  assert.deepEqual((await listing).map((p) => p.message), [`${IMPORTED} is listed but its file is missing (also not in the campaign's files)`]);
  assert.deepEqual(app.asked, ["/camp"], "the campaign was listed more than once: the run wasn't joined");
});

test("whether the campaign file is there, when that can't be found out, fails the checks naming why instead of meaning no campaign", async () => {
  const app = chapter({ existsError: new Error("Permission denied (os error 13)") });
  await assert.rejects(findCampaign(app.w3), /\/camp.*couldn't be checked.*Permission denied/);
  const lookup = new FileLookup(app.w3);
  await assert.rejects(lookup.whenReady(), /couldn't be checked.*Permission denied/);
  // (Asked at once: the campaign's file list is never waited for, there's no campaign known to list.)
  await assert.rejects(app.imports.run(), /couldn't be checked.*Permission denied/);
  // The campaign's custom objects aren't taken as absent either (placed ones would all look unknown).
  await assert.rejects(knownPlacedTypes(app.w3, async () => ({ baseIds: ["hfoo"] }), async () => null), /couldn't be checked/);
  // Control: a folder that answers "not there" is no campaign, and nothing fails.
  assert.equal(await findCampaign(chapter({ isCampaign: false }).w3), undefined);
});

test("the map's file is read from where it is: the chapter's own folder, or its campaign's", async () => {
  const own = new Uint8Array([1]), theirs = new Uint8Array([2]);
  const app = chapter({
    campaign: [{ path: "map/war3mapImported/camp.blp", size: 1, modified: 1 }],
    own: { "map/war3mapImported/Own.blp": own },
    disk: { [joinPath("/camp", "map", "war3mapImported", "camp.blp")]: theirs },
  });
  const lookup = new FileLookup(app.w3);
  app.release();
  await lookup.whenReady();
  assert.equal(await lookup.read(IMPORTED), theirs, "a file only the campaign has was read from the chapter's folder");
  // The map's own file, under the spelling it has on disk.
  assert.equal(await lookup.read("war3mapImported\\own.blp"), own);
  assert.equal(await lookup.read("war3mapImported\\none.blp"), null);
  // What writing would create in the chapter's folder: the campaign's file isn't the chapter's own.
  assert.equal(lookup.inMap(IMPORTED), true);
  assert.equal(lookup.inOwnMap(IMPORTED), false);
  assert.equal(lookup.inOwnMap("war3mapImported\\Own.blp"), true);
});

test("an unreadable chapter folder of the campaign is skipped: the campaign's own files are still found", async () => {
  const app = chapter({ unreadable: [{ path: "maps/Chapter 2", error: "Permission denied (os error 13)" }] });
  assert.deepEqual((await runImports(app)).map((p) => p.message), []);
});

test("control: an unreadable folder of the campaign's own map fails the check, naming it", async () => {
  const app = chapter({ unreadable: [{ path: "map/war3mapImported", error: "Permission denied (os error 13)" }] });
  await assert.rejects(runImports(app), /couldn't be listed \(map\/war3mapImported: Permission denied/);
});

/** A model (MDX) whose only content is one texture entry. */
function mdxWithTexture(path: string): Uint8Array {
  const b = new Uint8Array(4 + 8 + 268);
  const v = new DataView(b.buffer);
  b.set([..."MDLX"].map((c) => c.charCodeAt(0)), 0);
  b.set([..."TEXS"].map((c) => c.charCodeAt(0)), 4);
  v.setUint32(8, 268, true);
  b.set([...path].map((c) => c.charCodeAt(0)), 16);
  return b;
}

test("a model's missing texture says where it was looked for, the campaign's files included", async () => {
  const app = chapter({ own: { "map/m.mdx": mdxWithTexture("Textures\\Gone.blp") } });
  const check = builtinChecks(app.w3).find((c) => c.id === "modelTextures")!;
  const run = check.run();
  await settle();
  app.release();
  assert.deepEqual((await run).map((p) => p.message), ["texture Textures\\Gone.blp not found (neither in the map, its campaign's files nor in the game)"]);
});
