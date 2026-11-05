import type { ExtensionContext, W3Api } from "../../extensions/api";
import { OBJECTS_SERVICE } from "../../extensions/services";
import { h } from "../../workbench/dom";
import { loadKind, nextFreeId, type FieldMeta, type KindData, type ValueType } from "../../lib/objects/metadata";
import { pickBaseObject } from "./picker";
import { iconLoader, imageLoader, objectsService, soundLabels, stripColors } from "./service";
import { toProjectPath } from "../../lib/formats/archivepath";
import { pickFile, pickLabel, type FileKind } from "./filepicker";
import { StringTable } from "../../lib/formats/wts";
import { loadEditorTypes, OBJECT_CODE, OBJECT_LIST, objectEditor, typeEditor, type EditorType, type MixedValues } from "./fields";
import { ModelPreview } from "../../lib/model/preview";
import { capped, mapStrings, readMapDoc, requireProject } from "../../lib/formats/mapdoc";
import { changedFields, gameFields, mapObjectList, OBJECT_KINDS, objectName, type MapObjects } from "./objectinfo";
import { addCustomObject, fieldLevel, fieldValue, objectToEdit, removeObject, setObjectField, type EditFile } from "./objectedit";
import { jsonPathOf } from "../../lib/formats/mapdoc";
import { MCP_EDITS_SERVICE, type McpEditsService } from "../../extensions/services";

// Mirrors w3proj::objdata's JSON (format "w3proj.objects/1").
interface Mod { field: string; type: ValueType; level?: number; data?: number; value: number | string; end?: string }
interface ObjSet { flag: number; mods: Mod[] }
interface Obj { base: string; id?: string; end?: string; sets?: ObjSet[]; mods?: Mod[] }
interface ObjectFile { format: string; version: number; original: Obj[]; custom: Obj[] }

const FORMAT = "w3proj.objects/1";

/** An object data file without objects, in the version of the map's other object data (else
 *  Reforged's). */
async function emptyFile(w3: W3Api): Promise<ObjectFile> {
  const sibling = w3.workspace.files().find((f) => /^map\/war3map\.w3[utabdhq]\.json$/i.test(f.path));
  const version = sibling ? JSON.parse(await w3.workspace.readText(sibling.path)).version ?? 3 : 3;
  return { format: FORMAT, version, original: [], custom: [] };
}
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

