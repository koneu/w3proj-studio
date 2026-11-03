// vJASS (JassHelper): a script language extension. Maps whose trigger texts are
// vJASS get their generated war3map.j compiled by JassHelper, the open-source
// compiler (zlib licence) that ships with the game. It is called, not copied:
// script-only mode in a temp folder, with the game's common.j and Blizzard.j,
// as the World Editor does on save. In the trigger editor it adds "vJASS Library"
// (New ▸, and how trigger texts with vJASS are shown).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { CODE_EDITOR_SERVICE, SCRIPT_LANGUAGES_SERVICE, TRIGGERS_SERVICE, type CodeEditorService, type ScriptLanguagesService, type TriggersService } from "../../extensions/services";
import { mapJass } from "../../lib/jass/env";
import { ident } from "../../lib/script/jass";
import { h } from "../../workbench/dom";

/** vJASS source: libraries, scopes, structs, modules, interfaces, textmacros, block comments,
 *  //! directives. */
const SOURCE = /^\s*(?:(?:private|public)\s+)?(?:library|scope|struct|module|interface|textmacro|endlibrary|endscope|endstruct)\b|\/\*|^\s*\/\/!/m;
/** vJASS keywords (completion). */
const KEYWORDS = ["library", "endlibrary", "scope", "endscope", "struct", "endstruct", "method", "endmethod", "module", "endmodule",
  "interface", "endinterface", "implement", "private", "public", "static", "stub", "operator", "thistype", "requires", "needs", "uses",
  "optional", "initializer", "delegate", "readonly", "extends", "array", "key", "hook", "textmacro", "endtextmacro", "runtextmacro",
  "allocate", "deallocate", "onInit", "onDestroy", "create", "destroy", "super", "defaults", "debug", "inject", "endinject", "zinc", "endzinc"];
/** JassHelper's output ("//globals from <library>:", LIBRARY_<name> constants). */
const OUTPUT = /^\/\/globals from \w+:|^constant boolean LIBRARY_\w+\s*=\s*true/m;

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const exe = () => w3.settings.get<string>("vjass.jassHelper")
    || `${(w3.settings.get<string>("game.installDir") ?? "C:\\Program Files (x86)\\Warcraft III").replace(/[\\/]+$/, "")}\\_retail_\\x86_64\\JassHelper\\jasshelper.exe`;

  const compile = async (script: string, commonJ: string, blizzardJ: string): Promise<string> => {
    const path = exe();
    if (!(await w3.backend.invoke<boolean>("fs_exists", { path }))) {
      throw new Error(`JassHelper not found (${path}). Set "vjass.jassHelper" to jasshelper.exe.`);
    }
    const dir = await w3.backend.invoke<string>("tool_temp_dir");
    await w3.workspace.writeText(`${dir}\\common.j`, commonJ);
    await w3.workspace.writeText(`${dir}\\Blizzard.j`, blizzardJ);
    await w3.workspace.writeText(`${dir}\\input.j`, script);
    const flags = [...(w3.settings.get<boolean>("vjass.debug") ? ["--debug"] : []), ...(w3.settings.get<boolean>("vjass.optimize") === false ? ["--nooptimize"] : [])];
    const r = await w3.backend.invoke<{ code: number; stdout: string; stderr: string }>("tool_run", {
      exe: path, args: ["--scriptonly", ...flags, "common.j", "Blizzard.j", "input.j", "output.j"], cwd: dir,
    });
    if (r.code !== 0) {
      // JassHelper writes its errors (its own, or pjass's) to logs\compileerrors.txt.
      const log = await w3.workspace.readText(`${dir}\\logs\\compileerrors.txt`).catch(() => r.stdout || r.stderr || `exit code ${r.code}`);
      throw new Error(`JassHelper: ${log.split(/\r?\n/).filter(Boolean).slice(0, 8).join(" · ")} (files in ${dir})`);
    }
    return w3.workspace.readText(`${dir}\\output.j`);
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
  void w3.services.get<CodeEditorService>(CODE_EDITOR_SERVICE).then((editors) => {
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
        ed.setCustomText(t, `library ${ident(t.name)} initializer Init\r\n\r\n    private function Init takes nothing returns nothing\r\n    endfunction\r\n\r\nendlibrary\r\n`);
      },
      render(el, t, ed) {
        const status = h("span.muted");
        const checkBtn = h("button", {
          title: "Compiles this text alone with JassHelper (with common.j and Blizzard.j; the map's own globals and functions are unknown there).",
          onclick: async () => {
            status.textContent = "Compiling…";
            try {
              const [commonJ, blizzardJ] = await Promise.all([w3.game.readText("Scripts\\common.j"), w3.game.readText("Scripts\\Blizzard.j")]);
              await compile(ed.customText(t) ?? "", commonJ, blizzardJ);
              status.textContent = "JassHelper: no errors.";
            } catch (e) { status.textContent = e instanceof Error ? e.message : String(e); }
          },
        }, "Check with JassHelper");
        el.append(h("div.trig-section", {}, "vJASS"));
        const hint = h("p.muted.trig-hint", {}, t.type === 32
          ? `Copied into the "Custom Script Code" section of war3map.j; JassHelper compiles the map's script when it is generated.`
          : "Copied into war3map.j; JassHelper compiles the map's script when it is generated.");
        if (!code) {
          const area = h("textarea.trig-code-edit", {
            spellcheck: false, readOnly: !ed.editable, rows: 24, value: ed.customText(t) ?? "",
            onchange: () => ed.edit("Edit script", () => ed.setCustomText(t, area.value)),
          });
          el.append(area, h("div.trig-gui-toolbar", {}, checkBtn, status), hint);
          return;
        }
        const box = h("div.trig-code");
        el.append(box, h("div.trig-gui-toolbar", {}, checkBtn, status), hint);
        // Completion from the map script as last generated (JassHelper's output: libraries' functions too).
        const map = mapJass((p) => w3.game.readText(p), w3.workspace.readText("map/war3map.j").catch(() => null));
        const editor = code.create(box, {
          value: ed.customText(t) ?? "", language: "jass", readOnly: !ed.editable, symbols: map.symbols,
          openLocation: (loc) => { if (loc.startsWith("trigger:")) ed.openTrigger(`gg_trg_${ident(loc.slice(8))}`); },
          onChange: (v) => ed.edit("Edit script", () => ed.setCustomText(t, v), { keepView: true }),
        });
        return { dispose: () => editor.dispose() };
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
