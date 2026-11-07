// The built-in checks of the Problems view (more in mapchecks.ts): the map script's errors, file
// paths in object data that don't exist (or point to someone's disk),
// textures of imported models, placed objects of unknown types, placed objects
// without a Classic model, and import list entries without their file.

import { readMapDoc } from "../../lib/formats/mapdoc";
import type { W3Api } from "../../extensions/api";
import type { Problem, ProblemCheck, ProblemFix } from "../../extensions/services";
import { toProjectPath } from "../../lib/formats/archivepath";
import { encodeBlp1Jpeg } from "../../lib/image/encode";
import { decodeImage } from "../../lib/image/index.ts";
import { toClassicMdx } from "../../lib/model/classic";
import { checkJass } from "../../lib/jass/check";
import { checkLua } from "../../lib/lua/check";
import { gameJassEnv } from "../../lib/jass/env";
import { parseMdx, renameTextures } from "../../lib/model/mdx";
import { loadKind } from "../../lib/objects/metadata";
import { type ModeChoices, pickClassicModel } from "./modelpick";
import { chooseFolder, mergedValues, modelExists, modelFieldValue, modelNames, planImports, planModelEdit, serialQueue, textureLacking } from "./fixplan";
import { conversionSources, missingTextures, readLayered, type Source, SOURCE_NAME, sourcesText, textureCandidates, uniqueName } from "./reforged";
import { gamePartOf, isMachinePath } from "../../lib/model/texpath";
import { editPlacedFile, isRandomId, knownPlacedTypes } from "./invalid";
import { FileLookup, type FileKind } from "./lookup";
import { mapLimit, RunScope } from "./runscope";

export { FileLookup };

const KINDS = ["w3u", "w3t", "w3a", "w3h", "w3b", "w3d", "w3q"];
/** Object data field types that hold file paths (shadow textures are names, not paths). */
const PATH_TYPES = new Set(["model", "modelList", "icon", "texture", "pathingTexture"]);
/** At most this many problems per check (the rest is summarised). */
const LIMIT = 200;

interface Obj { base: string; id?: string; mods?: Mod[]; sets?: { mods: Mod[] }[] }
interface Mod { field: string; value: number | string; level?: number }

/** A path that only exists on someone's machine, or climbs out of the map. */
export const isAbsolute = (p: string) => /^[a-z]:[\\/]/i.test(p) || /^[\\/]{2}/.test(p) || /(^|[\\/])\.\.([\\/]|$)/.test(p);

/** A map file's JSON document ("map/x.json"), also from the raw file of older projects. */
export { readMapDoc };
const capped = (list: Problem[], what: string): Problem[] =>
  list.length > LIMIT ? [...list.slice(0, LIMIT), { severity: "warning", message: `… and ${list.length - LIMIT} more ${what}` }] : list;

/** A kind's object files: the map's and the campaign's, each with its skin file. */
const objectFiles = (kind: string) => [`map/war3map.${kind}.json`, `map/war3mapSkin.${kind}.json`, `map/war3campaign.${kind}.json`, `map/war3campaignSkin.${kind}.json`];
/** At most this many numbered variations of a model are looked up in the batch; more are asked one by one. */
const BATCH_VARIATIONS = 64;
/** Imported models read at the same time by "Textures of imported models". */
const MODEL_READS = 6;

/** `scope`: what the checks of the current run share (the Problems service makes one per run);
 *  without it, every check reads everything itself. */
