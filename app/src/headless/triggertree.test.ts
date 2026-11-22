// Check Trigger Tree and the per-file diagnostics in the Problems view, over the real backend (`w3proj serve-backend`,
// headless/rustbackend.ts) on copies of the mini map: the check's findings at their file and line with their fix, the
// fix written as one edit; each trigger script file linted with its own lines, and a finding of the whole map script
// in a copied text told at the file.

import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { W3Api } from "../extensions/api";
import { MCP_EDITS_SERVICE } from "../extensions/services";
import { headless } from "./host";
import { rustBackend } from "./rustbackend";
import { fixturePath, repoPath } from "../lib/testhelpers/testutil";
import { builtinChecks } from "../builtin/problems/checks";
import { mapChecks } from "../builtin/problems/mapchecks";
import { RunScope } from "../builtin/problems/runscope";
import { MINI_BLIZZARD_J, MINI_COMMON_J } from "../lib/jass/mini-game.fixture";

const cache = join(repoPath("app", "node_modules"), ".cache", "w3-triggertree-test");
mkdirSync(cache, { recursive: true });
const work = mkdtempSync(join(cache, "run-"));
const backend = rustBackend();
test.after(async () => { await backend.stop(); rmSync(work, { recursive: true, force: true }); });

/** A copy of the mini map (with the trigger-folders fixture's tree when `imported`: items with stored ids), served. */
function project(name: string, imported = false): string {
  const root = join(work, name);
  cpSync(fixturePath("mini-map"), root, { recursive: true });
  if (imported) {
    rmSync(join(root, "map", "triggers"), { recursive: true, force: true });
    cpSync(repoPath("tests", "fixtures", "trigger-folders", "map", "triggers"), join(root, "map", "triggers"), { recursive: true });
  }
  backend.serve(root);
  return root;
}

/** The app without a window on the project; the game's scripts are the made-up stand-ins; edits written through the
 *  workspace (as the MCP server's undoable edit does), their files counted in `writes`. */
async function open(root: string): Promise<{ w3: W3Api; writes: string[] }> {
  const h = headless([], {});
  await h.workspace.open(root);
  const w3 = h.w3;
  (w3.game as { readText: (p: string) => Promise<string> }).readText = async (p: string) => {
    if (p === "Scripts\\common.j") return MINI_COMMON_J;
    if (p === "Scripts\\Blizzard.j") return MINI_BLIZZARD_J;
    throw new Error(`no ${p}`);
  };
  const writes: string[] = [];
  w3.services.provide(MCP_EDITS_SERVICE, { edit: async (_t: string, change: (read: (p: string) => Promise<string | null>) => Promise<{ path: string; text: string | null }[]>) => {
    const files = await change((p) => w3.workspace.readText(p).catch(() => null));
    for (const f of files) {
      writes.push(f.path);
      if (f.text === null) throw new Error(`${f.path}: no fix here removes a file`);
      await w3.workspace.writeText(f.path, f.text);
    }
    return files.length > 0;
  } });
  return { w3, writes };
}

const check = (w3: W3Api, id: string) => {
  const scope = new RunScope(w3);
  return [...builtinChecks(w3, () => scope), ...mapChecks(w3, () => scope)].find((c) => c.id === id)!.run();
};

test("Check Trigger Tree: an id held twice is an error at the copy with a Renumber fix, written as one edit", async () => {
  const root = project("ids", true);
  const t = join(root, "map", "triggers");
  const { w3, writes } = await open(root);
  assert.deepEqual(await check(w3, "triggerFolders"), [], "the imported tree has nothing to report (its folders share no id here)");
  // The GUI trigger copied by hand into Systems.
  const gui = readFileSync(join(t, "Initialization", "Melee_Initialization.gui.json"), "utf8");
  writeFileSync(join(t, "Systems", "Melee_Copy.gui.json"), gui);
  await w3.workspace.refresh();
  const found = await check(w3, "triggerFolders");
  assert.deepEqual(found.map((p) => [p.severity, p.location, p.fixes?.map((f) => f.label) ?? []]), [
    ["warning", "map/triggers/Systems/order.txt", ["Fix order.txt"]],
    ["error", "map/triggers/Systems/Melee_Copy.gui.json", ["Renumber"]],
    ["warning", "map/triggers/Systems/Melee_Copy.gui.json", []],
  ]);
  assert.deepEqual(found[1].reveal, { command: "w3.text.revealLine", args: ["map/triggers/Systems/Melee_Copy.gui.json", 1] });
  // Refused while anything is unsaved, nothing written.
  const unsaved = w3.editors.unsavedPaths;
  (w3.editors as { unsavedPaths: () => string[] }).unsavedPaths = () => ["map/triggers"];
  await assert.rejects(found[1].fixes![0].run(), /save or discard the changes in map\/triggers first/);
  (w3.editors as { unsavedPaths: () => string[] }).unsavedPaths = unsaved;
  assert.deepEqual(writes, []);
  await found[1].fixes![0].run();
  assert.deepEqual(writes, ["map/triggers/Systems/Melee_Copy.gui.json"], "one file: the copy");
  assert.ok(!readFileSync(join(t, "Systems", "Melee_Copy.gui.json"), "utf8").includes("\"id\""));
  assert.equal(readFileSync(join(t, "Initialization", "Melee_Initialization.gui.json"), "utf8"), gui, "the first keeps its id");
  await found[0].fixes![0].run();
  assert.ok(readFileSync(join(t, "Systems", "order.txt"), "utf8").endsWith("Melee_Copy.gui.json\n"));
  assert.deepEqual((await check(w3, "triggerFolders")).map((p) => p.severity), ["warning"], "the two triggers' one gg_trg_ name is left (a rename is the user's)");
});

