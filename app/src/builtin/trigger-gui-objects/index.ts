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

/** The kinds a code of a type may be of where that is more than the picker's: a tech is an upgrade or a unit. */
const ALSO: Record<string, string[]> = { techcode: ["w3u"] };

export function activate(w3: W3Api, ctx: ExtensionContext) {
  void Promise.all([w3.services.get<TriggerGuiService>(TRIGGER_GUI_SERVICE), w3.services.get<ObjectsService>(OBJECTS_SERVICE)]).then(([gui, objects]) => {
    for (const [types, kind, label] of KINDS) {
      ctx.subscriptions.push(gui.registerParamEditor({
        id: `objects.${kind}`,
        title: `${label}…`,
        types,
        // The World Editor's Value dialog takes only a code it finds; Studio keeps any, and says so.
        async warn({ type, value }) {
          const found = await objects.name(value, [kind, ...(ALSO[type] ?? [])]);
          const what = type === "techcode" ? "upgrade or unit type" : label.toLowerCase();
          return found === undefined ? `No ${what} "${value}" in the game or this map. The World Editor doesn't take such a code; OK keeps it all the same.` : undefined;
        },
        async edit() {
          const o = await objects.pick(document.body, { title: `Choose a ${label.toLowerCase()}`, kinds: [kind] });
          return o ? { type: 3, value: o.id } : undefined;
        },
      }));
    }
  });
}