export function builtinChecks(w3: W3Api, scope: () => RunScope = () => new RunScope(w3, false)): ProblemCheck[] {
  return [
    {
      id: "jass",
      title: "Map script",
      async run() {
        const path = "map/war3map.j";
        const src = await w3.workspace.readText(path).catch(() => null);
        if (src === null) {
          const lua = await w3.workspace.readText("map/war3map.lua").catch(() => null);
          if (lua === null) return [];
          const lineAt = (at: number) => lua.slice(0, at).split("\n").length;
          return capped(checkLua(lua).map((d): Problem => ({
            severity: "error", message: d.message, location: `war3map.lua:${lineAt(d.from)}`,
            reveal: { command: "w3.text.revealAt", args: ["map/war3map.lua", lua.slice(0, d.from).replace(/\r\n/g, "\n").length] },
          })), "script problems");
        }
        const env = await gameJassEnv((p) => w3.game.readText(p));
        const lineOf = (at: number) => src.slice(0, at).split("\n").length;
        // The text editor counts a line break as one character, also in CRLF files.
        const editorOffset = (at: number) => src.slice(0, at).replace(/\r\n/g, "\n").length;
        return capped(checkJass(src, env).map((d): Problem => ({
          severity: d.severity, message: d.message, location: `war3map.j:${lineOf(d.from)}`,
          reveal: { command: "w3.text.revealAt", args: [path, editorOffset(d.from)] },
        })), "script problems");
      },
    },
    {
      id: "objectPaths",
      title: "Files used by object data",
      async run() {
        const s = scope();
        const files = s.lookup();
        const out: Problem[] = [];
        type Meta = NonNullable<Awaited<ReturnType<typeof loadKind>>>;
        /** What an object field's file is looked up as, and how many numbered models it stands for: a
         *  doodad or destructable with several variations names its model without the number; the files
         *  are X0.mdx, X1.mdx… */
        const lookupOf = (type: string, id: string, base: string, vars: Map<string, string>, meta: Meta, variationsField?: string) => {
          const what: FileKind = type.startsWith("model") ? "model" : type === "icon" || type.endsWith("exture") ? "texture" : "file";
          let variations = 1;
          if (what === "model" && variationsField) {
            // The count as the game merges the main and the skin file; else the base type's.
            const f = meta.fieldById.get(variationsField);
            variations = Number(vars.get(id) ?? (f ? meta.defaultValue(base, f, 0) : 1)) || 1;
          }
          return { what, variations };
        };
        // Every object file at once, and the game's data of each kind that has one.
        await s.prefetch(KINDS.flatMap(objectFiles));
        const metas = new Map(await Promise.all(KINDS.map(async (kind) => {
          const has = (await Promise.all(objectFiles(kind).map((f) => s.doc(f)))).some((d) => d);
          return [kind, has ? loadKind(w3, kind).catch(() => null) : null] as const;
        })));
        // First what to look up, in the order of the problems; then the game paths of all of it at once.
        const found: { p: string; at: string; reveal: { command: string; args: unknown[] }; what?: FileKind; variations?: number }[] = [];
        for (const kind of KINDS) {
          let meta: Awaited<ReturnType<typeof loadKind>> | null = null;
          const variationsField = ART[kind]?.variations;
          const vars = variationsField
            ? mergedValues(await Promise.all(objectFiles(kind).map((f) => s.doc<{ original?: Obj[]; custom?: Obj[] }>(f))), variationsField)
            : new Map<string, string>();
          for (const file of objectFiles(kind)) {
            const data = await s.doc<{ original?: Obj[]; custom?: Obj[] }>(file);
            if (!data) continue;
            meta ??= await metas.get(kind)!;
            if (!meta) continue;
            for (const o of [...(data.custom ?? []), ...(data.original ?? [])]) {
              const id = o.id ?? o.base;
              const name = meta.names.get(o.base) ?? id;
              const mods = [...(o.mods ?? []), ...(o.sets ?? []).flatMap((s) => s.mods)];
              for (const m of mods) {
                const f = meta.fieldById.get(m.field);
                if (!f || !PATH_TYPES.has(f.type) || typeof m.value !== "string") continue;
                // "none.mdl" / "_": deliberately no model (e.g. no portrait).
                const paths = (f.type.endsWith("List") ? m.value.split(",") : [m.value]).map((p) => p.trim())
                  .filter((p) => p && p !== "_" && p !== "." && !/^none(\.\w+)?$/i.test(p));
                for (const p of paths) {
                  const at = `${name} (${id}) › ${f.label}${m.level ? ` (level ${m.level})` : ""}`;
                  const reveal = { command: "w3.objectEditor.open", args: [kind, id] };
                  found.push(isAbsolute(p) ? { p, at, reveal } : { p, at, reveal, ...lookupOf(f.type, id, o.base, vars, meta, variationsField) });
                }
              }
            }
          }
        }
        await files.prefetch(found.flatMap(({ p, what, variations }) => (what ? modelNames(p, Math.min(variations!, BATCH_VARIATIONS)).map((x): [string, FileKind] => [x, what]) : [])));
        for (const { p, at, reveal, what, variations } of found) {
          if (!what) out.push({ severity: "error", message: `${p}: a path on someone's disk, not in the map`, location: at, reveal });
          else if (!(await modelExists(p, variations!, (x) => files.exists(x, what)))) {
            out.push({ severity: "warning", message: `${p} not found (neither in the map nor in the game)`, location: at, reveal });
          }
        }
        return capped(out, "missing files");
      },
    },
    {
      id: "modelTextures",
      title: "Textures of imported models",
      async run() {
        const files = scope().lookup();
        const out: Problem[] = [];
        const models = w3.workspace.files().filter((f) => /^map\/.+\.mdx$/i.test(f.path.replace(/\\/g, "/")));
        // Several models read at once; only their texture lists are kept.
        const read = await mapLimit(models, MODEL_READS, async (f) => {
          try { return { textures: parseMdx(await w3.workspace.readBytes(f.path)).textures.map(({ replaceableId, path }) => ({ replaceableId, path })) }; } catch (e) { return { error: e }; }
        });
        const lookedUp = (t: { replaceableId: number; path: string }) => t.replaceableId === 0 && !!t.path && !isAbsolute(t.path);
        await files.prefetch(read.flatMap((r) => (r.textures ?? []).filter(lookedUp).map((t): [string, FileKind] => [t.path, "texture"])));
        for (const [i, f] of models.entries()) {
          const { textures, error: e } = read[i];
          if (!textures) {
            out.push({ severity: "warning", message: `can't be read: ${(e as Error).message ?? e}`, location: f.path, reveal: { command: "w3.problems.open", args: [f.path] } });
            continue;
          }
          for (const t of textures) {
            if (t.replaceableId !== 0 || !t.path) continue;
            const reveal = { command: "w3.problems.open", args: [f.path] };
            if (isAbsolute(t.path)) out.push({ severity: "warning", message: `texture ${t.path}: a path on someone's disk`, location: f.path, reveal });
            else if (!(await files.exists(t.path, "texture"))) out.push({ severity: "warning", message: `texture ${t.path} not found`, location: f.path, reveal });
          }
        }
        return capped(out, "texture problems");
      },
    },
    {
      id: "placements",
      title: "Placed objects",
      async run() {
        const s = scope();
        const readJson = <T>(_: W3Api, path: string) => s.doc<T>(path);
        await s.prefetch(["map/war3mapUnits.doo.json", "map/war3map.doo.json", "map/war3map.w3i.json"]);
        const { known, inUnits, inDoodads } = await knownPlacedTypes(w3, loadKind, (path) => s.docStrict(path));
        const random = isRandomId;
        const unknown = new Map<string, { n: number; x: number; y: number; file: string }>();
        const misplaced = new Map<string, { n: number; x: number; y: number; file: string }>();
        for (const [file, key] of [["map/war3mapUnits.doo.json", "units"], ["map/war3map.doo.json", "doodads"]] as const) {
          const list = (await readJson<Record<string, { id: string; position: number[] }[]>>(w3, file))?.[key] ?? [];
          for (const p of list) {
            if (random(p.id)) continue;
            const own = key === "units" ? inUnits : inDoodads, other = key === "units" ? inDoodads : inUnits;
            const list2 = !known.has(p.id) ? unknown : other.has(p.id) && !own.has(p.id) ? misplaced : null;
            if (!list2) continue;
            const u = list2.get(p.id) ?? { n: 0, x: p.position[0], y: p.position[1], file };
            u.n++;
            list2.set(p.id, u);
          }
        }
        // The script leaves a missing table out, so such objects drop nothing, and nobody would know.
        const tables = new Set(((await readJson<{ itemTables?: { number: number }[] }>(w3, "map/war3map.w3i.json"))?.itemTables ?? []).map((t) => t.number));
        const noTable = new Map<string, { n: number; x: number; y: number; file: string }>();
        for (const [file, key] of [["map/war3mapUnits.doo.json", "units"], ["map/war3map.doo.json", "doodads"]] as const) {
          for (const p of (await readJson<Record<string, { id: string; position: number[]; itemTable?: number }[]>>(w3, file))?.[key] ?? []) {
            if ((p.itemTable ?? -1) < 0 || tables.has(p.itemTable as number)) continue;
            const u = noTable.get(p.id) ?? { n: 0, x: p.position[0], y: p.position[1], file };
            u.n++;
            noTable.set(p.id, u);
          }
        }
        const report = (list: typeof unknown, say: (id: string, u: { n: number }) => string) => [...list].map(([id, u]): Problem => ({
          severity: "warning", message: say(id, u), location: u.file.slice(4), reveal: { command: "w3.terrain.showPoint", args: [u.x, u.y] },
        }));
        return capped([
          ...report(unknown, (id, u) => `${id}: unknown object type (not in the game's or the map's object data), placed ${u.n}×`),
          ...report(noTable, (id, u) => `${id}: drops from an item table the map no longer has, placed ${u.n}×: it drops nothing from it`),
          ...report(misplaced, (id, u) => `${id}: in the wrong placement file, placed ${u.n}×: units and items belong in war3mapUnits.doo, doodads and destructables in war3map.doo`),
        ], "unknown types");
      },
    },
    {
      id: "classicModels",
      title: "Graphics modes",
      run: () => classicModels(w3, scope()),
    },
    {
      id: "imports",
      title: "Imported files",
      async run() {
        const s = scope();
        const files = s.lookup();
        const out: Problem[] = [];
        const lists = [["map/war3map.imp.json", "war3mapImported"], ["map/war3campaign.imp.json", "war3campImported"]] as const;
        await s.prefetch(lists.map(([list]) => list));
        /** The names an entry's file may have: "standard path" entries (flags 5, 8) name a file inside
         *  the import folder; a sound may be stored under its other extensions. */
        const variantsOf = (e: { flags: number; path: string }, folder: string) => {
          const paths = [5, 8].includes(e.flags) ? [`${folder}\\${e.path}`, e.path] : [e.path];
          const sound = /\.(flac|ogg|mp3|wav)$/i.test(e.path);
          return paths.flatMap((p) => (sound ? [".flac", ".ogg", ".mp3", ".wav"].map((x) => p.replace(/\.\w+$/, x)) : [p]));
        };
        // The game paths of every entry the map doesn't have, at once.
        const gamePaths: string[] = [];
        for (const [list, folder] of lists) {
          for (const e of (await s.doc<{ files?: { flags: number; path: string }[] }>(list))?.files ?? []) {
            const variants = variantsOf(e, folder);
            if (!variants.some((v) => files.inMap(v))) gamePaths.push(...variants);
          }
        }
        await files.prefetchGame(gamePaths);
        for (const [list, folder] of lists) {
          const data = await s.doc<{ files?: { flags: number; path: string }[] }>(list);
          for (const e of data?.files ?? []) {
            const variants = variantsOf(e, folder);
            if (variants.some((v) => files.inMap(v))) continue;
            let inGame = false;
            for (const v of variants) if (await files.inGame(v)) { inGame = true; break; }
            if (!inGame) out.push({ severity: "warning", message: `${e.path} is listed but its file is missing`, location: list.slice(4), reveal: { command: "w3.imports.open" } });
          }
        }
        return capped(out, "missing imports");
      },
    },
  ];
}

