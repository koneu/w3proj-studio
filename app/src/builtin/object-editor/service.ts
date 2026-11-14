// The "w3.objects" service (see extensions/services.ts): the object browser
// for other extensions, over game objects and the map's custom objects.

import type { W3Api } from "../../extensions/api";
import type { ObjectsService, PickedObject } from "../../extensions/services";
import { loadKind, type KindData } from "../../lib/objects/metadata";
import { loadEditorTypes, objectEditor } from "./fields";
import { pickFile, pickLabel } from "./filepicker";
import { pickObject } from "./picker";
import { parseSoundLabels, SOUND_INFO } from "../../lib/script/jass";
import { decodeImage } from "../../lib/image/index.ts";
import { levelFor } from "../../lib/model/gltexture";
import { StringTable } from "../../lib/formats/wts";
import { readMapDoc } from "../../lib/formats/mapdoc";
import { readImportedFor } from "../../lib/imports";
import { findCampaign, readCampaignObjects } from "../../lib/objects/campaign";
import { isNotFoundError } from "../../lib/oserror";
import { joinPath } from "../../lib/paths";
import { mergeSkin } from "./w3o";
import { withLists, withSkin } from "./skin";
import type { EditFile } from "./objectedit";

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

export interface RawObject {
  base: string;
  id?: string;
  mods?: { field: string; type?: string; value: unknown }[];
  sets?: { mods: { field: string; type?: string; value: unknown }[] }[];
}

/** A custom object as the browser lists it. `campaign`: one of a chapter map's campaign. */
interface CustomEntry { id: string; base: string; name: string; icon?: string; campaign?: boolean }

/** Custom objects of one object file with their display names (the object's own name field, resolved through the
 *  string table `wts`). */
function entriesOf(kind: string, kd: KindData, objects: RawObject[], wts: string | null, campaign: boolean): CustomEntry[] {
  let strings = new Map<string, string>();
  if (wts !== null) strings = parseWts(wts);
  const resolve = (v: string) => strings.get(v.replace(/^(TRIGSTR_)0*(\d{3,})$/, "$1$2")) ?? v;
  return objects.filter((o) => o.id).map((o) => {
    const mods = [...(o.mods ?? []), ...(o.sets ?? []).flatMap((s) => s.mods)];
    const nameMod = mods.find((m) => /nam$/.test(m.field) && typeof m.value === "string");
    const name = nameMod ? resolve(nameMod.value as string) : kd.names.get(o.base) ?? o.base;
    const icon = mods.find((m) => m.field === ICON_FIELDS[kind] && typeof m.value === "string")?.value as string | undefined;
    return { id: o.id!, base: o.base, name: stripColors(name), icon, ...(campaign ? { campaign: true } : {}) };
  });
}

/** The map's custom objects of one kind with their display names (the object's own name field, resolved through
 *  war3map.wts), then, for a chapter map, its campaign's that the map doesn't have itself (war3campaign.<kind> with its
 *  Skin file, names through war3campaign.wts): the chapter can use those as its own. */
async function customObjects(w3: W3Api, kind: string, kd: KindData): Promise<CustomEntry[]> {
  // With the Skin file's fields (names, icons), its values winning, as the World Editor shows them (skin.ts).
  const read = async (name: string) => {
    const path = w3.workspace.files().find((f) => f.path.toLowerCase() === `map/${name}.${kind}.json`.toLowerCase())?.path;
    return path ? withLists(JSON.parse(await w3.workspace.readText(path)) as EditFile) : null;
  };
  const [main, skin] = await Promise.all([read("war3map"), read("war3mapSkin")]);
  const merged = main || skin ? mergeSkin(main ?? { format: "w3proj.objects/1", version: skin!.version, original: [], custom: [] }, skin, { addSkinOnly: true }) : null;
  const own = merged ? entriesOf(kind, kd, merged.custom as RawObject[], await w3.workspace.readText("map/war3map.wts").catch(() => null), false) : [];
  // The campaign's are only offered: one that can't be read leaves them out, not the map's own.
  const campaign = await campaignObjects(w3, kind).catch(() => null);
  if (!campaign) return own;
  const ids = new Set(own.map((o) => o.id));
  return [...own, ...entriesOf(kind, kd, campaign.custom, campaign.wts, true).filter((o) => !ids.has(o.id))];
}

