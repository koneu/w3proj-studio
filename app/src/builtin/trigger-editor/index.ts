// Trigger Editor (host): war3map.wtg / war3map.wct as the World Editor's
// trigger module. It owns the tree (map header, variables, categories with
// triggers, comments and variables), the trigger's name, flags and comment,
// undo and saving. What a trigger contains is shown by trigger kinds that
// other extensions register through the "w3.triggers" service (GUI triggers,
// custom script, …). The files round-trip byte-exactly through lib/triggers.

import type { ExtensionContext, MenuItem, W3Api } from "../../extensions/api";
import { CODE_EDITOR_SERVICE, OBJECTS_SERVICE, TRIGGERS_SERVICE, type CodeEditorService, type FollowedRenames, type ObjectsService, type TriggerEditorHandle, type TriggerKind, type TriggerLocation, type TriggersService } from "../../extensions/services";
import { checkStringIds, compactStringIds, renumberStringRefs, StringTable } from "../../lib/formats/wts";
import { adjustStringTables, isLocaleWts, localeOnlyNumbers } from "../../lib/formats/localewts";
import { readPrunedStrings, reservedStringIds } from "../../lib/formats/prunedstrings";
import { resetTriggers } from "../../lib/triggers/defaults";
import { keyOf } from "../../lib/keys";
import { addKeyContext, UNDO_CONTEXT, undoStepOf } from "../../lib/keybindings";
import { checkpointIfOn } from "../../lib/checkpoint";
import { parseIni } from "../../lib/formats/text";
import { decodeImage } from "../../lib/image/index.ts";
import { ecaText, type DisplayContext } from "../../lib/triggers/display";
import { mapStrings, requireProject } from "../../lib/formats/mapdoc";
import { addScriptTrigger, addVariable, exportedTriggers, mapFileName, removeVariable, findTrigger, isScript, removeTrigger, scriptWarning, triggerDetail, triggerList } from "./triggerinfo";
import { MCP_EDITS_SERVICE, type McpEditsService } from "../../extensions/services";
import { ident } from "../../lib/script/jass";
import { convertToCustom, triggerCustomText } from "../../lib/script/triggers";
import { parseTriggerData, type TriggerData } from "../../lib/triggers/triggerdata";
import {
  allocItemId, parseWct, parseWctText, parseWtg, parseWtgJson, readWctFile, readWtgFile, textTriggers, TYPE_INDEX, WCT_RAW, WCT_TEXT, WTG_JSON, writeWct, writeWctFile, writeWtg, writeWctText, writeWtgFile, writeWtgJson, wtgPath,
  type CustomTextFile, type Eca, type Item, type Param, type TriggerFile, type TriggerItem, type Variable,
} from "../../lib/triggers/wtg";
import { copyText, errorView, h, widthSash } from "../../workbench/dom";
import { copyAs } from "../../lib/triggers/astext";
import { checkJass } from "../../lib/jass/check";
import { mapJass } from "../../lib/jass/env";
import { applyExpanded, collapsedOf, dropMode, moveItem, onlyFoldsUnsaved, pasteBlock, subtree, type DropMode } from "./tree";
import { deleteVariable, nameField, nameFields, newVariable, renameVariable, variableParams, variablesTable, type NameField, type VariableHost } from "./variables";
import { errorText } from "../../lib/oserror";
import { applyRenames, countInText, countRenames, globalRenames, renameInText, type RenameCount } from "../../lib/triggers/rename";
import { Listeners } from "../../lib/listeners";
import { ModeCache } from "../../lib/modecache";

/** A trigger of events, conditions and actions (not custom text, a script item or a comment). */
const isGuiTrigger = (it: Item): it is TriggerItem => "ecas" in it && it.type === 8 && !it.isCustom && !it.isComment;

/** The project's trigger file (war3map.wtg.json, or a raw war3map.wtg), or null. */
const triggerFile = (w3: W3Api) => wtgPath(w3.workspace.files());

class KindRegistry implements TriggersService {
  private kinds: TriggerKind[] = [];
  private listeners = new Set<() => void>();
  registerKind(kind: TriggerKind) {
    this.kinds.push(kind);
    this.listeners.forEach((l) => l());
    return { dispose: () => { this.kinds = this.kinds.filter((k) => k !== kind); this.listeners.forEach((l) => l()); } };
  }
  all() { return [...this.kinds].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)); }
  onChange(l: () => void) { this.listeners.add(l); return () => this.listeners.delete(l); }
  liveTriggers() { return openView?.file ?? null; }
  /** Told by the open editor after each edit, undo and redo, and when it closes. */
  readonly edits = new Listeners();
  onDidEdit(listener: () => void) { return this.edits.add(listener); }
  followRenames(kind: string, pairs: [string, string][], label: string): FollowedRenames | null {
    const view = openView;
    if (!view || !view.editable) return null;
    const forward = globalRenames(kind, pairs);
    const back = globalRenames(kind, pairs.map(([a, b]) => [b, a]));
    const first = view.followGlobals(label, forward);
    if (first === null) return null;
    // The step this handle did last and which way it went: on top of the history it's taken back in place, right
    // after it (undone) it's done again; otherwise the Trigger Editor was edited since, and it's a new step.
    let last = first, lastForward = true;
    const go = (toForward: boolean) => {
      if (openView !== view) return;
      // Text typed a moment ago becomes its step first: else the checks below look at the step before it.
      view.flush();
      if (view.isState(last) && lastForward !== toForward) { view.step(-1); return; }
      if (view.isNext(last) && lastForward === toForward) { view.step(1); return; }
      const id = view.followGlobals(label, toForward ? forward : back);
      if (id !== null) { last = id; lastForward = toForward; }
    };
    return { undo: () => go(false), redo: () => go(true) };
  }
}

/** Copied tree items with their contents, custom text and variables (shared by all maps). */
let treeClipboard: { items: Item[]; texts: (string | null)[]; variables: Variable[] } | null = null;

/** The open trigger editor (there is one war3map.wtg per project). */
let openView: TriggerView | null = null;
/** "Variables" asked before the editor was open: the new view starts there. */
let startWithVariables = false;
/** A trigger to select once the editor has opened (w3.triggers.reveal before it existed). */
let startWithTrigger: { name: string; at?: RevealAt } | null = null;

