// A campaign's chapter map finds files in the campaign's own files too, which are listed in the
// background: the checks that ask "is this file in the map?" have to wait for that list, a list
// that can't be read must not pass for an empty one, and results found while another project was
// opened must not be shown for it.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileInfo, W3Api } from "../../extensions/api";
import type { Problem, ProblemsService } from "../../extensions/services";
import { builtinChecks } from "./checks";
import { activate } from "./index";
import { FileLookup } from "./lookup";

const CHAPTER = "/camp/maps/Chapter 1";
const IMPORTED = "war3mapImported\\camp.blp";

interface Options {
  /** The campaign's file list, as project_files gives it: a list, or an Error it fails with. */
  campaign?: FileInfo[] | Error;
  /** Whether the campaign folder holds war3campaign.w3f (else it's no campaign). */
  isCampaign?: boolean;
  /** The chapter map's import list (war3map.imp). */
  imports?: { flags: number; path: string }[];
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
  };
  const services = new Map<string, unknown>();
  const tools = new Map<string, (args: unknown) => Promise<unknown>>();
  const none = { dispose() {} };
  const w3 = {
    workspace: {
      project: () => (open ? { root: open.root, name: "ch", manifest: {}, default_output: "" } : null),
      files: () => [{ path: "map/war3map.imp.json", size: 1, modified: 1 }],
      resolve: (p: string) => `${open?.root}/${p}`,
      readText: async (p: string) => { if (p in docs) return docs[p]; throw new Error(`no ${p}`); },
      readBytes: async (p: string) => { throw new Error(`no ${p}`); },
      onDidChange: () => none,
    },
    backend: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        if (command === "fs_exists") return (opts.isCampaign ?? true) && String(args.path) === "/camp/map/war3campaign.w3f.json";
        if (command === "project_files") {
          asked.push(String(args.root));
          await released;
          if (campaign instanceof Error) throw campaign;
          return campaign;
        }
        throw new Error(`${command}: not in this test`);
      },
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
  return {
    w3, imports, release, asked, tools,
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
  assert.deepEqual(found.map((p) => p.message), [`${IMPORTED} is listed but its file is missing`]);
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
