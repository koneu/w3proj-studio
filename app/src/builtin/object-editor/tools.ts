// The MCP tools over object data: list_objects, get_object, set_object_fields, create_object, delete_object.
//
// Which object data they work on follows the World Editor: in a campaign project, the campaign's own
// (war3campaign.<kind>, which every chapter map has), as its Object Editor edits it there. In a chapter map, the
// map's own (war3map.<kind>); the campaign's objects are listed and shown too, as the chapter has them, but they're
// changed in the campaign project (the World Editor changes them in its Campaign Editor), so the tools refuse to
// change them from a chapter and say where that's done. A chapter can still change a game object the campaign
// changes: the map's values win where both set a field.

import type { ExtensionContext, W3Api } from "../../extensions/api";
import { MCP_EDITS_SERVICE, type McpEditsService } from "../../extensions/services";
import { capped, jsonPathOf, mapStrings, readMapDoc, readMapDocStrict, requireProject, terrainFacts } from "../../lib/formats/mapdoc";
import { StringTable } from "../../lib/formats/wts";
import { nextFreeId, type KindData } from "../../lib/objects/metadata";
import { idsUsedBy, modsOf } from "../../lib/objects/refs";
import { isNotFoundError } from "../../lib/oserror";
import { triggerRefs } from "../../lib/triggers/refs";
import { parseTriggerData } from "../../lib/triggers/triggerdata";
import { parseWct, parseWctText, readWtgFile, textTriggers, WCT_RAW, WCT_TEXT, wtgPath, type CustomTextFile, type TriggerFile } from "../../lib/triggers/wtg";
import { addCustomObject, fieldLevel, fieldValue, NEGATIVE_REALS_SETTING, objectToEdit, rawOnlySkin, removeObject, setObjectField, type EditFile } from "./objectedit";
import { changedFields, gameFields, gameObjectList, mapObjectList, modelPacks, OBJECT_KINDS, objectName, type MapObject, type MapObjects } from "./objectinfo";
import { campaignObjects, stripColors } from "./service";
import { isSkinField, listedPath, skinChanged, skinWritable, splitSkin, withLists, withSkin } from "./skin";
import { mergeSkin } from "./w3o";

/** Whether a project (its files) is a campaign: it has war3campaign.w3f, as the Campaign Editor decides. */
export const isCampaignFiles = (files: readonly { path: string }[]) => files.some((f) => /^map\/war3campaign\.w3f(\.json)?$/i.test(f.path.replace(/\\/g, "/")));

/** The name the open project's own object data files start with: a campaign's war3campaign, else war3map. */
export const objectPrefix = (w3: W3Api) => (isCampaignFiles(w3.workspace.files()) ?"war3campaign" : "war3map");

/** A chapter map's campaign's objects of one kind, as campaignObjects reads them, with their texts. */
interface Campaign { custom: MapObject[]; original: MapObject[]; resolve: (value: string) => string }

/** Where an id is in object data: a custom object's id, or a changed game object's base. */
const findIn = (file: { custom?: MapObject[]; original?: MapObject[] }, id: string): { o: MapObject; custom: boolean } | null => {
  const custom = file.custom?.find((o) => o.id === id);
  if (custom) return { o: custom, custom: true };
  const changed = file.original?.find((o) => o.base === id);
  return changed ? { o: changed, custom: false } : null;
};

const named = (o: MapObject) => modsOf(o).some((m) => /nam$/.test(m.field) && typeof m.value === "string" && m.value !== "");

/** The campaign's objects a chapter map's list shows besides its own: those it doesn't have itself (its own replace
 *  the campaign's custom objects, and its changes to a game object are listed as the map's). */
export function campaignListed(own: MapObjects, campaign: Pick<Campaign, "custom" | "original">): MapObjects {
  const ids = new Set((own.custom ?? []).map((o) => o.id)), bases = new Set((own.original ?? []).map((o) => o.base));
  return { custom: campaign.custom.filter((o) => o.id && !ids.has(o.id)), original: campaign.original.filter((o) => !bases.has(o.base)) };
}

