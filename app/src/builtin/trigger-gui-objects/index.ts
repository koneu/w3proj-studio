// Trigger Object Pickers: parameter editors (service "w3.triggers.gui") that
// choose unit/item/ability/… types in the object browser ("w3.objects").

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { OBJECTS_SERVICE, TRIGGER_GUI_SERVICE, type ObjectsService, type TriggerGuiService } from "../../extensions/services";

/** TriggerData code types → object data kinds. */
const KINDS: [string[], string, string][] = [
  [["unitcode"], "w3u", "Unit type"],
  [["itemcode"], "w3t", "Item type"],
  [["abilcode", "heroskillcode"], "w3a", "Ability"],
  [["buffcode"], "w3h", "Buff"],
  [["destructablecode"], "w3b", "Destructable type"],
  [["doodadcode"], "w3d", "Doodad type"],
  [["techcode", "upgradecode"], "w3q", "Upgrade"],
];

export function activate(w3: W3Api, ctx: ExtensionContext) {
  void Promise.all([w3.services.get<TriggerGuiService>(TRIGGER_GUI_SERVICE), w3.services.get<ObjectsService>(OBJECTS_SERVICE)]).then(([gui, objects]) => {
    for (const [types, kind, label] of KINDS) {
      ctx.subscriptions.push(gui.registerParamEditor({
        id: `objects.${kind}`,
        title: `${label}…`,
        types,
        async edit() {
          const o = await objects.pick(document.body, { title: `Choose a ${label.toLowerCase()}`, kinds: [kind] });
          return o ? { type: 3, value: o.id } : undefined;
        },
      }));
    }
  });
}