/** Where w3.triggers.reveal goes in a trigger: its id (names may repeat), a line and a parameter. */
type RevealAt = Partial<TriggerLocation> & { id?: number };
/** The trigger `name` (the one with id `at.id`, if there is one of that name). */
function findRevealed(file: TriggerFile, name: string, at?: RevealAt): Item | undefined {
  const named = file.items.filter((i) => "ecas" in i && i.name === name);
  return named.find((i) => "ecas" in i && i.id === at?.id) ?? named[0];
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  /** The open Trigger Editor, opened if it isn't. */
  const theView = async () => {
    if (!openView) await w3.commands.execute("w3.triggers.open");
    if (!openView) throw new Error("This project has no triggers to work with.");
    return openView;
  };
  /** The map's triggers for a tool. */
  const toolTriggers = async () => {
    requireProject(w3);
    const path = wtgPath(w3.workspace.files());
    if (!path) throw new Error("This map has no triggers (no war3map.wtg).");
    return readWtgFile(w3.workspace, path, () => triggerData(w3));
  };
  ctx.subscriptions.push(
    w3.mcp.registerTool("list_triggers", async ({ variables }) => triggerList(await toolTriggers(), variables === true)),
    w3.mcp.registerTool("get_trigger", async ({ name }) => {
      const file = await toolTriggers();
      const found = findTrigger(file, String(name));
      if (!found) throw new Error(`There's no trigger "${String(name)}".`);
      const all = textTriggers(file);
      const scripts = await readWctFile(w3.workspace, all.length);
      const resolve = await mapStrings(w3);
      return triggerDetail(found, scripts?.texts[all.indexOf(found)] ?? null, { data: await triggerData(w3), string: resolve }, resolve);
    }),
  );
  /** Changes the trigger files as they are on disk: a GUI file kept raw can't take a text edit. */
  const editTriggers = async (title: string, change: (file: ReturnType<typeof parseWtgJson>, scripts: ReturnType<typeof parseWctText>) => void) => {
    requireProject(w3);
    const edits = await w3.services.get<McpEditsService>(MCP_EDITS_SERVICE);
    return edits.edit(title, async (read) => {
      const [wtg, wct] = await Promise.all([read(WTG_JSON), read(WCT_TEXT)]);
      if (wtg === null) throw new Error("This project keeps its triggers raw, or has none, so they can't be edited here.");
      if (wct === null) throw new Error("This project keeps its trigger scripts raw, or has none, so they can't be edited here.");
      const file = parseWtgJson(wtg), scripts = parseWctText(wct);
      change(file, scripts);
      return [{ path: WTG_JSON, text: writeWtgJson(file) }, { path: WCT_TEXT, text: writeWctText(scripts, textTriggers(file).map((t) => t.name)) }];
    });
  };
  const named = (file: ReturnType<typeof parseWtgJson>, name: unknown) => {
    const found = findTrigger(file, String(name));
    if (!found) throw new Error(`There's no trigger "${String(name)}".`);
    return found;
  };
  ctx.subscriptions.push(
    w3.mcp.registerTool("set_trigger_enabled", async ({ name, enabled }) => {
      if (typeof enabled !== "boolean") throw new Error("enabled must be true or false.");
      const changed = await editTriggers(`${enabled ? "Enable" : "Disable"} trigger ${String(name)}`, (file) => { named(file, name).enabled = enabled; });
      return changed ? `${String(name)} is now ${enabled ? "enabled" : "disabled"}.` : "It already was.";
    }),
    w3.mcp.registerTool("set_trigger_script", async ({ name, script }) => {
      if (typeof script !== "string" || script.includes("\0")) throw new Error("script must be text.");
      const changed = await editTriggers(`Change the script of trigger ${String(name)}`, (file, scripts) => {
        const t = named(file, name);
        if (!isScript(t)) throw new Error(`${t.name} is a GUI trigger. Only triggers in script can take a script.`);
        scripts.texts[textTriggers(file).indexOf(t)] = script;
      });
      return [changed ? `Changed the script of ${String(name)}.` : "It already had that script.", scriptWarning(String(name), script)].filter(Boolean).join(" ");
    }),
    w3.mcp.registerTool("add_trigger_variable", async ({ name, type, array, size, initialValue }) => {
      if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error("name must be letters, digits and _, starting with a letter.");
      const types = (await triggerData(w3)).types;
      if (typeof type !== "string" || !types.has(type)) throw new Error(`"${String(type)}" isn't a trigger type. Some are: integer, real, boolean, string, unit, group, location, timer, hashtable, effect.`);
      await editTriggers(`Add variable ${name}`, (file) => addVariable(file, { name, type, isArray: array === true, arraySize: typeof size === "number" ? size : 1, initialValue: typeof initialValue === "string" ? initialValue : "" }));
      return `Added the variable; scripts call it udg_${name}.`;
    }),
    w3.mcp.registerTool("remove_trigger_variable", async ({ name }) => {
      if (typeof name !== "string" || !name.trim()) throw new Error("remove_trigger_variable needs a name.");
      let removed = "";
      await editTriggers(`Remove variable ${name}`, (file, scripts) => { removed = removeVariable(file, scripts, name.trim().replace(/^udg_/, "")); });
      return `Removed the variable ${removed}.`;
    }),
    w3.mcp.registerTool("set_script_header", async ({ script }) => {
      if (typeof script !== "string" || script.includes("\0")) throw new Error("script must be text.");
      const changed = await editTriggers("Change the custom script", (_, scripts) => { scripts.header = script; });
      return changed ? "Changed the custom script." : "It already said that.";
    }),
    w3.mcp.registerTool("remove_trigger", async ({ name }) => {
      await editTriggers(`Remove trigger ${String(name)}`, (file, scripts) => removeTrigger(file, scripts, named(file, name)));
      return `Removed ${String(name)}.`;
    }),
    w3.mcp.registerTool("create_script_trigger", async ({ name, script, category }) => {
      if (typeof name !== "string" || !name.trim()) throw new Error("create_script_trigger needs a name.");
      if (typeof script !== "string" || script.includes("\0")) throw new Error("script must be text.");
      await editTriggers(`Create trigger ${name}`, (file, scripts) => addScriptTrigger(file, scripts, name.trim(), script, typeof category === "string" ? category : undefined));
      return [`Created the trigger ${name.trim()}.`, scriptWarning(name.trim(), script)].filter(Boolean).join(" ");
    }),
  );
  const kinds = new KindRegistry();
  const open = () => w3.commands.execute("w3.triggers.open").catch((e) => w3.window.showError(String(e)));
  // war3map.wct.txt (every trigger's text in one file) in the text editor: highlighted in the map's script language,
  // with its functions listed, not checked (its texts use the map's generated globals and each other).
  void w3.services.get<CodeEditorService>(CODE_EDITOR_SERVICE).then((code) => {
    ctx.subscriptions.push(code.registerFileLanguage({ id: "wct", title: "Custom script texts", base: "jass", baseOf: () => scriptLanguage(w3), extensions: [".wct.txt"] }));
  }).catch(() => {});
  ctx.subscriptions.push(
    w3.services.provide(TRIGGERS_SERVICE, kinds),
    w3.commands.register("w3.triggers.open", async () => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      const path = triggerFile(w3);
      if (!path) throw new Error("This project has no war3map.wtg.");
      await w3.editors.open(path, "w3.triggerEditor");
      openView?.setMode("triggers");
    }),
    // Selects a trigger by name (opening the editor first); used by the Object Manager. `at` (Problems):
    // the trigger's id, where names repeat, and the line and parameter to show in it.
    w3.commands.register("w3.triggers.reveal", async (name: string, at?: RevealAt) => {
      startWithVariables = false;
      startWithTrigger = openView ? null : { name, at };
      await w3.commands.execute("w3.triggers.open");
      const it = openView ? findRevealed(openView.file, name, at) : undefined;
      if (it) openView!.revealItem(it, at);
    }),
    // Renamed regions, cameras and the like (`kind` "rct", "cam"; `pairs` [old name, new name]) in the
    // triggers: GUI parameters always, script text after a question. In the open Trigger Editor as one undo
    // step (saved at once if it had nothing unsaved), else in the files. What changed; null without triggers.
    w3.commands.register("w3.triggers.renameGlobals", async (kind: unknown, pairs: unknown, what?: unknown) => {
      if (typeof kind !== "string" || !Array.isArray(pairs)) throw new Error("w3.triggers.renameGlobals takes a kind and [old, new] name pairs.");
      return renameGlobals(w3, kind, pairs as [string, string][], typeof what === "string" ? what : "objects");
    }),
    // Rename or delete a trigger or variable from elsewhere (the Object Manager), as the Trigger Editor does by hand: it
    // opens at it, and the change is an unsaved undo step there. Delete asks first. True when it was done.
    w3.commands.register("w3.triggers.itemAction", async (kind: unknown, name: unknown, action: unknown, to?: unknown) => {
      if ((kind !== "trigger" && kind !== "variable") || typeof name !== "string" || (action !== "rename" && action !== "delete")) {
        throw new Error("w3.triggers.itemAction takes \"trigger\" or \"variable\", a name and \"rename\" or \"delete\".");
      }
      if (action === "rename" && (typeof to !== "string" || !to.trim())) throw new Error("Renaming needs a name.");
      if (kind === "trigger") await w3.commands.execute("w3.triggers.reveal", name);
      else await w3.commands.execute("w3.triggers.variables");
      const view = openView;
      if (!view) throw new Error("The Trigger Editor didn't open.");
      if (!view.editable) throw new Error("This trigger file can't be changed here.");
      return kind === "trigger" ? view.triggerAction(name, action, typeof to === "string" ? to.trim() : "") : view.variableAction(name, action, typeof to === "string" ? to.trim() : "");
    }),
    w3.commands.register("w3.triggers.convertToCustomText", async () => {
      if (!openView) throw new Error("Open the Trigger Editor and select a GUI trigger first.");
      await openView.convertSelected();
    }),
    // The World Editor's Copy As Text / Copy As Script: the selected trigger, or the line selected in it (`lines`, or
    // the trigger's contents clicked last), onto the system clipboard. What was copied.
    ...(["text", "script"] as const).map((as) => w3.commands.register(as === "text" ? "w3.triggers.copyAsText" : "w3.triggers.copyAsScript", async (opts?: { lines?: boolean }) => {
      if (!openView) throw new Error("Open the Trigger Editor and select a trigger first.");
      return openView.copyToClipboard(as, opts?.lines);
    })),
    w3.commands.register("w3.triggers.variables", async () => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      const path = triggerFile(w3);
      if (!path) throw new Error("This project has no war3map.wtg.");
      startWithVariables = !openView;
      await w3.editors.open(path, "w3.triggerEditor");
      openView?.showVariables();
    }),
    // Activity bar entry: a way in and what the map has.
    w3.views.register("w3.triggers.overview", {
      render(el) {
        if (!w3.workspace.project()) { el.append(h("div.view-empty", {}, "Open or import a project to see its triggers.")); return; }
        const path = triggerFile(w3);
        if (!path) { el.append(h("div.view-empty", {}, "This project has no war3map.wtg.")); return; }
        const facts = h("div.terrain-facts.muted", {}, "Reading triggers…");
        el.append(h("div.tree", {}, h("div.tree-row.obj-kind", { onclick: open, title: "F4" },
          h("span.tree-icon", {}, "›"), h("span.tree-label", {}, "Open Trigger Editor")),
          h("div.tree-row.obj-kind", { onclick: () => w3.commands.execute("w3.triggers.variables").catch((e) => w3.window.showError(String(e))) },
            h("span.tree-icon", {}, "›"), h("span.tree-label", {}, "Variables"))), facts);
        void (async () => {
          const file = await readWtgFile(w3.workspace, path, () => triggerData(w3));
          const n = (t: number) => file.items.filter((i) => i.type === t).length;
          facts.replaceChildren(
            h("div", {}, `${n(8) + n(32)} triggers · ${n(4)} categories`),
            h("div", {}, `${file.variables.length} variables${n(16) ? ` · ${n(16)} comments` : ""}`));
        })().catch((e) => { facts.textContent = String((e as Error).message ?? e); });
      },
    }),
    w3.workspace.onDidChange(() => w3.views.refresh("w3.triggers.overview")),
    // The World Editor's files, a .wtg and its .wct beside it. Importing replaces everything, as there.
    w3.commands.register("w3.triggers.export", async () => {
      const view = await theView();
      const path = await w3.window.pickSaveFile({ title: "Export triggers", defaultPath: "triggers.wtg", filters: [{ name: "Triggers (.wtg)", extensions: ["wtg"] }] });
      if (!path) return;
      // With the tree's open and closed categories, as a save writes them.
      await w3.backend.writeBytes(path, writeWtg(exportedTriggers(view.mark().file, mapFileName(w3.workspace.project()?.default_output))));
      await w3.backend.writeBytes(path.replace(/\.wtg$/i, "") + ".wct", writeWct(view.customFile()));
      void w3.window.showInfo(`Exported ${textTriggers(view.file).length} triggers and ${view.file.variables.length} variables, with their .wct beside them.`);
    }),
    w3.commands.register("w3.triggers.import", async () => {
      const view = await theView();
      const path = await w3.window.pickFile({ title: "Import triggers", filters: [{ name: "Triggers (.wtg)", extensions: ["wtg"] }] });
      if (!path) return;
      const file = parseWtg(await w3.backend.readBytes(path), await triggerData(w3));
      const scripts = await w3.backend.readBytes(path.replace(/\.wtg$/i, "") + ".wct").then((b) => parseWct(b, textTriggers(file).length)).catch(() => null);
      if (!(await w3.window.confirm("Importing replaces all current triggers and variables. Ctrl+Z takes it back.", "Import", 60000))) return;
      view.replaceAll(file, scripts);
      void w3.window.showInfo(`Imported ${textTriggers(file).length} triggers and ${file.variables.length} variables${scripts ? "" : ", without a .wct: their custom scripts are empty"}.`);
    }),
    // The World Editor's Reset Triggers: asked first ("Clear all triggers and reset to default?"), a checkpoint of the
    // saved map, then one undo step in the Trigger Editor (saved with it). True when done.
    w3.commands.register("w3.triggers.reset", async () => {
      const view = await theView();
      if (!view.editable) throw new Error("This trigger file can't be changed here.");
      const n = textTriggers(view.file).length, v = view.file.variables.length;
      if (!(await w3.window.confirm(`Clear all triggers and reset to default? ${n} trigger${n === 1 ? "" : "s"} and ${v} variable${v === 1 ? "" : "s"} go; `
        + "the melee initialization trigger is all that's left. A checkpoint of the saved map is made first; Ctrl+Z takes it back.", "Reset Triggers", 60_000))) return false;
      await checkpointIfOn(w3, "Reset Triggers");
      // The editor closed or another opened during the question or the checkpoint: nothing happens.
      if (openView !== view) return false;
      view.resetTriggers(mapFileName(w3.workspace.project()?.default_output));
      return true;
    }),
    // Adjust Map String IDs: a string of war3map.wts gets another number (`ids` [[from, to], …], else asked), or all are
    // numbered from 1 in order; every TRIGSTR_ reference in the map's text files follows, and so do the languages' tables
    // (_Locales, lib/formats/localewts: their own numbers stay, and no string takes one). One edit of all the files (Undo
    // in the message, or the MCP edits' undo); refused while anything is unsaved. How many strings changed number.
    w3.commands.register("w3.triggers.adjustStringIds", async (ids?: unknown) => adjustStringIds(w3, ids)),
    w3.editors.registerProvider("w3.triggerEditor", {
      async resolve(el, doc) {
        el.classList.add("trig-editor");
        el.append(h("div.muted.trig-loading", {}, "Reading triggers…"));
        const data = await triggerData(w3);
        let file: TriggerFile;
        try {
          file = await readWtgFile(doc, doc.path, async () => data);
        } catch (e) {
          el.replaceChildren(errorView(`Can't read ${doc.path}: ${errorText(e)}`, h("button.link-inline", { onclick: () => w3.editors.open(doc.path, "w3.hexViewer") }, "Open in Binary Viewer")));
          return {};
        }
        const game = doc.path.startsWith("game:");
        const custom = game ? null : await readWctFile(w3.workspace, textTriggers(file).length);
        let wtsText = game ? null : await w3.workspace.readText("map/war3map.wts").catch(() => null);
        let strings = wtsText !== null ? new StringTable(wtsText) : null;
        const names = await objectNames(w3, file);
        // Ids that show up later (new parameters) are looked up on demand; the view redraws once.
        const objects = await w3.services.get<ObjectsService>(OBJECTS_SERVICE).catch(() => null);
        const asked = new Set(names.keys());
        let redraw = 0;
        const objectName = (id: string) => {
          if (!asked.has(id) && objects) {
            asked.add(id);
            void objects.name(id).then((n) => {
              if (!n) return;
              names.set(id, n);
              clearTimeout(redraw);
              redraw = window.setTimeout(() => view.refresh(), 50);
            });
          }
          return names.get(id);
        };
        const display: DisplayContext = { data, string: (v) => strings?.resolve(v) ?? v, objectName };
        const lua = (await scriptLanguage(w3)) === "lua";
        el.replaceChildren();
        const code = await w3.services.get<CodeEditorService>(CODE_EDITOR_SERVICE).catch(() => null);
        const view = new TriggerView(w3, el, kinds, file, custom, data, display, !doc.readOnly, lua ? "lua" : "jass", (d) => doc.setDirty(d), code);
        if (!doc.readOnly) {
          openView = view;
          view.edited = () => { if (openView === view) kinds.edits.fire(); };
        }
        // Asked for (Variables, a trigger to show), else where it was when the tab was last open.
        const askedWhere = startWithVariables || !!startWithTrigger;
        if (startWithVariables) { startWithVariables = false; view.showVariables(); }
        if (startWithTrigger) {
          const { name, at } = startWithTrigger;
          const it = findRevealed(view.file, name, at);
          startWithTrigger = null;
          if (it) view.revealItem(it, at);
        }
        if (!askedWhere) view.applyViewState(doc.viewState);
        const write = async () => {
          // What is saved is the state at the start; an edit made meanwhile stays unsaved.
          const at = view.mark();
          await writeWtgFile({ writeText: (_, t) => doc.writeText(t), writeBytes: (_, b) => doc.writeBytes(b) }, doc.path, at.file);
          await writeWctFile(w3.workspace, at.custom, textTriggers(at.file).map((t) => t.name));
          view.markSaved(at.step, at.toggles);
        };
        // The user's save (Ctrl+S, Save All, Save on closing): a name typed into the focused name field is part of it,
        // after the rename's question if it asks one (the workbench's commitField leaves editors with a flush alone).
        const save = async () => {
          await view.commitName();
          // Closed while the question was open: the close decided about the unsaved changes.
          if (view.closed) throw new Error("The Trigger Editor was closed before it saved.");
          await write();
        };
        // A save the user didn't ask for (renamed objects followed): it doesn't rename what is being typed.
        view.persist = write;
        return {
          undo: () => view.step(-1),
          redo: () => view.step(1),
          viewState: () => view.viewState(),
          flush: () => view.flush(),
          viewOnlyUnsaved: () => view.onlyFoldsDirty,
          save,
          // The triggers' texts are this editor's too: saved by something else (set_trigger_script), it opens
          // again, else its next save would put back the texts it read.
          // The string table gives the texts of TRIGSTR_ parameters: saved by another editor, they are shown again
          // in place (nothing is edited, selection and scroll stay). A table that can't be read keeps the old texts.
          watches: game ? [] : [WCT_TEXT, WCT_RAW, WTS],
          reloadFile: async (path: string) => {
            if (path !== WTS) return false;
            const text = await w3.workspace.readText(WTS).catch(() => null);
            if (view.closed) return true;
            if (text === null || text === wtsText) return true;
            wtsText = text;
            strings = new StringTable(text);
            view.refresh();
            return true;
          },
          dispose: () => {
            view.dispose();
            if (openView === view) { openView = null; kinds.edits.fire(); }
          },
        };
      },
    }),
  );
}

