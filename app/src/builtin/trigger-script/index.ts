// Custom Script Triggers: the trigger kind for triggers converted to custom
// text. Their JASS or Lua code lives in war3map.wct; this shows and edits it
// in a code editor (service "w3.codeEditor"; a plain text box without it).
// A new one gets the InitTrig_<name> function the World Editor expects.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { CODE_EDITOR_SERVICE, TRIGGERS_SERVICE, type CodeEditorService, type TriggersService } from "../../extensions/services";
import { h } from "../../workbench/dom";

/** The trigger's name as the World Editor turns it into identifiers (gg_trg_<name>). */
const ident = (name: string) => name.trim().replace(/[^A-Za-z0-9_]/g, "_");

export function activate(w3: W3Api, ctx: ExtensionContext) {
  void Promise.all([w3.services.get<TriggersService>(TRIGGERS_SERVICE), w3.services.get<CodeEditorService>(CODE_EDITOR_SERVICE).catch(() => null)]).then(([s, code]) => {
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
        const hint = h("p.muted.trig-hint", {}, `Copied into war3map.${ed.language === "lua" ? "lua" : "j"} as it is when the map script is generated.`);
        el.append(h("div.trig-section", {}, `Custom script (${lang})`));
        if (code) {
          const box = h("div.trig-code");
          el.append(box, hint);
          // Typing is committed after a pause (one undo step each) without redrawing the editor.
          const editor = code.create(box, {
            value: ed.customText(t) ?? "", language: ed.language, readOnly: !ed.editable,
            onChange: (v) => ed.edit("Edit script", () => ed.setCustomText(t, v), { keepView: true }),
          });
          return { dispose: () => editor.dispose() };
        }
        const area = h("textarea.trig-code-edit", {
          spellcheck: false, readOnly: !ed.editable, rows: 24, value: ed.customText(t) ?? "",
          onchange: () => ed.edit("Edit script", () => ed.setCustomText(t, area.value)),
        });
        el.append(area, hint);
      },
    }));
  });
}
