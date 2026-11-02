// Custom Script Triggers: the trigger kind for triggers converted to custom
// text. Their JASS or Lua code lives in war3map.wct; this shows and edits it.
// A new one gets the InitTrig_<name> function the World Editor expects.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { TRIGGERS_SERVICE, type TriggersService } from "../../extensions/services";
import { h } from "../../workbench/dom";

/** The trigger's name as the World Editor turns it into identifiers (gg_trg_<name>). */
const ident = (name: string) => name.trim().replace(/[^A-Za-z0-9_]/g, "_");

export function activate(w3: W3Api, ctx: ExtensionContext) {
  void w3.services.get<TriggersService>(TRIGGERS_SERVICE).then((s) => {
    ctx.subscriptions.push(s.registerKind({
      id: "script",
      priority: 5,
      title: "Custom Script Trigger",
      matches: (t) => t.isCustom,
      init(t, ed) {
        t.isCustom = true;
        const n = ident(t.name);
        ed.setCustomText(t, ed.language === "lua"
          ? `function InitTrig_${n}()\r\n    gg_trg_${n} = CreateTrigger()\r\nend\r\n`
          : `//===========================================================================\r\nfunction InitTrig_${n} takes nothing returns nothing\r\n    set gg_trg_${n} = CreateTrigger(  )\r\nendfunction\r\n`);
      },
      render(el, t, ed) {
        const lang = ed.language === "lua" ? "Lua" : "JASS";
        const area = h("textarea.trig-code-edit", {
          spellcheck: false, readOnly: !ed.editable, rows: 24, value: ed.customText(t) ?? "",
          onchange: () => ed.edit("Edit script", () => ed.setCustomText(t, area.value)),
        });
        el.append(h("div.trig-section", {}, `Custom script (${lang})`), area,
          h("p.muted.trig-hint", {}, "The World Editor compiles this into war3map.j / war3map.lua when it saves the map; W3Proj Studio doesn't regenerate the map script yet."));
      },
    }));
  });
}