/** The lines of a script text that name `id` as an object code: JASS 'h000', Lua FourCC("h000") or 'h000', a
 *  string "h000" (1-based line numbers, each once). */
export function scriptLines(text: string, id: string): number[] {
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(['"])${esc}\\1`);
  const out: number[] = [];
  text.split(/\r?\n/).forEach((line, i) => { if (re.test(line)) out.push(i + 1); });
  return out;
}

/** What still names an object after it's gone from the object data. `unchecked`: files that are there but couldn't be
 *  read, so whatever they name isn't known (they aren't taken for files that name nothing). */
export interface Uses {
  objects: string[];
  placed: number;
  guiTriggers: string[];
  customScripts: string[];
  mapScript: { file: string; lines: number[] }[];
  unchecked: string[];
}

/** One sentence per kind of use, for a tool's answer; "" when nothing names it. */
export function describeUses(id: string, u: Uses): string {
  const parts: string[] = [];
  const few = (list: string[]) => (list.length > 5 ? `${list.slice(0, 5).join(", ")} and ${list.length - 5} more` : list.join(", "));
  if (u.mapScript.length) parts.push(u.mapScript.map((s) => `${s.file} (line${s.lines.length === 1 ? "" : "s"} ${few(s.lines.map(String))})`).join(", "));
  if (u.customScripts.length) parts.push(`the custom script of ${few(u.customScripts)}`);
  if (u.guiTriggers.length) parts.push(`the trigger${u.guiTriggers.length === 1 ? "" : "s"} ${few(u.guiTriggers)}`);
  if (u.objects.length) parts.push(`the object${u.objects.length === 1 ? "" : "s"} ${few(u.objects)}`);
  if (u.placed) parts.push(`${u.placed} placed object${u.placed === 1 ? "" : "s"}`);
  const still = parts.length ? `${id} is still named by ${parts.join("; ")}: those aren't changed, and now refer to nothing.` : "";
  const unknown = u.unchecked.length ? `Not checked, as ${u.unchecked.length === 1 ? "it is" : "they are"} there but can't be read: ${u.unchecked.join(", ")}.` : "";
  return [still, unknown].filter(Boolean).join(" ");
}

/** Reads a project file's text: null when it isn't there; throws when it's there but can't be read. */
const textOrNull = (w3: W3Api, path: string) => w3.workspace.readText(path).then((t) => t, (e) => { if (isNotFoundError(e)) return null; throw e; });
const bytesOrNull = (w3: W3Api, path: string) => w3.workspace.readBytes(path).then((t) => t, (e) => { if (isNotFoundError(e)) return null; throw e; });

/** What in the open project names `id` (see Uses): the map script, custom script triggers, GUI triggers' object
 *  codes, other objects' fields (`prefix`'s object data, every kind) and placed objects. */
export async function usesOf(w3: W3Api, id: string, prefix: string): Promise<Uses> {
  const u: Uses = { objects: [], placed: 0, guiTriggers: [], customScripts: [], mapScript: [], unchecked: [] };
  const ids = new Set([id]);
  for (const [label, ext] of Object.entries(OBJECT_KINDS)) {
    const name = `map/${prefix}.${ext}.json`;
    let doc: MapObjects | null;
    // With the Skin file's fields and objects, as the Object Editor shows them.
    try {
      doc = withSkin(await readMapDocStrict<EditFile>(w3, name), await readMapDocStrict<EditFile>(w3, `map/${prefix}Skin.${ext}.json`)) as MapObjects | null;
    } catch { u.unchecked.push(name.slice(4).replace(/\.json$/, "")); continue; }
    for (const o of [...(doc?.custom ?? []), ...(doc?.original ?? [])]) {
      if (idsUsedBy(o as Parameters<typeof idsUsedBy>[0], ids).length) u.objects.push(`${o.id ?? o.base} (${label})`);
    }
  }
  for (const [name, list] of [["war3mapUnits.doo", "units"], ["war3map.doo", "doodads"]] as const) {
    try {
      const doc = await readMapDocStrict<Record<string, { id?: string }[]>>(w3, `map/${name}.json`);
      u.placed += (doc?.[list] ?? []).filter((p) => p.id === id).length;
    } catch { u.unchecked.push(name); }
  }
  for (const file of ["war3map.j", "war3map.lua"]) {
    try {
      const text = await textOrNull(w3, `map/${file}`);
      const lines = text === null ? [] : scriptLines(text, id);
      if (lines.length) u.mapScript.push({ file, lines });
    } catch { u.unchecked.push(file); }
  }
  // The triggers: GUI ones by their parameters' object codes, those in custom script by their text.
  let triggers: TriggerFile | null = null;
  const wtg = wtgPath(w3.workspace.files());
  if (wtg) {
    try {
      triggers = await readWtgFile(w3.workspace, wtg, async () => parseTriggerData(await w3.game.readText("UI\\TriggerData.txt")));
      for (const t of triggerRefs(triggers).get(id) ?? []) u.guiTriggers.push(t);
    } catch { u.unchecked.push("war3map.wtg"); }
  }
  let custom: CustomTextFile | null = null;
  try {
    const text = await textOrNull(w3, WCT_TEXT);
    if (text !== null) custom = parseWctText(text);
    else {
      const bytes = await bytesOrNull(w3, WCT_RAW);
      if (bytes) custom = parseWct(bytes, triggers ? textTriggers(triggers).length : 0);
    }
  } catch { u.unchecked.push("war3map.wct"); }
  if (custom) {
    const names = triggers ? textTriggers(triggers).map((t) => t.name) : [];
    if (custom.header && scriptLines(custom.header, id).length) u.customScripts.push("the map (its header)");
    custom.texts.forEach((t, i) => { if (t && scriptLines(t, id).length) u.customScripts.push(names[i] ?? `trigger ${i}`); });
  }
  return u;
}

export interface ObjectToolDeps {
  /** The game's tables of an object kind (loadKind). */
  loadKind(kind: string): Promise<KindData>;
  /** An object data file without objects, for a kind the project has no file of yet. */
  emptyFile(): Promise<EditFile>;
}

/** Registers the object data tools (see the top of this file). */
export function registerObjectTools(w3: W3Api, ctx: ExtensionContext, deps: ObjectToolDeps) {
  const kindOf = (name: unknown) => {
    const kind = OBJECT_KINDS[String(name)];
    if (!kind) throw new Error(`kind must be one of: ${Object.keys(OBJECT_KINDS).join(", ")}.`);
    return kind;
  };
  const singular = (kind: string) => (Object.entries(OBJECT_KINDS).find(([, k]) => k === kind)?.[0] ?? "object").replace(/s$/, "");
  /** A chapter map's campaign's objects of `kind`; null when the map isn't a chapter (or the campaign has none of it).
   *  Throws when that can't be told or read. */
  const campaignOf = async (kind: string): Promise<Campaign | null> => {
    const c = await campaignObjects(w3, kind);
    if (!c) return null;
    const table = c.wts === null ? null : new StringTable(c.wts);
    return { custom: c.custom as MapObject[], original: c.original as MapObject[], resolve: (v) => table?.resolve(v) ?? v };
  };
  /** A tool's `kind` argument: the tables, what the project has of it, and in a chapter map its campaign's. */
  const toolKind = async (name: unknown) => {
    requireProject(w3);
    const kind = kindOf(name);
    const prefix = objectPrefix(w3);
    const [data, main, skin, resolve, campaign] = await Promise.all([
      deps.loadKind(kind), readMapDocStrict<EditFile>(w3, `map/${prefix}.${kind}.json`), readMapDocStrict<EditFile>(w3, `map/${prefix}Skin.${kind}.json`),
      mapStrings(w3, `map/${prefix}.wts`), prefix === "war3map" ? campaignOf(kind) : Promise.resolve(null),
    ]);
    // With the Skin file's fields (names, art), its values winning, as the World Editor shows them (skin.ts).
    const file: MapObjects = (withSkin(main, skin) as MapObjects | null) ?? {};
    return { kind, data, file, resolve, campaign };
  };
  const inCampaign = (kind: string, id: string, what: string) =>
    `${id} is ${what} of the campaign (war3campaign.${kind}), which every chapter map has. It's changed in the campaign project: open that in W3Proj Studio.`;
  ctx.subscriptions.push(
    w3.mcp.registerTool("list_objects", async ({ kind, scope, filter, limit, tileset, category, trees }) => {
      const { data, file, resolve, campaign } = await toolKind(kind);
      const text = typeof filter === "string" ? filter.toLowerCase() : "";
      const hit = (o: { id: string; name: string; base?: string }) => o.id.toLowerCase().includes(text) || o.name.toLowerCase().includes(text) || data.searchText(o.base ?? o.id).includes(text);
      const wantTileset = tileset === "map" ? (await terrainFacts(w3))?.tileset : typeof tileset === "string" ? tileset : undefined;
      const stored = scope === "game" ? modelPacks(await w3.game.list()) : null;
      const game = () => gameObjectList(data, stripColors, wantTileset, typeof category === "string" ? category : undefined, stored ?? undefined, trees === true);
      const theirs = () => (campaign ? mapObjectList(campaignListed(file, campaign), data, campaign.resolve).map((o) => ({ ...o, campaign: true })) : []);
      return capped<{ id: string; name: string }>((scope === "game" ? game() : [...mapObjectList(file, data, resolve), ...theirs()]).filter(hit), limit, 200);
    }),
    w3.mcp.registerTool("get_object", async ({ kind, id, gameValues }) => {
      const { data, file, resolve, campaign } = await toolKind(kind);
      const own = findIn(file, String(id)), theirs = campaign ? findIn(campaign, String(id)) : null;
      const found = own ?? theirs;
      const base = found?.o.base ?? String(id);
      if (!found && !data.baseIds.includes(base)) throw new Error(`There's no ${String(kind)} object "${String(id)}" in this ${campaign ? "map, its campaign" : "project"} or the game.`);
      // The name the map gives it, else the campaign's, else the game's.
      const name = own && named(own.o) ? objectName(own.o, data, resolve) : theirs ? objectName(theirs.o, data, campaign!.resolve) : objectName(own?.o ?? { base }, data, resolve);
      return {
        id, name, ...(found?.custom ? { base } : {}), custom: !!found?.custom,
        ...(!own && theirs ? { campaign: true } : {}),
        changes: own ? changedFields(own.o, data, resolve) : theirs ? changedFields(theirs.o, data, campaign!.resolve) : [],
        // A game object both change: the campaign's changes under the map's.
        ...(own && theirs ? { campaignChanges: changedFields(theirs.o, data, campaign!.resolve) } : {}),
        ...(gameValues === true ? { gameValues: gameFields(base, data) } : {}),
      };
    }),
  );
  /** One edit of a kind's object data (the project's own: see the top). Files without changes to game objects stay
   *  tidy, as the editor keeps them. `change` gets the chapter map's campaign's objects of the kind (null when it isn't
   *  a chapter; an error when they can't be read, for `change` to fail with where it needs them). */
  const editObjects = async (title: string, kindName: unknown, change: (file: EditFile, kind: string, data: KindData, campaign: Campaign | Error | null) => void | Promise<void>) => {
    const root = requireProject(w3).root;
    const kind = kindOf(kindName);
    const prefix = objectPrefix(w3);
    const path = jsonPathOf(w3, `${prefix}.${kind}`);
    const [data, edits, campaign] = await Promise.all([
      deps.loadKind(kind), w3.services.get<McpEditsService>(MCP_EDITS_SERVICE),
      prefix === "war3map" ? campaignOf(kind).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))) : Promise.resolve(null),
    ]);
    // The Skin file: changed through `read` as text; kept raw, it is read through its codec and can't be changed.
    const paths = w3.workspace.files().map((f) => f.path);
    const skinPath = listedPath(paths, `map/${prefix}Skin.${kind}.json`);
    const rawSkin = rawOnlySkin(paths, kind, prefix);
    const raw = rawSkin ? await readMapDocStrict<EditFile>(w3, skinPath) : null;
    return edits.edit(title, async (read) => {
      // Which file, and the campaign's objects, were the project's then: another one opened meanwhile isn't edited.
      if (w3.workspace.project()?.root !== root) throw new Error("Another project was opened meanwhile; nothing was changed.");
      const text = await read(path);
      const main: EditFile | null = text === null ? null : JSON.parse(text);
      const skinText = rawSkin ? null : await read(skinPath);
      const skin: EditFile | null = rawSkin ? raw : skinText === null ? null : JSON.parse(skinText);
      // The objects as the World Editor shows them, the Skin file's fields in them; split again below (skin.ts).
      const file = mergeSkin(main ? withLists(main) : { ...(await deps.emptyFile()), ...(skin ? { version: skin.version } : {}) }, skin && withLists(skin), { addSkinOnly: true });
      await change(file, kind, data, campaign);
      const split = splitSkin(file, main && withLists(main), skin && withLists(skin), {
        toSkin: (field) => isSkinField(data.fieldById.get(field)),
        skinWritable: skinWritable(file.version, rawSkin ? "raw" : skin ? "json" : "none"),
      });
      const tidy = { ...split.main, original: split.main.original.filter((o) => (o.sets ?? [{ mods: o.mods ?? [] }]).some((s) => s.mods.length)) };
      // Encodes it too: what can't be packed doesn't get written.
      const out = [{ path, text: await w3.backend.invoke<string>("objects_canonicalize", { name: path, text: JSON.stringify(tidy) }) }];
      if (skinChanged(skin && withLists(skin), split.skin)) {
        if (rawSkin) throw new Error(`${prefix}Skin.${kind} is kept raw in this project and holds fields of what was changed, so it can't be changed here. Nothing was changed.`);
        // Written first: a field moving into it is never missing from both files.
        out.unshift({ path: skinPath, text: await w3.backend.invoke<string>("objects_canonicalize", { name: skinPath, text: JSON.stringify(split.skin) }) });
      }
      return out;
    });
  };
  /** Fails, saying why, when `id` is the campaign's and not the map's (the map would change nothing of it). */
  const refuseCampaignOnly = (file: EditFile, kind: string, id: string, campaign: Campaign | Error | null, gameHas: boolean) => {
    if (findIn(file, id) || gameHas || !campaign) return;
    if (campaign instanceof Error) throw new Error(`"${id}" isn't in this map's object data or the game's, and the campaign's can't be read: ${campaign.message}`);
    if (campaign.custom.some((o) => o.id === id)) throw new Error(inCampaign(kind, id, `a custom ${singular(kind)}`));
  };
  ctx.subscriptions.push(
    w3.mcp.registerTool("set_object_fields", async ({ kind, id, changes }) => {
      if (!Array.isArray(changes) || !changes.length) throw new Error("changes must list what to change.");
      const list = changes as { field: string; level?: unknown; value: unknown }[];
      const allowNegative = w3.settings.get<boolean>(NEGATIVE_REALS_SETTING) === true;
      const changed = await editObjects(`Set ${list.length} field${list.length === 1 ? "" : "s"} of ${String(id)}`, kind, (file, ext, data, campaign) => {
        const gameHas = data.baseIds.includes(String(id));
        refuseCampaignOnly(file, ext, String(id), campaign, gameHas);
        const o = objectToEdit(file, String(id), gameHas);
        // A game object the campaign changes: what the map inherits is the campaign's value (a game object only: a
        // custom object of the map replaces the campaign's of that id whole).
        const inherited = !o.id && campaign && !(campaign instanceof Error) ? campaign.original.find((c) => c.base === o.base) : undefined;
        // Runs on a parsed copy: a throw here leaves the file as it was.
        for (const c of list) {
          const f = data.fieldsFor(o.base).find((x) => x.id === c.field);
          if (!f) throw new Error(`${String(c.field)} isn't a field of ${o.base}. get_object with gameValues lists them.`);
          const at = fieldLevel(f, c.level);
          const fromCampaign = inherited && modsOf(inherited).find((m) => m.field === f.id && (m.level ?? 0) === at);
          const before = fromCampaign ? String(fromCampaign.value) : data.defaultValue(o.base, f, at);
          setObjectField(o, ext, f, at, c.value === null ? null : fieldValue(f, c.value, { allowNegative }), before);
        }
      });
      return changed ? `Changed ${list.length} field${list.length === 1 ? "" : "s"} of ${String(id)}.` : "It already had those values.";
    }),
    w3.mcp.registerTool("create_object", async ({ kind, base, name }) => {
      let made = "";
      const prefix = objectPrefix(w3);
      await editObjects(`Create an object from ${String(base)}`, kind, async (file, ext, data, campaign) => {
        const from = String(base);
        if (!data.baseIds.includes(from)) throw new Error(`There's no game object "${from}" of that kind.`);
        const taken = new Set([...file.custom.map((o) => o.id ?? ""), ...file.original.map((o) => o.base), ...data.baseIds]);
        // Ids should be unique over all kinds: scripts name them without saying which. A chapter map's campaign's
        // custom objects count too: a new one of the same id would replace the campaign's in this map.
        if (campaign instanceof Error) throw new Error(`The campaign's object data can't be read (${campaign.message}), so it isn't known which ids it uses.`);
        for (const o of campaign?.custom ?? []) if (o.id) taken.add(o.id);
        for (const other of Object.values(OBJECT_KINDS).filter((k) => k !== ext)) {
          const known = await readMapDoc<MapObjects>(w3, `map/${prefix}.${other}.json`);
          for (const o of known?.custom ?? []) if (o.id) taken.add(o.id);
          for (const b of (await deps.loadKind(other)).baseIds) taken.add(b);
          if (prefix === "war3map") {
            const theirs = await campaignOf(other).catch((e: unknown) => { throw new Error(`The campaign's object data can't be read (${e instanceof Error ? e.message : String(e)}), so it isn't known which ids it uses.`); });
            for (const o of theirs?.custom ?? []) if (o.id) taken.add(o.id);
          }
        }
        made = nextFreeId(ext, from, taken);
        const o = addCustomObject(file, from, made);
        if (typeof name === "string" && name) {
          const f = data.fieldsFor(from).find((x) => /nam$/.test(x.id) && x.valueType === "string");
          if (f) setObjectField(o, ext, f, f.repeat > 0 ? 1 : 0, name, undefined);
        }
      });
      return { id: made };
    }),
    w3.mcp.registerTool("delete_object", async ({ kind, id }) => {
      const prefix = objectPrefix(w3), root = w3.workspace.project()?.root;
      await editObjects(`Delete object ${String(id)}`, kind, (file, ext, _data, campaign) => {
        if (removeObject(file, String(id))) return;
        if (campaign instanceof Error) throw new Error(`The map has no object or change "${String(id)}", and its campaign's object data can't be read: ${campaign.message}`);
        const theirs = campaign && findIn(campaign, String(id));
        if (theirs) throw new Error(inCampaign(ext, String(id), theirs.custom ? `a custom ${singular(ext)}` : "a game object changed"));
        throw new Error(`The ${prefix === "war3campaign" ? "campaign" : "map"} has no object or change "${String(id)}".`);
      });
      // What still names it, from the files as they are now (the edit is saved); not another project's.
      if (w3.workspace.project()?.root !== root) return `Removed ${String(id)}. Another project was opened since, so what still names it wasn't looked at.`;
      const found = await usesOf(w3, String(id), prefix);
      if (w3.workspace.project()?.root !== root) return `Removed ${String(id)}. Another project was opened since, so what still names it wasn't looked at.`;
      const uses = describeUses(String(id), found);
      const chapters = prefix === "war3campaign" ? " Its chapter maps' own scripts and placed objects weren't looked at: open each to check." : "";
      return `Removed ${String(id)}.${uses ? ` ${uses}` : " Nothing in the project names it."}${chapters} list_problems shows what's left.`;
    }),
  );
}
