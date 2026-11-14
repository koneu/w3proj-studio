// vJASS (JassHelper): a script language extension. Maps whose trigger texts are
// vJASS get their generated war3map.j compiled by JassHelper, the open-source
// compiler (zlib licence) that ships with the game. It is called, not copied:
// script-only mode in a temp folder, with the game's common.j and Blizzard.j,
// as the World Editor does on save. In the trigger editor it adds "vJASS Library"
// (New ▸, and how trigger texts with vJASS are shown).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { CODE_EDITOR_SERVICE, SCRIPT_LANGUAGES_SERVICE, TRIGGERS_SERVICE, type CodeEditorService, type CodeSymbol, type ScriptLanguagesService, type TriggerEditorHandle,
  type TriggersService } from "../../extensions/services";
import type { TriggerItem } from "../../lib/triggers/wtg";
import { mapJass } from "../../lib/jass/env";
import { joinPath } from "../../lib/paths";
import { ident } from "../../lib/script/jass";
import { h } from "../../workbench/dom";
import { checkMessages, markTexts, placeErrors } from "./check";
import { runJassHelper } from "./run";
import { vjassExports, vjassSymbols } from "./symbols";

/** vJASS source: libraries, scopes, structs, modules, interfaces, textmacros, block comments
 *  (not in a // comment: "//****" banners are plain JASS), //! directives. */
const SOURCE = /^\s*(?:(?:private|public)\s+)?(?:library|scope|struct|module|interface|textmacro|endlibrary|endscope|endstruct)\b|^(?:(?!\/\/).)*\/\*|^\s*\/\/!/m;
/** vJASS keywords (completion). */
const KEYWORDS = ["library", "endlibrary", "scope", "endscope", "struct", "endstruct", "method", "endmethod", "module", "endmodule",
  "interface", "endinterface", "implement", "private", "public", "static", "stub", "operator", "thistype", "requires", "needs", "uses",
  "optional", "initializer", "delegate", "readonly", "extends", "array", "key", "hook", "textmacro", "endtextmacro", "runtextmacro",
  "allocate", "deallocate", "onInit", "onDestroy", "create", "destroy", "super", "defaults", "debug", "inject", "endinject", "zinc", "endzinc"];
/** A library name from an item name: JassHelper rejects underscores in library and scope names
 *  ("Untitled Script 001" → "UntitledScript001"). */
export function libraryName(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1));
  const id = words.join("");
  return /^[A-Za-z]/.test(id) ? id : `Lib${id}`;
}
/** JassHelper's output ("//globals from <library>:", LIBRARY_<name> constants). */
const OUTPUT = /^\/\/globals from \w+:|^constant boolean LIBRARY_\w+\s*=\s*true/m;