function parseValue(type: ValueType, text: string): number | string | null {
  if (type === "string") return text;
  const n = Number(text);
  if (text.trim() === "" || Number.isNaN(n) || (type === "int" && !Number.isInteger(n))) return null;
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
    w3.mcp.registerTool("list_objects", async ({ kind, scope, filter, limit }) => {
      const { data, file, resolve } = await toolKind(kind);
      const text = typeof filter === "string" ? filter.toLowerCase() : "";
      const hit = (o: { id: string; name: string }) => o.id.toLowerCase().includes(text) || o.name.toLowerCase().includes(text);
      const game = () => data.baseIds.map((id) => ({ id, name: stripColors(data.names.get(id) ?? id) }));
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
    w3.mcp.registerTool("set_object_field", async ({ kind, id, field, level, value }) => {
      const changed = await editObjects(`Set ${String(field)} of ${String(id)}`, kind, (file, _, data) => {
        const o = objectToEdit(file, String(id), data.baseIds.includes(String(id)));
        const f = data.fieldsFor(o.base).find((x) => x.id === field);
        if (!f) throw new Error(`${String(field)} isn't a field of ${o.base}. get_object with gameValues lists them.`);
        const at = fieldLevel(f, level);
        setObjectField(o, OBJECT_KINDS[String(kind)], f, at, value === null ? null : fieldValue(f, value), data.defaultValue(o.base, f, at));
      });
      return changed ? `Changed ${String(field)} of ${String(id)}.` : "It already had that value.";
    }),
    w3.mcp.registerTool("create_object", async ({ kind, base, name }) => {
      let made = "";
      await editObjects(`Create an object from ${String(base)}`, kind, async (file, ext, data) => {
        const from = String(base);
        if (!data.baseIds.includes(from)) throw new Error(`There's no game object "${from}" of that kind.`);
        const taken = new Set([...file.custom.map((o) => o.id ?? ""), ...file.original.map((o) => o.base), ...data.baseIds]);
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
  const objects = objectsService(w3);
  /** Open editors by document path: show an object (filter the list to it and select it). */
  const focusers = new Map<string, (id: string) => void>();
  /** Object to show once an editor that is being opened has loaded. */
  let pendingFocus: { path: string; id: string } | null = null;

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
        for (const k of KINDS) {
          const path = files.get(`map/war3map.${k.ext}.json`);
          const counts = h("small.muted", {}, path ? "…" : "none yet");
          list.append(h("div.tree-row.obj-kind", { title: path ?? `Creates map/war3map.${k.ext}.json`, onclick: () => w3.commands.execute("w3.objectEditor.open", k.ext).catch((e) => w3.window.showError(String(e))) },
            h("span.tree-icon", {}, KIND_ICONS[k.ext]),
            h("span.tree-label", {}, k.label),
            counts));
          if (path) {
            w3.workspace.readText(path).then((t) => {
              const j: ObjectFile = JSON.parse(t);
              counts.textContent = `${j.custom.length} custom · ${j.original.length} modified`;
            }, () => { counts.textContent = "unreadable"; });
          }
        }
      },
    }),
    w3.workspace.onDidChange(() => w3.views.refresh("w3.objects.kinds")),

    // `focusId` (optional) shows that object, e.g. when coming from the terrain view.
    w3.commands.register("w3.objectEditor.open", async (ext?: string, focusId?: string) => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      ext ??= (await w3.window.quickPick(KINDS.map((k) => ({ label: k.label, description: `war3map.${k.ext}`, value: k.ext })), { placeholder: "Which object data?" }))?.value;
      if (!ext) return;
      // A kind the map has no file for opens empty; the file is created on the first save.
      const path = `map/war3map.${ext}.json`;
      const open = w3.workspace.files().find((f) => f.path.toLowerCase() === path.toLowerCase())?.path ?? path;
      if (focusId) pendingFocus = { path: open, id: focusId };
      await w3.editors.open(open, "w3.objectEditor");
      // Already open: the editor didn't load again, so show the object now.
      if (focusId && focusers.has(open)) {
        pendingFocus = null;
        focusers.get(open)!(focusId);
      }
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

        // The map's string table: TRIGSTR_n values show (and edit) their text in war3map.wts.
        let savedWts = await w3.workspace.readText("map/war3map.wts").catch(() => null);
        let table = new StringTable(savedWts ?? "");
        const trigRef = (v: unknown) => {
          const n = typeof v === "string" ? StringTable.ref(v) : null;
          return n !== null && table.has(n) ? n : null;
        };
        const resolveStr = (v: unknown) => { const n = trigRef(v); return n === null ? null : table.get(n)!; };

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

        /** The anchor (single selection, Shift+click range start). */
        let selected: Obj | null = file.custom[0] ?? file.original[0] ?? null;
        /** All selected objects; Ctrl+click toggles, Shift+click selects a range. */
        let selection = new Set<Obj>(selected ? [selected] : []);
        const select = (o: Obj | null) => {
          selected = o;
          selection = new Set(o ? [o] : []);
        };
        /** Objects in list order (for Shift ranges and ordered multi views). */
        let visible: Obj[] = [];
        let filter = "";
        let fieldFilter = "";
        let modifiedOnly = false;
        /** Folded multi-selection blocks ("same" / "different"); kept across re-renders. */
        const foldedBlocks = new Set<string>();
        // What would be written: standard objects without modifications are
        // left out, so adding one and removing it again is not a change.
        const serialize = () => JSON.stringify({ ...file, original: file.original.filter(hasMods) });
        let saved = "";
        // Undo/redo: every change ends in markDirty, which records the whole file (snapshots;
        // object data files are small). Restoring maps the selection back by id.
        const snapshot = () => JSON.stringify({ custom: file.custom, original: file.original, wts: table.serialize() });
        const history = [snapshot()];
        let at = 0;
        const record = () => {
          const s = snapshot();
          if (s === history[at]) return;
          history.splice(at + 1, history.length, s);
          if (history.length > 200) history.shift();
          at = history.length - 1;
        };
        /** Records the change (undo) and re-evaluates the dirty state against the last saved content. */
        const isDirty = () => serialize() !== saved || (savedWts !== null && table.serialize() !== savedWts);
        const markDirty = () => { record(); doc.setDirty(isDirty()); };
        const keyOf = (o: Obj) => (o.id ? `c:${o.id}` : `o:${o.base}`);
        const restore = (s: string) => {
          const keys = new Set([...selection].map(keyOf)), anchor = selected ? keyOf(selected) : null;
          const d = JSON.parse(s) as { custom: Obj[]; original: Obj[]; wts: string };
          file.custom = d.custom;
          file.original = d.original;
          if (savedWts !== null) table = new StringTable(d.wts);
          const all = [...file.custom, ...file.original];
          selection = new Set(all.filter((o) => keys.has(keyOf(o))));
          selected = all.find((o) => keyOf(o) === anchor) ?? [...selection][0] ?? all[0] ?? null;
          if (selected) selection.add(selected);
          doc.setDirty(isDirty());
          renderDetail();
        };
        const step = (dir: -1 | 1) => {
          const to = at + dir;
          if (to < 0 || to >= history.length) return;
          at = to;
          restore(history[at]);
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

        const renderList = () => {
          const group = (title: string, objs: Obj[], action?: HTMLElement) => {
            const items = objs.filter((o) => !filter || `${o.base} ${o.id ?? ""} ${nameOf(o)}`.toLowerCase().includes(filter));
            return [
              h("div.obj-group", {}, h("span", {}, `${title} (${items.length})`), action ?? null),
              ...items.map((o) =>
                h(`div.obj-item${selection.has(o) ? ".selected" : ""}`, { onclick: (e: MouseEvent) => clickItem(o, e) },
                  ICON_FIELD[kind] ? itemIcon(o) : null,
                  h("code", {}, o.id ? `${o.id}` : o.base),
                  o.id ? h("small", { title: stripColors(baseName(o)) }, `← ${o.base}`) : null,
                  h("span", {}, nameOf(o)),
                ),
              ),
            ];
          };
          const matchesFilter = (o: Obj) => !filter || `${o.base} ${o.id ?? ""} ${nameOf(o)}`.toLowerCase().includes(filter);
          // With a filter, only the listed entries are cleaned up.
          const unchanged = file.original.filter((o) => !hasMods(o) && matchesFilter(o)).length;
          const cleanUp = unchanged
            ? h("button.link-inline", {
              title: filter ? "Remove the listed standard objects that have no modified fields" : "Remove standard objects that have no modified fields",
              onclick: () => cleanUpStandard(matchesFilter),
            }, `Clean up (${unchanged})`)
            : undefined;
          visible = [...file.custom, ...file.original].filter(matchesFilter);
          listEl.replaceChildren(...group("Custom", file.custom), ...group("Modified standard", file.original, cleanUp));
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

        /** Removes every selected object after one confirmation. */
        const removeSelection = async () => {
          const objs = [...selection];
          if (!objs.length) return;
          const what = objs.length === 1 ? (objs[0].id || objs[0].base) : `${objs.length} objects`;
          const c = await w3.window.showWarning(`Remove ${what} and all their modifications?`, "Remove", "Cancel");
          if (c !== "Remove") return;
          file.custom = file.custom.filter((o) => !selection.has(o));
          file.original = file.original.filter((o) => !selection.has(o));
          select(file.custom[0] ?? file.original[0] ?? null);
          markDirty(); renderDetail();
        };
        listEl.tabIndex = 0;
        listEl.addEventListener("keydown", (e) => {
          if (e.key === "Delete") { e.preventDefault(); removeSelection(); }
          else if (e.key === "a" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); selection = new Set(visible); renderDetail(); }
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
        const labelButton = (metaType: string, value: string, onCommit: (v: number | string) => void): HTMLElement | null => (metaType !== "soundLabel" ? null
          : h("button.obj-art-view", { title: "Choose one of the game's sound labels", onclick: async () => {
            const label = await pickLabel(el, { title: "Choose a sound label", current: value, labels: () => soundLabels(w3) });
            if (label !== null) onCommit(label);
          } }, "Choose…"));
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
            const text = table.get(ref) ?? "";
            const input = h(`input.obj-value${inherited ? ".inherited" : ""}`, {
              value: text, title: `Text of TRIGSTR_${ref} in war3map.wts (every use of this string changes)`,
              onchange: () => { table.set(ref, input.value); markDirty(); renderDetail(); },
            });
            return h("div.obj-value-cell", {}, input, h("div.obj-resolved", {}, h("code", {}, `TRIGSTR_${ref}`), " · map string"));
          }
          // Object codes and lists of them: the object browser; the value types of UnitEditorData:
          // a choice, a list or flags.
          if (OBJECT_CODE[metaType] || OBJECT_LIST[metaType]) {
            return objectEditor(objects, el, OBJECT_CODE[metaType] ?? OBJECT_LIST[metaType], !!OBJECT_LIST[metaType], mixed ? "" : current, onCommit, !!mixed);
          }
          const et = editorTypes?.get(metaType);
          if (et) return typeEditor(et, mixed ? "" : current, type !== "string", onCommit, mixed && each ? { values: mixed, each } : undefined);
          const resolved = mixed ? null : resolveStr(current);
          const shown = mixed && [...new Set(mixed)].map((v) => stripColors(resolveStr(v) ?? v) || "(empty)");
          const input = h(`input.obj-value${inherited ? ".inherited" : ""}${mixed ? ".mixed" : ""}`, {
            value: mixed ? "" : String(current),
            placeholder: shown ? `mixed: ${shown.slice(0, 4).join(" / ")}${shown.length > 4 ? " / …" : ""}` : "",
            title: shown ? shown.join("\n") : (resolved ?? ""),
            onchange: () => {
              const v = parseValue(type, input.value);
              if (v === null) { input.classList.add("invalid"); return; }
              input.classList.remove("invalid");
              onCommit(v);
            },
          });
          return h("div.obj-value-cell", {}, input, resolved ? h("div.obj-resolved", {}, stripColors(resolved)) : null,
            browseButton(metaType, mixed ? "" : String(current), onCommit), labelButton(metaType, mixed ? "" : String(current), onCommit),
            mixed ? null : artPreview(metaType, String(current)));
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
          return h(`tr${inherited ? "" : ".modified"}`, {},
            h("td", { title: `${f.category} · ${f.type}${f.slk ? ` · ${f.slk}.${f.field}` : ""}` },
              h("span.obj-field-label", {}, f.label),
              h("code", {}, f.id)),
            h("td.muted", {}, levels > 1 ? String(level) : ""),
            h("td", {}, valueEditor(f.valueType, f.type, current, inherited, commit)),
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
            const value = parseValue(type, newValue.value);
            if (value === null) return w3.window.showWarning(`"${newValue.value}" is not a valid ${type}.`);
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
        const renderDetailInner = () => {
          // Edits can change names and the clean-up count in the list too.
          renderList();
          const scroll = detailEl.scrollTop;
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
            for (const f of kd.fieldsFor(o.base)) {
              const lvls = f.repeat > 0 ? Array.from({ length: levels }, (_, i) => i + 1) : [0];
              for (const lv of lvls) {
                const found = findMod(o, f.id, lv);
                if (found) known.add(found.m);
                if (modifiedOnly && !found) continue;
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
            if (!byCategory.size) sections.push(h("div.muted", {}, modifiedOnly ? "No modified fields." : "No fields match."));
          }
          // Mods the field table didn't show: unknown fields, or levels beyond the level count.
          const other = modLists(o).flatMap((l) => l.mods).filter((m) => !known.has(m));
          sections.push(rawTable(o, other, kd ? "Other modifications" : "Modifications"));

          const parts: (HTMLElement | null)[] = [
            preview && kd ? (preview.show(modelOf(o)), preview.el) : null,
            h("div.obj-detail-header", {},
              h("h2", {}, nameOf(o) || "(unnamed)"),
              h("code", {}, o.id ? `${o.id} (based on ${o.base}${baseName(o) ? ` · ${stripColors(baseName(o))}` : ""})` : o.base),
              h("button", { title: "Delete key also removes the selection", onclick: removeSelection }, "Remove object"),
            ),
            kd ? h("div.obj-detail-toolbar", {},
              fieldSearch,
              h("label", {}, h("input", { type: "checkbox", checked: modifiedOnly, onchange: (e: Event) => { modifiedOnly = (e.target as HTMLInputElement).checked; renderDetail(); } }), " Modified only"),
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
            const distinct = [...new Set(values)];
            const isSame = distinct.length === 1;
            const commit = (v: number | string) => { for (const o of objs) setValue(o, f, level, v); markDirty(); renderDetail(); };
            const each = (change: (old: string) => number | string) => { for (const o of objs) setValue(o, f, level, change(effective(o, f, level))); markDirty(); renderDetail(); };
            const row = h(`tr${anyModified ? ".modified" : ""}`, {},
              h("td", { title: `${f.category} · ${f.type}` }, h("span.obj-field-label", {}, f.label), h("code", {}, f.id)),
              h("td.muted", {}, level ? String(level) : ""),
              h("td", {}, valueEditor(f.valueType, f.type, isSame ? values[0] : "", !anyModified, commit, isSame ? undefined : values, each)),
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
              h("label", {}, h("input", { type: "checkbox", checked: modifiedOnly, onchange: (e: Event) => { modifiedOnly = (e.target as HTMLInputElement).checked; renderDetail(); } }), " Modified in any")),
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
          const overlay = h("div.picker-overlay", { tabindex: -1, onmousedown: (e: MouseEvent) => { if (e.target === overlay) close(); }, onkeydown: (e: KeyboardEvent) => { if (e.key === "Escape") close(); } },
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
        const newObject = async () => {
          const base = await pickBase(`New ${kindInfo?.singular ?? "object"} based on… (hold Shift to choose the id)`);
          if (!base || base.length !== 4) return;
          const askId = shiftHeld;
          const taken = new Set<string>([...file.custom.map((o) => o.id ?? ""), ...file.original.map((o) => o.base), ...(kd?.baseIds ?? [])]);
          // The next free id, like the World Editor (also free among the other object types).
          let free = nextFreeId(kind, base, taken);
          for (let n = 0; n < 50 && (await usedElsewhere(free)); n++) { taken.add(free); free = nextFreeId(kind, base, taken); }
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
          const k = e.key.toLowerCase();
          if (k === "z" && !e.shiftKey) { e.preventDefault(); step(-1); }
          else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); step(1); }
        });
        const focusObject = (id: string) => {
          search.value = id;
          filter = id.toLowerCase();
          const o = file.custom.find((c) => c.id === id) ?? file.original.find((c) => c.base === id);
          select(o ?? null);
          renderList();
          renderDetail();
          if (o) return;
          // An unchanged game object: shown as a standard entry without modifications, like the World
          // Editor (such entries aren't written, so this changes nothing until a field is edited).
          void loadKind(w3, kind).then((k) => {
            if (!k.names.has(id)) {
              status.textContent = `${id} isn't in this map's object data or the game's — a campaign's custom object is edited in the campaign project.`;
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
        renderList();
        renderDetail();
        if (pendingFocus?.path === doc.path) {
          focusObject(pendingFocus.id);
          pendingFocus = null;
        }
        status.textContent ||= "Loading game data…";
        loadEditorTypes(w3).then((t) => { editorTypes = t; renderDetail(); }, () => {});
        loadKind(w3, kind).then(
          (k) => { kd = k; if (status.textContent === "Loading game data…") status.textContent = ""; renderList(); renderDetail(); },
          (e) => { status.textContent = `Game data unavailable — showing raw ids (${e})`; },
        );

        return {
          async save() {
            // The backend encodes the JSON to binary (validating it) and returns
            // it in canonical formatting, so diffs stay minimal.
            const text = await w3.backend.invoke<string>("objects_canonicalize", { name: doc.path, text: serialize() });
            await doc.writeText(text);
            if (isNew && !exists()) await w3.workspace.refresh();
            // Edited strings go to war3map.wts, merged onto the file as it is now (other editors
            // may have saved strings meanwhile; only changed blocks are rewritten).
            if (savedWts !== null && table.serialize() !== savedWts) {
              const base = savedWts;
              const current = await w3.workspace.readText("map/war3map.wts").catch(() => base);
              const merged = StringTable.merge(base, table, current);
              if (merged !== current) await w3.workspace.writeText("map/war3map.wts", merged);
              savedWts = merged;
              table = new StringTable(merged);
            }
            saved = serialize();
            doc.setDirty(false);
            w3.views.refresh("w3.objects.kinds");
          },
          focus: () => search.focus(),
          dispose: () => { focusers.delete(doc.path); preview?.dispose(); },
          watches: ["map/war3map.wts"],
        };
      },
    }),
  );
}
