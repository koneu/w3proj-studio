import type { ExtensionContext, W3Api, MenuItem } from "../../extensions/api";
import { outside, rangeNote } from "../../lib/objects/limits";
import { keyOf } from "../../lib/keys";
import { constantWarning, GAME_CONSTANT_FILES, MAP_CONSTANTS, readGameplayLimits, type GameplayLimits } from "../../lib/objects/constlimits";
import { OBJECTS_SERVICE, type LiveObjectData } from "../../extensions/services";
import { Listeners } from "../../lib/listeners";
import { h } from "../../workbench/dom";
import { loadKind, nextFreeId, type FieldMeta, type KindData, type ValueType } from "../../lib/objects/metadata";
import { pickBaseObject } from "./picker";
import { campaignObjects, iconLoader, imageLoader, objectsService, soundLabels, stripColors } from "./service";
import { findCampaign } from "../../lib/objects/campaign";
import { toProjectPath } from "../../lib/formats/archivepath";
import { joinPath } from "../../lib/paths";
import { fieldSound, soundSets } from "./browse";
import { pickFile, pickLabel, soundPlayer, type FileKind } from "./filepicker";
import { StringTable, WtsCutError, askWtsCuts, wtsSafeText } from "../../lib/formats/wts";
import { WtsSession, fileIsMissing, findPackedMap, mapFolderGone, isNotFoundError, recreatedMessage, attempt, isDirtyNow, runSave, type WtsSnapshot } from "./wtssession";
import { loadEditorTypes, OBJECT_CODE, OBJECT_LIST, objectEditor, typeEditor, type EditorType, type MixedValues } from "./fields";
import { ModelPreview } from "../../lib/model/preview";
import { capped, mapStrings, readMapDoc, readMapDocStrict, requireProject, terrainFacts } from "../../lib/formats/mapdoc";
import { changedFields, gameFields, gameObjectList, mapObjectList, modelPacks, OBJECT_KINDS, objectName, type MapObjects } from "./objectinfo";
import { exportAllObjectData, exportObjects, importObjectData } from "./w3ofiles";
import { mergeSkin } from "./w3o";
import { answerHolds, signature, summary, summaryTypes, writeInto, mergeObjects, autoFillText, autoFill, addCustomObject, copyOf, fieldLevel, fieldValue, negativeRefused, NEGATIVE_REALS_SETTING, objectToEdit, pastedObject, removeObject, setObjectField, type EditFile, type EditObject } from "./objectedit";
import { jsonPathOf } from "../../lib/formats/mapdoc";
import { referencedBy, type Copied } from "../../lib/objects/copydeps";
import { applyPlan, prepareCopy, settle, settleEditors, viewMap } from "./copyalong";
import { MCP_EDITS_SERVICE, type McpEditsService } from "../../extensions/services";

// Mirrors w3proj::objdata's JSON (format "w3proj.objects/1").
interface Mod { field: string; type: ValueType; level?: number; data?: number; value: number | string; end?: string }
interface ObjSet { flag: number; mods: Mod[] }
interface Obj { base: string; id?: string; end?: string; sets?: ObjSet[]; mods?: Mod[] }
interface ObjectFile { format: string; version: number; original: Obj[]; custom: Obj[] }

/** Copied objects by kind, for the session: they paste into any open map. `along` is what they refer to
 *  in the map they were copied from (its custom abilities and the like), found while the user goes on. */
const clipboard: Record<string, { count: number; ready: Promise<{ objects: Obj[]; along: Copied[] }> }> = {};
/** What the terrain view was told about types, per project and set of types: the answer to the question
 *  and the ids it left in the map. A later paste of the same asks nothing while those are still there. */
const answered = new Map<string, { renames: Map<string, string>; targets: Map<string, string> }>();
/** A field value copied by the field menu: goes into any field of the same type. */
let fieldClip: { type: string; value: number | string } | null = null;

const FORMAT = "w3proj.objects/1";

/** The packed map to point at when war3map.wts had to be recreated (build output, else the newest
 *  checkpoint); null when there is none, or finding it takes more than a moment. */