test("Check Trigger Tree: conflict markers and an unreadable file are errors at their lines; no layout, nothing", async () => {
  const root = project("conflicts");
  const t = join(root, "map", "triggers");
  const { w3 } = await open(root);
  const script = join(t, "Foo_Setup", "Foo_Script.j");
  const text = readFileSync(script, "utf8");
  writeFileSync(script, text.replace("    set udg_fooCount = FooHelper()\n", "<<<<<<< HEAD\n    set udg_fooCount = FooHelper()\n=======\n    set udg_fooCount = 4\n>>>>>>> theirs\n"));
  writeFileSync(join(t, "Foo_Setup", "_category.json"), "{\"name\": ");
  await w3.workspace.refresh();
  const found = await check(w3, "triggerFolders");
  assert.deepEqual(found.map((p) => [p.severity, p.location]).sort(), [["error", "map/triggers/Foo_Setup/Foo_Script.j:3"], ["error", "map/triggers/Foo_Setup/_category.json:1"]]);
  rmSync(t, { recursive: true });
  await w3.workspace.refresh();
  assert.deepEqual(await check(w3, "triggerFolders"), []);
});

test("per-file diagnostics: a trigger script file's problem is told at its own file and line", async () => {
  const root = project("perfile");
  const { w3 } = await open(root);
  // Control: the mini map's files have nothing to report (FooHelper is the header's, udg_fooCount the whole script's).
  assert.deepEqual(await check(w3, "jass"), []);
  const script = join(root, "map", "triggers", "Foo_Setup", "Foo_Script.j");
  const text = readFileSync(script, "utf8");
  writeFileSync(script, text.replace("    set udg_fooCount = FooHelper()\n", "    set udg_fooCount = FooHelper()\n    call NoSuchFoo()\n"));
  await w3.workspace.refresh();
  const found = await check(w3, "jass");
  assert.deepEqual(found.map((p) => [p.message, p.location]), [["Unknown function NoSuchFoo", "map/triggers/Foo_Setup/Foo_Script.j:4"]]);
  const edited = readFileSync(script, "utf8");
  assert.deepEqual(found[0].reveal, { command: "w3.text.revealAt", args: ["map/triggers/Foo_Setup/Foo_Script.j", edited.indexOf("NoSuchFoo")] });
  // The map script copying the text (as a generated one does) with a udg_ name nothing declares: that finding of the
  // whole script is told at the file's line, once, not at war3map.j.
  writeFileSync(script, text.replace("udg_fooCount", "udg_fooTypo"));
  const body = readFileSync(script, "utf8").split("\n").slice(1).join("\n");
  writeFileSync(join(root, "map", "war3map.j"), `${readFileSync(join(root, "map", "triggers", "header.j"), "utf8")}${body}function main takes nothing returns nothing\nendfunction\nfunction config takes nothing returns nothing\nendfunction\n`.replace(/\n/g, "\r\n"));
  await w3.workspace.refresh();
  const moved = await check(w3, "jass");
  assert.ok(moved.some((p) => p.message === "Unknown variable udg_fooTypo" && p.location === "map/triggers/Foo_Setup/Foo_Script.j:3"), JSON.stringify(moved));
  assert.ok(!moved.some((p) => p.location?.startsWith("war3map.j") && /udg_fooTypo/.test(p.message)), JSON.stringify(moved));
});