/** A chapter map's campaign's object data of one kind (war3campaign.<kind> with its Skin file's fields) and the
 *  campaign's string table; null when the map isn't a chapter or its campaign has none of that kind. Throws when it
 *  can't be told or read. `root`: that project's (the open one's by default). */
export async function campaignObjects(w3: W3Api, kind: string, root?: string): Promise<{ campaign: string; custom: RawObject[]; original: RawObject[]; wts: string | null } | null> {
  const campaign = await findCampaign(w3, root ?? w3.workspace.project()?.root);
  if (!campaign) return null;
  const [main, skin] = await Promise.all([readCampaignObjects<EditFile>(w3, campaign, kind), readCampaignObjects<EditFile>(w3, campaign, kind, true)]);
  if (!main && !skin) return null;
  const base = { format: "w3proj.objects/1", version: main?.version ?? skin?.version ?? 3, original: main?.original ?? [], custom: main?.custom ?? [] } as EditFile;
  const merged = mergeSkin(base, skin && { ...skin, original: skin.original ?? [], custom: skin.custom ?? [] }, { addSkinOnly: true });
  const wtsPath = joinPath(campaign, "map", "war3campaign.wts");
  const wts = await w3.workspace.readText(wtsPath).then((t) => t, (e) => {
    if (isNotFoundError(e)) return null;
    throw new Error(`${wtsPath} is there but can't be read (${e instanceof Error ? e.message : String(e)}).`);
  });
  return { campaign, custom: (merged.custom ?? []) as RawObject[], original: (merged.original ?? []) as RawObject[], wts };
}

/** Icon (command button art) field per object kind; destructables and doodads have none. */
const ICON_FIELDS: Record<string, string> = { w3u: "uico", w3t: "iico", w3a: "aart", w3h: "fart", w3q: "gar1" };

/** The side of a list icon in pixels: rows show them at 20 to 24, doubled on a dense screen. A Reforged icon is
 *  256 a side, and as a data URL of that size 100 KB that every row's picture decodes again. */
export const LIST_ICON_SIZE = 64;

/** Images (icons, textures) as data URLs: the map's imports first, then the game's files (cached). `maxSize`: the
 *  picture is made no larger than about this a side (its first mip level at least that tall, scaled down if the
 *  file has none that small). */
export function imageLoader(w3: W3Api, maxSize?: number): (path: string) => Promise<string | null> {
  const cache = new Map<string, Promise<string | null>>();
  // Icons of a list fill in as they come: the reads someone waits on (a map opening) go first.
  const background = { background: true };
  return (path: string) => {
    const key = path.toLowerCase();
    let p = cache.get(key);
    if (!p) {
      p = (async () => {
        const project = w3.workspace.project();
        // The map's import under its name on disk, whatever the case the field names (as the game finds it); in
        // Reforged its Reforged version (_HD.w3mod\) first.
        const own = project ? await readImportedFor(w3, path, w3.settings.get<string>("game.graphicsMode") ?? "hd").catch(() => null) : null;
        const bytes = own ?? await w3.game.read(path, background);
        const image = decodeImage(bytes, path), mip = image.mip(maxSize ? levelFor(image, maxSize) : 0);
        const canvas = document.createElement("canvas");
        canvas.width = mip.width;
        canvas.height = mip.height;
        canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(mip.rgba), mip.width, mip.height), 0, 0);
        if (!maxSize || mip.height <= maxSize * 2) return canvas.toDataURL();
        // No small level in the file: scaled here.
        const small = document.createElement("canvas");
        small.height = maxSize;
        small.width = Math.max(1, Math.round((mip.width * maxSize) / mip.height));
        small.getContext("2d")!.drawImage(canvas, 0, 0, small.width, small.height);
        return small.toDataURL();
      })().catch(() => null);
      cache.set(key, p);
    }
    return p;
  };
}