/** Model field and variation count field per object kind. */
const ART: Record<string, { model: string; variations?: string }> = {
  w3u: { model: "umdl" }, w3t: { model: "ifil" }, w3d: { model: "dfil", variations: "dvar" }, w3b: { model: "bfil", variations: "bvar" },
};

interface PlacedEntry { id: string; variation?: number; position: number[] }

/** The graphics modes: the map info's supported-modes bit, and the game folder searched before
 *  the Classic one (bits as the game's maps use them: Classic campaign 1, Reforged campaign 2,
 *  melee 3, Forsaken Kingdom 4). */
const MODES = [
  { bit: 1, name: "Classic", layer: null },
  { bit: 2, name: "Reforged (HD)", layer: "_hd" },
  { bit: 4, name: "Reforged (DE)", layer: "_de" },
] as const;

/** Placed objects whose model is missing in a graphics mode the map supports (Classic falls
 *  back to nothing, HD and DE each only to Classic, never to one another): players in that mode
 *  don't see them. Maps without the supported-modes field (before 1.32) count as Classic only. */
/** What classicModels takes from the game's file list: game paths (lowercase, without the folder
 *  prefix) per art folder (Classic, _hd, _de), the Classic models and the Reforged ones by set (as
 *  stored, for the pickers of the fixes, which only read them). */
