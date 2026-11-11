// Custom Script Triggers: the trigger kind for triggers converted to custom
// text. Their JASS or Lua code lives in war3map.wct; this shows and edits it
// in a code editor (service "w3.codeEditor"; a plain text box without it).
// A new one gets the InitTrig_<name> function the World Editor expects. Script
// items (Reforged, wtg type 32) are code that isn't a trigger ("Custom Script").

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { CODE_EDITOR_SERVICE, TRIGGERS_SERVICE, type CodeEditorService, type TriggerEditorHandle, type TriggersService } from "../../extensions/services";
import type { TriggerItem } from "../../lib/triggers/wtg";
import { checkJass } from "../../lib/jass/check";
import { gameJassEnv, mapJass } from "../../lib/jass/env";
import { checkLua } from "../../lib/lua/check";
import { luaSymbols } from "../../lib/lua/symbols";
import { ident } from "../../lib/script/jass";
import { h } from "../../workbench/dom";


export function activate(w3: W3Api, ctx: ExtensionContext) {
  void Promise.all([w3.services.get<TriggersService>(TRIGGERS_SERVICE), w3.services.get<CodeEditorService>(CODE_EDITOR_SERVICE).catch(() => null)]).then(([s, code]) => {
    /** The code editor for a trigger's custom text (`trigger`: it has a gg_trg_ global). */
    const render = (el: HTMLElement, t: TriggerItem, ed: TriggerEditorHandle, trigger: boolean) => {
      const lua = ed.language === "lua";
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
        const map = mapJass((p) => w3.game.readText(p), w3.workspace.readText("map/war3map.j").catch(() => null));
        const own = `gg_trg_${ident(t.name)}`;
        const check = !lua ? async (text: string) => {
          const env = await map.without(text);
          if (trigger) env.globals.set(own, { type: "trigger", array: false, constant: false });
          return checkJass(text, env, { ordered: false });
        } : (text: string) => checkLua(text).map((d) => ({ ...d, severity: "error" as const }));
        const editor = code.create(box, {
          value: ed.customText(t) ?? "", language: ed.language, readOnly: !ed.editable, check,
          symbols: lua ? async (text: string) => luaSymbols(await gameJassEnv((p) => w3.game.readText(p)), text) : map.symbols,
          openLocation: (loc) => { if (loc.startsWith("trigger:")) ed.openTrigger(`gg_trg_${ident(loc.slice(8))}`); },
          onChange: (v) => ed.edit("Edit script", () => ed.setCustomText(t, v), { keepView: true }),
        });
        return { dispose: () => editor.dispose(), flush: () => editor.flush() };
      }
      const area = h("textarea.trig-code-edit", {
        spellcheck: false, readOnly: !ed.editable, rows: 24, value: ed.customText(t) ?? "",
        // Also called by the host before a save (TriggerKind.render's flush): nothing when the text is unchanged.
        onchange: () => { if (area.value !== (ed.customText(t) ?? "")) ed.edit("Edit script", () => ed.setCustomText(t, area.value)); },
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