/** The map's script language (war3map.w3i scriptType 1 is Lua); JASS when the map info isn't there or can't be read. */
function scriptLanguage(w3: W3Api): Promise<"jass" | "lua"> {
  return w3.workspace.readText("map/war3map.w3i.json").then((t) => (JSON.parse(t).scriptType === 1 ? "lua" as const : "jass" as const)).catch(() => "jass" as const);
}

/** Asks whether script text changes too; dismissing it keeps the scripts as they are. */
async function askScripts(w3: W3Api, renames: ReadonlyMap<string, string>, uses: number): Promise<boolean> {
  if (!uses) return false;
  const names = [...renames.keys()];
  const listed = names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
  const c = await w3.window.showWarning(`${listed} appear${names.length === 1 ? "s" : ""} ${uses} time${uses === 1 ? "" : "s"} in custom script. Rename ${names.length === 1 ? "it" : "them"} there too?`,
    "Rename in script too", "Only GUI triggers");
  return c === "Rename in script too";
}

/** See w3.triggers.renameGlobals. */
async function renameGlobals(w3: W3Api, kind: string, pairs: [string, string][], what: string, tries = 0): Promise<(RenameCount & { inEditor: boolean }) | null> {
  const renames = globalRenames(kind, pairs);
  const root = w3.workspace.project()?.root;
  if (!root || !renames.size) return null;
  const label = `Rename ${what} in triggers`;
  const same = () => w3.workspace.project()?.root === root;
  const view = openView;
  if (view && view.editable) {
    const withScripts = await askScripts(w3, renames, view.countGlobals(renames).script);
    // The editor closed or another project opened during the question: start again with what is there now.
    if (!same()) return null;
    if (openView !== view) return tries < 2 ? renameGlobals(w3, kind, pairs, what, tries + 1) : null;
    // What followed the renames at once (followRenames) is saved with them, as is this step.
    const clean = view.unsavedOnlyFollows();
    const n = view.renameGlobals(label, renames, withScripts);
    if (view.dirty) {
      if (clean) await view.persist();
      else if (n.gui || n.script) void w3.window.showInfo(`${label}: changed in the Trigger Editor, which has other unsaved changes too; save it to keep them.`);
    }
    return { ...n, inEditor: true };
  }
  const path = wtgPath(w3.workspace.files());
  if (!path) return null;
  // A file that is there and can't be read stops here: it isn't written over.
  const read = async () => {
    const file = await readWtgFile(w3.workspace, path, () => triggerData(w3));
    const custom = await readWctFile(w3.workspace, textTriggers(file).length);
    return { file, custom };
  };
  const first = await read();
  const scriptsOf = (c: CustomTextFile | null) => (c ? [c.header, ...c.texts] : []);
  const would = countRenames(first.file, scriptsOf(first.custom), renames);
  if (!would.gui && !would.script) return { gui: 0, script: 0, inEditor: false };
  const withScripts = await askScripts(w3, renames, would.script);
  if (!same()) return null;
  // The Trigger Editor opened during the question: it holds the triggers now.
  if (openView) return tries < 2 ? renameGlobals(w3, kind, pairs, what, tries + 1) : null;
  // Read again: the files may have changed during the question.
  const { file, custom } = await read();
  const texts = custom ? [{ get: () => custom.header, set: (t: string) => { custom.header = t; } }, ...custom.texts.map((_, k) => ({ get: () => custom.texts[k], set: (t: string) => { custom.texts[k] = t; } }))] : [];
  const n = applyRenames(file, texts, renames, withScripts);
  // Custom Script actions are in the trigger file too.
  if (n.gui || n.script) await writeWtgFile(w3.workspace, path, file);
  if (custom && n.script) await writeWctFile(w3.workspace, custom, textTriggers(file).map((t) => t.name));
  return { ...n, inEditor: false };
}

const WTS = "map/war3map.wts";
/** The map's files that hold text, where TRIGSTR_ references can be (object data, map info, triggers, scripts, …). */
const TEXT_FILE = /^map\/.*\.(json|j|lua|txt|fdf|toc)$/i;
/** The map's own files kept raw (no codec): binary, so a reference in them can't be renumbered as text. */
const RAW_MAP_FILE = /^map\/war3(map|campaign)[^/]*$/i;

/** The terrain editor's files: they hold no string references (its w3i changes edit the file as it is then). */
const TERRAIN_FILE = /^map\/war3map\.w3e(\.txt)?$/i;

/** Opens the editors of the map's files again, those that can hold string references (TRIGSTR_): their undo history
 *  holds the numbers as they were, and an undo would bring back a reference that now names another string (or none).
 *  Adjust refuses while anything is unsaved, so they're all saved; one changed meanwhile keeps its history, and is
 *  named. Editors of a file Adjust changed or watching war3map.wts may have opened again already: once more is safe. */
async function forgetStringHistory(w3: W3Api) {
  const kept: string[] = [];
  for (const f of w3.workspace.files()) {
    if (!(TEXT_FILE.test(f.path) || RAW_MAP_FILE.test(f.path)) || TERRAIN_FILE.test(f.path)) continue;
    if ((await w3.editors.reopen(f.path)) > 0) kept.push(f.path);
  }
  if (kept.length) {
    void w3.window.showWarning(`${kept.join(", ")} ${kept.length === 1 ? "was" : "were"} changed during Adjust Map String IDs and kept ${kept.length === 1 ? "its" : "their"} undo history: an undo there can bring back a string ID that names another string now.`);
  }
}