export function iconLoader(w3: W3Api) {
  const load = imageLoader(w3, LIST_ICON_SIZE);
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

/** The game's sound labels, sorted. Read once. */
let labels: Promise<string[]> | null = null;
export function soundLabels(w3: W3Api): Promise<string[]> {
  labels ??= Promise.all(SOUND_INFO.map((n) => w3.game.readText(`UI\\SoundInfo\\${n}.slk`).catch(() => ""))).then((t) => [...parseSoundLabels(t).keys()].sort((a, b) => a.localeCompare(b)));
  labels.catch(() => { labels = null; });
  return labels;
}

export function objectsService(w3: W3Api, copying: Pick<ObjectsService, "typesFor" | "bringTypes" | "liveObjects" | "onDidEdit">): ObjectsService {
  const icons = iconLoader(w3);
  const images = imageLoader(w3);
  // Callers ask for names one by one, a whole map's worth at once: the files are read once per
  // kind until something is saved or changes on disk.
  const parsed = new Map<string, ReturnType<typeof customObjects>>();
  const forget = () => parsed.clear();
  w3.workspace.onDidChange(forget);
  w3.workspace.onDidSave(forget);
  const customOf = (kind: string, kd: KindData) => {
    let list = parsed.get(kind);
    if (!list) parsed.set(kind, (list = customObjects(w3, kind, kd).catch(() => [])));
    return list;
  };
  /** Tab last used per set of kinds, so the browser reopens where it was. */
  const lastTab = new Map<string, number>();
  const service: ObjectsService = {
    ...copying,
    pickFile: (host, opts) => pickFile(w3, host, { ...opts, thumb: images }),
    pickSoundLabel: (host, opts) => pickLabel(w3, host, { ...opts, labels: () => soundLabels(w3) }),
    image: (path) => images(/\.\w+$/.test(path) ? path : `${path}.blp`),
    objectField: (host, opts) => objectEditor(service, host, opts.kinds, opts.list, opts.current, opts.onCommit),
    async savedObjects(kind) {
      const read = (name: string) => readMapDoc<EditFile>(w3, `map/${name}.${kind}.json`);
      return withSkin(await read("war3map"), await read("war3mapSkin"));
    },
    async name(id, kinds = Object.keys(KIND_LABELS)) {
      for (const kind of kinds) {
        const kd = await loadKind(w3, kind).catch(() => null);
        if (!kd) continue;
        const custom = (await customOf(kind, kd)).find((c) => c.id === id);
        if (custom) return custom.name;
        const n = kd.names.get(id);
        if (n) return stripColors(n);
      }
      return undefined;
    },
    async icon(kind, id) {
      if (!ICON_FIELDS[kind]) return null;
      const kd = await loadKind(w3, kind);
      const custom = (await customOf(kind, kd)).find((c) => c.id === id);
      return icons(kd, kind, id, custom?.base, custom?.icon);
    },
    async pick(host, opts): Promise<PickedObject | undefined> {
      const key = opts.kinds.join(",");
      let tab = Math.min(lastTab.get(key) ?? 0, opts.kinds.length - 1), query = "";
      for (;;) {
        const kind = opts.kinds[tab];
        const kd = await loadKind(w3, kind);
        const custom = await customOf(kind, kd);
        // Not awaited: the browser opens at once and labels its values when the types arrive.
        const editorTypes = loadEditorTypes(w3).catch(() => null);
        const r = await pickObject(host, kd, {
          title: opts.title, custom, query, editorTypes,
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
  return service;
}
