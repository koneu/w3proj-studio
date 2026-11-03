// Trigger Map Objects: a parameter editor (service "w3.triggers.gui") listing
// what the map itself defines, as the generated globals the World Editor
// stores in triggers: regions gg_rct_, cameras gg_cam_, sounds and music
// gg_snd_, triggers gg_trg_, placed units gg_unit_, items gg_item_ and
// destructables gg_dest_ (object id and creation number).

import type { ExtensionContext, W3Api } from "../../extensions/api";
import {
  OBJECTS_SERVICE, TERRAIN_SERVICE, TRIGGER_GUI_SERVICE, type ObjectsService, type TerrainService, type TriggerGuiService, type TriggerParamChoice,
} from "../../extensions/services";
import { ident, placedName, type PlacedJson } from "../../lib/script/jass";

const VARIABLE = 1;
const NEUTRAL: Record<number, string> = { 24: "Neutral Hostile", 25: "Neutral Victim", 26: "Neutral Extra", 27: "Neutral Passive" };

type Placed = PlacedJson & { position: number[]; player?: number };
type Region = { name: string; left: number; right: number; bottom: number; top: number };
/** How far from a click a placed object may stand to be picked. */
const PICK_RADIUS = 128;

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const json = async <T>(path: string): Promise<T | null> => {
    const text = await w3.workspace.readText(`${path}.json`).catch(() => null);
    return text === null ? null : JSON.parse(text) as T;
  };
  const global = (value: string): TriggerParamChoice["param"] => ({ type: VARIABLE, value });
  const at = (p: Placed) => `(${Math.round(p.position[0])}, ${Math.round(p.position[1])})`;

  void Promise.all([
    w3.services.get<TriggerGuiService>(TRIGGER_GUI_SERVICE), w3.services.get<ObjectsService>(OBJECTS_SERVICE), w3.services.get<TerrainService>(TERRAIN_SERVICE),
  ]).then(([gui, objects, terrain]) => {
    /** Placed objects of one object kind, labelled like the World Editor ("Footman 0012"). */
    const placed = async (entries: Placed[], kind: string, prefix: string, owner: boolean): Promise<(TriggerParamChoice & { at: number[] })[]> => {
      const names = new Map<string, string | undefined>();
      for (const id of new Set(entries.map((e) => e.id))) names.set(id, await objects.name(id, [kind]).catch(() => undefined));
      return entries.filter((e) => names.get(e.id) !== undefined).map((e) => {
        const value = placedName(e, prefix);
        const player = e.player ?? -1;
        const group = owner ? NEUTRAL[player] ?? `Player ${player + 1}` : undefined;
        return { label: `${names.get(e.id)} ${value.slice(-4)}`, detail: `${e.id} ${at(e)}`, group, param: global(value), at: e.position };
      });
    };

    const placedOf: Record<string, () => Promise<(TriggerParamChoice & { at: number[] })[]>> = {
      unit: async () => placed((await json<{ units: Placed[] }>("map/war3mapUnits.doo"))?.units ?? [], "w3u", "unit", true),
      item: async () => placed((await json<{ units: Placed[] }>("map/war3mapUnits.doo"))?.units ?? [], "w3t", "item", false),
      destructable: async () => placed((await json<{ doodads: Placed[] }>("map/war3map.doo"))?.doodads ?? [], "w3b", "dest", false),
    };
    const regions = async () => (await json<{ regions: Region[] }>("map/war3map.w3r"))?.regions ?? [];
    const lists: Record<string, () => Promise<TriggerParamChoice[]>> = {
      rect: async () => (await regions())
        .map((r) => ({ label: r.name, detail: `gg_rct_${ident(r.name)}`, param: global(`gg_rct_${ident(r.name)}`) })),
      camerasetup: async () => ((await json<{ cameras: { name: string }[] }>("map/war3map.w3c"))?.cameras ?? [])
        .map((c) => ({ label: c.name, detail: `gg_cam_${ident(c.name)}`, param: global(`gg_cam_${ident(c.name)}`) })),
      // Music (flag 8) is a file path, for music parameters only.
      sound: async () => sounds(false),
      musicfile: async () => sounds(true),
      ...placedOf,
    };
    const sounds = async (music: boolean) => ((await json<{ sounds: { name: string; file: string; flags: number }[] }>("map/war3map.w3s"))?.sounds ?? [])
      .filter((s) => ((s.flags & 8) !== 0) === music)
      .map((s) => ({ label: s.name.replace(/^gg_snd_/, ""), detail: s.file, param: global(s.name) }));

    ctx.subscriptions.push(gui.registerParamEditor({
      id: "map.objects",
      title: "Map",
      types: [...Object.keys(lists), "trigger"],
      async list({ type, editor }) {
        if (type === "trigger") {
          return editor.file.items.filter((i) => i.type === 8 || i.type === 32)
            .map((t) => ({ label: t.name, detail: `gg_trg_${ident(t.name)}`, param: global(`gg_trg_${ident(t.name)}`) }));
        }
        return lists[type]?.() ?? [];
      },
    }));

    // Clicking it on the map: the nearest placed object, or the smallest region there.
    // (Reads the saved files: placements not saved yet aren't found.)
    const what: Record<string, string> = { unit: "a unit", item: "an item", destructable: "a destructable", rect: "a region" };
    ctx.subscriptions.push(gui.registerParamEditor({
      id: "map.pick",
      title: "Pick on map…",
      types: Object.keys(what),
      async edit({ type }) {
        const p = await terrain.pickPoint({ prompt: `Click ${what[type]} on the map` }).finally(() => w3.commands.execute("w3.triggers.open").catch(() => {}));
        if (!p) return undefined;
        if (type === "rect") {
          const hit = (await regions()).filter((r) => p.x >= r.left && p.x <= r.right && p.y >= r.bottom && p.y <= r.top)
            .sort((a, b) => (a.right - a.left) * (a.top - a.bottom) - (b.right - b.left) * (b.top - b.bottom))[0];
          if (hit) return global(`gg_rct_${ident(hit.name)}`);
        } else {
          const near = (await placedOf[type]()).map((c) => ({ c, d: Math.hypot(c.at[0] - p.x, c.at[1] - p.y) }))
            .filter((x) => x.d <= PICK_RADIUS).sort((a, b) => a.d - b.d)[0];
          if (near) return near.c.param;
        }
        void w3.window.showWarning(`There is no ${type === "rect" ? "region" : type} there (saved placements only).`);
        return undefined;
      },
    }));
  });
}