interface GameModels { stored: Map<string | null, Set<string>>; classicModels: Set<string>; reforgedModels: Record<Source, Set<string>> }
/** Per file list: the game service keeps one list until the game folder changes, so a new list is a new key. */
const gameModelsCache = new WeakMap<string[], GameModels>();

function gameModels(list: string[]): GameModels {
  const known = gameModelsCache.get(list);
  if (known) return known;
  const stored = new Map<string | null, Set<string>>(MODES.map((m) => [m.layer, new Set()]));
  const classicModels = new Set<string>();
  const reforgedModels: Record<Source, Set<string>> = { de: new Set(), hd: new Set() };
  for (const full of list) {
    const path = full.slice(full.lastIndexOf(":") + 1);
    const layer = /:_(hd|de)\.w3mod:/i.exec(full)?.[1].toLowerCase();
    stored.get(layer ? `_${layer}` : null)!.add(path.replace(/\\/g, "/").toLowerCase());
    if (/\.mdx$/i.test(path) && !/_portrait\.mdx$/i.test(path)) {
      if (!layer) classicModels.add(path.replace(/\//g, "\\"));
      else if (/:_(hd|de)\.w3mod:[^:]*$/i.test(full)) reforgedModels[layer as Source].add(path.replace(/\//g, "\\"));
    }
  }
  const out = { stored, classicModels, reforgedModels };
  gameModelsCache.set(list, out);
  return out;
}

async function classicModels(w3: W3Api, s: RunScope): Promise<Problem[]> {
  const readJson = <T>(_: W3Api, path: string) => s.doc<T>(path);
  const info = await readJson<{ supportedModes?: number }>(w3, "map/war3map.w3i.json");
  const supported = MODES.filter((m) => (info?.supportedModes ?? 1) & m.bit);
  if (!supported.length) return [];
  const { stored, classicModels, reforgedModels } = gameModels(await w3.game.list());
  const files = s.lookup();
  // The project the problems were found in: the fixes write into no other.
  const root = w3.workspace.project()?.root;
  const kinds = new Map<string, Awaited<ReturnType<typeof loadKind>>>();
  const loaded = await Promise.all(Object.keys(ART).map((kind) => loadKind(w3, kind).catch(() => null)));
  Object.keys(ART).forEach((kind, i) => { if (loaded[i]) kinds.set(kind, loaded[i]); });
  await s.prefetch(Object.keys(ART).flatMap((kind) => [`map/war3map.${kind}.json`, `map/war3mapSkin.${kind}.json`]));
  // The map's own objects and skin changes: id → [kind, base, field → value].
  const custom = new Map<string, { kind: string; base: string; mods: Map<string, string> }>();
  for (const kind of Object.keys(ART)) {
    for (const file of [`map/war3map.${kind}.json`, `map/war3mapSkin.${kind}.json`]) {
      const data = await readJson<{ custom?: Obj[]; original?: Obj[] }>(w3, file);
      for (const o of [...(data?.original ?? []), ...(data?.custom ?? [])]) {
        const id = o.id ?? o.base;
        const c = custom.get(id) ?? { kind, base: o.base, mods: new Map() };
        for (const m of o.mods ?? []) c.mods.set(m.field, String(m.value));
        custom.set(id, c);
      }
    }
  }
  const kindOf = (id: string, fromUnits: boolean) => custom.get(id)?.kind
    ?? (fromUnits ? ["w3u", "w3t"] : ["w3d", "w3b"]).find((k) => kinds.get(k)?.names.has(id));
  const value = (id: string, kind: string, field: string): string | undefined => {
    const c = custom.get(id);
    if (c?.mods.has(field)) return c.mods.get(field);
    const k = kinds.get(kind), base = c?.base ?? id, f = k?.fieldById.get(field);
    return k && f ? k.defaultValue(base, f, 0) : undefined;
  };
  const found = new Map<string, (typeof MODES)[number][]>();
  /** The supported modes that can't load a model: not in the map (imports count for every
   *  mode), nor in the mode's folder or the Classic one. */
  const missingIn = async (path: string) => {
    const known = found.get(path);
    if (known) return known;
    const key = path.replace(/\\/g, "/").toLowerCase();
    // Only the map's own copy counts here (once a chapter map's campaign files are listed too): the
    // game's is decided by the art folders below.
    await files.whenReady();
    const imported = files.inMap(path);
    const out = imported || stored.get(null)!.has(key) ? [] : supported.filter((m) => !m.layer || !stored.get(m.layer)!.has(key));
    found.set(path, out);
    return out;
  };
  const inReforged = (path: string) => ["_de", "_hd"].some((l) => stored.get(l)!.has(path.replace(/\\/g, "/").toLowerCase()));

  const out: Problem[] = [];
  for (const [file, key] of [["map/war3mapUnits.doo.json", "units"], ["map/war3map.doo.json", "doodads"]] as const) {
    const list = (await readJson<Record<string, PlacedEntry[]>>(w3, file))?.[key] ?? [];
    const missing = new Map<string, { items: PlacedEntry[]; paths: Set<string>; modes: Set<string> }>();
    for (const p of list) {
      const kind = kindOf(p.id, key === "units");
      if (!kind) continue; // unknown types: the "Placed objects" check
      const model = value(p.id, kind, ART[kind].model);
      if (!model || model === "_") continue;
      const variations = Number(ART[kind].variations ? value(p.id, kind, ART[kind].variations!) : 1) || 1;
      const stem = model.replace(/\.(mdl|mdx)$/i, "");
      const path = `${stem}${variations > 1 ? p.variation ?? 0 : ""}.mdx`;
      const modes = await missingIn(path);
      if (!modes.length) continue;
      const m = missing.get(p.id) ?? { items: [], paths: new Set(), modes: new Set() };
      m.items.push(p);
      m.paths.add(path);
      for (const mode of modes) m.modes.add(mode.name);
      missing.set(p.id, m);
    }
    for (const [id, { items, paths, modes }] of missing) {
      const kind = kindOf(id, key === "units")!;
      const base = custom.get(id)?.base ?? id;
      const name = kinds.get(kind)?.names.get(base) ?? id;
      const where = MODES.filter((m) => modes.has(m.name)).map((m) => m.name).join(", ");
      // The Reforged sets that have every model of the type: a Classic model can be made from each.
      const sources = conversionSources([...paths], (s, key) => stored.get(`_${s}`)!.has(key));
      // Models split over both sets: taken from whichever has each.
      if (!sources.length && [...paths].every(inReforged)) sources.push("de");
      const fixes: ProblemFix[] = [];
      // One button per set to take the model from, when there is a choice.
      for (const source of sources) {
        const set = SOURCE_NAME[source], pick = sources.length > 1 ? ` from ${set}` : "";
        fixes.push({
          label: `Convert${pick} to a Classic model`,
          title: `Writes a Classic copy of the ${set} model (and its colour textures) into the map and points the type at it; every graphics mode shows it, with the Classic look (no Reforged extra maps or effects)`,
          run: () => serial(async () => {
            const model = value(id, kind, ART[kind].model) ?? "";
            const variations = Number(ART[kind].variations ? value(id, kind, ART[kind].variations!) : 1) || 1;
            const bytes = await convertToClassic(w3, root, kind, base, id, model, variations, source);
            void w3.window.showInfo(`Converted ${name} from the ${set} model to a Classic model (${(bytes / 1048576).toFixed(1)} MB in the map).`);
          }),
        });
      }
      // Without Classic, the Reforged model itself can be imported: both Reforged modes draw it.
      for (const source of modes.has("Classic") ? [] : sources) {
        const set = SOURCE_NAME[source], pick = sources.length > 1 ? ` ${set}` : "";
        fixes.push({
          label: `Import the${pick} Reforged model`,
          title: `Copies the ${set} model (and the textures ${where} lacks) into the map, at the path the type names; the map doesn't support Classic, which couldn't draw it`,
          run: () => serial(async () => {
            const lacking = supported.filter((m) => m.layer && modes.has(m.name)).map((m) => m.layer!);
            // A texture the map has itself (the user's own import) is not lacking.
            const bytes = await importReforged(w3, root, [...paths], source, (cands, inMap) => textureLacking(cands, inMap, lacking, (l, k) => stored.get(l)!.has(k)));
            void w3.window.showInfo(`Imported ${name}'s ${set} model (${(bytes / 1048576).toFixed(1)} MB in the map).`);
          }),
        });
      }
      fixes.push({
        label: "Replace with a Classic game model…",
        title: "Pick one of the game's own Classic models for this type (every graphics mode can load those); it's written into the map's object data (a modified standard object), and the type's Reforged model is no longer used",
        run: () => useClassicModel(w3, root, kind, base, id, name, [...paths][0] ?? "", classicModels, reforgedModels, sources),
      }, {
        label: `Remove the ${items.length} placed`,
        title: `Deletes every placed ${name} (${id}) from ${file.slice(4)}`,
        run: () => removePlaced(w3, file, key, id),
      });
      out.push({
        severity: "warning",
        message: `${name} (${id}): no model in ${where} graphics, invisible there; placed ${items.length}×`
          + (sources.length ? `. ${sourcesText(sources, [...paths][0])}` : ""),
        location: file.slice(4),
        reveal: { command: "w3.terrain.showPoint", args: [items[0].position[0], items[0].position[1]] },
        fixes,
      });
    }
  }
  return capped(out, "objects with a missing model");
}

/** Deletes every placed object of a type from a placement file (JSON form or raw). */
const removePlaced = (w3: W3Api, file: string, key: string, id: string) =>
  editPlacedFile(w3, file, (doc) => { doc[key] = (doc[key] ?? []).filter((p) => p.id !== id); });

/** Fixes run one at a time: each reads and writes war3map.imp and the object data. */
const serial = serialQueue();

/** The fix was found in a project; it must not write into another one opened since. */
function sameProject(w3: W3Api, root: string | undefined) {
  if (!root || w3.workspace.project()?.root !== root) throw new Error("Another project is open than the one this was found in; nothing was changed. Run the check again.");
}

/** Asks for one of the game's models (best name matches first), from the Classic files or, to be
 *  converted, a Reforged set's, and writes it into the type's model field in the map's object data
 *  (a modified standard object, or the custom object itself); variations are set to 1 (the chosen
 *  model has no numbered variants). A Reforged model is converted to a Classic one first. Only the
 *  type the picker was opened for changes. */
async function useClassicModel(
  w3: W3Api, root: string | undefined, kind: string, base: string, id: string, name: string, current: string,
  classic: Set<string>, reforged: Record<Source, Set<string>>, preferred: Source[],
) {
  // Words of the current model's file name ("Wood_Debris_Barrels_01" → wood, debris, barrels).
  const words = (current.split(/[\\/]/).pop() ?? "").replace(/\.\w+$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
  const score = (p: string) => { const l = p.toLowerCase(); return words.reduce((n, w) => n + (l.includes(w) ? 1 : 0), 0); };
  const choices = (models: Set<string>) => [...models].map((p) => ({ p, s: score(p) })).sort((x, y) => y.s - x.s || x.p.localeCompare(y.p)).map(({ p, s }) => ({
    path: p, label: p.split("\\").pop()!.replace(/\.mdx$/i, ""), detail: p.replace(/\\[^\\]+$/, "") + (s ? "  ·  name match" : ""),
  }));
  const modes: ModeChoices[] = [{ mode: "classic", label: "Classic", choices: choices(classic) }];
  // The set the type's own Reforged model comes from first.
  for (const s of [...preferred, ...(["de", "hd"] as const).filter((x) => !preferred.includes(x))]) {
    if (reforged[s].size) modes.push({ mode: s, label: `Reforged (${SOURCE_NAME[s]}), converted to Classic`, choices: choices(reforged[s]) });
  }
  const pick = await pickClassicModel(w3, { title: `Model for ${name} (${id})`, current: current || null, modes });
  if (!pick) return;
  if (pick.mode === "classic") {
    await serial(async () => {
      sameProject(w3, root);
      const apply = await prepareModel(w3, kind, base, id, modelFieldValue(kind, pick.path), 1);
      sameProject(w3, root);
      await apply();
      await w3.workspace.refresh();
    });
    return;
  }
  const bytes = await serial(() => convertToClassic(w3, root, kind, base, id, pick.path, 1, pick.mode as Source));
  void w3.window.showInfo(`Converted ${pick.path.split("\\").pop()} from the ${SOURCE_NAME[pick.mode as Source]} files to a Classic model for ${name} (${(bytes / 1048576).toFixed(1)} MB in the map).`);
}

/** Works out a type's model edit (see planModelEdit) and returns the function that writes it: every
 *  check that can fail happens here, before the caller writes its first file. */
async function prepareModel(w3: W3Api, kind: string, base: string, id: string, model: string, variations: number): Promise<() => Promise<void>> {
  const path = `map/war3map.${kind}.json`, skinPath = `map/war3mapSkin.${kind}.json`;
  const names = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
  // A file that is listed but can't be read is not an absent one: writing a fresh document over it would destroy it.
  const main = await readListed(w3, names, path);
  const skin = await readListed(w3, names, skinPath);
  if (skin === null && names.has(skinPath.slice(0, -5).toLowerCase())) throw new Error(`war3mapSkin.${kind} is kept raw in this project; set the model in the Object Editor.`);
  const plan = planModelEdit({ kind, base, id, model, variations, fields: MODEL_FIELDS[kind], main, mainRaw: names.has(path.slice(0, -5).toLowerCase()), skin });
  const canon = (p: string, doc: unknown) => w3.backend.invoke<string>("objects_canonicalize", { name: p, text: JSON.stringify(doc) });
  const mainText = await canon(path, plan.main);
  const skinText = plan.skin ? await canon(skinPath, plan.skin) : null;
  return async () => {
    await w3.workspace.writeText(path, mainText);
    if (skinText !== null) await w3.workspace.writeText(skinPath, skinText);
  };
}

/** The text of a project file that is in the file list: null only when it is not listed. A listed
 *  file that can't be read throws, naming it. */
export async function readListed(w3: W3Api, names: Set<string>, path: string): Promise<string | null> {
  if (!names.has(path.toLowerCase())) return null;
  try { return await w3.workspace.readText(path); } catch (e) { throw new Error(`${path} can't be read (${(e as Error).message ?? e}); nothing was changed.`); }
}

/** Model and variation count fields of a kind's object data. */
const MODEL_FIELDS: Record<string, { model: string; variations?: string }> = ART;

/** Works out the import list with `names` added and returns the function that writes it. */
async function prepareImports(w3: W3Api, names: string[]): Promise<() => Promise<void>> {
  const root = w3.workspace.project()!.root;
  const listed = new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
  const json = await readListed(w3, listed, "map/war3map.imp.json");
  let raw: string | null = null;
  if (json === null && listed.has("map/war3map.imp")) {
    try { raw = await w3.backend.invoke<string>("codec_decode", { root, path: "map/war3map.imp" }); } catch (e) { throw new Error(`map/war3map.imp can't be read (${(e as Error).message ?? e}); nothing was changed.`); }
  }
  const { doc, asRaw } = planImports(json, raw, names);
  if (asRaw) return async () => { await w3.backend.invoke("codec_write", { root, path: "map/war3map.imp", text: JSON.stringify(doc) }); };
  const text = await w3.backend.invoke<string>("codec_canonicalize", { root, path: "map/war3map.imp.json", text: JSON.stringify(doc) });
  return async () => { await w3.workspace.writeText("map/war3map.imp.json", text); };
}

/** The game's copy of a file from the Reforged set `source` (else the other one, else Classic's), for
 *  a texture under the names the game also accepts (.dds for .tif/.blp/.tga, the game part of a
 *  build machine's path). `name` is the game path it was found under. */
async function readReforged(w3: W3Api, path: string, source: Source, modelPath = ""): Promise<{ name: string; bytes: Uint8Array }> {
  const isTexture = /\.(blp|tif|tiff|tga|png|jpg|dds)$/i.test(path);
  const candidates = isTexture ? textureCandidates(path, modelPath) : [path.replace(/\\/g, "/")];
  const { name, bytes } = await readLayered(candidates, source, (full) => w3.game.read(full), path);
  return { name, bytes };
}

/** Writes a fix's files, then its steps (import list, object data), checking before each write that
 *  the project is still the one the fix was found in. If something fails before the first step is
 *  done, the files this fix newly created are removed again; later, the files and the entries made
 *  so far stay, and the error says so. */
export async function writeFix(w3: W3Api, root: string | undefined, files: Map<string, Uint8Array>, isNew: (archive: string) => boolean, steps: (() => Promise<void>)[]) {
  const created: string[] = [];
  let stepsDone = 0;
  try {
    for (const [archive, bytes] of files) {
      sameProject(w3, root);
      const path = `map/${toProjectPath(archive)}`;
      await w3.workspace.writeBytes(path, bytes);
      if (isNew(archive)) created.push(path);
    }
    for (const step of steps) { sameProject(w3, root); await step(); stepsDone++; }
  } catch (e) {
    const why = (e as Error).message ?? String(e);
    if (stepsDone === 0 && w3.workspace.project()?.root === root) {
      const failed: string[] = [];
      for (const p of created) await w3.workspace.delete(p).catch(() => failed.push(p));
      throw new Error(`${why} The files this fix had written were removed${failed.length ? ` (except ${failed.length}, which are left)` : ""}.`);
    }
    throw new Error(`${why} Files and entries already written are left in the map.`);
  }
}

/** A lookup of the map's files as they are now (the project's file list, read again). */
async function freshLookup(w3: W3Api): Promise<FileLookup> {
  const lookup = new FileLookup(w3);
  await lookup.exists("war3mapImported", "file");
  return lookup;
}

/** Imports Reforged models as they are (from the set `source`) at their own paths, with the textures
 *  `lacks` (the game paths a texture may have) says some mode doesn't have; a texture stored as .dds
 *  under another name is imported as .dds and the model renamed to it. A texture path of a build
 *  machine ("C:/Users/…/Art/HD//Doodads/…") is rewritten to the game path in it. A file the map
 *  already has under an archive name is never written over (the user's own import stays). Returns the
 *  bytes written. */
async function importReforged(
  w3: W3Api, root: string | undefined, models: string[], source: Source, lacks: (candidates: string[], inMap: (p: string) => boolean) => boolean,
): Promise<number> {
  const lookup = await freshLookup(w3);
  const inMap = (p: string) => lookup.inMap(p.replace(/\//g, "\\"));
  const files = new Map<string, Uint8Array>();
  for (const model of models) {
    const { bytes } = await readReforged(w3, model, source);
    const renamed = new Map<string, string>();
    for (const t of parseMdx(bytes).textures) {
      if (t.replaceableId || !t.path) continue;
      const candidates = textureCandidates(t.path, model);
      if (lacks(candidates, inMap)) {
        const tex = await readReforged(w3, t.path, source, model);
        const archive = tex.name.replace(/\//g, "\\");
        if (!inMap(archive)) files.set(archive, tex.bytes);
        if (archive.toLowerCase() !== t.path.replace(/\//g, "\\").toLowerCase()) renamed.set(t.path, archive);
      } else if (isMachinePath(t.path)) {
        const game = gamePartOf(t.path);
        if (game) renamed.set(t.path, game.replace(/\//g, "\\"));
      }
    }
    const archive = model.replace(/\//g, "\\");
    if (!inMap(archive)) files.set(archive, renamed.size ? renameTextures(bytes, (p) => renamed.get(p) ?? p) : bytes);
  }
  const applyImports = await prepareImports(w3, [...files.keys()]);
  await writeFix(w3, root, files, (a) => !inMap(a), [applyImports]);
  await w3.workspace.refresh();
  return [...files.values()].reduce((n, b) => n + b.length, 0);
}

/** Converts the type's Reforged models (every variation, from the set `source`) to Classic ones in
 *  the map (war3mapImported\Classic\<name>\…: the model as MDX 800, its colour textures as BLP, at
 *  most 512 px), lists them as imports and points the type's model field at them. The folder is a
 *  free one (see chooseFolder). Nothing is written unless every texture the new models name is among
 *  the files written, the object data and the import list can be changed, and the project is still
 *  the one the problem was found in. */
async function convertToClassic(
  w3: W3Api, root: string | undefined, kind: string, base: string, id: string, model: string, variations: number, source: Source,
): Promise<number> {
  const stem = model.replace(/\.(mdl|mdx)$/i, "").replace(/\//g, "\\");
  const name = stem.split("\\").pop()!;
  const lookup = await freshLookup(w3);
  const count = Math.max(1, variations);
  const parsedModels: { modelPath: string; suffix: string; parsed: ReturnType<typeof parseMdx> }[] = [];
  for (let v = 0; v < count; v++) {
    const suffix = variations > 1 ? String(v) : "";
    const modelPath = `${stem}${suffix}.mdx`;
    parsedModels.push({ modelPath, suffix, parsed: parseMdx((await readReforged(w3, modelPath, source)).bytes) });
  }
  // The converted textures, by source path (the same for every folder).
  const blps = new Map<string, Uint8Array>();
  const blpOf = async (path: string, owner: string) => {
    const known = blps.get(path);
    if (known) return known;
    const tex = await readReforged(w3, path, source, owner);
    const img = decodeImage(tex.bytes, tex.name);
    // The first level at most 512 px wide and high (Reforged textures are 1–2k).
    let k = 0;
    while (k < img.mipCount - 1 && Math.max(img.mip(k).width, img.mip(k).height) > 512) k++;
    const m = img.mip(k);
    const blp = encodeBlp1Jpeg(m.width, m.height, m.rgba, 90, { alpha: true, mipmaps: true });
    blps.set(path, blp);
    return blp;
  };
  const build = async (dir: string) => {
    const files = new Map<string, Uint8Array>();
    const textures = new Map<string, { target: string; owner: string }>();
    const used = new Set<string>();
    for (const { modelPath, suffix, parsed } of parsedModels) {
      const mdx = toClassicMdx(parsed, (i) => {
        const t = parsed.textures[i];
        if (!t.path) return null;
        const known = textures.get(t.path);
        if (known) return known.target;
        // The file name only: the path may be a build machine's.
        const file = (t.path.split(/[\\/]/).pop() ?? "").replace(/\.\w+$/, "");
        const target = uniqueName(dir, `${file}.blp`, used);
        textures.set(t.path, { target, owner: modelPath });
        return target;
      });
      files.set(`${dir}\\${name}${suffix}.mdx`, mdx);
    }
    for (const [path, { target, owner }] of textures) files.set(target, await blpOf(path, owner));
    return files;
  };
  // Absent is null; a file the map has that can't be read throws (it would look free and be overwritten).
  const existing = async (archive: string) => (lookup.inMap(archive) ? w3.workspace.readBytes(`map/${toProjectPath(archive)}`) : null);
  const { dir, files } = await chooseFolder(name, build, existing);
  // The converted models must find every texture they name, in the map.
  const have = new Set([...files.keys()].map((f) => f.toLowerCase()));
  for (const [file, bytes] of files) {
    if (!/\.mdx$/i.test(file)) continue;
    const missing = missingTextures(parseMdx(bytes).textures, (n) => have.has(n));
    if (missing.length) throw new Error(`${file}: texture ${missing[0]} was not written, nothing changed`);
  }
  // Everything that can fail comes before the first write.
  const applyImports = await prepareImports(w3, [...files.keys()]);
  const applyModel = await prepareModel(w3, kind, base, id, modelFieldValue(kind, `${dir}\\${name}`), count);
  await writeFix(w3, root, files, (a) => !lookup.inMap(a), [applyImports, applyModel]);
  await w3.workspace.refresh();
  return [...files.values()].reduce((n, b) => n + b.length, 0);
}