/** See w3.triggers.adjustStringIds. */
async function adjustStringIds(w3: W3Api, given: unknown): Promise<number> {
  const asked = requireProject(w3).root;
  // The tables and the files that refer to strings come from the file list: only once it has every file.
  await w3.workspace.filesReady();
  if (w3.workspace.project()?.root !== asked) throw new Error("Not changed: the project changed meanwhile.");
  const listed = w3.workspace.files().some((f) => f.path.toLowerCase() === WTS);
  if (!listed) throw new Error("This map has no string table (war3map.wts).");
  // There but unreadable is an error, not an empty table.
  const table = new StringTable(await w3.workspace.readText(WTS));
  // Numbers an earlier drop recorded stay free: a reference to one can come back (a record that can't be read refuses).
  const reserved = reservedStringIds(await readPrunedStrings(w3), table);
  // The languages' tables follow the same numbers (lib/formats/localewts); their own numbers stay, and stay free. One
  // that is there but can't be read refuses: its numbers can't be told.
  const localePaths = w3.workspace.files().map((f) => f.path).filter(isLocaleWts);
  const locales: { path: string; wts: string }[] = [];
  for (const path of localePaths) {
    const wts = await w3.workspace.readText(path).catch((e) => { throw new Error(`Not changed: ${path} can't be read (${errorText(e)}), so its strings can't follow the new IDs.`); });
    locales.push({ path, wts });
  }
  const localeOnly = localeOnlyNumbers(table, locales);
  let ids: Map<number, number>;
  if (given !== undefined) {
    if (!Array.isArray(given) || !given.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number"))) {
      throw new Error("w3.triggers.adjustStringIds takes [from, to] pairs of string IDs.");
    }
    ids = new Map(given as [number, number][]);
  } else {
    const nums = [...table.entries()].map(([n]) => n).sort((a, b) => a - b);
    if (!nums.length) { void w3.window.showInfo("The map's string table is empty."); return 0; }
    const ALL = -1;
    const picked = await w3.window.quickPick<number>([
      { label: `Renumber all from 1 in order (${nums.length} strings)`, value: ALL },
      ...nums.map((n) => ({ label: `STRING ${n}`, description: (table.get(n) ?? "").split(/\r?\n/)[0].slice(0, 80), value: n })),
    ], { placeholder: "Adjust Map String IDs: which string gets a new ID?" });
    if (picked?.value === undefined) return 0;
    if (picked.value === ALL) ids = compactStringIds(table, 1, new Set([...reserved, ...localeOnly.keys()]));
    else {
      const typed = await w3.window.inputBox({ prompt: `New ID for string ${picked.value} (its references in the map follow)`, value: String(picked.value) });
      if (typed === undefined) return 0;
      if (!/^\s*\d+\s*$/.test(typed)) throw new Error(`"${typed}" isn't a string ID (a whole number from 0).`);
      ids = new Map([[picked.value, Number(typed)]]);
    }
  }
  for (const [from, to] of [...ids]) if (from === to) ids.delete(from);
  checkStringIds(table, ids, reserved, localeOnly);
  if (!ids.size) { void w3.window.showInfo("Nothing to change: the strings keep their IDs."); return 0; }
  // A raw map file can't be changed as text: a reference in it would be left pointing at another string.
  const raw: string[] = [];
  for (const f of w3.workspace.files()) {
    if (!RAW_MAP_FILE.test(f.path) || TEXT_FILE.test(f.path) || f.path.toLowerCase() === WTS) continue;
    const bytes = await w3.workspace.readBytes(f.path);
    if (new TextDecoder("latin1").decode(bytes).includes("TRIGSTR_")) raw.push(f.path);
  }
  if (raw.length) throw new Error(`Not changed: ${raw.join(", ")} ${raw.length === 1 ? "is" : "are"} kept raw and refer${raw.length === 1 ? "s" : ""} to strings, which can't be renumbered there.`);
  const texts = w3.workspace.files().map((f) => f.path).filter((p) => TEXT_FILE.test(p));
  const edits = await w3.services.get<McpEditsService>(MCP_EDITS_SERVICE);
  const root = asked;
  let files = 0, languages = 0;
  const done = await edits.edit("Adjust Map String IDs", async (read) => {
    // The lists above are that project's (the questions may have taken a while).
    if (w3.workspace.project()?.root !== root) throw new Error("Not changed: the project changed meanwhile.");
    const wts = await read(WTS);
    if (wts === null) throw new Error("The map's string table (war3map.wts) is gone.");
    // Read again: what was asked is checked against the tables and the record as they are now (a language's table gone
    // meanwhile has nothing to follow).
    const now = new StringTable(wts);
    const localesNow: { path: string; wts: string }[] = [];
    for (const path of localePaths) {
      const text = await read(path).catch((e) => { throw new Error(`Not changed: ${path} can't be read (${errorText(e)}), so its strings can't follow the new IDs.`); });
      if (text !== null) localesNow.push({ path, wts: text });
    }
    const adjusted = adjustStringTables(wts, localesNow, ids, reservedStringIds(await readPrunedStrings(w3), now));
    const renumbered = adjusted.locales;
    const out = [{ path: WTS, text: adjusted.wts }, ...renumbered.map((l) => ({ path: l.path, text: l.wts }))];
    for (const path of texts) {
      const text = await read(path);
      const next = text === null ? null : renumberStringRefs(text, ids);
      if (next !== null) out.push({ path, text: next });
    }
    languages = renumbered.length;
    files = out.length - 1 - languages;
    return out;
  }, async () => {
    // After the edit and after its undo: the numbers changed under the editors' undo history.
    if (w3.workspace.project()?.root === root) await forgetStringHistory(w3);
  });
  if (done) {
    const tables = languages ? `, ${languages} language${languages === 1 ? "'s table" : "s' tables"}` : "";
    void w3.window.showInfo(`${ids.size} string${ids.size === 1 ? "" : "s"} got a new ID, in war3map.wts${tables} and ${files} file${files === 1 ? "" : "s"} that refer to them. Open editors of the map's texts start a new undo history.`, "Undo")
      .then((a) => { if (a === "Undo") void w3.commands.execute("w3.mcp.undo").catch((e) => w3.window.showError(String(e))); });
  }
  return done ? ids.size : 0;
}

/** TriggerData with WESTRING_ names resolved, loaded once. */
let dataPromise: Promise<TriggerData> | null = null;
function triggerData(w3: W3Api): Promise<TriggerData> {
  dataPromise ??= (async () => {
    const strings = new Map<string, string>();
    for (const f of ["UI\\WorldEditStrings.txt", "UI\\WorldEditGameStrings.txt"]) {
      for (const sec of parseIni(await w3.game.readText(f).catch(() => "")).values()) for (const [k, v] of sec) strings.set(k.toUpperCase(), v);
    }
    const hints = await w3.game.readText("UI\\TriggerStrings.txt").catch(() => "");
    return parseTriggerData(await w3.game.readText("UI\\TriggerData.txt"), strings, hints);
  })();
  dataPromise.catch(() => { dataPromise = null; });
  return dataPromise;
}

/** Names of the object ids the triggers mention (raw codes and gg_unit_xxxx globals). */
async function objectNames(w3: W3Api, file: TriggerFile): Promise<Map<string, string>> {
  const ids = new Set<string>();
  const visitParam = (p: Param) => {
    if (p.type === 3 && p.value.length === 4) ids.add(p.value);
    const g = /^gg_(?:unit|item|dest)_(.{4})_\d+$/.exec(p.value);
    if (g) ids.add(g[1]);
    p.call?.params.forEach(visitParam);
    if (p.index) visitParam(p.index);
  };
  const visit = (e: Eca) => { e.params.forEach(visitParam); e.children.forEach(visit); };
  for (const it of file.items) if ("ecas" in it) it.ecas.forEach(visit);
  const out = new Map<string, string>();
  const objects = await w3.services.get<ObjectsService>(OBJECTS_SERVICE).catch(() => null);
  if (!objects) return out;
  await Promise.all([...ids].map(async (id) => {
    const n = await objects.name(id).catch(() => undefined);
    if (n) out.set(id, n);
  }));
  return out;
}

/** Game images (category icons) as data URLs, by graphics mode and path (the modes have their own icons). */
const iconCache = new ModeCache<string | null>();
function icon(w3: W3Api, path: string): Promise<string | null> {
  if (!path) return Promise.resolve(null);
  return iconCache.get(() => w3.settings.get<string>("game.graphicsMode") ?? "hd", path.toLowerCase(), () => (async () => {
    const file = /\.\w+$/.test(path) ? path : `${path}.blp`;
    const mip = decodeImage(await w3.game.read(file), file).mip(0);
    const canvas = document.createElement("canvas");
    canvas.width = mip.width;
    canvas.height = mip.height;
    canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(mip.rgba), mip.width, mip.height), 0, 0);
    return canvas.toDataURL();
  })().catch(() => null));
}

type Selection = { kind: "header" } | { kind: "variables" } | { kind: "item"; type: number; id: number };
interface Snapshot { file: TriggerFile; texts: (string | null)[]; header: string | null }

