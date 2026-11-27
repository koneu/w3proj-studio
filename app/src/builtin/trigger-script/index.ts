// Custom Script Triggers: the trigger kind for triggers converted to custom
// text. Their JASS or Lua code lives in war3map.wct; this shows and edits it
// in a code editor (service "w3.codeEditor"; a plain text box without it).
// A new one gets the InitTrig_<name> function the World Editor expects. Script
// items (Reforged, wtg type 32) are code that isn't a trigger ("Custom Script").

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { CODE_EDITOR_SERVICE, TRIGGERS_SERVICE, type CodeEditorService, type TriggerEditorHandle, type TriggersService } from "../../extensions/services";
import type { TriggerItem } from "../../lib/triggers/wtg";
import { checkJass } from "../../lib/jass/check";
import { gameJassEnv, mapJass, projectJassEnv } from "../../lib/jass/env";
import { readScriptFile } from "../../lib/script/guard";
import { checkLua } from "../../lib/lua/check";
import { mapLuaNames } from "../../lib/lua/env";
import { luaSymbols } from "../../lib/lua/symbols";
import { ident } from "../../lib/script/jass";
import { h } from "../../workbench/dom";


export function activate(w3: W3Api, ctx: ExtensionContext) {
  void Promise.all([w3.services.get<TriggersService>(TRIGGERS_SERVICE), w3.services.get<CodeEditorService>(CODE_EDITOR_SERVICE).catch(() => null)]).then(([s, code]) => {
    /** The code editor for a trigger's custom text (`trigger`: it has a gg_trg_ global). */
    const render = (el: HTMLElement, t: TriggerItem, ed: TriggerEditorHandle, trigger: boolean) => {
      const lua = ed.language === "lua";
      // The text as it was when shown: lines in an old code page show readable in the map's text encoding, and the
      // lines typed are written in it while the others keep their bytes (lib/formats/codepage.ts).
      const was = ed.customText(t) ?? "";
      const shown = ed.text ? ed.text.show(was) : was;
      const stored = (typed: string): string | null => {
        if (!ed.text) return typed;
        try {
          return ed.text.store(typed, was);
        } catch (e) {
          void w3.window.showError((e as Error).message);
          return null;
        }
      };
      const hint = h("p.muted.trig-hint", {}, trigger
        ? `Copied into war3map.${lua ? "lua" : "j"} as it is when the map script is generated.`
        : `Copied into the "Custom Script Code" section of war3map.${lua ? "lua" : "j"} (after the map header), in tree order.`);
      el.append(h("div.trig-section", {}, `${trigger ? "Custom script" : "Script"} (${lua ? "Lua" : "JASS"})`));
      if (code) {
        const box = h("div.trig-code");
        el.append(box, hint);
        // Typing is committed after a pause (one undo step each) without redrawing the editor.
        // JASS is checked against the game's scripts and the map script's declarations
        // (war3map.j as last generated; this trigger's own global may be newer).
        const map = mapJass((p) => w3.game.readText(p), readScriptFile(w3.workspace, "map/war3map.j").catch(() => null), () => projectJassEnv(w3));
        const own = `gg_trg_${ident(t.name)}`;
        // Lua names are checked against the game's API, war3map.lua as last generated (without it, e.g. a map
        // never built, names aren't judged: the triggers' functions would be missing) and the custom texts as the
        // editor holds them now (a function another trigger's text has just defined).
        const luaScript = lua ? readScriptFile(w3.workspace, "map/war3map.lua").catch(() => null) : null;
        const check = !lua ? async (text: string) => {
          const env = await map.without(text);
          if (trigger) env.globals.set(own, { type: "trigger", array: false, constant: false });
          return checkJass(text, env, { ordered: false });
        } : async (text: string) => {
          const script = await luaScript;
          const texts = ed.customFile();
          const names = script === null ? null : await mapLuaNames((p) => w3.game.readText(p), [script, texts.header, ...texts.texts.filter((x) => x !== text)]);
          return checkLua(text, names);
        };
        const editor = code.create(box, {
          value: shown, language: ed.language, readOnly: !ed.editable, check,
          symbols: lua ? async (text: string) => luaSymbols(await gameJassEnv((p) => w3.game.readText(p)), text) : map.symbols,
          openLocation: (loc) => { if (loc.startsWith("trigger:")) ed.openTrigger(`gg_trg_${ident(loc.slice(8))}`); },
          onChange: (typed) => {
            const v = stored(typed);
            if (v !== null) ed.edit("Edit script", () => ed.setCustomText(t, v), { keepView: true });
          },
        });
        return { dispose: () => editor.dispose(), flush: () => editor.flush() };
      }
      const area = h("textarea.trig-code-edit", {
        spellcheck: false, readOnly: !ed.editable, rows: 24, value: shown,
        // Also called by the host before a save (TriggerKind.render's flush): nothing when the text is unchanged.
        onchange: () => {
          const v = stored(area.value);
          if (v !== null && v !== (ed.customText(t) ?? "")) ed.edit("Edit script", () => ed.setCustomText(t, v));
        },
      });
      el.append(area, hint);
    };
    ctx.subscriptions.push(s.registerKind({
      id: "script",
      priority: 5,
      title: "Custom Script Trigger",
      matches: (t) => t.isCustom && t.type === 8,
      init(t, ed) {
        t.isCustom = true;
        const n = ident(t.name);
        ed.setCustomText(t, ed.language === "lua"
          ? `function InitTrig_${n}()\r\n    gg_trg_${n} = CreateTrigger()\r\nend\r\n`
          : `//===========================================================================\r\nfunction InitTrig_${n} takes nothing returns nothing\r\n    set gg_trg_${n} = CreateTrigger(  )\r\nendfunction\r\n`);
      },
      render: (el, t, ed) => render(el, t, ed, true),
    }), s.registerKind({
      // Code that isn't a trigger (functions, globals blocks…): a Reforged script item.
      id: "scriptItem",
      priority: 5,
      title: "Custom Script",
      itemType: 32,
      matches: (t) => t.type === 32,
      init(t, ed) {
        t.isCustom = true;
        ed.setCustomText(t, ed.language === "lua" ? "-- " + t.name + "\r\n" : "// " + t.name + "\r\n");
      },
      render: (el, t, ed) => render(el, t, ed, false),
    }));
  });
}