/** Each trigger's exports, scanned again only when its text changed. */
const exportsCache = new WeakMap<TriggerItem, { text: string; name: string; symbols: CodeSymbol[] }>();
/** What the editor's other custom texts declare for the map (vjassExports). */
function otherTexts(ed: TriggerEditorHandle, self: TriggerItem): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  for (const item of ed.file.items) {
    if (item === self || (item.type !== 8 && item.type !== 16 && item.type !== 32)) continue;
    const text = ed.customText(item);
    if (!text) continue;
    let hit = exportsCache.get(item);
    if (hit?.text !== text || hit.name !== item.name) exportsCache.set(item, hit = { text, name: item.name, symbols: vjassExports(text, `trigger:${item.name}`) });
    out.push(...hit.symbols);
  }
  return out;
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const exe = () => w3.settings.get<string>("vjass.jassHelper")
    || joinPath(w3.settings.get<string>("game.installDir") ?? "C:\\Program Files (x86)\\Warcraft III", "_retail_/x86_64/JassHelper/jasshelper.exe");

  /** Runs JassHelper on a whole map script: its output, or what it wrote about its errors (logs/compileerrors.txt,
   *  and the script its failing step was reading). */
  const run = async (script: string, commonJ: string, blizzardJ: string): Promise<{ output: string } | { log: string; current: string | null; dir: string }> => {
    const path = exe();
    if (!(await w3.backend.invoke<boolean>("fs_exists", { path }))) {
      throw new Error(`JassHelper not found (${path}). Set "vjass.jassHelper" to jasshelper.exe.`);
    }
    const flags = [...(w3.settings.get<boolean>("vjass.debug") ? ["--debug"] : []), ...(w3.settings.get<boolean>("vjass.optimize") === false ? ["--nooptimize"] : [])];
    const seconds = w3.settings.get<number>("vjass.timeout");
    const idleMs = Math.max(5, typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 60) * 1000;
    const io = { invoke: <T>(cmd: string, args?: Record<string, unknown>) => w3.backend.invoke<T>(cmd, args), writeText: (p: string, t: string) => w3.workspace.writeText(p, t), readText: (p: string) => w3.workspace.readText(p) };
    return runJassHelper(io, path, script, commonJ, blizzardJ, flags, idleMs);
  };
  const compile = async (script: string, commonJ: string, blizzardJ: string): Promise<string> => {
    const r = await run(script, commonJ, blizzardJ);
    if ("output" in r) return r.output;
    // The log starts with the script's file name and ends with a count; the errors are between.
    const lines = r.log.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^logs[\\/]/i.test(l) && !/^\d+$/.test(l));
    throw new Error(`JassHelper: ${lines.slice(0, 8).join(" · ")} (files in ${r.dir})`);
  };

  /** "Check with JassHelper": the map's script as it would be generated with the editor's triggers and texts as they
   *  are now, compiled, and what JassHelper says about it by the checked text's lines (check.ts). */
  const checkText = async (ed: TriggerEditorHandle, t: TriggerItem): Promise<string> => {
    if (!ed.file.items.includes(t)) throw new Error("This trigger is no longer in the map.");
    const nonce = Math.random().toString(36).slice(2);
    const texts = markTexts(ed.file, ed.customFile(), t, nonce);
    const languages = await w3.services.get<ScriptLanguagesService>(SCRIPT_LANGUAGES_SERVICE);
    const [script, commonJ, blizzardJ] = await Promise.all([
      languages.source({ triggers: texts.triggers, custom: texts.custom }), w3.game.readText("Scripts\\common.j"), w3.game.readText("Scripts\\Blizzard.j")]);
    const r = await run(script, commonJ, blizzardJ);
    if ("output" in r) return "JassHelper: no errors (compiled in the map's script).";
    const { own, others } = checkMessages(placeErrors(r.log, script, r.current, nonce), texts);
    const list = (lines: string[]) => `${lines.slice(0, 8).join(" · ")}${lines.length > 8 ? ` · and ${lines.length - 8} more` : ""}`;
    if (own.length) return `JassHelper: ${list(own)}${others.length ? ` · Also outside this text: ${list(others)}` : ""}`;
    return `JassHelper stopped at errors outside this text, before it was through with this one: ${list(others)} (files in ${r.dir})`;
  };

  void w3.services.get<ScriptLanguagesService>(SCRIPT_LANGUAGES_SERVICE).then((s) => {
    ctx.subscriptions.push(s.register({
      id: "vjass",
      title: "vJASS (JassHelper)",
      detect: ({ texts, script }) => texts.some((t) => SOURCE.test(t)) || OUTPUT.test(script),
      compile: ({ script, commonJ, blizzardJ }) => compile(script, commonJ, blizzardJ),
    }));
  });

  // vJASS keywords in code editors, for texts that use vJASS already (plain JASS isn't cluttered).
  // Files: .vj and .zn are vJASS; .j files are when their content is (not checked as plain JASS).
  void w3.services.get<CodeEditorService>(CODE_EDITOR_SERVICE).then((editors) => {
    ctx.subscriptions.push(editors.registerFileLanguage({
      id: "vjass", title: "vJASS", base: "jass", extensions: [".vj", ".zn"],
      detect: (path, text) => /\.j$/i.test(path) && SOURCE.test(text),
      symbols: vjassSymbols,
    }));
    ctx.subscriptions.push(editors.registerCompletion({
      languages: ["jass"],
      provide: ({ text, inString, inRawcode, prefix }) => (inString || inRawcode || prefix.length < 2 || !SOURCE.test(text) ? []
        : KEYWORDS.filter((k) => k.startsWith(prefix)).map((k) => ({ label: k, kind: "keyword" as const, detail: "vJASS" }))),
    }));
  }).catch(() => {});

  // The trigger editor's kind for vJASS texts: new ones are libraries (a script item in Reforged
  // files, else a custom text trigger without InitTrig), edited without the plain JASS checker.
  void Promise.all([w3.services.get<TriggersService>(TRIGGERS_SERVICE), w3.services.get<CodeEditorService>(CODE_EDITOR_SERVICE).catch(() => null)]).then(([triggers, code]) => {
    ctx.subscriptions.push(triggers.registerKind({
      id: "vjass",
      priority: 7,
      title: "vJASS Library",
      itemType: 32,
      available: (ed) => ed.language === "jass",
      matches: (t, ed) => ed.language === "jass" && (t.isCustom || t.type === 32) && SOURCE.test(ed.customText(t) ?? ""),
      init(t, ed) {
        t.isCustom = true;
        ed.setCustomText(t, `library ${libraryName(t.name)} initializer Init\r\n\r\n    private function Init takes nothing returns nothing\r\n    endfunction\r\n\r\nendlibrary\r\n`);
      },
      render(el, t, ed) {
        const status = h("span.muted.vjass-check-status");
        let checking = false;
        /** Commits what the code editor still holds back while typing pauses: the check is of the text as shown. */
        let flush = () => {};
        const checkBtn = h("button.vjass-check", {
          title: "Compiles the map's script with this text in it, with JassHelper: the Trigger Editor's other texts and triggers as they are now (unsaved changes too), "
            + "and the globals the saved map makes (gg_ variables of placed objects, regions, cameras and sounds; udg_ variables). "
            + "Errors are told by this text's own lines; errors elsewhere in the map's script are named with where they are. "
            + "A text that is switched off is checked as if it were on. Nothing is written.",
          onclick: async () => {
            // One at a time: a second run's answer could come before the first's.
            if (checking) return;
            checking = true;
            flush();
            status.textContent = "Compiling…";
            const text = ed.customText(t);
            try {
              status.textContent = await checkText(ed, t);
              if (ed.customText(t) !== text) status.textContent += " (The text has changed since.)";
            } catch (e) { status.textContent = e instanceof Error ? e.message : String(e); } finally { checking = false; }
          },
        }, "Check with JassHelper");
        el.append(h("div.trig-section", {}, "vJASS"));
        const hint = h("p.muted.trig-hint", {}, t.type === 32
          ? `Copied into the "Custom Script Code" section of war3map.j; JassHelper compiles the map's script when it is generated.`
          : "Copied into war3map.j; JassHelper compiles the map's script when it is generated.");
        if (!code) {
          const area = h("textarea.trig-code-edit", {
            spellcheck: false, readOnly: !ed.editable, rows: 24, value: ed.customText(t) ?? "",
            // Also called by the host before a save (TriggerKind.render's flush): nothing when the text is unchanged.
            onchange: () => { if (area.value !== (ed.customText(t) ?? "")) ed.edit("Edit script", () => ed.setCustomText(t, area.value)); },
          });
          el.append(area, h("div.trig-gui-toolbar", {}, checkBtn, status), hint);
          return;
        }
        const box = h("div.trig-code");
        el.append(box, h("div.trig-gui-toolbar", {}, checkBtn, status), hint);
        // Completion from the map script as last generated (JassHelper's output: libraries' functions too).
        const map = mapJass((p) => w3.game.readText(p), w3.workspace.readText("map/war3map.j").catch(() => null));
        const editor = code.create(box, {
          value: ed.customText(t) ?? "", language: "jass", readOnly: !ed.editable,
          // The text's own declarations from the vJASS scanner; other texts' as they are now (saved or not,
          // libraries' public ones as Library_Name); the rest from the game and the map.
          symbols: async (text) => [...vjassSymbols(text), ...otherTexts(ed, t), ...(await map.symbols("").catch(() => []))],
          openLocation: (loc) => { if (loc.startsWith("trigger:")) ed.openTrigger(`gg_trg_${ident(loc.slice(8))}`); },
          onChange: (v) => ed.edit("Edit script", () => ed.setCustomText(t, v), { keepView: true }),
        });
        flush = () => editor.flush();
        return { dispose: () => editor.dispose(), flush: () => editor.flush() };
      },
    }));
  }).catch(() => {});

  ctx.subscriptions.push(w3.commands.register("w3.vjass.check", async () => {
    const path = exe();
    const found = await w3.backend.invoke<boolean>("fs_exists", { path });
    if (found) void w3.window.showInfo(`JassHelper found: ${path}. Maps with vJASS are compiled with it when their script is generated.`);
    else void w3.window.showError(`JassHelper not found at ${path}. Set "vjass.jassHelper" in the settings.`);
  }));
}