class TriggerView {
  private tree = h("div.trig-tree-rows");
  private detail = h("div.trig-detail");
  private selected: Selection = { kind: "header" };
  private collapsed = new Set<number>();
  /** Custom text per trigger (war3map.wct is stored in trigger order). */
  private texts = new Map<TriggerItem, string | null>();
  private header: string | null;
  /** `id`: the state after the step, unique, so a saved state is known again after undo and redo. */
  private undo: { label: string; before: Snapshot; after: Snapshot; id: number; replaces?: boolean }[] = [];
  private nextId = 1;
  /** The state now: the id of the last step done, 0 for the state the editor opened with. */
  private get state() { return this.at ? this.undo[this.at - 1].id : 0; }
  private at = 0;
  /** The state last saved (see `state`). */
  private savedAt = 0;
  /** Categories expanded or collapsed by hand so far, and how many of those the last save had: a toggle is view state
   *  the file keeps (each category's `expanded`, as the World Editor saves it), so it makes the editor unsaved without
   *  being an undo step. */
  private toggles = 0;
  private savedToggles = 0;
  private body: { dispose?(): void; keyDown?(e: KeyboardEvent): boolean; flush?(): void } | void = undefined;
  private handle: TriggerEditorHandle;
  private vars: VariableHost;
  private unsubscribe: () => void;
  /** Where the last click was: keys go to the trigger's contents or to the tree. */
  private area: "tree" | "detail" = "tree";
  private keydown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    // Code editors have their own undo, copy and paste.
    if (e.target instanceof Element && e.target.closest(".cm-editor")) return;
    if (this.area === "detail" && this.body?.keyDown?.(e)) { e.preventDefault(); return; }
    if (keyOf(e) === "Delete" && this.handle.editable) { e.preventDefault(); this.deleteSelected(); return; }
    const step = undoStepOf(this.w3.keybindings.commandsFor(e));
    if (step) { e.preventDefault(); this.step(step === "undo" ? -1 : 1); return; }
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = keyOf(e).toLowerCase();
    if (this.area === "tree" && (k === "c" || k === "x" || k === "v")) {
      e.preventDefault();
      if (k === "v") this.pasteItems(); else this.copyItem(k === "x");
    }
  };

  constructor(private w3: W3Api, private el: HTMLElement, private kinds: KindRegistry, public file: TriggerFile,
    private custom: CustomTextFile | null, data: TriggerData, display: DisplayContext, editable: boolean,
    language: "jass" | "lua", private setDirty: (dirty: boolean) => void, private code: CodeEditorService | null = null) {
    const tt = textTriggers(file);
    tt.forEach((t, i) => this.texts.set(t, custom?.texts[i] ?? null));
    this.header = custom?.header ?? null;
    this.followExpanded();
    const view = this;
    this.handle = {
      get file() { return view.file; }, data, display, editable, language,
      customText: (t) => this.texts.get(t) ?? null,
      setCustomText: (t, text) => { this.texts.set(t, text); },
      edit: (label, change, opts) => this.edit(label, change, opts),
      icon: (path) => icon(w3, path),
      openTrigger: (name) => {
        const it = this.file.items.find((i) => "ecas" in i && i.type !== 16 && `gg_trg_${ident(i.name)}` === name);
        if (it) this.revealItem(it);
        return !!it;
      },
    };
    this.vars = {
      handle: this.handle,
      allocId: (type) => this.allocId(type),
      category: () => this.variableCategory(),
      select: (v) => {
        this.selected = this.file.reforged ? { kind: "item", type: 64, id: v.id } : { kind: "variables" };
        if (this.mode === "triggers") this.mode = "variables";
      },
      scripts: () => [
        { get: () => this.header, set: (t) => { this.header = t; } },
        ...textTriggers(this.file).map((t) => ({ get: () => this.texts.get(t) ?? null, set: (text: string) => { this.texts.set(t, text); } })),
      ],
    };
    el.tabIndex = -1;
    addKeyContext(el, UNDO_CONTEXT);
    el.addEventListener("keydown", this.keydown);
    const treePane = h("div.trig-tree", { onmousedown: () => { this.area = "tree"; } }, this.modeBar, this.searchBox, editable ? this.toolbar() : null, this.tree);
    el.append(treePane, this.detail);
    // The tree's width, dragged at its edge (remembered for every Trigger Editor); the CSS leaves the trigger 240px.
    widthSash({ key: "triggerEditor.tree", pane: treePane, initial: 300, min: 180, max: () => Math.max(180, el.clientWidth - 240),
      apply: (px) => el.style.setProperty("--trig-tree-width", `${px}px`) });
    this.detail.addEventListener("mousedown", () => { this.area = "detail"; });
    // A name typed but not committed makes the tab unsaved, and leaving the field (committed or put back) settles it.
    this.detail.addEventListener("input", (e) => { if (e.target instanceof HTMLInputElement && nameFields.has(e.target)) this.report(); });
    this.detail.addEventListener("focusout", (e) => {
      if (e.target instanceof HTMLInputElement && nameFields.has(e.target)) setTimeout(() => { if (!this.disposed) this.report(); });
    });
    this.tree.addEventListener("scroll", () => { if (this.tree.clientHeight > 0) this.treeTop = this.tree.scrollTop; });
    this.unsubscribe = kinds.onChange(() => this.renderDetail());
    this.renderTree();
    this.renderDetail();
  }

  private disposed = false;
  private flushing = false;
  /** Text typed but not committed yet becomes its undo step now: a code editor's change waiting for the pause in
   *  typing, and the focused text box's (they commit when they lose the focus). Called before a save reads the state
   *  (mark), before other edits, undo and redo, and when the selection changes, so nothing typed a moment ago is
   *  left out of a save or put back after them. */
  flush() {
    if (this.flushing || this.disposed) return;
    this.flushing = true;
    try {
      this.body?.flush?.();
      // Their change handlers do nothing when the text is what the trigger already has.
      const a = document.activeElement;
      if (a instanceof HTMLTextAreaElement && this.detail.contains(a)) a.dispatchEvent(new Event("change"));
    } finally {
      this.flushing = false;
    }
  }
  dispose() { this.disposed = true; this.body?.dispose?.(); this.unsubscribe(); this.el.removeEventListener("keydown", this.keydown); }

  /** The World Editor's Convert to Custom Text: the selected GUI trigger becomes the script the map script
   *  has for it (InitTrig_<name> and all), after a question, as one undo step. False if not done. */
  async convertSelected(): Promise<boolean> {
    const it = this.find(this.selected);
    if (!it || !isGuiTrigger(it)) throw new Error("Select a GUI trigger to convert to custom text.");
    if (!this.handle.editable) throw new Error("This trigger file can't be changed here.");
    const lua = this.handle.language === "lua", was = JSON.stringify(it);
    // Placed objects the trigger names keep their globals: the map script reads custom text for them too.
    const ok = await this.w3.window.confirm(`Convert ${it.name} to custom text? Its events, conditions and actions become the ${lua ? "Lua" : "JASS"} the map script has for them. `
      + "It can't be turned back into a GUI trigger; Ctrl+Z takes the conversion back.", "Convert", 60_000);
    if (!ok || this.disposed) return false;
    // While the question was open the trigger may have been edited, undone or deleted: then nothing happens.
    const now = this.file.items.find((i) => i.type === 8 && i.id === it.id);
    if (!now || !("ecas" in now) || JSON.stringify(now) !== was) {
      void this.w3.window.showWarning(`Not converted: ${it.name} changed while the question was open.`);
      return false;
    }
    this.edit(`Convert ${now.name} to custom text`, () => {
      const text = triggerCustomText({ data: this.handle.data, triggers: this.file, custom: this.customFile(), lua }, now);
      convertToCustom(now);
      this.texts.set(now, text);
    });
    return true;
  }

  /** Rename (to `to`) or delete the trigger or comment-free tree item `name` (w3.triggers.itemAction). */
  async triggerAction(name: string, action: "rename" | "delete", to: string): Promise<boolean> {
    const it = this.file.items.find((i) => "ecas" in i && i.type !== 16 && i.name === name);
    if (!it) throw new Error(`There's no trigger "${name}".`);
    if (action === "rename") return this.rename(it, to);
    if (!(await this.w3.window.askDelete(`Delete the trigger ${name}?`, "Delete"))) return false;
    // While the question was open the trigger may have gone (undo, another edit) or the editor closed.
    const now = this.file.items.find((i) => i.type === it.type && i.id === it.id);
    if (this.disposed || !now) return false;
    this.selected = { kind: "item", type: now.type, id: now.id };
    this.deleteSelected();
    return !this.file.items.includes(now);
  }
  /** Rename (to `to`) or delete the variable `name` (w3.triggers.itemAction), as its row in the table does. */
  async variableAction(name: string, action: "rename" | "delete", to: string): Promise<boolean> {
    const v = this.file.variables.find((x) => x.name === name);
    if (!v) throw new Error(`There's no variable "${name}".`);
    if (action === "rename") return renameVariable(this.w3, this.vars, v, to);
    // A used variable is asked about by deleteVariable itself (it clears the uses).
    if (!variableParams(this.file, v.name).length && !(await this.w3.window.askDelete(`Delete the variable ${name}?`, "Delete"))) return false;
    if (this.disposed || !this.file.variables.includes(v)) return false;
    await deleteVariable(this.w3, this.vars, v);
    const gone = !this.file.variables.some((x) => x.id === v.id && x.name === v.name);
    if (gone) { this.selected = { kind: "variables" }; this.renderTree(); this.renderDetail(); }
    return gone;
  }

  /** What Copy As Text (`as` "text") or Copy As Script puts on the clipboard: the selected trigger, or the lines
   *  selected in its contents when `lines` says so (unset: when its contents were clicked last). Throws when
   *  there's nothing of the kind to copy. */
  copyText(as: "text" | "script", lines?: boolean): { text: string; what: string } {
    this.flush();
    const it = this.find(this.selected);
    if (!it || !("ecas" in it) || it.type === 16 || it.isComment) throw new Error("Select a trigger to copy.");
    const kind = this.kinds.all().find((k) => k.matches(it, this.handle));
    const picked = (lines ?? this.area === "detail") ? kind?.selectedLines?.(it) ?? [] : [];
    if (lines && !picked.length) throw new Error(`Select a line of ${it.name} to copy.`);
    const src = { display: this.handle.display, file: this.file, language: this.handle.language, customText: (t: TriggerItem) => this.texts.get(t) ?? null };
    const text = copyAs(as, src, it, picked);
    if (text === null) throw new Error(`${it.name} is custom text: Copy As Script copies it.`);
    return { text, what: picked.length ? `${picked.length === 1 ? "a line" : `${picked.length} lines`} of ${it.name}` : it.name };
  }
  /** Copy As Text / Copy As Script (see copyText) onto the system clipboard, saying what was copied. The text. */
  async copyToClipboard(as: "text" | "script", lines?: boolean): Promise<string> {
    const { text, what } = this.copyText(as, lines);
    const how = as === "text" ? "as text" : "as script";
    if (await copyText(text)) void this.w3.window.showInfo(`Copied ${what} ${how}.`);
    else void this.w3.window.showWarning(`The clipboard refused the copy of ${what} ${how}.`);
    return text;
  }

  /** Renames a tree item, as one undo step. A trigger's gg_trg_ global changes with its name: the GUI
   *  parameters naming it follow, and after a question the script text too (the map header, custom
   *  text, Custom Script actions; the trigger's own InitTrig_ function with it). A name whose global
   *  another trigger has is refused. False if nothing was renamed. */
  async rename(it: Item, to: string): Promise<boolean> {
    const from = it.name;
    const isTrigger = "ecas" in it && it.type === 8 && !it.isComment;
    const renames = isTrigger ? globalRenames("trg", [[from, to]]) : new Map<string, string>();
    if (renames.size) {
      const clash = this.file.items.find((x) => x !== it && "ecas" in x && x.type === 8 && !x.isComment && ident(x.name) === ident(to));
      if (clash) { void this.w3.window.showError(`${clash.name} already is gg_trg_${ident(to)} in the script; choose another name.`); return false; }
    }
    // The trigger's own text defines InitTrig_<name> (the map script calls it by the trigger's name).
    const own = isTrigger && "ecas" in it && it.isCustom ? new Map([[`InitTrig_${ident(from)}`, `InitTrig_${ident(to)}`]]) : new Map<string, string>();
    const scriptsOf = () => this.vars.scripts();
    const ownText = () => ("ecas" in it ? this.texts.get(it) ?? null : null);
    const inScript = renames.size ? countRenames(this.file, scriptsOf().map((s) => s.get()), renames).script + countInText(ownText(), own) : 0;
    let withScripts = false;
    if (inScript) {
      const c = await this.w3.window.showWarning(`${[...renames.keys()][0]}${own.size ? ` and ${[...own.keys()][0]} appear` : " appears"} ${inScript} time${inScript === 1 ? "" : "s"} in custom script. Rename ${own.size ? "them" : "it"} there too?`,
        "Rename in script too", "Only GUI triggers");
      if (c === undefined) return false;
      withScripts = c === "Rename in script too";
      // While the question was open the item may have been renamed, deleted or undone, or the editor closed.
      const now = this.file.items.find((x) => x.type === it.type && x.id === it.id);
      if (this.disposed || !now || now.name !== from) { void this.w3.window.showWarning(`Not renamed: ${from} changed while the question was open.`); return false; }
      it = now;
    }
    const target = it;
    this.edit(`Rename ${from}`, () => {
      target.name = to;
      if (!renames.size) return;
      applyRenames(this.file, scriptsOf(), renames, withScripts);
      const text = "ecas" in target ? this.texts.get(target) ?? null : null;
      if (withScripts && own.size && text !== null && "ecas" in target) this.texts.set(target, renameInText(text, own));
    });
    return true;
  }

  /** Renamed objects' globals (regions, cameras: `kind` "rct", "cam") in the triggers as they are here,
   *  as one undo step; `withScripts`: in script text too. What changed. */
  renameGlobals(label: string, renames: ReadonlyMap<string, string>, withScripts: boolean): RenameCount {
    let n: RenameCount = { gui: 0, script: 0 };
    const would = this.countGlobals(renames);
    // Nothing to change: no undo step.
    if (!would.gui && !(withScripts && would.script)) return n;
    this.edit(label, () => { n = applyRenames(this.file, this.vars.scripts(), renames, withScripts); });
    return n;
  }
  /** What renameGlobals would change. */
  countGlobals(renames: ReadonlyMap<string, string>): RenameCount {
    return countRenames(this.file, this.vars.scripts().map((s) => s.get()), renames);
  }
  /** Steps that followed objects renamed elsewhere (followGlobals). */
  private follows = new Set<number>();
  /** Renamed objects' globals in the GUI parameters only, as one undo step that followed another editor
   *  (TriggersService.followRenames). The step's id; null when no parameter names them (no step). */
  followGlobals(label: string, renames: ReadonlyMap<string, string>): number | null {
    if (!this.handle.editable || this.disposed || !renames.size || !this.countGlobals(renames).gui) return null;
    this.edit(label, () => { applyRenames(this.file, this.vars.scripts(), renames, false); });
    this.follows.add(this.state);
    return this.state;
  }
  /** Whether the state now is the one after step `id`. */
  isState(id: number) { return this.state === id; }
  /** Whether step `id` is the one redo does next. */
  isNext(id: number) { return this.at < this.undo.length && this.undo[this.at].id === id; }
  /** Whether everything unsaved came from followGlobals (or nothing is unsaved): saved with the objects it followed. */
  unsavedOnlyFollows(): boolean {
    this.flush();
    for (let p = this.at; p >= 0; p--) {
      if ((p ? this.undo[p - 1].id : 0) === this.savedAt) return true;
      if (!this.follows.has(this.undo[p - 1]?.id ?? -1)) return false;
    }
    return false;
  }
  get editable() { return this.handle.editable; }
  /** Whether the only unsaved change is an opened or closed category (see onlyFoldsUnsaved). */
  get onlyFoldsDirty(): boolean {
    this.flush();
    return onlyFoldsUnsaved({ state: this.state, savedAt: this.savedAt, toggles: this.toggles, savedToggles: this.savedToggles, pendingName: !!this.pendingName() });
  }
  /** Whether there are unsaved changes. */
  get dirty() { return this.state !== this.savedAt || this.toggles !== this.savedToggles; }
  get closed() { return this.disposed; }
  /** Tells the tab whether it's unsaved: changes, or a name typed into the focused name field and not committed yet
   *  (a close then asks, and a save commits it: commitName). */
  private report() { this.setDirty(this.dirty || !!this.pendingName()); }
  /** The focused name field (NameField) when what it holds isn't the name. */
  private pendingName(): NameField | null {
    const a = document.activeElement;
    if (this.disposed || !(a instanceof HTMLInputElement) || a.readOnly || !this.detail.contains(a)) return null;
    const field = nameFields.get(a);
    return field && a.value.trim() !== field.name() ? field : null;
  }
  /** Before a save: the name typed into the focused name field is committed, as leaving the field would (flush leaves
   *  names out). A rename may ask about custom script first: this waits for the answer. A refused rename puts the
   *  name back and the save goes on without it. */
  async commitName() {
    const field = this.pendingName();
    if (!field) return;
    await field.commit();
    if (!this.disposed) this.report();
  }
  /** Saves the editor (set by its provider). */
  persist: () => Promise<void> = async () => {};

  /** Category is Comment (the World Editor's toggle on a category): flips it on the category `id`, as one undo step. */
  toggleCategoryComment(id: number) {
    const cat = this.file.items.find((i) => i.type === 4 && i.id === id);
    if (!cat || "ecas" in cat || cat.type === 64 || !this.handle.editable) return;
    this.edit(`${cat.isComment ? "Category is no comment" : "Category is comment"}: ${cat.name}`, () => { cat.isComment = cat.isComment ? 0 : 1; });
  }

  /** Reset Triggers: the default trigger and nothing else (lib/triggers/defaults.ts resetTriggers), as one undo step. */
  resetTriggers(mapFile?: string) {
    this.edit("Reset triggers", () => {
      const r = resetTriggers(this.file, this.customFile(), mapFile);
      this.file = r.file;
      this.custom = r.custom;
      this.header = r.custom.header;
      this.texts = new Map(textTriggers(r.file).map((t, i) => [t, r.custom.texts[i] ?? null]));
      this.selected = { kind: "header" };
      this.followExpanded();
    }, { replaces: true });
  }

  /** Every trigger and variable from elsewhere, as one undo step. */
  replaceAll(file: TriggerFile, custom: CustomTextFile | null) {
    this.edit("Import triggers", () => {
      this.file = file;
      this.selected = { kind: "header" };
      this.custom = custom;
      this.header = custom?.header ?? null;
      this.texts = new Map(textTriggers(file).map((t, i) => [t, custom?.texts[i] ?? null]));
      this.followExpanded();
    }, { replaces: true });
  }

  /** The tree's open and closed categories as the file has them (each category's `expanded`). On opening and when the
   *  whole file is replaced (Reset Triggers, Import, and their undo and redo): a new file's ids reuse the old ones, so
   *  the old view state would show e.g. a reset's expanded Initialization closed. */
  private followExpanded() {
    this.collapsed = collapsedOf(this.file);
  }

  customFile(): CustomTextFile {
    const texts = textTriggers(this.file).map((t) => this.texts.get(t) ?? null);
    return this.custom
      ? { ...this.custom, header: this.header, texts }
      : { reforged: this.file.reforged, version: 1, comment: "", header: this.header, texts };
  }

  /** What a save writes, taken at once: the triggers (with the tree's open and closed categories), the custom texts,
   *  and the undo step and toggles they're at. */
  mark(): { file: TriggerFile; custom: CustomTextFile; step: number; toggles: number } {
    this.flush();
    const file = structuredClone(this.file);
    applyExpanded(file, this.collapsed);
    return { file, custom: this.customFile(), step: this.state, toggles: this.toggles };
  }
  /** The state `step` and `toggles` (from mark) were saved; edits and toggles after it stay unsaved. */
  markSaved(step = this.state, toggles = this.toggles) { this.savedAt = step; this.savedToggles = toggles; this.report(); }

  /** Selects the variables table. */
  showVariables() { this.flush(); this.mode = "variables"; this.selected = { kind: "variables" }; this.renderTree(); this.renderDetail(); }

  /** The tree's scroll position as last seen while shown (a hidden tab's reads 0). */
  private treeTop = 0;
  /** Where the editor is, kept with the project's open tabs: the tree's mode, the selection, the tree's scroll. */
  viewState(): { mode: string; selected: Selection; top: number } {
    return { mode: this.mode, selected: this.selected, top: this.treeTop };
  }
  /** Back where viewState() was; what the file no longer has (an item deleted meanwhile) is left out. */
  applyViewState(v: unknown) {
    if (!v || typeof v !== "object") return;
    const { mode, selected, top } = v as { mode?: unknown; selected?: Partial<Record<string, unknown>>; top?: unknown };
    if (mode === "triggers" || mode === "variables" || mode === "all") this.mode = mode;
    if (selected?.kind === "header" || selected?.kind === "variables") this.selected = { kind: selected.kind };
    else if (selected?.kind === "item" && typeof selected.type === "number" && typeof selected.id === "number") {
      const sel: Selection = { kind: "item", type: selected.type, id: selected.id };
      if (this.find(sel)) this.selected = sel;
    }
    this.renderTree();
    this.renderDetail();
    if (typeof top === "number" && Number.isFinite(top) && top > 0) {
      this.treeTop = top;
      const scroll = () => { this.tree.scrollTop = top; };
      scroll();
      // Laid out only once shown.
      requestAnimationFrame(scroll);
    }
  }

  /** What the tree lists: triggers and comments, variables, or both (as stored, Reforged files
   *  keep variables in the categories). Categories show in every mode. */
  private mode: "triggers" | "variables" | "all" = "triggers";
  private modeBar = h("div.trig-modes");
  setMode(m: "triggers" | "variables" | "all") {
    if (m === this.mode) return;
    this.flush();
    this.mode = m;
    const s = this.find(this.selected);
    // A selection the tree no longer shows goes back to the map header.
    if (s && ((m === "triggers" && s.type === 64) || (m === "variables" && "ecas" in s))) this.selected = { kind: "header" };
    this.renderTree();
    this.renderDetail();
  }

  /** Redraws the selected item (e.g. after names were looked up). */
  refresh() {
    const top = this.detail.scrollTop;
    this.renderDetail();
    this.detail.scrollTop = top;
  }

  // ---- undo -------------------------------------------------------------------------
  // A snapshot holds the tree's open and closed categories as they were. Undo and redo keep the tree as it is, except
  // across a step that replaced the whole file (`replaces`): there the tree follows the file put back, and the side
  // left takes the tree as it is now, so going back and forth keeps the toggles on each side.
  private snapshot(): Snapshot {
    const file = structuredClone(this.file);
    applyExpanded(file, this.collapsed);
    return { file, texts: textTriggers(this.file).map((t) => this.texts.get(t) ?? null), header: this.header };
  }
  private restore(s: Snapshot, followExpanded = false) {
    this.file = structuredClone(s.file);
    this.texts = new Map(textTriggers(this.file).map((t, i) => [t, s.texts[i]]));
    this.header = s.header;
    if (followExpanded) this.followExpanded();
    this.renderTree();
    this.renderDetail();
  }
  private edit(label: string, change: () => void, opts: { keepView?: boolean; replaces?: boolean } = {}) {
    // Text typed a moment ago is its own step, before this one (and not put back over it afterwards).
    this.flush();
    const before = this.snapshot();
    change();
    this.undo.splice(this.at, this.undo.length, { label, before, after: this.snapshot(), id: this.nextId++, ...(opts.replaces ? { replaces: true } : {}) });
    this.at = this.undo.length;
    this.report();
    this.renderTree();
    if (!opts.keepView) this.renderDetail();
    this.edited();
  }
  step(dir: -1 | 1) {
    // Undo takes back what was typed a moment ago, rather than redrawing it away.
    this.flush();
    if (dir < 0 && this.at > 0) {
      const s = this.undo[--this.at];
      if (s.replaces) applyExpanded(s.after.file, this.collapsed);
      this.restore(s.before, s.replaces);
    } else if (dir > 0 && this.at < this.undo.length) {
      const s = this.undo[this.at++];
      if (s.replaces) applyExpanded(s.before.file, this.collapsed);
      this.restore(s.after, s.replaces);
    } else return;
    this.report();
    this.edited();
  }
  /** After each edit, undo and redo (TriggersService.onDidEdit; set by the provider). */
  edited: () => void = () => {};

  // ---- items ------------------------------------------------------------------------
  private find(sel: Selection): Item | undefined {
    return sel.kind === "item" ? this.file.items.find((i) => i.type === sel.type && i.id === sel.id) : undefined;
  }
  private root(): number {
    const r = this.file.items.find((i) => i.type === 1);
    return r ? r.id : -1;
  }
  /** A new id for an item of `type` (Reforged: type index in the high byte, counted per type). */
  private allocId(type: number): number {
    return allocItemId(this.file, type);
  }
  /** Where a new item goes: into the selected category, or after the selected item. */
  private insertionPoint(category: boolean): { parent: number; index: number } {
    const sel = this.find(this.selected);
    const items = this.file.items;
    if (sel && (sel.type === 4 || sel.type === 2) && !category) {
      const last = items.reduce((at, it, i) => (it.parent === sel.id ? i : at), items.indexOf(sel));
      return { parent: sel.id, index: last + 1 };
    }
    if (sel && sel.type !== 1 && !(category && sel.type !== 4)) return { parent: sel.parent, index: items.indexOf(sel) + 1 };
    if (!category) {
      const cat = items.find((i) => i.type === 4);
      if (cat) return { parent: cat.id, index: items.reduce((at, it, i) => (it.parent === cat.id ? i : at), items.indexOf(cat)) + 1 };
    }
    return { parent: this.root(), index: items.length };
  }
  private uniqueName(base: string): string {
    const taken = new Set(this.file.items.map((i) => i.name));
    for (let n = 1; ; n++) { const name = `${base} ${String(n).padStart(3, "0")}`; if (!taken.has(name)) return name; }
  }

  /** The selected category, if categories can nest there (Reforged files only). */
  private subcategoryParent(): Item | undefined {
    const sel = this.find(this.selected);
    return this.file.reforged && sel && sel.type === 4 ? sel : undefined;
  }
  /** A new category next to the selected one, or (`sub`) inside it, after its contents. */
  private newCategory(sub = false) {
    const outer = sub ? this.subcategoryParent() : undefined;
    if (sub && !outer) return;
    this.edit(sub ? "New subcategory" : "New category", () => {
      const { parent, index } = outer
        ? { parent: outer.id, index: this.file.items.indexOf(subtree(this.file, outer).at(-1)!) + 1 }
        : this.insertionPoint(true);
      const it: Item = { type: 4, id: this.allocId(4), name: this.uniqueName("Untitled Category"), isComment: 0, expanded: 1, parent };
      this.file.items.splice(index, 0, it);
      this.collapsed.delete(parent);
      this.selected = { kind: "item", type: 4, id: it.id };
    });
  }
  private newTrigger(kind: TriggerKind | null) {
    this.edit(kind ? `New ${kind.title}` : "New comment", () => {
      const { parent, index } = this.insertionPoint(false);
      const type = !kind ? 16 : kind.itemType === 32 && this.file.reforged ? 32 : 8;
      const t: TriggerItem = {
        type, name: this.uniqueName(!kind ? "Untitled Comment" : kind.itemType === 32 ? "Untitled Script" : "Untitled Trigger"), description: "", isComment: kind ? 0 : 1, id: this.allocId(type),
        enabled: true, isCustom: false, initiallyOff: false, runOnInit: false, parent, ecas: [],
      };
      this.file.items.splice(index, 0, t);
      this.collapsed.delete(parent);
      if (kind) { this.texts.set(t, null); kind.init?.(t, this.handle); }
      this.selected = { kind: "item", type, id: t.id };
    });
  }
  /** Where a new variable goes: the selected category (or the selected item's), else the first one. */
  private variableCategory(): { parent: number; index: number } {
    const items = this.file.items;
    const at = this.insertionPoint(false);
    const isCategory = (id: number) => items.some((i) => i.type === 4 && i.id === id);
    if (isCategory(at.parent)) return at;
    let cat = items.find((i) => i.type === 4);
    if (!cat) {
      cat = { type: 4, id: this.allocId(4), name: "Variables", isComment: 0, expanded: 1, parent: this.root() };
      items.push(cat);
    }
    return { parent: cat.id, index: items.reduce((last, it, i) => (it.parent === cat!.id ? i : last), items.indexOf(cat)) + 1 };
  }
  private deleteSelected(cut = false) {
    const sel = this.find(this.selected);
    if (!sel || sel.type === 1) return;
    if (sel.type === 64) {
      const v = this.file.variables.find((x) => x.id === sel.id);
      if (v) void deleteVariable(this.w3, this.vars, v, { cut }).then(() => { if (!this.file.variables.includes(v)) { this.selected = { kind: "variables" }; this.renderTree(); this.renderDetail(); } });
      return;
    }
    this.edit(`Delete ${sel.name}`, () => {
      const gone = new Set<Item>();
      const collect = (it: Item) => { gone.add(it); for (const c of this.file.items) if (c.parent === it.id && (it.type === 2 || it.type === 4) && c !== it) collect(c); };
      collect(sel);
      for (const it of gone) {
        if (this.file.reforged) this.file.counts[TYPE_INDEX[it.type]]?.deleted.push(it.id);
        if (it.type === 64) this.file.variables = this.file.variables.filter((v) => v.id !== it.id);
      }
      this.file.items = this.file.items.filter((i) => !gone.has(i));
      this.selected = { kind: "header" };
    });
  }
  private move(dir: -1 | 1) {
    const sel = this.find(this.selected);
    if (!sel || sel.type === 1) return;
    const items = this.file.items;
    const siblings = items.filter((i) => i.parent === sel.parent && i.type !== 1);
    const other = siblings[siblings.indexOf(sel) + dir];
    if (!other) return;
    this.edit(`Move ${sel.name}`, () => {
      const a = items.indexOf(sel), b = items.indexOf(other);
      [items[a], items[b]] = [items[b], items[a]];
    });
  }

  // ---- copy and paste ---------------------------------------------------------------
  private copyItem(cut: boolean) {
    const sel = this.find(this.selected);
    if (!sel || sel.type === 1) return;
    const block = subtree(this.file, sel);
    treeClipboard = {
      items: structuredClone(block),
      texts: block.map((it) => ("ecas" in it ? this.texts.get(it) ?? null : null)),
      variables: structuredClone(this.file.variables.filter((v) => block.some((i) => i.type === 64 && i.id === v.id))),
    };
    if (cut && this.handle.editable) this.deleteSelected(true);
  }
  /** Pastes copied items after the selection (or into the selected category). */
  private pasteItems() {
    const clip = treeClipboard;
    if (!clip || !this.handle.editable) return;
    // Variables live in Reforged files' tree only.
    if (!this.file.reforged && clip.items.some((i) => i.type === 64)) { void this.w3.window.showWarning("This trigger file keeps variables outside the tree; use the Variables table."); return; }
    this.edit("Paste", () => {
      const root = clip.items[0];
      const at = root.type === 64 ? this.variableCategory() : this.insertionPoint(root.type === 4 || root.type === 2);
      const pasted = pasteBlock(this.file, clip, at, (type) => this.allocId(type));
      pasted.forEach((it, k) => { if ("ecas" in it) this.texts.set(it, clip.texts[k]); });
      this.collapsed.delete(at.parent);
      this.selected = { kind: "item", type: pasted[0].type, id: pasted[0].id };
    });
  }

  // ---- drag and drop ----------------------------------------------------------------
  private drop(drag: Item, target: Item, mode: DropMode) {
    this.edit(`Move ${drag.name}`, () => {
      moveItem(this.file, drag, target, mode);
      if (mode === "into") this.collapsed.delete(target.id);
    });
  }
  private dragging: Item | null = null;
  private dragHandlers(sel: Selection): Record<string, unknown> {
    const it = this.find(sel);
    if (!this.handle.editable || !it || it.type === 1) return {};
    const clear = () => this.tree.querySelectorAll(".drop-into, .drop-before").forEach((e) => e.classList.remove("drop-into", "drop-before"));
    const mode = (e: DragEvent) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      return this.dragging ? dropMode(this.file, this.dragging, it, e.clientY < r.top + r.height / 3) : null;
    };
    return {
      draggable: true,
      ondragstart: (e: DragEvent) => { this.dragging = it; e.dataTransfer?.setData("text/plain", it.name); },
      ondragend: () => { this.dragging = null; clear(); },
      ondragover: (e: DragEvent) => {
        const m = mode(e);
        if (!m) return;
        e.preventDefault();
        clear();
        (e.currentTarget as HTMLElement).classList.add(m === "into" ? "drop-into" : "drop-before");
      },
      ondragleave: (e: DragEvent) => (e.currentTarget as HTMLElement).classList.remove("drop-into", "drop-before"),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        const m = mode(e), d = this.dragging;
        clear();
        this.dragging = null;
        if (m && d) { this.selected = { kind: "item", type: d.type, id: d.id }; this.drop(d, it, m); }
      },
    };
  }

  private toolbar(): HTMLElement {
    const newMenu = h("select.trig-new", { title: "Add to the selected category", onchange: () => {
      const v = newMenu.value;
      newMenu.value = "";
      if (v === "category") this.newCategory();
      else if (v === "subcategory") this.newCategory(true);
      else if (v === "comment") this.newTrigger(null);
      else if (v === "variable") newVariable(this.vars);
      else { const k = this.kinds.all().find((x) => x.id === v); if (k) this.newTrigger(k); }
    } });
    const fill = () => newMenu.replaceChildren(h("option", { value: "" }, "New…"), h("option", { value: "category" }, "Category"),
      ...(this.file.reforged ? [h("option", { value: "subcategory", title: "Inside the selected category" }, "Subcategory")] : []),
      ...this.kinds.all().filter((k) => k.init && (k.available?.(this.handle) ?? true)).map((k) => h("option", { value: k.id }, k.title)), h("option", { value: "comment" }, "Comment"),
      h("option", { value: "variable" }, "Variable"));
    fill();
    this.kinds.onChange(fill);
    return h("div.trig-toolbar", {}, newMenu,
      h("button", { title: "Move up", onclick: () => this.move(-1) }, "↑"),
      h("button", { title: "Move down", onclick: () => this.move(1) }, "↓"),
      h("button", { title: "Delete (Del)", onclick: () => this.deleteSelected() }, "Delete"),
      // Export and Import in a menu: with them as buttons the toolbar took three lines at the tree's narrowest.
      h("button.trig-more", { title: "More: Export…, Import…", onclick: (e: MouseEvent) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        this.w3.window.showContextMenu({ x: r.left, y: r.bottom }, [
          { label: "Export…", hint: "Save all triggers and variables as a .wtg and .wct, which the World Editor can import too", run: () => this.run("w3.triggers.export") },
          { label: "Import…", hint: "Replace all triggers and variables with a .wtg and .wct", run: () => this.run("w3.triggers.import") },
        ]);
      } }, "⋯"));
  }
  private run(command: string) { this.w3.commands.execute(command).catch((e) => this.w3.window.showError(String((e as Error).message ?? e))); }
  private convertCommand() { this.run("w3.triggers.convertToCustomText"); }

  // ---- tree -------------------------------------------------------------------------
  private row(label: string, cls: string, depth: number, sel: Selection, opts: { toggle?: number; title?: string; off?: boolean } = {}) {
    const s = this.selected;
    const active = s.kind === sel.kind && (sel.kind !== "item" || (s.kind === "item" && s.type === sel.type && s.id === sel.id));
    const caret = opts.toggle !== undefined
      ? h("span.trig-caret", { onclick: (e: Event) => { e.stopPropagation(); this.toggle(opts.toggle!); } }, this.collapsed.has(opts.toggle) ? "▸" : "▾")
      : h("span.trig-caret");
    return h(`div.trig-row.${cls}${active ? ".active" : ""}${opts.off ? ".off" : ""}`, {
      style: { paddingLeft: `${6 + depth * 14}px` }, title: opts.title ?? "",
      onclick: () => { this.flush(); this.selected = sel; this.renderTree(); this.renderDetail(); this.el.focus(); },
      ondblclick: () => { if (opts.toggle !== undefined) this.toggle(opts.toggle); },
      oncontextmenu: (e: MouseEvent) => this.menu(e, sel, opts.toggle),
      ...this.dragHandlers(sel),
    }, caret, h("span.trig-label", {}, label));
  }
  /** Right-click in the tree: selects the row, then offers new items, moving and deleting. */
  private menu(e: MouseEvent, sel: Selection, category?: number) {
    e.preventDefault();
    this.flush();
    this.selected = sel;
    this.renderTree();
    this.renderDetail();
    this.el.focus();
    const items: MenuItem[] = [];
    if (category !== undefined) items.push({ label: this.collapsed.has(category) ? "Expand" : "Collapse", run: () => this.toggle(category) }, "-");
    if (this.handle.editable) {
      items.push({ label: "New Category", run: () => this.newCategory() },
        ...(this.subcategoryParent() ? [{ label: "New Subcategory", run: () => this.newCategory(true) }] : []),
        ...this.kinds.all().filter((k) => k.init && (k.available?.(this.handle) ?? true)).map((k) => ({ label: `New ${k.title}`, run: () => this.newTrigger(k) })),
        { label: "New Comment", run: () => this.newTrigger(null) }, { label: "New Variable", run: () => newVariable(this.vars) });
      if (sel.kind === "item") {
        items.push("-", { label: "Move Up", run: () => this.move(-1) }, { label: "Move Down", run: () => this.move(1) },
          "-", { label: "Cut", hint: "Ctrl+X", run: () => this.copyItem(true) }, { label: "Copy", hint: "Ctrl+C", run: () => this.copyItem(false) });
      }
      const it = this.find(sel);
      if (it && isGuiTrigger(it)) items.push("-", { label: "Convert to Custom Text…", run: () => this.convertCommand() });
      if (it && it.type === 4) items.push("-", { label: "Category is Comment", checked: !!it.isComment, run: () => this.toggleCategoryComment(it.id) });
      if (treeClipboard) items.push("-", { label: `Paste ${treeClipboard.items[0].name}`, hint: "Ctrl+V", run: () => this.pasteItems() });
      if (sel.kind === "item") items.push("-", { label: "Delete", hint: "Del", run: () => this.deleteSelected() });
    }
    // The trigger onto the system clipboard (read-only files too): GUI triggers as text and script, custom text as script.
    const trig = this.find(sel);
    if (trig && "ecas" in trig && trig.type !== 16 && !trig.isComment) {
      const copy = (as: "text" | "script") => () => { this.copyToClipboard(as, false).catch((err) => this.w3.window.showError(String((err as Error).message ?? err))); };
      items.push(...(items.length ? ["-" as const] : []),
        ...(isGuiTrigger(trig) ? [{ label: "Copy As Text", run: copy("text") }] : []),
        { label: "Copy As Script", run: copy("script") });
    }
    if (items.length) this.w3.window.showContextMenu({ x: e.clientX, y: e.clientY }, items);
  }

  /** Opens or closes a category: view state, but saved (see `toggles`). */
  private toggle(id: number) {
    if (this.collapsed.has(id)) this.collapsed.delete(id); else this.collapsed.add(id);
    // Classic files don't store it; a read-only file isn't saved.
    if (this.handle.editable && this.file.reforged) { this.toggles++; this.report(); }
    this.renderTree();
  }
  private renderTree() {
    const modes = [["triggers", "Triggers"], ["variables", "Variables"], ["all", "All"]] as const;
    this.modeBar.replaceChildren(...modes.map(([m, label]) =>
      h(`button.trig-mode${this.mode === m ? ".active" : ""}`, { onclick: () => this.setMode(m) }, label)));
    const rows: HTMLElement[] = [];
    const root = this.file.items.find((i) => i.type === 1);
    const q = this.query.trim().toLowerCase();
    if (!q) {
      rows.push(this.row(root?.name || this.w3.workspace.project()?.name || "Map", "trig-map", 0, { kind: "header" }, { title: "Map header: custom script code" }));
      rows.push(this.row(`Variables (${this.file.variables.length})`, "trig-vars", 0, { kind: "variables" }));
    }
    const children = new Map<number, Item[]>();
    for (const it of this.file.items) if (it.type !== 1) children.set(it.parent, [...(children.get(it.parent) ?? []), it]);
    // While searching: only matches and the categories around them (expanded).
    const shown = q ? this.searchMatches(q, children) : null;
    if (shown && !shown.size) rows.push(h("div.trig-row.muted", {}, "No matches."));
    const walk = (parent: number, depth: number) => {
      for (const it of children.get(parent) ?? []) {
        if (shown && !shown.has(it)) continue;
        const sel: Selection = { kind: "item", type: it.type, id: it.id };
        if (it.type === 2 || it.type === 4) {
          const comment = it.type === 4 && it.isComment;
          rows.push(this.row(it.name, it.type === 4 ? (comment ? "trig-cat.trig-cat-comment" : "trig-cat") : "trig-lib", depth, sel,
            { toggle: it.id, title: comment ? "Category is Comment" : undefined }));
          if (shown || !this.collapsed.has(it.id)) walk(it.id, depth + 1);
        } else if (it.type === 64) { if (this.mode !== "triggers") rows.push(this.row(it.name, "trig-var", depth, sel)); }
        else if ("ecas" in it && this.mode !== "variables") {
          rows.push(this.row(it.name, it.type === 16 ? "trig-comment" : it.type === 32 ? "trig-script" : it.isCustom ? "trig-custom" : "trig-gui", depth, sel, { off: !it.enabled }));
        }
      }
    };
    walk(root ? root.id : -1, 1);
    this.tree.replaceChildren(...rows);
  }

  /** Search text of the tree (names, comments, lines of GUI triggers, custom script, variables). */
  private query = "";
  private searchBox = h("input.trig-search", { type: "search", placeholder: "Search triggers (names, actions, script)",
    oninput: () => { clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => { this.query = this.searchBox.value; this.renderTree(); }, 150); },
    onkeydown: (e: KeyboardEvent) => { if (keyOf(e) === "Escape") { this.searchBox.value = ""; this.query = ""; this.renderTree(); } } });
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  /** Items matching `q` in the current mode, with the categories containing them. */
  private searchMatches(q: string, children: Map<number, Item[]>): Set<Item> {
    const display = this.handle.display;
    const hit = (s: string | null | undefined) => !!s && s.toLowerCase().includes(q);
    const ecaHit = (es: Eca[]): boolean => es.some((e) => {
      try { if (hit(ecaText(e, display)) || hit(e.name)) return true; } catch { /* unknown function */ }
      return ecaHit(e.children);
    });
    const matches = (it: Item): boolean => {
      if (it.type === 64) {
        const v = this.file.variables.find((x) => x.id === it.id);
        return this.mode !== "triggers" && (hit(it.name) || hit(v?.type) || hit(v ? this.handle.data.types.get(v.type)?.name : ""));
      }
      if (!("ecas" in it) || this.mode === "variables") return false;
      return hit(it.name) || hit(it.description) || ecaHit(it.ecas) || (it.isCustom && hit(this.texts.get(it)));
    };
    const shown = new Set<Item>();
    const visit = (it: Item): boolean => {
      let any = it.type !== 2 && it.type !== 4 ? matches(it) : hit(it.name);
      for (const c of children.get(it.id) ?? []) if (it.type === 2 || it.type === 4) any = visit(c) || any;
      if (any) shown.add(it);
      return any;
    };
    const root = this.file.items.find((i) => i.type === 1);
    for (const it of children.get(root ? root.id : -1) ?? []) visit(it);
    return shown;
  }
  /** Selects a trigger (from a gg_trg_ reference elsewhere); `at.path`: also the line in it, and the
   *  parameter `at.param` there (a found problem), through the trigger's kind. */
  revealItem(it: Item, at?: Partial<TriggerLocation>) {
    this.flush();
    if (at?.path && "ecas" in it) this.kinds.all().find((k) => k.matches(it, this.handle))?.reveal?.(it, { path: at.path, ...(at.param ? { param: at.param } : {}) });
    if (this.query) { this.query = ""; this.searchBox.value = ""; }
    if ("ecas" in it && this.mode === "variables") this.mode = "triggers";
    for (let p = it.parent; ;) {
      const c = this.file.items.find((x) => (x.type === 4 || x.type === 2) && x.id === p);
      if (!c) break;
      this.collapsed.delete(c.id);
      p = c.parent;
    }
    this.selected = { kind: "item", type: it.type, id: it.id };
    this.area = "tree";
    this.renderTree();
    this.renderDetail();
    this.tree.querySelector(".trig-row.active")?.scrollIntoView({ block: "nearest" });
    if (at?.path) this.detail.querySelector(".trig-flagged, .trig-eca.active")?.scrollIntoView({ block: "nearest" });
  }

  // ---- detail -----------------------------------------------------------------------
  private renderDetail() {
    this.body?.dispose?.();
    this.body = undefined;
    const s = this.selected;
    const editable = this.handle.editable;
    if (s.kind === "header") {
      const heading = [h("h2", {}, "Map script header"), ...(this.custom?.comment ? [h("p.trig-desc", {}, this.custom.comment)] : [])];
      if (this.code) {
        const box = h("div.trig-code");
        this.detail.replaceChildren(...heading, box);
        // JASS headers are checked like the map script they open (its own functions in order).
        const map = mapJass((p) => this.w3.game.readText(p), this.w3.workspace.readText("map/war3map.j").catch(() => null));
        const jass = this.handle.language === "jass";
        const check = jass ? async (text: string) => checkJass(text, await map.without(text)) : undefined;
        const ed = this.code.create(box, {
          value: this.header ?? "", language: this.handle.language, readOnly: !editable, check, symbols: jass ? map.symbols : undefined,
          openLocation: (loc) => { if (loc.startsWith("trigger:")) this.handle.openTrigger(`gg_trg_${ident(loc.slice(8))}`); },
          onChange: (v) => this.edit("Edit map script", () => { this.header = v || (this.header === null ? null : ""); }, { keepView: true }),
        });
        this.body = { dispose: () => ed.dispose(), flush: () => ed.flush() };
        return;
      }
      const area = h("textarea.trig-code-edit", {
        spellcheck: false, readOnly: !editable, rows: 16, value: this.header ?? "",
        placeholder: `Map-specific ${this.handle.language === "lua" ? "Lua" : "JASS"} code, placed in the map script before the triggers.`,
        onchange: () => { if (area.value !== (this.header ?? "")) this.edit("Edit map script", () => { this.header = area.value || (this.header === null ? null : ""); }); },
      });
      this.detail.replaceChildren(h("h2", {}, "Map script header"),
        ...(this.custom?.comment ? [h("p.trig-desc", {}, this.custom.comment)] : []), area);
      return;
    }
    if (s.kind === "variables") { this.detail.replaceChildren(h("h2", {}, "Variables"), variablesTable(this.w3, this.vars, this.file.variables)); return; }
    const it = this.find(s);
    if (!it) { this.detail.replaceChildren(h("p.muted", {}, "Nothing selected.")); return; }
    const name = nameField(h("input.trig-name", { type: "text", value: it.name, readOnly: !editable }), () => it.name, (to) => this.rename(it, to));
    if (it.type === 64) {
      const v = this.file.variables.find((x) => x.id === it.id);
      this.detail.replaceChildren(h("h2", {}, "Variable"), v ? variablesTable(this.w3, this.vars, [v]) : h("p.muted", {}, "Variable not found."));
      return;
    }
    if (!("ecas" in it)) {
      const n = this.file.items.filter((i) => i.parent === it.id).length;
      this.detail.replaceChildren(h("div.trig-head", {}, name), h("p.muted", {}, `Category · ${n} item${n === 1 ? "" : "s"}`));
      return;
    }
    const flag = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const box = h("input", { type: "checkbox", checked: get(), disabled: !editable, onchange: () => this.edit(label, () => set(box.checked)) });
      return h("label.trig-flag", {}, box, label);
    };
    const desc = h("textarea.trig-desc-edit", {
      rows: 2, value: it.description, readOnly: !editable, placeholder: it.type === 16 ? "Comment" : it.type === 32 ? "Script comment" : "Trigger comment",
      onchange: () => { if (desc.value !== it.description) this.edit("Edit comment", () => { it.description = desc.value; }); },
    });
    const head = h("div.trig-head", {}, name,
      ...(it.type === 16 ? [] : [
        flag("Enabled", () => it.enabled, (v) => { it.enabled = v; }),
        // A script item is no trigger: nothing to turn on.
        ...(it.type === 32 ? [] : [flag("Initially on", () => !it.initiallyOff, (v) => { it.initiallyOff = !v; })]),
        // Custom text has no events: this is its Map Initialization (RunInitializationTriggers).
        ...(it.type === 8 && it.isCustom ? [flag("Run on map initialization", () => it.runOnInit, (v) => { it.runOnInit = v; })] : []),
        ...(isGuiTrigger(it) && editable ? [h("button.trig-convert", { title: "Replace the events, conditions and actions with the script the map script has for them (one way; Ctrl+Z takes it back)", onclick: () => this.convertCommand() }, "Convert to Custom Text…")] : []),
      ]));
    if (it.type === 16) { this.detail.replaceChildren(head, desc); return; }
    const kind = this.kinds.all().find((k) => k.matches(it, this.handle));
    const body = h("div.trig-body");
    this.detail.replaceChildren(head, desc, body);
    if (!kind) { body.append(h("p.muted", {}, "No installed extension shows this kind of trigger.")); return; }
    this.body = kind.render(body, it, this.handle);
  }
}
