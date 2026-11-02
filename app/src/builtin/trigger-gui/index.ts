// GUI Triggers: the trigger kind for triggers made of events, conditions and
// actions (not converted to custom text). Shows them as the World Editor words
// them, with the category icons and nested blocks (If/Then/Else, loops).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { TRIGGERS_SERVICE, type TriggerEditorHandle, type TriggersService } from "../../extensions/services";
import { branchLabels, ecaText } from "../../lib/triggers/display";
import { ACTION, CONDITION, EVENT } from "../../lib/triggers/triggerdata";
import type { Eca } from "../../lib/triggers/wtg";
import { h } from "../../workbench/dom";

export function activate(w3: W3Api, ctx: ExtensionContext) {
  void w3.services.get<TriggersService>(TRIGGERS_SERVICE).then((s) => {
    ctx.subscriptions.push(s.registerKind({
      id: "gui",
      priority: 10,
      title: "GUI Trigger",
      matches: (t) => !t.isCustom,
      init: () => { /* an empty trigger: no events, conditions or actions */ },
      render(el, t, ed) {
        for (const [kind, label] of [[EVENT, "Events"], [CONDITION, "Conditions"], [ACTION, "Actions"]] as const) {
          const list = t.ecas.filter((e) => e.kind === kind);
          el.append(h("div.trig-section", {}, label), h("div.trig-ecas", {}, ...list.map((e) => ecaNode(e, ed))));
        }
      },
    }));
  });
}

function ecaNode(e: Eca, ed: TriggerEditorHandle): HTMLElement {
  const img = h("img.trig-icon", { alt: "" });
  const f = ed.data.find(e.kind, e.name);
  const cat = f ? ed.data.categories.get(f.category) : undefined;
  void ed.icon(cat?.icon ?? "").then((url) => { if (url) img.src = url; else img.classList.add("none"); });
  const line = h(`div.trig-eca${e.enabled ? "" : ".off"}`, { title: e.name }, img, h("span", {}, ecaText(e, ed.display)));
  if (!e.children.length) return line;
  const labels = branchLabels(e.name);
  const groups = [...new Set(e.children.map((c) => c.group ?? 0))].sort((a, b) => a - b);
  return h("div.trig-block", {}, line, ...groups.map((g) => h("div.trig-branch", {},
    h("div.trig-branch-label", {}, labels[g] ?? "Actions"),
    ...e.children.filter((c) => (c.group ?? 0) === g).map((c) => ecaNode(c, ed)))));
}
