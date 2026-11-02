// The "w3.objects" service (see extensions/services.ts): the object browser
// for other extensions, over game objects and the map's custom objects.

import type { W3Api } from "../../extensions/api";
import type { ObjectsService, PickedObject } from "../../extensions/services";
import { loadKind, type KindData } from "../../lib/objects/metadata";
import { pickObject } from "./picker";
import { decodeImage } from "../../lib/image/index.ts";
import { StringTable } from "../../lib/formats/wts";

const KIND_LABELS: Record<string, string> = {
  w3u: "Units", w3t: "Items", w3a: "Abilities", w3h: "Buffs/Effects", w3b: "Destructables", w3d: "Doodads", w3q: "Upgrades",
};

/** war3map.wts as "TRIGSTR_nnn" → text. */
export function parseWts(text: string): Map<string, string> {
  return new Map([...new StringTable(text).entries()].map(([n, v]) => [`TRIGSTR_${String(n).padStart(3, "0")}`, v]));
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
async function customObjects(w3: W3Api, kind: string, kd: KindData): Promise<{ id: string; base: string; name: string; icon?: string }[]> {
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
    const icon = mods.find((m) => m.field === ICON_FIELDS[kind] && typeof m.value === "string")?.value as string | undefined;
    return { id: o.id!, base: o.base, name: stripColors(name), icon };
  });
}

/** Icon (command button art) field per object kind; destructables and doodads have none. */
const ICON_FIELDS: Record<string, string> = { w3u: "uico", w3t: "iico", w3a: "aart", w3h: "fart", w3q: "gar1" };

/** Data URLs of object icons (map imports first, then the game), cached. */
export function iconLoader(w3: W3Api) {
  const cache = new Map<string, Promise<string | null>>();
  const load = (path: string) => {
    const key = path.toLowerCase();
    let p = cache.get(key);
    if (!p) {
      p = (async () => {
        const project = w3.workspace.project();
        const bytes = await (project ? w3.workspace.readBytes(`map/${path.replace(/\\/g, "/")}`).catch(() => w3.game.read(path)) : w3.game.read(path));
        const mip = decodeImage(bytes, path).mip(0);
        const canvas = document.createElement("canvas");
        canvas.width = mip.width;
        canvas.height = mip.height;
        canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(mip.rgba), mip.width, mip.height), 0, 0);
        return canvas.toDataURL();
      })().catch(() => null);
      cache.set(key, p);
    }
    return p;
  };
  /** Icon of object `id` of `kind` (custom objects: `base` and the map's own value in `custom`). */
  return (kd: KindData, kind: string, id: string, base?: string, custom?: string): Promise<string | null> => {
    const field = ICON_FIELDS[kind] && kd.fieldById.get(ICON_FIELDS[kind]);
    if (!field) return Promise.resolve(null);
    const raw = custom ?? kd.defaultValue(base ?? id, field, field.repeat > 0 ? 1 : 0);
    // Some art fields list several files; the first is the icon.
    const path = raw?.split(",")[0]?.trim();
    return path ? load(/\.\w+$/.test(path) ? path : `${path}.blp`) : Promise.resolve(null);
  };
}

export function objectsService(w3: W3Api): ObjectsService {
  const icons = iconLoader(w3);
  /** Tab last used per set of kinds, so the browser reopens where it was. */
  const lastTab = new Map<string, number>();
  return {
    async name(id, kinds = Object.keys(KIND_LABELS)) {
      for (const kind of kinds) {
        const kd = await loadKind(w3, kind).catch(() => null);
        if (!kd) continue;
        const custom = (await customObjects(w3, kind, kd).catch(() => [])).find((c) => c.id === id);
        if (custom) return custom.name;
        const n = kd.names.get(id);
        if (n) return stripColors(n);
      }
      return undefined;
    },
    async icon(kind, id) {
      if (!ICON_FIELDS[kind]) return null;
      const kd = await loadKind(w3, kind);
      const custom = (await customObjects(w3, kind, kd).catch(() => [])).find((c) => c.id === id);
      return icons(kd, kind, id, custom?.base, custom?.icon);
    },
    async pick(host, opts): Promise<PickedObject | undefined> {
      const key = opts.kinds.join(",");
      let tab = Math.min(lastTab.get(key) ?? 0, opts.kinds.length - 1), query = "";
      for (;;) {
        const kind = opts.kinds[tab];
        const kd = await loadKind(w3, kind);
        const custom = await customObjects(w3, kind, kd).catch(() => []);
        const r = await pickObject(host, kd, {
          title: opts.title, custom, query,
          iconOf: (id, base) => icons(kd, kind, id, base, custom.find((c) => c.id === id)?.icon),
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