async function packedMapPath(w3: W3Api): Promise<string | null> {
  const project = w3.workspace.project();
  if (!project) return null;
  const find = async () => {
    const output = project.default_output;
    // Not known whether the build output is there: no map is pointed at rather than perhaps the wrong one.
    const exists = await w3.backend.invoke<boolean>("fs_exists", { path: output }).catch(() => null);
    if (exists === null) return null;
    const newest = exists ? null : await w3.commands.execute<string | null>("w3.checkpoints.newest").catch(() => null);
    return findPackedMap(output, exists, newest);
  };
  return Promise.race([find(), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
}

/** An object data file without objects, in the version of the map's other object data (else
 *  Reforged's). */
async function emptyFile(w3: W3Api): Promise<ObjectFile> {
  const sibling = w3.workspace.files().find((f) => /^map\/war3(map|campaign)\.w3[utabdhq]\.json$/i.test(f.path));
  const version = sibling ? JSON.parse(await w3.workspace.readText(sibling.path)).version ?? 3 : 3;
  return { format: FORMAT, version, original: [], custom: [] };
}
/** Whether the open project is a campaign (it has war3campaign.w3f, as the Campaign Editor decides). */
const isCampaignProject = (w3: W3Api) => w3.workspace.files().some((f) => /^map\/war3campaign\.w3f(\.json)?$/i.test(f.path.replace(/\\/g, "/")));
/** The object data file of a kind the Object Editor edits in the open project: a campaign's own (war3campaign.<kind>,
 *  which every chapter map uses, as the World Editor's Campaign Editor edits it), else the map's (war3map.<kind>). */
const objectDocPath = (w3: W3Api, ext: string) => `map/${isCampaignProject(w3) ? "war3campaign" : "war3map"}.${ext}.json`;
/** The string table of an object data file: a campaign's own texts are in war3campaign.wts. */
const wtsOf = (docPath: string) => (/(^|\/)war3campaign\.w3[utabdhq]\.json$/i.test(docPath.replace(/\\/g, "/")) ? "map/war3campaign.wts" : "map/war3map.wts");
/** Path field types (UnitMetaData & co.) that get a file browser. */
const PATH_KIND: Record<string, FileKind> = { model: "model", modelList: "model", icon: "image", texture: "image" };
const KINDS: { ext: string; label: string; singular: string }[] = [
  { ext: "w3u", label: "Units", singular: "unit" },
  { ext: "w3t", label: "Items", singular: "item" },
  { ext: "w3a", label: "Abilities", singular: "ability" },
  { ext: "w3h", label: "Buffs/Effects", singular: "buff" },
  { ext: "w3b", label: "Destructables", singular: "destructable" },
  { ext: "w3d", label: "Doodads", singular: "doodad" },
  { ext: "w3q", label: "Upgrades", singular: "upgrade" },
];
const KIND_ICONS: Record<string, string> = { w3u: "♞", w3t: "✦", w3a: "✧", w3h: "◌", w3b: "▲", w3d: "♣", w3q: "⇧" };
/** Kinds whose mods carry level and data-pointer fields. */
const OPT_INTS = new Set(["w3a", "w3d", "w3q"]);
/** Icon (art) field per kind. */
const ICON_FIELD: Record<string, string> = { w3u: "uico", w3t: "iico", w3a: "aart", w3h: "fart", w3q: "gar1" };
/** Fields that override the number of levels. */
const LEVEL_FIELD: Record<string, string> = { w3a: "alev", w3q: "glvl" };

function modLists(o: Obj): { label: string; mods: Mod[] }[] {
  if (o.sets) return o.sets.map((s) => ({ label: `Set (flag ${s.flag})`, mods: s.mods }));
  o.mods ??= [];
  return [{ label: "", mods: o.mods }];
}

function parseValue(type: ValueType, text: string, allowNegative: boolean): number | string | null {
  if (type === "string") return text;
  const n = Number(text);
  if (text.trim() === "" || Number.isNaN(n) || (type === "int" && !Number.isInteger(n))) return null;
  if (negativeRefused(type, n, allowNegative)) return null;
  return n;
}

/** Whether Shift is down (updated on every key and mouse press). */
let shiftHeld = false;

export function activate(w3: W3Api, ctx: ExtensionContext) {
  /** A tool's `kind` argument: the tables, and what the map has of it. */
  const toolKind = async (name: unknown) => {
    requireProject(w3);
    const kind = OBJECT_KINDS[String(name)];
    if (!kind) throw new Error(`kind must be one of: ${Object.keys(OBJECT_KINDS).join(", ")}.`);
    const [data, file, resolve] = await Promise.all([loadKind(w3, kind), readMapDoc<MapObjects>(w3, `map/war3map.${kind}.json`), mapStrings(w3)]);
    return { data, file: file ?? {}, resolve };
  };
  ctx.subscriptions.push(
    w3.mcp.registerTool("list_objects", async ({ kind, scope, filter, limit, tileset, category, trees }) => {
      const { data, file, resolve } = await toolKind(kind);
      const text = typeof filter === "string" ? filter.toLowerCase() : "";
      const hit = (o: { id: string; name: string; base?: string }) => o.id.toLowerCase().includes(text) || o.name.toLowerCase().includes(text) || data.searchText(o.base ?? o.id).includes(text);
      const wantTileset = tileset === "map" ? (await terrainFacts(w3))?.tileset : typeof tileset === "string" ? tileset : undefined;
      const stored = scope === "game" ? modelPacks(await w3.game.list()) : null;
      const game = () => gameObjectList(data, stripColors, wantTileset, typeof category === "string" ? category : undefined, stored ?? undefined, trees === true);
      return capped<{ id: string; name: string }>((scope === "game" ? game() : mapObjectList(file, data, resolve)).filter(hit), limit, 200);
    }),
    w3.mcp.registerTool("get_object", async ({ kind, id, gameValues }) => {
      const { data, file, resolve } = await toolKind(kind);
      const custom = file.custom?.find((o) => o.id === id);
      const changed = custom ?? file.original?.find((o) => o.base === id);
      const base = changed?.base ?? String(id);
      if (!changed && !data.baseIds.includes(base)) throw new Error(`There's no ${String(kind)} object "${String(id)}" in this map or the game.`);
      return {
        id, name: objectName(changed ?? { base }, data, resolve), ...(custom ? { base } : {}), custom: !!custom,
        changes: changed ? changedFields(changed, data, resolve) : [],
        ...(gameValues === true ? { gameValues: gameFields(base, data) } : {}),
      };
    }),
  );
  /** One edit of a kind's object data. Files without changes to game objects stay tidy, as the editor keeps them. */
  const editObjects = async (title: string, kindName: unknown, change: (file: EditFile, kind: string, data: KindData) => void | Promise<void>) => {
    requireProject(w3);
    const kind = OBJECT_KINDS[String(kindName)];
    if (!kind) throw new Error(`kind must be one of: ${Object.keys(OBJECT_KINDS).join(", ")}.`);
    const path = jsonPathOf(w3, `war3map.${kind}`);
    const [data, edits] = await Promise.all([loadKind(w3, kind), w3.services.get<McpEditsService>(MCP_EDITS_SERVICE)]);
    return edits.edit(title, async (read) => {
      const text = await read(path);
      const file: EditFile = text === null ? await emptyFile(w3) as EditFile : JSON.parse(text);
      await change(file, kind, data);
      const tidy = { ...file, original: file.original.filter((o) => (o.sets ?? [{ mods: o.mods ?? [] }]).some((s) => s.mods.length)) };
      // Encodes it too: what can't be packed doesn't get written.
      return [{ path, text: await w3.backend.invoke<string>("objects_canonicalize", { name: path, text: JSON.stringify(tidy) }) }];
    });
  };
  ctx.subscriptions.push(
    w3.mcp.registerTool("set_object_fields", async ({ kind, id, changes }) => {
      if (!Array.isArray(changes) || !changes.length) throw new Error("changes must list what to change.");
      const list = changes as { field: string; level?: unknown; value: unknown }[];
      const allowNegative = w3.settings.get<boolean>(NEGATIVE_REALS_SETTING) === true;
      const changed = await editObjects(`Set ${list.length} field${list.length === 1 ? "" : "s"} of ${String(id)}`, kind, (file, ext, data) => {
        const o = objectToEdit(file, String(id), data.baseIds.includes(String(id)));
        // Runs on a parsed copy: a throw here leaves the file as it was.
        for (const c of list) {
          const f = data.fieldsFor(o.base).find((x) => x.id === c.field);
          if (!f) throw new Error(`${String(c.field)} isn't a field of ${o.base}. get_object with gameValues lists them.`);
          const at = fieldLevel(f, c.level);
          setObjectField(o, ext, f, at, c.value === null ? null : fieldValue(f, c.value, { allowNegative }), data.defaultValue(o.base, f, at));
        }
      });
      return changed ? `Changed ${list.length} field${list.length === 1 ? "" : "s"} of ${String(id)}.` : "It already had those values.";
    }),
    w3.mcp.registerTool("create_object", async ({ kind, base, name }) => {
      let made = "";
      await editObjects(`Create an object from ${String(base)}`, kind, async (file, ext, data) => {
        const from = String(base);
        if (!data.baseIds.includes(from)) throw new Error(`There's no game object "${from}" of that kind.`);
        const taken = new Set([...file.custom.map((o) => o.id ?? ""), ...file.original.map((o) => o.base), ...data.baseIds]);
        // Ids should be unique over all kinds: scripts name them without saying which.
        for (const other of Object.values(OBJECT_KINDS).filter((k) => k !== ext)) {
          const known = await readMapDoc<MapObjects>(w3, `map/war3map.${other}.json`);
          for (const o of known?.custom ?? []) if (o.id) taken.add(o.id);
          for (const b of (await loadKind(w3, other)).baseIds) taken.add(b);
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
      await editObjects(`Delete object ${String(id)}`, kind, (file) => {
        if (!removeObject(file, String(id))) throw new Error(`The map has no object or change "${String(id)}".`);
      });
      return `Removed ${String(id)}. Anything placed or using it isn't changed: list_problems shows what's left.`;
    }),
  );
  const icons = iconLoader(w3);
  // Shift held while a new object's base is confirmed: ask for its id.
  const trackShift = (e: KeyboardEvent | MouseEvent) => { shiftHeld = e.shiftKey; };
  for (const t of ["keydown", "keyup", "mousedown"] as const) window.addEventListener(t, trackShift, true);
  ctx.subscriptions.push({ dispose: () => { for (const t of ["keydown", "keyup", "mousedown"] as const) window.removeEventListener(t, trackShift, true); } });
  const images = imageLoader(w3);
  /** Open editors by document path: their kind and object data as they hold it now (ObjectsService.liveObjects). */
  const liveData = new Map<string, { kind: string; data(): LiveObjectData }>();
  /** ObjectsService.onDidEdit's listeners. */
  const edits = new Listeners<string>();
  const objects = objectsService(w3, {
    liveObjects: () => new Map([...liveData.values()].map((l) => [l.kind, l.data()])),
    onDidEdit: (listener) => edits.add(listener),
    async typesFor(ids: readonly string[], root?: string) {
      const view = await viewMap(w3, undefined, root);
      const seeds = [...new Set(ids)].flatMap((id) => view.customs.get(id) ?? []);
      return [...seeds, ...referencedBy(seeds, view.customs, view.holdsIds)];
    },
    async bringTypes(types: readonly Copied[], label: string) {
      if (!types.length) return new Map<string, string>();
      const root = w3.workspace.project()?.root ?? "";
      const key = `${root}\n${JSON.stringify(types)}`;
      const before = answered.get(key);
      // Unsaved object data isn't what the check would read: no shortcut then, the paste settles it.
      const unsavedData = w3.editors.unsavedPaths().some((p) => /^map\/war3map(Skin)?\.w3[utbdahq]\.json$/i.test(p));
      if (before && !unsavedData) {
        // Asked about this already: the answer holds while what it left in the map is there as it was (an undo takes it away, an edit changes it).
        const view = await viewMap(w3);
        if (answerHolds(before.targets, (id) => view.customs.get(id)?.object)) return new Map(before.renames);
        answered.delete(key);
      } else if (before) answered.delete(key);
      if (!(await settleEditors(w3))) return null;
      const settled = await settle(w3, { chosen: [], along: [...types] }, label, undefined, false);
      if (!settled) return null;
      const plan = settled.plan;
      const remember = async () => {
        const view = await viewMap(w3);
        if (answered.size >= 20) answered.delete(answered.keys().next().value as string);
        const targets = new Map<string, string>();
        for (const i of plan.items) if (i.to && i.fate !== "chosen") targets.set(i.to, signature(view.customs.get(i.to)?.object));
        answered.set(key, { renames: new Map(plan.renames), targets });
      };
      if (plan.writes.length) {
        const title = `Add ${plan.writes.length} object${plan.writes.length === 1 ? "" : "s"} for ${label}`;
        if (!(await applyPlan(w3, plan, title, async () => emptyFile(w3) as Promise<EditFile>))) return null;
        await remember();
        void w3.window.showInfo(summaryTypes(plan), "Undo").then((a) => { if (a === "Undo") void w3.commands.execute("w3.mcp.undo").catch((e) => w3.window.showError(String(e))); });
      }
      if (!plan.writes.length) await remember();
      return plan.renames;
    },
  });
  /** Open editors by document path: show an object (filter the list to it and select it). */
  const focusers = new Map<string, (id: string) => void>();
  /** Object to show once an editor that is being opened has loaded. */
  let pendingFocus: { path: string; id: string } | null = null;
  /** Open editors by document path: rename and remove an object as the editor does (its undo step, its question). */
  const actors = new Map<string, { rename(id: string, name: string): void; remove(id: string): Promise<boolean>; resetAll(): Promise<boolean> }>();

  ctx.subscriptions.push(
    w3.services.provide(OBJECTS_SERVICE, objects),
    w3.views.register("w3.objects.kinds", {
      render(el) {
        if (!w3.workspace.project()) {
          el.append(h("div.view-empty", {}, "Open or import a project to edit its objects."));
          return;
        }
        const list = h("div.tree");
        el.append(list);
        const files = new Map(w3.workspace.files().map((f) => [f.path.toLowerCase(), f.path]));
        if (isCampaignProject(w3)) list.append(h("div.muted.obj-kinds-note", {}, "The campaign's object data: every chapter map has these objects."));
        for (const k of KINDS) {
          const wanted = objectDocPath(w3, k.ext);
          const path = files.get(wanted.toLowerCase());
          const counts = h("small.muted", {}, path ? "…" : "none yet");
          list.append(h("div.tree-row.obj-kind", { title: path ?? `Creates ${wanted}`, onclick: () => w3.commands.execute("w3.objectEditor.open", k.ext).catch((e) => w3.window.showError(String(e))) },
            h("span.tree-icon", {}, KIND_ICONS[k.ext]),
            h("span.tree-label", {}, k.label),
            counts));
          if (path) {
            // A file that is not valid JSON is "unreadable" too: the parse is inside the handler that says so.
            w3.workspace.readText(path).then((t) => {
              const j: ObjectFile = JSON.parse(t);
              counts.textContent = `${j.custom.length} custom · ${j.original.length} modified`;
            }).catch((e) => { counts.textContent = "unreadable"; counts.title = String(e instanceof Error ? e.message : e); });
          }
        }
      },
    }),
    w3.workspace.onDidChange(() => w3.views.refresh("w3.objects.kinds")),

    w3.commands.register("w3.objects.exportAll", () => exportAllObjectData(w3)),
    w3.commands.register("w3.objects.importAll", () => importObjectData(w3)),
    // `focusId` (optional) shows that object, e.g. when coming from the terrain view.
    w3.commands.register("w3.objectEditor.open", async (ext?: string, focusId?: string) => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      ext ??= (await w3.window.quickPick(KINDS.map((k) => ({ label: k.label, description: objectDocPath(w3, k.ext).slice(4, -5), value: k.ext })), { placeholder: "Which object data?" }))?.value;
      if (!ext) return;
      // A kind the map (or campaign) has no file for opens empty; the file is created on the first save.
      const path = objectDocPath(w3, ext);
      const open = w3.workspace.files().find((f) => f.path.toLowerCase() === path.toLowerCase())?.path ?? path;
      if (focusId) pendingFocus = { path: open, id: focusId };
      await w3.editors.open(open, "w3.objectEditor");
      // Already open: the editor didn't load again, so show the object now.
      if (focusId && focusers.has(open)) {
        pendingFocus = null;
        focusers.get(open)!(focusId);
      }
    }),

    // Rename or delete an object from elsewhere (the Object Manager): the editor opens at it and does it as it does by
    // hand, as an unsaved change with its undo step (delete asks first). True when it was done.
    w3.commands.register("w3.objectEditor.objectAction", async (ext: unknown, id: unknown, action: unknown, name?: unknown) => {
      if (typeof ext !== "string" || typeof id !== "string" || (action !== "rename" && action !== "delete")) throw new Error("w3.objectEditor.objectAction takes a kind, an id and \"rename\" or \"delete\".");
      if (action === "rename" && (typeof name !== "string" || !name.trim())) throw new Error("Renaming needs a name.");
      await w3.commands.execute("w3.objectEditor.open", ext, id);
      const path = [...actors.keys()].find((p) => p.toLowerCase() === objectDocPath(w3, ext).toLowerCase());
      const actor = path ? actors.get(path) : undefined;
      if (!actor) throw new Error(`The Object Editor for ${ext} didn't open.`);
      if (action === "delete") return actor.remove(id);
      actor.rename(id, (name as string).trim());
      return true;
    }),
    // A chapter map's campaign object, edited where the World Editor edits it: in the campaign. Opens the campaign project
    // (which asks about this map's unsaved changes) and its Object Editor at the object. True when it got there.
    w3.commands.register("w3.objectEditor.openInCampaign", async (ext: unknown, id: unknown) => {
      if (typeof ext !== "string" || !KINDS.some((k) => k.ext === ext) || typeof id !== "string") throw new Error("w3.objectEditor.openInCampaign takes a kind (w3u, …) and an object id.");
      const campaign = await findCampaign(w3);
      if (!campaign) throw new Error("This map isn't a chapter of a campaign project.");
      const same = (a: string | undefined) => (a ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === campaign.replace(/\/+$/, "").toLowerCase();
      await w3.commands.execute("w3.project.open", campaign);
      // Not opened (unsaved changes kept, or it failed): nothing more.
      if (!same(w3.workspace.project()?.root)) return false;
      await w3.commands.execute("w3.objectEditor.open", ext, id);
      return true;
    }),
    // Reset Standard Objects To Defaults (the World Editor's File menu): of the open Object Editor's kind, `ext` for another
    // (else asked when none is open). Asks first; one undo step in that editor, saved with it. True when done.
    w3.commands.register("w3.objectEditor.resetAllStandard", async (ext?: unknown) => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      const active = w3.editors.activePath();
      let kindExt = typeof ext === "string" ? ext.toLowerCase() : active && actors.has(active) ? active.replace(/\.json$/i, "").split(".").pop()!.toLowerCase() : undefined;
      kindExt ??= (await w3.window.quickPick(KINDS.map((k) => ({ label: `Reset Standard ${k.label} to Defaults`, description: objectDocPath(w3, k.ext).slice(4, -5), value: k.ext })), { placeholder: "Which object data?" }))?.value;
      if (!kindExt) return false;
      if (!KINDS.some((k) => k.ext === kindExt)) throw new Error(`No object data kind ${kindExt}.`);
      await w3.commands.execute("w3.objectEditor.open", kindExt);
      const path = [...actors.keys()].find((p) => p.toLowerCase() === objectDocPath(w3, kindExt!).toLowerCase());
      if (!path) throw new Error(`The Object Editor for ${kindExt} didn't open.`);
      return actors.get(path)!.resetAll();
    }),
    w3.editors.registerProvider("w3.objectEditor", {
      async resolve(el, doc) {
        const exists = () => w3.workspace.files().some((f) => f.path.toLowerCase() === doc.path.toLowerCase());
        const isNew = !exists();
        const file: ObjectFile = isNew ? await emptyFile(w3) : JSON.parse(await doc.readText());
        if (file.format !== FORMAT) throw new Error(`unsupported format ${file.format}`);
        const kind = doc.path.replace(/\.json$/, "").split(".").pop()!.toLowerCase();
        const kindInfo = KINDS.find((k) => k.ext === kind);
        const optInts = OPT_INTS.has(kind);

        // The map's string table: TRIGSTR_n values show (and edit) their text in war3map.wts (a campaign's own object
        // data: war3campaign.wts).
        const WTS = wtsOf(doc.path), wtsName = WTS.slice(4);
        const wtsText = await w3.workspace.readText(WTS).catch(() => null);
        const wts = new WtsSession(wtsText ?? "");
        const hasWts = wtsText !== null;
        const trigRef = (v: unknown) => {
          const n = typeof v === "string" ? StringTable.ref(v) : null;
          return n !== null && wts.table.has(n) ? n : null;
        };
        const resolveStr = (v: unknown) => { const n = trigRef(v); return n === null ? null : wts.table.get(n)!; };

        // Game knowledge; until it loads (or without a game install) the
        // editor shows only the modifications, with raw ids.
        let kd: KindData | null = null;
        /** UnitEditorData's value types (choices, lists, flags); plain text until loaded. */
        let editorTypes: Map<string, EditorType> | null = null;
        const baseName = (o: Obj) => kd?.names.get(o.base) ?? "";
        const nameOf = (o: Obj) => {
          for (const { mods } of modLists(o)) {
            const m = mods.find((m) => /nam$/.test(m.field) && m.type === "string");
            if (m) return stripColors(resolveStr(m.value) ?? String(m.value));
          }
          return stripColors(baseName(o));
        };
        // A chapter map's campaign's objects of this kind: the chapter has them too, but they're edited in the campaign
        // (as the World Editor's Campaign Editor does), so they're listed here to look at only. One that can't be read
        // says so; its ids then aren't known to be free, and no new ids are given out.
        const openedRoot = w3.workspace.project()?.root;
        let campaign: Awaited<ReturnType<typeof campaignObjects>> = null;
        let campaignError: string | null = null;
        if (!/war3campaign\./i.test(doc.path) && doc.path.toLowerCase().startsWith("map/")) {
          try { campaign = await campaignObjects(w3, kind, openedRoot); } catch (e) { campaignError = e instanceof Error ? e.message : String(e); }
        }
        const campaignStrings = new StringTable(campaign?.wts ?? "");
        const campaignStr = (v: unknown) => { const n = typeof v === "string" ? StringTable.ref(v) : null; return n !== null && campaignStrings.has(n) ? campaignStrings.get(n)! : null; };
        /** The campaign's objects the list shows: its custom ones the map doesn't have itself (the map's own wins), and
         *  the game objects it changes. */
        const campaignListed = (): Obj[] => {
          if (!campaign) return [];
          const own = new Set(file.custom.map((o) => o.id));
          return [...(campaign.custom as Obj[]).filter((o) => o.id && !own.has(o.id)), ...(campaign.original as Obj[])];
        };
        const campaignName = (o: Obj) => {
          for (const { mods } of modLists(o)) {
            const m = mods.find((m) => /nam$/.test(m.field) && m.type === "string");
            if (m) return stripColors(campaignStr(m.value) ?? String(m.value));
          }
          return stripColors(baseName(o));
        };
        /** The campaign object shown (read-only); the map's selection is empty meanwhile. */
        let campaignShown: Obj | null = null;
        /** The object data as it is here now, for other modules (ObjectsService.liveObjects). */
        const liveNow = (): LiveObjectData => ({
          custom: file.custom, original: file.original,
          names: new Map(file.custom.flatMap((o): [string, string][] => { const n = o.id ? nameOf(o) : ""; return n ? [[o.id!, n]] : []; })),
        });

        /** The anchor (single selection, Shift+click range start). */
        let selected: Obj | null = file.custom[0] ?? file.original[0] ?? null;
        /** All selected objects; Ctrl+click toggles, Shift+click selects a range. */
        let selection = new Set<Obj>(selected ? [selected] : []);
        const select = (o: Obj | null) => {
          selected = o;
          selection = new Set(o ? [o] : []);
          campaignShown = null;
        };
        /** Objects in list order (for Shift ranges and ordered multi views). */
        let visible: Obj[] = [];
        let filter = "";
        let fieldFilter = "";
        let modifiedOnly = false;
        let outsideOnly = false;
        /** Folded multi-selection blocks ("same" / "different"); kept across re-renders. */
        const foldedBlocks = new Set<string>();
        // What would be written: standard objects without modifications are
        // left out, so adding one and removing it again is not a change.
        const serialize = () => JSON.stringify({ ...file, original: file.original.filter(hasMods) });
        let saved = "";
        // Undo/redo: every change ends in markDirty, which records the whole file (snapshots;
        // object data files are small). Restoring maps the selection back by id.
        const snapshot = () => JSON.stringify({ custom: file.custom, original: file.original, wts: wts.snapshot() });
        const history = [snapshot()];
        let at = 0;
        /** Other modules hear of each edit, undo and redo here (ObjectsService.onDidEdit). */
        const told = () => { if (liveData.get(doc.path)?.data === liveNow) edits.fire(kind); };
        const record = () => {
          const s = snapshot();
          if (s === history[at]) return;
          history.splice(at + 1, history.length, s);
          if (history.length > 200) history.shift();
          at = history.length - 1;
          told();
        };
        /** Records the change (undo) and re-evaluates the dirty state against the last saved content. */
        const isDirty = () => isDirtyNow(serialize(), saved, hasWts && wts.dirty);
        const markDirty = () => { record(); doc.setDirty(isDirty()); };
        const objectKey = (o: Obj) => (o.id ? `c:${o.id}` : `o:${o.base}`);
        const restore = (s: string) => {
          const keys = new Set([...selection].map(objectKey)), anchor = selected ? objectKey(selected) : null;
          const d = JSON.parse(s) as { custom: Obj[]; original: Obj[]; wts: WtsSnapshot };
          file.custom = d.custom;
          file.original = d.original;
          if (hasWts) wts.restore(d.wts);
          const all = [...file.custom, ...file.original];
          selection = new Set(all.filter((o) => keys.has(objectKey(o))));
          selected = all.find((o) => objectKey(o) === anchor) ?? [...selection][0] ?? all[0] ?? null;
          if (selected) selection.add(selected);
          doc.setDirty(isDirty());
          renderDetail();
          told();
        };
        const step = (dir: -1 | 1) => {
          const to = at + dir;
          if (to < 0 || to >= history.length) return;
          at = to;
          restore(history[at]);
        };

        /** Set when this editor is closed: a paste that was asking something doesn't go on into it. */
        let closed = false;
        /** The Gameplay Constants that limit fields (map first, else the game's); empty until read, and while the
         *  map's file can't be read (it may set any of them). */
        let gameplayLimits: GameplayLimits = {};
        let limitsRead = 0;
        const loadLimits = async () => {
          const seq = ++limitsRead;
          const listed = w3.workspace.files().some((f) => f.path.toLowerCase() === MAP_CONSTANTS.toLowerCase());
          // A file that is there but can't be read isn't "no overrides": the game's defaults could be wrong for it.
          const map = listed ? await w3.workspace.readText(MAP_CONSTANTS).then((t) => ({ text: t }), () => null) : { text: null };
          const game = await Promise.all(GAME_CONSTANT_FILES.map((p) => w3.game.readText(p).catch(() => "")));
          if (closed || seq !== limitsRead) return;
          const next = map ? readGameplayLimits(map.text, game) : {};
          if (JSON.stringify(next) === JSON.stringify(gameplayLimits)) return;
          gameplayLimits = next;
          renderDetail();
        };
        const listEl = h("div.obj-list");
        // Created once and re-attached on every render, so typing keeps focus
        // and caret (a fresh input per render lost both after each key).
        const fieldSearch = h("input.obj-field-search", { placeholder: "Filter fields…" });
        fieldSearch.addEventListener("input", () => { fieldFilter = fieldSearch.value; renderDetail(); });
        const detailEl = h("div.obj-detail", { tabindex: -1 });
        const status = h("div.obj-status");
        const search = h("input.obj-search", { placeholder: "Filter by id or name…", oninput: () => { filter = search.value.toLowerCase(); renderList(); } });

        /** Icon of an object: its own art field if modified, else the base object's. */
        const itemIcon = (o: Obj) => {
          const img = h("img.obj-icon", { alt: "" });
          if (kd) {
            const own = modLists(o).flatMap((l) => l.mods).find((m) => m.field === ICON_FIELD[kind] && typeof m.value === "string")?.value as string | undefined;
            void icons(kd, kind, o.id ?? o.base, o.base, own).then((src) => { if (src) img.src = src; else img.classList.add("none"); });
          } else img.classList.add("none");
          return img;
        };

        /** The list's order: as in the file, or by name. */
        let sortByName = false;
        const inOrder = (objs: Obj[]) => (sortByName ? [...objs].sort((a, b) => nameOf(a).localeCompare(nameOf(b))) : objs);
        const renderList = () => {
          const group = (title: string, objs: Obj[], action?: HTMLElement) => {
            const items = inOrder(objs).filter((o) => !filter || `${o.base} ${o.id ?? ""} ${nameOf(o)} ${kd?.searchText(o.base) ?? ""}`.toLowerCase().includes(filter));
            return [
              h("div.obj-group", {}, h("span", {}, `${title} (${items.length})`), action ?? null),
              ...items.map((o) =>
                h(`div.obj-item${selection.has(o) ? ".selected" : ""}`, { onclick: (e: MouseEvent) => clickItem(o, e), oncontextmenu: (e: MouseEvent) => itemMenu(o, e) },
                  ICON_FIELD[kind] ? itemIcon(o) : null,
                  h("code", {}, o.id ? `${o.id}` : o.base),
                  o.id ? h("small", { title: stripColors(baseName(o)) }, `← ${o.base}`) : null,
                  h("span", {}, nameOf(o)),
                ),
              ),
            ];
          };
          const matchesFilter = (o: Obj) => !filter || `${o.base} ${o.id ?? ""} ${nameOf(o)} ${kd?.searchText(o.base) ?? ""}`.toLowerCase().includes(filter);
          // With a filter, only the listed entries are cleaned up.
          const unchanged = file.original.filter((o) => !hasMods(o) && matchesFilter(o)).length;
          const cleanUp = unchanged
            ? h("button.link-inline", {
              title: filter ? "Remove the listed standard objects that have no modified fields" : "Remove standard objects that have no modified fields",
              onclick: () => cleanUpStandard(matchesFilter),
            }, `Clean up (${unchanged})`)
            : undefined;
          visible = [...inOrder(file.custom), ...inOrder(file.original)].filter(matchesFilter);
          listEl.replaceChildren(...group("Custom", file.custom), ...group("Modified standard", file.original, cleanUp), ...campaignGroup());
        };
        /** A chapter map's campaign's objects: shown to look at, edited in the campaign. */
        const campaignGroup = (): HTMLElement[] => {
          if (campaignError) return [h("div.obj-group.obj-campaign-error", { title: campaignError }, h("span", {}, "Campaign: its object data can't be read"))];
          if (!campaign) return [];
          const sorted = sortByName ? [...campaignListed()].sort((a, b) => campaignName(a).localeCompare(campaignName(b))) : campaignListed();
          const items = sorted.filter((o) => !filter || `${o.base} ${o.id ?? ""} ${campaignName(o)} ${kd?.searchText(o.base) ?? ""}`.toLowerCase().includes(filter));
          return [
            h("div.obj-group", { title: `The campaign's ${kindInfo?.label.toLowerCase() ?? "objects"} (war3campaign.${kind}): this map has them too. They're edited in the campaign.` },
              h("span", {}, `Campaign (${items.length})`)),
            ...items.map((o) => h(`div.obj-item.obj-campaign${campaignShown === o ? ".selected" : ""}`, {
              title: o.id ? "A custom object of the campaign" : "A game object the campaign changes",
              onclick: () => { select(null); campaignShown = o; renderDetail(); },
            },
            ICON_FIELD[kind] ? itemIcon(o) : null,
            h("code", {}, o.id ?? o.base),
            o.id ? h("small", { title: stripColors(baseName(o)) }, `← ${o.base}`) : null,
            h("span", {}, campaignName(o)),
            h("span.badge", {}, "campaign"))),
          ];
        };

        const clickItem = (o: Obj, e: MouseEvent) => {
          if (e.shiftKey && selected && visible.includes(selected)) {
            const [a, b] = [visible.indexOf(selected), visible.indexOf(o)].sort((x, y) => x - y);
            selection = new Set(visible.slice(a, b + 1));
          } else if (e.ctrlKey || e.metaKey) {
            if (selection.has(o) && selection.size > 1) {
              selection.delete(o);
              if (selected === o) selected = [...selection][0];
            } else {
              selection.add(o);
              selected = o;
            }
          } else {
            select(o);
          }
          renderDetail();
        };

        /** Right click: on an object outside the selection, that object alone. */
        const itemMenu = (o: Obj, e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          if (!selection.has(o)) { select(o); renderDetail(); }
          const many = selection.size > 1;
          w3.window.showContextMenu({ x: e.clientX, y: e.clientY }, [
            ...listMenu(),
            { label: many ? `Copy ${selection.size} objects` : "Copy", shortcut: "Ctrl+C", run: copySelection },
            { label: many ? `Export ${selection.size} objects…` : "Export Object…", run: () => void exportSelection().catch(failed) },
            "-",
            { label: many ? `Remove ${selection.size} objects` : o.id ? "Delete" : "Remove changes", shortcut: "Del", run: () => void removeSelection() },
          ]);
        };
        /** What the list offers anywhere: new objects. */
        const listMenu = (): MenuItem[] => {
          const held = clipboard[kind]?.count ?? 0;
          return [
            { label: "New…", run: () => void newObject() },
            { label: held > 1 ? `Paste ${held} objects` : "Paste", shortcut: "Ctrl+V", disabled: !held, run: () => void paste() },
            "-",
            { label: `Reset Standard ${kindInfo?.label ?? "Objects"} to Defaults…`, disabled: !file.original.length || doc.readOnly, run: () => void resetAllStandard().catch(failed) },
          ];
        };
        listEl.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          w3.window.showContextMenu({ x: e.clientX, y: e.clientY }, listMenu());
        });
        const copySelection = () => {
          const text = (v: string) => { const ref = trigRef(v); return ref === null ? null : wts.table.get(ref) ?? null; };
          const objects = [...selection].map((o) => copyOf(o as EditObject, text) as Obj);
          // The copy is made from the editor as it is now, and finished while the user goes on.
          const live = { ext: kind, file: { version: file.version, custom: structuredClone(file.custom), original: structuredClone(file.original) }, text };
          const ready = prepareCopy(w3, kind, objects, live, w3.workspace.project()?.root) as Promise<{ objects: Obj[]; along: Copied[] }>;
          ready.catch((e) => void w3.window.showError(`Copying: ${(e as Error).message ?? e} Pasting this copy will not work.`));
          clipboard[kind] = { count: objects.length, ready };
        };
        /** New custom objects from what was copied, each with the next free id. What they refer to in
         *  the map they come from (custom abilities, buffs, units they train, …) comes along: see copyalong.ts. */
        const paste = async () => {
          const held = clipboard[kind];
          if (!held?.count) return;
          const root = w3.workspace.project()?.root;
          const here = () => !closed && w3.workspace.project()?.root === root;
          let ready: Awaited<typeof held.ready>;
          try { ready = await held.ready; } catch { return; }
          const { along, objects: copies } = ready;
          const taken = takenIds();
          let made: Obj[] = [];
          if (along.length) {
            const chosen = copies.map((object) => ({ ext: kind, object }));
            const label = chosen.length === 1 ? nameOf(copies[0]) || copies[0].base : `${chosen.length} objects`;
            try {
              // The plan reads every kind's saved data: other editors' unsaved changes are saved first.
              if (!(await settleEditors(w3, doc.path)) || !here()) return;
              const settled = await settle(w3, { chosen, along }, label, { ext: kind, file, text: resolveStr }, true, here);
              if (!settled) return;
              const plan = settled.plan;
              if (plan.writes.some((x) => x.ext !== kind || x.overwrites)) {
                // Other kinds too, or an overwrite (which changes the Skin file): the files change together, as one edit with one undo.
                const done = await applyPlan(w3, plan, `Paste ${label} with what it refers to`, async () => emptyFile(w3) as Promise<EditFile>, here);
                if (done) void w3.window.showInfo(summary(plan), "Undo").then((a) => { if (a === "Undo") void w3.commands.execute("w3.mcp.undo").catch((e) => w3.window.showError(String(e))); });
                return;
              }
              if (!here()) return;
              made = writeInto(file as EditFile, kind, plan).slice(0, chosen.length) as Obj[];
              if (plan.items.some((i) => i.fate !== "chosen")) void w3.window.showInfo(summary(plan));
            } catch (e) { void w3.window.showError(String((e as Error).message ?? e)); return; }
          } else {
            try {
              for (const c of copies) {
                const id = await freeIdFor(c.base, taken);
                taken.add(id);
                made.push(pastedObject(c as EditObject, id, file.version) as Obj);
              }
            } catch (e) { void w3.window.showError(String((e as Error).message ?? e)); return; }
            if (!here()) return;
            file.custom.push(...made);
          }
          selected = made[made.length - 1];
          selection = new Set(made);
          filter = "";
          search.value = "";
          markDirty(); renderDetail();
        };

        /** Removes every selected object after one confirmation. */
        const removeSelection = async () => {
          const objs = [...selection];
          if (!objs.length) return;
          const what = objs.length === 1 ? (objs[0].id || objs[0].base) : `${objs.length} objects`;
          if (!(await w3.window.askDelete(`Remove ${what} and all their modifications?`, "Remove"))) return;
          // What the question named, whatever is selected by now.
          const going = new Set(objs);
          file.custom = file.custom.filter((o) => !going.has(o));
          file.original = file.original.filter((o) => !going.has(o));
          selection = new Set([...selection].filter((o) => !going.has(o)));
          select((selected && !going.has(selected) ? selected : null) ?? file.custom[0] ?? file.original[0] ?? null);
          markDirty(); renderDetail();
        };
        listEl.tabIndex = 0;
        listEl.addEventListener("keydown", (e) => {
          const key = keyOf(e);
          if (key === "Delete") { e.preventDefault(); removeSelection(); }
          else if (key === "a" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); selection = new Set(visible); renderDetail(); }
          else if (key === "c" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); copySelection(); }
          else if (key === "v" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void paste(); }
        });

        const hasMods = (o: Obj) => modLists(o).some((l) => l.mods.length > 0);
        /** Removes standard entries without modifications (those `which` accepts). */
        const cleanUpStandard = (which: (o: Obj) => boolean = () => true) => {
          const keep = file.original.filter((o) => hasMods(o) || !which(o));
          if (keep.length === file.original.length) return;
          file.original = keep;
          for (const o of [...selection]) if (!file.custom.includes(o) && !keep.includes(o)) selection.delete(o);
          if (!selected || !selection.has(selected)) select([...selection][0] ?? file.custom[0] ?? keep[0] ?? null);
          markDirty(); renderDetail();
        };
        /** The World Editor's Reset Standard Objects To Defaults: every change to the game's objects of this kind goes, after
         *  its question, as one undo step. Custom objects stay (they keep pointing at their bases). True when done. */
        const resetAllStandard = async () => {
          if (doc.readOnly) throw new Error("This object data can't be changed here.");
          const changed = file.original.filter(hasMods).length;
          const plural = kindInfo?.label.toLowerCase() ?? "objects";
          if (!file.original.length) { void w3.window.showInfo(`No standard ${plural} are changed in this map.`); return false; }
          const ask = `Are you sure you want to reset all standard ${plural} to the default settings? ${changed} changed in this map lose their changes; Ctrl+Z takes it back.`;
          if (!(await w3.window.confirm(ask, "Reset", 60_000)) || closed) return false;
          const going = new Set(file.original);
          file.original = [];
          selection = new Set([...selection].filter((o) => !going.has(o)));
          select((selected && !going.has(selected) ? selected : null) ?? file.custom[0] ?? null);
          markDirty(); renderDetail();
          return true;
        };

        /** The mod list new modifications go to (the first set). */
        const primaryMods = (o: Obj) => modLists(o)[0].mods;
        const findMod = (o: Obj, field: string, level: number) => {
          for (const { mods } of modLists(o)) {
            const m = mods.find((m) => m.field === field && (m.level ?? 0) === level);
            if (m) return { mods, m };
          }
          return null;
        };
        const levelCount = (o: Obj) => {
          if (!kd) return 1;
          const lf = LEVEL_FIELD[kind];
          const override = lf ? findMod(o, lf, 0)?.m.value : undefined;
          return Math.max(1, Number(override ?? kd.levels(o.base)) || 1);
        };

        /** Current value of a field: the modification, else the inherited one. */
        const effective = (o: Obj, f: FieldMeta, level: number): string => {
          const found = findMod(o, f.id, level);
          return String(found ? found.m.value : (kd!.defaultValue(o.base, f, level) ?? ""));
        };
        /** Sets a field; creates a modification only if it differs from the inherited value. */
        const setValue = (o: Obj, f: FieldMeta, level: number, v: number | string) => {
          const found = findMod(o, f.id, level);
          if (found) { found.m.value = v; return; }
          if (String(v) === String(kd!.defaultValue(o.base, f, level) ?? "")) return;
          const mod: Mod = { field: f.id, type: f.valueType, value: v };
          if (optInts) { mod.level = level; mod.data = f.data; }
          else if (level) mod.level = level;
          primaryMods(o).push(mod);
        };
        const resetValue = (o: Obj, f: FieldMeta, level: number) => {
          const found = findMod(o, f.id, level);
          if (found) found.mods.splice(found.mods.indexOf(found.m), 1);
        };

        /** Icons and textures as a thumbnail; models with a button opening the model viewer. */
        const artPreview = (metaType: string, value: string): HTMLElement | null => {
          const path = value.split(",")[0]?.trim();
          if (!path || path === "_") return null;
          if (metaType === "icon" || metaType === "texture") {
            const img = h("img.obj-art-thumb", { alt: "", title: path });
            void images(/\.\w+$/.test(path) ? path : `${path}.blp`).then((src) => { if (src) img.src = src; else img.remove(); });
            return img;
          }
          if (metaType === "model" || metaType === "modelList") {
            // Data names .mdl; the game stores .mdx. The map's imports come first.
            const mdx = path.replace(/\.mdl$/i, ".mdx").replace(/^(?!.*\.\w+$)(.*)$/, "$1.mdx");
            return h("button.obj-art-view", { title: `Open ${mdx} in the model viewer`, onclick: async () => {
              const imported = `map/${toProjectPath(mdx)}`;
              const has = w3.workspace.files().some((f) => f.path.replace(/\\/g, "/").toLowerCase() === imported.toLowerCase());
              await w3.editors.open(has ? imported : `game:${mdx}`).catch((e) => w3.window.showError(String(e)));
            } }, "View");
          }
          return null;
        };
        /** "Browse…" for path fields: a file from the map's imports or the game. List fields
         *  (modelList) get the file added to the list. */
        const browseButton = (metaType: string, value: string, onCommit: (v: number | string) => void): HTMLElement | null => {
          const kind: FileKind | undefined = PATH_KIND[metaType];
          if (!kind) return null;
          const list = metaType.endsWith("List");
          return h("button.obj-art-view", {
            title: list ? "Add a file to the list" : "Choose a file from the map's imports or the game",
            onclick: async () => {
              const path = await pickFile(w3, el, { title: list ? "Add a model" : kind === "model" ? "Choose a model" : "Choose an image", kind, current: value, thumb: images });
              if (path === null) return;
              const rest = value.split(",").map((x) => x.trim()).filter((x) => x && x !== "_");
              onCommit(list && rest.length ? [...rest, path].join(",") : path);
            },
          }, "Browse…");
        };
        /** A sound label from the game's tables. */
        const labelButton = (metaType: string, value: string, onCommit: (v: number | string) => void): HTMLElement | null => (metaType !== "soundLabel" && metaType !== "unitSound" ? null
          : h("button.obj-art-view", { title: metaType === "unitSound" ? "Choose one of the game's unit sound sets" : "Choose one of the game's sound labels", onclick: async () => {
            const sets = metaType === "unitSound";
            const label = await pickLabel(w3, el, {
              title: sets ? "Choose a unit sound set" : "Choose a sound label", current: value,
              labels: async () => (sets ? soundSets(await soundLabels(w3)) : soundLabels(w3)),
              playAs: async (entry) => fieldSound(metaType, entry, await soundLabels(w3)),
            });
            if (label !== null) onCommit(label);
          } }, "Choose…"));
        /** ▶ beside a sound field, to hear what it's set to without opening anything. */
        const sounds = soundPlayer(w3);
        const playButton = (metaType: string, value: string): HTMLElement | null => (!["soundLabel", "unitSound", "combatSound"].includes(metaType) ? null
          : h("button.obj-art-view", { title: "Play this sound", onclick: async () => {
            const label = fieldSound(metaType, value, await soundLabels(w3));
            if (!label) { void w3.window.showInfo("This field has no sound to play."); return; }
            await sounds.play(label).catch((e) => w3.window.showWarning(String((e as Error).message ?? e)));
          } }, "▶"));
        /** Editor for one field value. `mixed`: the differing values of a multi-selection, and
         *  how to change each object's own one (flags and lists tick per object). */
        const valueEditor = (type: ValueType, metaType: string, current: number | string, inherited: boolean, onCommit: (v: number | string) => void, mixed?: string[], each?: MixedValues["each"]) => {
          if (metaType === "bool") {
            const box = h("input", { type: "checkbox", checked: !mixed && Number(current) === 1, onchange: () => onCommit(box.checked ? 1 : 0) });
            if (mixed) box.indeterminate = true;
            return h("label.obj-bool", {}, box, h("span.muted", {}, mixed ? "mixed" : inherited ? "inherited" : ""));
          }
          // A string kept in war3map.wts: the text itself is edited (shared by everything using it).
          const ref = mixed || type !== "string" ? null : trigRef(current);
          if (ref !== null) {
            const text = wts.table.get(ref) ?? "";
            const input = h(`input.obj-value${inherited ? ".inherited" : ""}`, {
              value: text, title: `Text of TRIGSTR_${ref} in ${wtsName} (every use of this string changes)`,
              onchange: () => { wts.set(ref, input.value); markDirty(); renderDetail(); },
            });
            return h("div.obj-value-cell", {}, input, h("div.obj-resolved", {}, h("code", {}, `TRIGSTR_${ref}`), " · map string"));
          }
          // Object codes and lists of them: the object browser; the value types of UnitEditorData:
          // a choice, a list or flags.
          if (OBJECT_CODE[metaType] || OBJECT_LIST[metaType]) {
            return objectEditor(objects, el, OBJECT_CODE[metaType] ?? OBJECT_LIST[metaType], !!OBJECT_LIST[metaType], mixed ? "" : current, onCommit, !!mixed);
          }
          const et = editorTypes?.get(metaType);
          if (et) {
            const editor = typeEditor(et, mixed ? "" : current, type !== "string", onCommit, mixed && each ? { values: mixed, each } : undefined);
            const play = mixed ? null : playButton(metaType, String(current));
            return play ? h("div.obj-sound-cell", {}, editor, play) : editor;
          }
          const resolved = mixed ? null : resolveStr(current);
          const shown = mixed && [...new Set(mixed)].map((v) => stripColors(resolveStr(v) ?? v) || "(empty)");
          const input = h(`input.obj-value${inherited ? ".inherited" : ""}${mixed ? ".mixed" : ""}`, {
            value: mixed ? "" : String(current),
            placeholder: shown ? `mixed: ${shown.slice(0, 4).join(" / ")}${shown.length > 4 ? " / …" : ""}` : "",
            title: shown ? shown.join("\n") : (resolved ?? ""),
            onchange: () => {
              const allowNegative = w3.settings.get<boolean>(NEGATIVE_REALS_SETTING) === true;
              const v = parseValue(type, input.value, allowNegative);
              if (v === null) {
                input.classList.add("invalid");
                const n = Number(input.value);
                if (negativeRefused(type, n, allowNegative)) void w3.window.showWarning(`${input.value} ${negativeRefused(type, n, allowNegative)}.`);
                return;
              }
              input.classList.remove("invalid");
              onCommit(v);
            },
          });
          return h("div.obj-value-cell", {}, input, resolved ? h("div.obj-resolved", {}, stripColors(resolved)) : null,
            browseButton(metaType, mixed ? "" : String(current), onCommit), labelButton(metaType, mixed ? "" : String(current), onCommit),
            mixed ? null : playButton(metaType, String(current)),
            mixed ? null : artPreview(metaType, String(current)));
        };

        /** Whether an object sets a field past the World Editor's range. Only what the map sets
         *  counts: inherited values are the game's own. */
        const overRange = (o: Obj, f: FieldMeta, level: number) => {
          const found = findMod(o, f.id, level);
          return !!found && outside(f.range, found.m.value);
        };
        /** A value past what a Gameplay Constant (or the unit's own clamp) lets the game use, when the map
         *  made it so (see constantWarning); null otherwise. */
        const overConstant = (o: Obj, f: FieldMeta, level: number) => {
          if (!kd || kind !== "w3u") return null;
          const found = findMod(o, f.id, level);
          const value = found ? found.m.value : (kd.defaultValue(o.base, f, level) ?? "");
          const warning = constantWarning(f.id, value, !!found, gameplayLimits, (id) => {
            const other = kd!.fieldById.get(id);
            if (!other) return undefined;
            const m = findMod(o, id, 0);
            return { value: m ? m.m.value : (kd!.defaultValue(o.base, other, 0) ?? ""), set: !!m };
          });
          return warning?.setByMap ? warning : null;
        };
        const overLimit = (o: Obj, f: FieldMeta, level: number) => overRange(o, f, level) || !!overConstant(o, f, level);
        /** Puts a number field's range, and a Gameplay Constant it runs into, in its tooltip, under what the tooltip
         *  already says. */
        const withRange = (cell: HTMLElement, f: FieldMeta, objs: Obj[], level: number) => {
          const constant = objs.map((o) => overConstant(o, f, level)).find((w) => w);
          const note = [rangeNote(f.range, objs.some((o) => overRange(o, f, level))), constant?.text ?? ""].filter(Boolean).join("\n");
          const target = cell.matches("input") ? cell : cell.querySelector("input");
          if (note && target) target.title = [target.title, note].filter(Boolean).join("\n");
          if (constant) cell.dataset.constantLimit = constant.text;
          return cell;
        };
        const outsideToggle = (label: string) => h("label", { title: "Show only values past the World Editor's range, or past what Gameplay Constants let the game use" },
          h("input", { type: "checkbox", checked: outsideOnly, onchange: (e: Event) => { outsideOnly = (e.target as HTMLInputElement).checked; renderDetail(); } }), ` ${label}`);
        /** The World Editor's Auto Fill Levels, with its preview. */
        const openAutoFill = (o: Obj, f: FieldMeta, levels: number) => {
          const text = f.valueType === "string";
          const number = (label: string, value: string, step = "any") => {
            const input = h("input", { type: "number", step, value, oninput: preview });
            return { input, row: h("div.terrain-sel-row", {}, h("span.muted", {}, label), input) };
          };
          const fromEl = h("select", { onchange: () => { base.input.value = effective(o, f, Number(fromEl.value)); baseText.value = effective(o, f, Number(fromEl.value)); preview(); } },
            ...Array.from({ length: levels }, (_, i) => h("option", { value: String(i + 1) }, String(i + 1))));
          const base = number("Base value", effective(o, f, 1)), previous = number("Previous value factor", "1"), level = number("Level factor", "0"), constant = number("Constant factor", "0");
          const baseText = h("input", { value: effective(o, f, 1), oninput: preview }), mark = h("input", { value: "#", size: 3, maxLength: 8, oninput: preview });
          const rows = h("div.obj-autofill-rows");
          const values = () => {
            const from = Number(fromEl.value);
            if (text) return autoFillText(baseText.value, mark.value, from, levels);
            const raw = autoFill({ from, to: levels, base: Number(base.input.value), previous: Number(previous.input.value), level: Number(level.input.value), constant: Number(constant.input.value) });
            return raw.map((r) => ({ level: r.level, value: f.valueType === "int" ? Math.round(r.value) : Math.round(r.value * 1000) / 1000 }));
          };
          function preview() { rows.replaceChildren(...values().map((r) => h("div.terrain-sel-row", {}, h("span.muted", {}, `Level ${r.level}`), h("span", {}, String(r.value))))); }
          const close = () => { overlay.remove(); };
          const apply = () => {
            for (const r of values()) setValue(o, f, r.level, r.value);
            close();
            markDirty();
            renderDetail();
          };
          const overlay = h("div.picker-overlay", { onmousedown: (e: MouseEvent) => { if (e.target === overlay) close(); }, onkeydown: (e: KeyboardEvent) => { if (keyOf(e) === "Escape") close(); } },
            h("div.picker.obj-autofill", {},
              h("h3", {}, `Auto Fill Levels: ${f.label}`),
              h("div.terrain-sel-row", {}, h("span.muted", {}, "Start from level"), fromEl),
              ...(text
                ? [h("div.terrain-sel-row", {}, h("span.muted", {}, "Base text"), baseText), h("div.terrain-sel-row", {}, h("span.muted", {}, "Replace with level"), mark)]
                : [base.row, previous.row, level.row, constant.row]),
              h("div.terrain-sel-sub.muted", {}, "Preview"), rows,
              h("div.obj-toolbar-buttons", {}, h("button.primary-inline", { onclick: apply }, "OK"), h("button", { onclick: close }, "Cancel"))));
          el.append(overlay);
          preview();
          (text ? baseText : base.input).focus();
        };
        /** Right-click on a field, as in the World Editor. */
        const fieldMenu = (o: Obj, f: FieldMeta, level: number, levels: number, current: number | string, e: MouseEvent) => {
          e.preventDefault();
          const held = fieldClip, fits = !!held && held.type === f.valueType;
          w3.window.showContextMenu({ x: e.clientX, y: e.clientY }, [
            { label: "Copy value", run: () => { fieldClip = { type: f.valueType, value: current }; } },
            { label: "Paste value", disabled: !fits, hint: held && !fits ? "The copied value is of another type." : undefined, run: () => { setValue(o, f, level, (held as { value: number | string }).value); markDirty(); renderDetail(); } },
            { label: "Reset to default", disabled: !findMod(o, f.id, level), run: () => { resetValue(o, f, level); markDirty(); renderDetail(); } },
            ...(levels > 1 ? ["-" as const, { label: "Auto Fill Levels…", run: () => openAutoFill(o, f, levels) }] : []),
          ]);
        };
        const fieldRow = (o: Obj, f: FieldMeta, level: number, levels: number) => {
          const found = findMod(o, f.id, level);
          const def = kd!.defaultValue(o.base, f, level);
          const inherited = !found;
          const current = found ? found.m.value : (def ?? (f.valueType === "string" ? "" : 0));
          const commit = (v: number | string) => {
            setValue(o, f, level, v);
            markDirty();
            renderDetail();
          };
          const over = overLimit(o, f, level);
          return h(`tr${inherited ? "" : ".modified"}${over ? ".obj-over" : ""}`, { oncontextmenu: (e: MouseEvent) => fieldMenu(o, f, level, levels, current, e) },
            h("td", { title: `${f.category} · ${f.type}${f.slk ? ` · ${f.slk}.${f.field}` : ""}` },
              h("span.obj-field-label", {}, f.label),
              h("code", {}, f.id)),
            h("td.muted", {}, levels > 1 ? String(level) : ""),
            h("td", {}, withRange(valueEditor(f.valueType, f.type, current, inherited, commit), f, [o], level)),
            h("td", {}, found
              ? h("button.icon-button", {
                  title: def !== undefined ? `Reset to inherited value: ${def}` : "Remove modification",
                  onclick: () => { found.mods.splice(found.mods.indexOf(found.m), 1); markDirty(); renderDetail(); },
                }, "↺")
              : null),
          );
        };

        /** Raw table for mods without metadata (or when game data is unavailable). */
        const rawTable = (o: Obj, mods: Mod[], title: string) => {
          if (!mods.length && kd) return null;
          const hasLevels = mods.some((m) => m.level !== undefined) || optInts;
          const newField = h("input", { placeholder: "field", maxLength: 4, size: 6 });
          const newType = h("select", {}, ...["string", "int", "real", "unreal"].map((t) => h("option", { value: t }, t)));
          const newLevel = h("input", { placeholder: "lvl", size: 3, value: "0" });
          const newValue = h("input", { placeholder: "value" });
          const add = () => {
            if (newField.value.length !== 4) return w3.window.showWarning("Field ids are exactly four characters, e.g. unam.");
            const type = newType.value as ValueType;
            const allowNegative = w3.settings.get<boolean>(NEGATIVE_REALS_SETTING) === true;
            const value = parseValue(type, newValue.value, allowNegative);
            if (value === null) {
              const why = negativeRefused(type, Number(newValue.value), allowNegative);
              return w3.window.showWarning(why ? `${newValue.value} ${why}.` : `"${newValue.value}" is not a valid ${type}.`);
            }
            const mod: Mod = { field: newField.value, type, value };
            if (hasLevels) { mod.level = Number(newLevel.value || 0); mod.data = 0; }
            primaryMods(o).push(mod);
            markDirty();
            renderDetail();
          };
          return h("section.obj-section", {},
            h("h3", {}, title),
            h("table.obj-table", {},
              h("tbody", {},
                ...mods.map((m) =>
                  h("tr.modified", {},
                    h("td", {}, h("code", {}, m.field)),
                    h("td.muted", {}, `${m.type}${m.level !== undefined ? ` · lvl ${m.level}` : ""}`),
                    h("td", {}, valueEditor(m.type, m.type, m.value, false, (v) => { m.value = v; markDirty(); })),
                    h("td", {}, h("button.icon-button", { title: "Remove modification", onclick: () => {
                      for (const l of modLists(o)) { const i = l.mods.indexOf(m); if (i >= 0) l.mods.splice(i, 1); }
                      markDirty(); renderDetail();
                    } }, "×")),
                  ),
                ),
                h("tr.obj-add", {},
                  h("td", {}, newField), h("td", {}, newType, hasLevels ? newLevel : null),
                  h("td", {}, newValue), h("td", {}, h("button", { onclick: add }, "Add")),
                ),
              ),
            ),
          );
        };

        const renderDetail = () => {
          const focused = document.activeElement === fieldSearch;
          const caret = [fieldSearch.selectionStart, fieldSearch.selectionEnd] as const;
          const inside = el.contains(document.activeElement);
          renderDetailInner();
          if (focused) {
            fieldSearch.focus();
            fieldSearch.setSelectionRange(caret[0], caret[1]);
          } else if (inside && !el.contains(document.activeElement)) {
            // The focused field was redrawn: keep the keys (Ctrl+Z) in the editor.
            detailEl.focus({ preventScroll: true });
          }
        };
        // A live view of the selected object's model (units, items, doodads, destructables).
        const MODEL_FIELD: Record<string, { model: string; variations?: string }> = {
          w3u: { model: "umdl" }, w3t: { model: "ifil" }, w3d: { model: "dfil", variations: "dvar" }, w3b: { model: "bfil", variations: "bvar" },
        };
        const preview = MODEL_FIELD[kind] ? new ModelPreview(w3) : null;
        /** The model the object shows (its first variation). */
        const modelOf = (o: Obj): string | null => {
          const mf = MODEL_FIELD[kind], f = kd?.fieldById.get(mf.model);
          if (!f) return null;
          const path = effective(o, f, 0).split(",")[0]?.trim();
          if (!path || path === "_") return null;
          const vf = mf.variations ? kd!.fieldById.get(mf.variations) : undefined;
          const variations = vf ? Number(effective(o, vf, 0)) || 1 : 1;
          return variations > 1 ? `${path.replace(/\.(mdl|mdx)$/i, "")}0` : path;
        };
        /** The look it shows, for a model that holds several (Animprops). */
        const looksOf = (o: Obj): string => {
          const f = kind === "w3u" ? kd?.fieldById.get("uani") : undefined;
          return f ? effective(o, f, 0) : "";
        };
        /** A campaign object, to look at: its fields as the campaign sets them (the game's where it doesn't), no editing.
         *  "Edit in the Campaign" opens the campaign project's Object Editor at it. */
        const renderCampaignObject = (o: Obj) => {
          const shown = (v: unknown) => stripColors(campaignStr(v) ?? String(v));
          const rows: HTMLElement[] = [];
          const known = new Set<Mod>();
          if (kd) {
            const lf = LEVEL_FIELD[kind];
            const levels = Math.max(1, Number((lf ? findMod(o, lf, 0)?.m.value : undefined) ?? kd.levels(o.base)) || 1);
            const q = fieldFilter.toLowerCase();
            for (const f of kd.fieldsFor(o.base)) {
              for (const lv of f.repeat > 0 ? Array.from({ length: levels }, (_, i) => i + 1) : [0]) {
                const found = findMod(o, f.id, lv);
                if (found) known.add(found.m);
                if (modifiedOnly && !found) continue;
                if (q && !`${f.label} ${f.id}`.toLowerCase().includes(q)) continue;
                const value = found ? found.m.value : (kd.defaultValue(o.base, f, lv) ?? "");
                rows.push(h(`tr${found ? ".modified" : ""}`, {},
                  h("td", { title: `${f.category} · ${f.type}` }, h("span.obj-field-label", {}, f.label), h("code", {}, f.id)),
                  h("td.muted", {}, f.repeat > 0 && levels > 1 ? String(lv) : ""),
                  h("td.obj-campaign-value", { title: found ? "Set by the campaign" : "The game's value" }, shown(value))));
              }
            }
          }
          // Fields the table didn't show (unknown ones, or without the game's data).
          for (const m of modLists(o).flatMap((l) => l.mods).filter((m) => !known.has(m))) {
            rows.push(h("tr.modified", {}, h("td", {}, h("code", {}, m.field)), h("td.muted", {}, m.level ? String(m.level) : ""), h("td.obj-campaign-value", {}, shown(m.value))));
          }
          const what = o.id ? `${o.id} (based on ${o.base}${baseName(o) ? ` · ${stripColors(baseName(o))}` : ""})` : o.base;
          detailEl.replaceChildren(
            h("div.obj-detail-header", {},
              h("h2", {}, campaignName(o) || "(unnamed)"),
              h("code", {}, what),
              h("button.obj-edit-in-campaign", {
                title: "Opens the campaign project (this map closes) and its Object Editor at this object",
                onclick: () => void w3.commands.execute("w3.objectEditor.openInCampaign", kind, o.id ?? o.base).catch(failed),
              }, "Edit in the Campaign…")),
            h("div.muted.obj-campaign-note", {}, `${o.id ? "A custom object" : "A change to a game object"} of the campaign (war3campaign.${kind}): every chapter map has it. `
              + "It's edited in the campaign; an object of the same id in this map replaces it here."),
            h("div.obj-detail-toolbar", {},
              fieldSearch,
              h("label", {}, h("input", { type: "checkbox", checked: modifiedOnly, onchange: (e: Event) => { modifiedOnly = (e.target as HTMLInputElement).checked; renderDetail(); } }), " Modified only")),
            rows.length
              ? h("table.obj-table.obj-campaign-table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Field"), h("th", {}, "Lvl"), h("th", {}, "Value"))), h("tbody", {}, ...rows))
              : h("div.muted", {}, modifiedOnly ? "No modified fields." : "No fields match."));
        };
        /** Values of the shown object past the World Editor's range. */
        let overCount = 0;
        const renderDetailInner = () => {
          // Edits can change names and the clean-up count in the list too.
          // Choosing one of the map's objects (also Ctrl+click, an undo) leaves the campaign's.
          if (selection.size) campaignShown = null;
          renderList();
          const scroll = detailEl.scrollTop;
          if (campaignShown) {
            renderCampaignObject(campaignShown);
            detailEl.scrollTop = scroll;
            return;
          }
          if (!selected) {
            detailEl.replaceChildren(h("div.muted", {}, kd ? `No ${kindInfo?.label.toLowerCase() ?? "objects"} yet — use "+ New".` : "No objects in this file."));
            return;
          }
          if (selection.size > 1) {
            renderMulti();
            detailEl.scrollTop = scroll;
            return;
          }
          const o = selected;
          const sections: (HTMLElement | null)[] = [];
          const known = new Set<Mod>();
          if (kd) {
            const levels = levelCount(o);
            const q = fieldFilter.toLowerCase();
            const byCategory = new Map<string, HTMLElement[]>();
            overCount = 0;
            for (const f of kd.fieldsFor(o.base)) {
              const lvls = f.repeat > 0 ? Array.from({ length: levels }, (_, i) => i + 1) : [0];
              for (const lv of lvls) {
                const found = findMod(o, f.id, lv);
                if (found) known.add(found.m);
                const over = overLimit(o, f, lv);
                if (over) overCount++;
                if (modifiedOnly && !found) continue;
                if (outsideOnly && !over) continue;
                if (q && !`${f.label} ${f.id}`.toLowerCase().includes(q)) continue;
                const rows = byCategory.get(f.category) ?? [];
                rows.push(fieldRow(o, f, lv, f.repeat > 0 ? levels : 1));
                byCategory.set(f.category, rows);
              }
            }
            for (const [cat, rows] of byCategory) {
              sections.push(h("section.obj-section", {},
                h("h3", {}, cat),
                h("table.obj-table", {},
                  h("thead", {}, h("tr", {}, h("th", {}, "Field"), h("th", {}, "Lvl"), h("th", {}, "Value"), h("th", {}))),
                  h("tbody", {}, ...rows)),
              ));
            }
            if (!byCategory.size) sections.push(h("div.muted", {}, outsideOnly ? "No values outside the World Editor's range or the Gameplay Constants." : modifiedOnly ? "No modified fields." : "No fields match."));
          }
          // Mods the field table didn't show: unknown fields, or levels beyond the level count.
          const other = modLists(o).flatMap((l) => l.mods).filter((m) => !known.has(m));
          sections.push(rawTable(o, other, kd ? "Other modifications" : "Modifications"));

          const parts: (HTMLElement | null)[] = [
            preview && kd ? (preview.show(modelOf(o), looksOf(o)), preview.el) : null,
            h("div.obj-detail-header", {},
              h("h2", {}, nameOf(o) || "(unnamed)"),
              h("code", {}, o.id ? `${o.id} (based on ${o.base}${baseName(o) ? ` · ${stripColors(baseName(o))}` : ""})` : o.base),
              h("button", { title: "Delete key also removes the selection", onclick: removeSelection }, "Remove object"),
            ),
            kd ? h("div.obj-detail-toolbar", {},
              fieldSearch,
              h("label", {}, h("input", { type: "checkbox", checked: modifiedOnly, onchange: (e: Event) => { modifiedOnly = (e.target as HTMLInputElement).checked; renderDetail(); } }), " Modified only"),
              outsideToggle(`Outside limits${overCount ? ` (${overCount})` : ""}`),
              LEVEL_FIELD[kind] ? h("span.muted", {}, `${levelCount(o)} level${levelCount(o) === 1 ? "" : "s"}`) : null,
            ) : null,
            ...sections,
          ];
          detailEl.replaceChildren(...parts.filter((p): p is HTMLElement => p !== null));
          detailEl.scrollTop = scroll;
        };

        /** Fields every selected object has, with the level count they share. */
        const commonFields = (objs: Obj[]) => {
          const sets = objs.map((o) => new Set(kd!.fieldsFor(o.base)));
          const fields = kd!.fieldsFor(objs[0].base).filter((f) => sets.every((s) => s.has(f)));
          const levels = Math.min(...objs.map(levelCount));
          return fields.flatMap((f) => (f.repeat > 0 ? Array.from({ length: levels }, (_, i) => ({ f, level: i + 1 })) : [{ f, level: 0 }]));
        };
        const ordered = () => visible.filter((o) => selection.has(o)).concat([...selection].filter((o) => !visible.includes(o)));

        /** Several objects: shared values on top, differing values below; edits apply to all. */
        const renderMulti = () => {
          const objs = ordered();
          const header = h("div.obj-detail-header", {},
            h("h2", {}, `${objs.length} objects selected`),
            h("code.obj-multi-ids", { title: objs.map((o) => `${o.id || o.base} ${nameOf(o)}`).join("\n") }, objs.map((o) => o.id || o.base).join(", ")),
            h("div.obj-toolbar-buttons", {},
              kd ? h("button", { title: "Compare the selected objects side by side", onclick: () => showDiff(objs) }, "Diff") : null,
              h("button", { title: "Delete key also removes the selection", onclick: removeSelection }, `Remove ${objs.length} objects`)));
          if (!kd) {
            detailEl.replaceChildren(header, h("div.muted", {}, "Editing several objects at once needs the game data. Select one object to edit its modifications."));
            return;
          }
          const q = fieldFilter.toLowerCase();
          const same = new Map<string, HTMLElement[]>(), diff = new Map<string, HTMLElement[]>();
          let sameCount = 0, diffCount = 0;
          for (const { f, level } of commonFields(objs)) {
            if (q && !`${f.label} ${f.id}`.toLowerCase().includes(q)) continue;
            const values = objs.map((o) => effective(o, f, level));
            const anyModified = objs.some((o) => findMod(o, f.id, level));
            if (modifiedOnly && !anyModified) continue;
            const over = objs.some((o) => overLimit(o, f, level));
            if (outsideOnly && !over) continue;
            const distinct = [...new Set(values)];
            const isSame = distinct.length === 1;
            const commit = (v: number | string) => { for (const o of objs) setValue(o, f, level, v); markDirty(); renderDetail(); };
            const each = (change: (old: string) => number | string) => { for (const o of objs) setValue(o, f, level, change(effective(o, f, level))); markDirty(); renderDetail(); };
            const row = h(`tr${anyModified ? ".modified" : ""}${over ? ".obj-over" : ""}`, {},
              h("td", { title: `${f.category} · ${f.type}` }, h("span.obj-field-label", {}, f.label), h("code", {}, f.id)),
              h("td.muted", {}, level ? String(level) : ""),
              h("td", {}, withRange(valueEditor(f.valueType, f.type, isSame ? values[0] : "", !anyModified, commit, isSame ? undefined : values, each), f, objs, level)),
              h("td", {}, anyModified
                ? h("button.icon-button", { title: "Reset all selected to their inherited values", onclick: () => { for (const o of objs) resetValue(o, f, level); markDirty(); renderDetail(); } }, "↺")
                : null));
            const target = isSame ? same : diff;
            if (isSame) sameCount++; else diffCount++;
            target.set(f.category, [...(target.get(f.category) ?? []), row]);
          }
          const block = (key: string, title: string, hint: string, groups: Map<string, HTMLElement[]>) => {
            const folded = foldedBlocks.has(key);
            const toggle = () => {
              if (folded) foldedBlocks.delete(key);
              else foldedBlocks.add(key);
              renderDetail();
            };
            return h("section.obj-multi-block", {},
              h("h2.obj-multi-title", { title: folded ? "Click to expand" : "Click to collapse", onclick: toggle },
                h("span.twistie", {}, folded ? "▸" : "▾"), title, h("small.muted", {}, hint)),
              ...(folded ? [] : groups.size ? [...groups].map(([cat, rows]) => h("section.obj-section", {},
                h("h3", {}, cat),
                h("table.obj-table", {}, h("tbody", {}, ...rows)))) : [h("div.muted", {}, "None.")]));
          };
          detailEl.replaceChildren(
            header,
            h("div.obj-detail-toolbar", {},
              fieldSearch,
              h("label", {}, h("input", { type: "checkbox", checked: modifiedOnly, onchange: (e: Event) => { modifiedOnly = (e.target as HTMLInputElement).checked; renderDetail(); } }), " Modified in any"),
              outsideToggle("Outside limits in any")),
            block("same", `Same in all (${sameCount})`, " — editing changes every selected object", same),
            block("different", `Different (${diffCount})`, " — a value entered here overrides all selected", diff),
          );
        };

        /** Side-by-side table of the fields whose values differ. */
        const showDiff = (objs: Obj[]) => {
          const rows: HTMLElement[] = [];
          for (const { f, level } of commonFields(objs)) {
            const values = objs.map((o) => effective(o, f, level));
            if (new Set(values).size === 1) continue;
            rows.push(h("tr", {},
              h("td.diff-field", { title: f.id }, f.label, level ? h("small.muted", {}, ` lvl ${level}`) : null),
              ...objs.map((o, i) => {
                const modified = !!findMod(o, f.id, level);
                const text = stripColors(resolveStr(values[i]) ?? values[i]);
                return h(`td${modified ? ".diff-modified" : ".diff-inherited"}`, { title: modified ? "modified" : "inherited" }, text || "—");
              })));
          }
          const close = () => overlay.remove();
          const overlay = h("div.picker-overlay", { tabindex: -1, onmousedown: (e: MouseEvent) => { if (e.target === overlay) close(); }, onkeydown: (e: KeyboardEvent) => { if (keyOf(e) === "Escape") close(); } },
            h("div.picker.diff-dialog", {},
              h("div.picker-header", {},
                h("strong", {}, `Diff — ${objs.length} objects`),
                h("span.muted", {}, `${rows.length} differing fields · gold = modified, grey = inherited`),
                h("button.icon-button", { title: "Close (Esc)", onclick: close }, "×")),
              h("div.diff-scroll", {},
                rows.length
                  ? h("table.diff-table", {},
                      h("thead", {}, h("tr", {}, h("th", {}, "Field"), ...objs.map((o) => h("th", {}, h("code", {}, o.id || o.base), h("div", {}, nameOf(o)))))),
                      h("tbody", {}, ...rows))
                  : h("div.muted", {}, "All shared fields have the same values."))));
          el.append(overlay);
          overlay.focus();
        };

        /** Asks for a game object; the selected object's base is offered first. */
        const pickBase = async (placeholder: string): Promise<string | undefined> => {
          if (!kd) return w3.window.inputBox({ prompt: "Base object id (e.g. hfoo)" });
          const pinned = selected && kd.baseIds.includes(selected.base) ? selected.base : undefined;
          const k = kd;
          return pickBaseObject(el, kd, { title: placeholder, pinned, iconOf: (id) => icons(k, kind, id) });
        };

        /** Where an id is in use in the other object types ("a custom item of this map"), or null. */
        const usedElsewhere = async (id: string): Promise<string | null> => {
          const ofCampaign = (await campaignIds()).get(id);
          if (ofCampaign) return `a custom ${ofCampaign} of the campaign`;
          for (const k of KINDS) {
            if (k.ext === kind) continue;
            const text = await w3.workspace.readText(`map/war3map.${k.ext}.json`).catch(() => null);
            const other = text ? (JSON.parse(text) as ObjectFile) : null;
            if (other?.custom.some((o) => o.id === id)) return `a custom ${k.singular} of this map`;
            const okd = await loadKind(w3, k.ext).catch(() => null);
            if (okd?.baseIds.includes(id)) return `a game ${k.singular} (${stripColors(okd.names.get(id) ?? id)})`;
          }
          return null;
        };
        /** A chapter map's campaign's custom objects of every kind (id → its kind, singular), read once: a new object's
         *  id shouldn't be one of them, or it would replace the campaign's in this map. Rejects when they can't be read. */
        let campaignIdList: Promise<Map<string, string>> | null = null;
        const campaignIds = () => {
          campaignIdList ??= (async () => {
            const ids = new Map<string, string>();
            if (campaignError) throw new Error(`The campaign's object data can't be read (${campaignError}), so it isn't known which ids it uses.`);
            for (const k of KINDS) {
              const c = k.ext === kind ? campaign : await campaignObjects(w3, k.ext, openedRoot);
              for (const o of c?.custom ?? []) if (o.id && !ids.has(o.id)) ids.set(o.id, k.singular);
            }
            return ids;
          })();
          campaignIdList.catch(() => { campaignIdList = null; });
          return campaignIdList;
        };
        const takenIds = () => new Set<string>([...file.custom.map((o) => o.id ?? ""), ...file.original.map((o) => o.base), ...(kd?.baseIds ?? []),
          ...((campaign?.custom ?? []).map((o) => o.id ?? ""))]);
        /** The next free id, like the World Editor (also free among the other object types). */
        const freeIdFor = async (base: string, taken: Set<string>) => {
          let free = nextFreeId(kind, base, taken);
          for (let n = 0; n < 50 && (await usedElsewhere(free)); n++) { taken.add(free); free = nextFreeId(kind, base, taken); }
          return free;
        };
        // Fails, saying why, when the ids in use can't be told (a campaign whose object data can't be read).
        const newObject = () => newObjectAsked().catch((e) => failed(e));
        const newObjectAsked = async () => {
          const base = await pickBase(`New ${kindInfo?.singular ?? "object"} based on… (hold Shift to choose the id)`);
          if (!base || base.length !== 4) return;
          const askId = shiftHeld;
          const taken = takenIds();
          const free = await freeIdFor(base, taken);
          let id = free;
          if (askId) {
            const typed = await w3.window.inputBox({ prompt: `New ${kindInfo?.singular ?? "object"} id`, value: free });
            if (!typed) return;
            if (typed.length !== 4) return w3.window.showWarning("Object ids are exactly four characters.");
            if (taken.has(typed) && typed !== free) return w3.window.showWarning(`${typed} is already used.`);
            // Other object types: the map's custom objects and the game's (ids should be unique overall).
            const clash = await usedElsewhere(typed);
            if (clash && (await w3.window.showWarning(`${typed} is already ${clash}. Use it anyway?`, "Use it", "Cancel")) !== "Use it") return;
            id = typed;
          }
          const o: Obj = file.version >= 3 ? { base, id, mods: [] } : { base, id, end: id, mods: [] };
          file.custom.push(o);
          select(o);
          filter = "";
          search.value = "";
          markDirty(); renderDetail();
        };

        /** Modifies a game object in place ("Modified standard"). */
        const editStandard = async () => {
          const base = await pickBase(`Standard ${kindInfo?.singular ?? "object"} to modify…`);
          if (!base || base.length !== 4) return;
          let o = file.original.find((x) => x.base === base);
          if (!o) {
            o = file.version >= 3 ? { base, mods: [] } : { base, end: base, mods: [] };
            file.original.push(o);
            markDirty();
          }
          select(o);
          filter = "";
          search.value = "";
          renderDetail();
        };

        el.append(
          h("div.object-editor", {},
            h("div.obj-sidebar", {},
              h("div.obj-toolbar", {},
                h("strong", {}, kindInfo?.label ?? kind),
                h("div.obj-toolbar-buttons", {},
                  h("button", { title: "Create a new custom object based on a game object", onclick: newObject }, "+ New"),
                  h("button", { title: "Change a game object itself — affects every instance in the map", onclick: editStandard }, "Edit standard…"))),
              h("div.obj-toolbar-buttons", {},
                h("button", { title: `Save this map's ${kindInfo?.label ?? kind} as a .${kind} file, which the World Editor can import too`, onclick: () => void exportFile().catch(failed) }, "Export…"),
                h("button", { title: `Take in a .${kind} file, from the World Editor or another map. Same ids are replaced`, onclick: () => void importFile().catch(failed) }, "Import…"),
                h("label", { title: "Sort the list by name" }, h("input", { type: "checkbox", onchange: (e: Event) => { sortByName = (e.target as HTMLInputElement).checked; renderList(); } }), " By name")),
              status,
              search,
              listEl,
            ),
            detailEl,
          ),
        );
        saved = serialize();
        // Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) anywhere in the editor. In a text field only when nothing was
        // typed since its value was set (else the field undoes its own typing).
        el.addEventListener("keydown", (e) => {
          if (!(e.ctrlKey || e.metaKey)) return;
          const t = e.target as HTMLElement;
          const typing = (t instanceof HTMLInputElement && t.type !== "checkbox" && t.value !== t.defaultValue)
            || (t instanceof HTMLTextAreaElement && t.value !== t.defaultValue);
          if (typing) return;
          const k = keyOf(e).toLowerCase();
          if (k === "z" && !e.shiftKey) { e.preventDefault(); step(-1); }
          else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); step(1); }
        });
        const exportFile = async () => {
          const path = await w3.window.pickSaveFile({ title: `Export ${kindInfo?.label ?? kind}`, defaultPath: `${kindInfo?.label ?? kind}.${kind}`, filters: [{ name: `${kindInfo?.label ?? kind} (.${kind})`, extensions: [kind] }] });
          if (!path) return;
          // Its own texts: references to this map's string table mean nothing in another.
          const text = (v: string) => { const ref = trigRef(v); return ref === null ? null : wts.table.get(ref) ?? null; };
          // The fields the map keeps in its Skin file (names, models, art) belong in the exported file. All objects
          // are exported here, so the Skin file's own entries come along; Export Object takes the chosen ones only.
          const skinPath = doc.path.replace(/(war3map|war3campaign)(\.w3[utabdhq]\.json)$/i, "$1Skin$2");
          const merged = mergeSkin(file as unknown as EditFile, await readMapDocStrict<EditFile>(w3, skinPath), { addSkinOnly: true }) as unknown as ObjectFile;
          const own = { ...merged, custom: merged.custom.map((o) => copyOf(o as EditObject, text)), original: merged.original.filter(hasMods).map((o) => copyOf(o as EditObject, text)) };
          await w3.backend.invoke("objects_export", { name: `war3map.${kind}`, text: JSON.stringify(own), path });
          void w3.window.showInfo(`Exported ${own.custom.length} custom and ${own.original.length} changed objects.`);
        };
        /** The selected objects as a .w3o of their own. */
        const exportSelection = async () => {
          const text = (v: string) => { const ref = trigRef(v); return ref === null ? null : wts.table.get(ref) ?? null; };
          await exportObjects(w3, kind, file as unknown as EditFile, [...selection] as unknown as EditObject[], text);
        };
        const importFile = async () => {
          const path = await w3.window.pickFile({ title: `Import ${kindInfo?.label ?? kind}`, filters: [{ name: `${kindInfo?.label ?? kind} (.${kind})`, extensions: [kind] }] });
          if (!path) return;
          const incoming = JSON.parse(await w3.backend.invoke<string>("objects_import", { name: `war3map.${kind}`, path })) as ObjectFile;
          const { added, replaced } = mergeObjects(file as unknown as EditFile, incoming as unknown as EditFile);
          markDirty();
          renderDetail();
          void w3.window.showInfo(`Imported: ${added} new, ${replaced} replaced. Ctrl+Z takes it back.`);
        };
        const failed = (e: unknown) => void w3.window.showError(String((e as Error).message ?? e));
        const focusObject = (id: string) => {
          search.value = id;
          filter = id.toLowerCase();
          const o = file.custom.find((c) => c.id === id) ?? file.original.find((c) => c.base === id);
          select(o ?? null);
          renderList();
          renderDetail();
          if (o) return;
          // A custom object of a chapter map's campaign: shown as the campaign has it (edited in the campaign).
          const fromCampaign = (campaign?.custom as Obj[] | undefined)?.find((c) => c.id === id);
          if (fromCampaign) {
            campaignShown = fromCampaign;
            status.textContent = `${id}: a custom object of the campaign — "Edit in the Campaign…" opens it there.`;
            renderList();
            renderDetail();
            return;
          }
          // An unchanged game object: shown as a standard entry without modifications, like the World
          // Editor (such entries aren't written, so this changes nothing until a field is edited).
          void loadKind(w3, kind).then((k) => {
            if (!k.names.has(id)) {
              status.textContent = campaignError ? `${id} isn't in this map's object data or the game's, and the campaign's can't be read: ${campaignError}`
                : `${id} isn't in this map's object data, its campaign's or the game's.`;
              return;
            }
            const std: Obj = file.version >= 3 ? { base: id, mods: [] } : { base: id, end: id, mods: [] };
            file.original.push(std);
            select(std);
            status.textContent = `${k.names.get(id)} (${id}): game object, unchanged in this map — edits change it for this map.`;
            renderList();
            renderDetail();
          }, () => { status.textContent = `${id}: game data unavailable.`; });
        };
        focusers.set(doc.path, focusObject);
        const shownObject = (id: string) => {
          const o = file.custom.find((c) => c.id === id) ?? file.original.find((c) => c.base === id);
          if (!o) throw new Error(`${id} isn't in this map's object data.`);
          return o;
        };
        actors.set(doc.path, {
          // As typing the name in its field: the map's string table keeps the text where the name is a TRIGSTR.
          rename: (id, name) => {
            if (doc.readOnly) throw new Error("This object data can't be changed here.");
            const o = shownObject(id);
            if (!kd) throw new Error("The game's object data isn't loaded yet; try again in a moment.");
            const f = kd.fieldsFor(o.base).find((x) => /nam$/.test(x.id) && x.valueType === "string");
            if (!f) throw new Error(`${id} has no name field.`);
            const level = f.repeat > 0 ? 1 : 0;
            const ref = trigRef(findMod(o, f.id, level)?.m.value);
            if (ref !== null) wts.set(ref, name); else setValue(o, f, level, name);
            select(o);
            markDirty();
            renderList();
            renderDetail();
          },
          // As the Delete key on the selected object: its question, then one undo step.
          remove: async (id) => {
            if (doc.readOnly) throw new Error("This object data can't be changed here.");
            select(shownObject(id));
            const before = file.custom.length + file.original.length;
            await removeSelection();
            return file.custom.length + file.original.length < before;
          },
          resetAll: resetAllStandard,
        });
        renderList();
        renderDetail();
        if (pendingFocus?.path === doc.path) {
          focusObject(pendingFocus.id);
          pendingFocus = null;
        }
        status.textContent ||= "Loading game data…";
        loadEditorTypes(w3).then((t) => { editorTypes = t; renderDetail(); }, () => {});
        // Gameplay Constants limit some fields (units only: see constlimits). Read again when the map's change.
        const limitSubs = kind === "w3u" ? [
          w3.workspace.onDidSave((p) => { if (p.toLowerCase() === MAP_CONSTANTS.toLowerCase()) void loadLimits(); }),
          w3.workspace.onDidChange(() => void loadLimits()),
        ] : [];
        if (kind === "w3u") void loadLimits();
        // The map's own object data: other modules see it as it is here (the newest editor of a file counts).
        const isLive = !doc.readOnly && doc.path.toLowerCase().startsWith("map/");
        if (isLive) liveData.set(doc.path, { kind, data: liveNow });
        loadKind(w3, kind).then(
          (k) => { kd = k; if (status.textContent === "Loading game data…") status.textContent = ""; renderList(); renderDetail(); },
          (e) => { status.textContent = `Game data unavailable — showing raw ids (${e})`; },
        );

        return {
          undo: () => step(-1),
          redo: () => step(1),
          async save() {
            // Nothing is written into a vanished map folder: it would leave a lone file there.
            const root = w3.workspace.project()?.root;
            if (root) {
              const folderExists = await w3.backend.invoke<boolean>("fs_exists", { path: joinPath(root, "map") }).catch(() => true);
              if (mapFolderGone({ folderExists, isNew, hasWts })) {
                w3.window.showError("The map folder is missing, so nothing was saved. Restore it (a checkpoint or the packed map has the files) and save again.");
                return;
              }
            }
            // A text with a `}` line would be cut by the game: change it (one undo step) or save nothing,
            // before the object file is written.
            const cuts = hasWts ? wts.table.cuts() : [];
            if (cuts.length) {
              if (!(await askWtsCuts((m, yes, ms) => w3.window.confirm(m, yes, ms), cuts))) throw new WtsCutError(cuts);
              const now = wts.table.cuts();
              for (const c of now) wts.set(c.num, wtsSafeText(wts.table.get(c.num)!));
              if (now.length) { markDirty(); renderDetail(); }
            }
            // The backend encodes the JSON to binary (validating it) and returns
            // it in canonical formatting, so diffs stay minimal.
            let result: { shown: boolean; recreated: boolean } | undefined;
            await runSave({
              serialize,
              canonicalize: (text) => w3.backend.invoke<string>("objects_canonicalize", { name: doc.path, text }),
              write: (text) => doc.writeText(text),
              afterWrite: async () => {
                if (isNew && !exists()) await w3.workspace.refresh();
                // Edited strings go to war3map.wts (war3campaign.wts), merged onto the file as it is now (other editors
                // may have saved strings meanwhile; only changed blocks are rewritten).
                if (!hasWts) return;
                const outcome = await attempt(async () => {
                  // Only a file that is really gone is recreated; any other failed read stops the save.
                  const isMissing = async (error: unknown) => {
                    if (!isNotFoundError(error)) return false;
                    const refreshed = await w3.workspace.refresh().then(() => true, () => false);
                    const paths = w3.workspace.files().map((f) => f.path.toLowerCase());
                    return fileIsMissing({
                      error,
                      refreshed,
                      listed: paths.includes(WTS.toLowerCase()),
                      otherMapFiles: paths.some((p) => p.startsWith("map/") && p !== WTS.toLowerCase() && p !== doc.path.toLowerCase()),
                    });
                  };
                  return wts.save(() => w3.workspace.readText(WTS), (t) => w3.workspace.writeText(WTS, t), isMissing);
                });
                if (!outcome.ok) {
                  // The object file is written; saving again rewrites it unchanged and retries the strings.
                  await w3.workspace.refresh().catch(() => {});
                  w3.window.showError(`${wtsName}: strings not saved (${outcome.error instanceof Error ? outcome.error.message : outcome.error})`);
                } else {
                  result = outcome.value;
                }
              },
              setSaved: (text) => { saved = text; doc.setDirty(isDirty()); },
              followUps: async () => {
                if (result?.recreated) {
                  await w3.workspace.refresh().catch(() => {});
                  void packedMapPath(w3).then((packed) => w3.window.showWarning(recreatedMessage(packed)));
                }
                // A text changed by the save (another editor's was kept) shows at once.
                const renderNeeded = !!result?.shown;
                if (renderNeeded) {
                  try { renderDetail(); } catch (e) { w3.window.showError(`Saved, but the detail view failed to redraw (${e})`); }
                }
                w3.views.refresh("w3.objects.kinds");
              },
            });
          },
          focus: () => search.focus(),
          dispose: () => {
            closed = true; focusers.delete(doc.path); actors.delete(doc.path); preview?.dispose(); sounds.stop(); for (const s of limitSubs) s.dispose();
            // Closed: the saved file is what there is again.
            if (liveData.get(doc.path)?.data === liveNow) { liveData.delete(doc.path); edits.fire(kind); }
          },
          watches: [WTS],
        };
      },
    }),
  );
}
