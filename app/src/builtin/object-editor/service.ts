// The "w3.objects" service (see extensions/services.ts): the object browser
// for other extensions, over game objects and the map's custom objects.

import type { W3Api } from "../../extensions/api";
import type { ObjectsService, PickedObject } from "../../extensions/services";
import { loadKind, type KindData } from "../../lib/objects/metadata";
import { pickObject } from "./picker";

const KIND_LABELS: Record<string, string> = {
  w3u: "Units", w3t: "Items", w3a: "Abilities", w3h: "Buffs/Effects", w3b: "Destructables", w3d: "Doodads", w3q: "Upgrades",
};

/** war3map.wts: STRING <n> [// comment] { text } */
export function parseWts(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /STRING\s+(\d+)\s*(?:\/\/[^\n]*\n\s*)*\{\r?\n([\s\S]*?)\r?\n\}/g;
  for (let m; (m = re.exec(text)); ) map.set(`TRIGSTR_${m[1].padStart(3, "0")}`, m[2]);
  return map;
}

export function stripColors(s: string) {
  return s.replace(/\|c[0-9a-f]{8}|\|r/gi, "");
}

interface RawObject {
  base: string;
  id?: string;
  mods?: { field: string; type?: string; value: unknown }[];
  sets?: { mods: { field: string; type?: string; value: unknown }[] }[];
}

/** The map's custom objects of one kind with their display names (the
 *  object's own name field, resolved through war3map.wts). */
async function customObjects(w3: W3Api, kind: string, kd: KindData): Promise<{ id: string; base: string; name: string }[]> {
  const path = w3.workspace.files().find((f) => f.path.toLowerCase() === `map/war3map.${kind}.json`)?.path;
  if (!path) return [];
  const file = JSON.parse(await w3.workspace.readText(path)) as { custom?: RawObject[] };
  let strings = new Map<string, string>();
  try { strings = parseWts(await w3.workspace.readText("map/war3map.wts")); } catch { /* no string table */ }
  const resolve = (v: string) => strings.get(v.replace(/^(TRIGSTR_)0*(\d{3,})$/, "$1$2")) ?? v;
  return (file.custom ?? []).filter((o) => o.id).map((o) => {
    const mods = [...(o.mods ?? []), ...(o.sets ?? []).flatMap((s) => s.mods)];
    const nameMod = mods.find((m) => /nam$/.test(m.field) && typeof m.value === "string");
    const name = nameMod ? resolve(nameMod.value as string) : kd.names.get(o.base) ?? o.base;
    return { id: o.id!, base: o.base, name: stripColors(name) };
  });
}

export function objectsService(w3: W3Api): ObjectsService {
  /** Tab last used per set of kinds, so the browser reopens where it was. */
  const lastTab = new Map<string, number>();
  return {
    async pick(host, opts): Promise<PickedObject | undefined> {
      const key = opts.kinds.join(",");
      let tab = Math.min(lastTab.get(key) ?? 0, opts.kinds.length - 1), query = "";
      for (;;) {
        const kind = opts.kinds[tab];
        const kd = await loadKind(w3, kind);
        const custom = await customObjects(w3, kind, kd).catch(() => []);
        const r = await pickObject(host, kd, {
          title: opts.title, custom, query,
          tabs: opts.kinds.length > 1 ? { labels: opts.kinds.map((k) => KIND_LABELS[k] ?? k), active: tab } : undefined,
        });
        if (!r) return undefined;
        if ("tab" in r) { tab = r.tab; query = r.query; lastTab.set(key, tab); continue; }
        const c = custom.find((x) => x.id === r.id);
        return { kind, id: r.id, name: c?.name ?? stripColors(kd.names.get(r.id) ?? r.id), base: c?.base };
      }
    },
  };
}
