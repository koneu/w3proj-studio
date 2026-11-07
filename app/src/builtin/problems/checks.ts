// The built-in checks of the Problems view (more in mapchecks.ts): the map script's errors, file
// paths in object data that don't exist (or point to someone's disk),
// textures of imported models, placed objects of unknown types, placed objects
// without a Classic model, and import list entries without their file.

import { readMapDoc } from "../../lib/formats/mapdoc";
import type { W3Api } from "../../extensions/api";
import type { Problem, ProblemCheck, ProblemFix } from "../../extensions/services";
import type { FileInfo } from "../../extensions/api";
import { toArchiveName, toProjectPath } from "../../lib/formats/archivepath";
import { encodeBlp1Jpeg } from "../../lib/image/encode";
import { decodeImage } from "../../lib/image/index.ts";
import { toClassicMdx } from "../../lib/model/classic";
import { checkJass } from "../../lib/jass/check";
import { checkLua } from "../../lib/lua/check";
import { gameJassEnv } from "../../lib/jass/env";
import { parseMdx, renameTextures } from "../../lib/model/mdx";
import { loadKind } from "../../lib/objects/metadata";
import { type ModeChoices, pickClassicModel } from "./modelpick";
import { conversionSources, missingTextures, modelExists, readLayered, type Source, SOURCE_NAME, sourcesText, textureCandidates, uniqueName } from "./reforged";
import { gamePartOf, isMachinePath } from "../../lib/model/texpath";
import { editPlacedFile, isRandomId, knownPlacedTypes } from "./invalid";

const KINDS = ["w3u", "w3t", "w3a", "w3h", "w3b", "w3d", "w3q"];
/** Object data field types that hold file paths (shadow textures are names, not paths). */
const PATH_TYPES = new Set(["model", "modelList", "icon", "texture", "pathingTexture"]);
/** At most this many problems per check (the rest is summarised). */
const LIMIT = 200;

interface Obj { base: string; id?: string; mods?: Mod[]; sets?: { mods: Mod[] }[] }
interface Mod { field: string; value: number | string; level?: number }

/** A path that only exists on someone's machine, or climbs out of the map. */
export const isAbsolute = (p: string) => /^[a-z]:[\\/]/i.test(p) || /^[\\/]{2}/.test(p) || /(^|[\\/])\.\.([\\/]|$)/.test(p);

/** A path as the game looks it up: lower case, "\\", without art set or language folders
 *  (`_HD.w3mod\\`, `_Locales\\zhCN.w3mod\\`), which only choose the variant. */
const plainPath = (p: string) => {
  let s = p.replace(/\//g, "\\").toLowerCase();
  for (let before = ""; before !== s;) { before = s; s = s.replace(/^(_hd|_de|_teen)\.w3mod\\|^_locales\\[a-z]{4}\.w3mod\\/, ""); }
  return s;
};

/** Where files are looked up: the project's map folder (and a chapter map's campaign), then the
 *  game's data (cached). */
export class FileLookup {
  private files = new Set<string>();
  private game = new Map<string, Promise<boolean>>();
  private ready: Promise<void>;
  constructor(private w3: W3Api) {
    const add = (list: FileInfo[]) => {
      for (const f of list) {
        const rel = f.path.replace(/\\/g, "/");
        if (rel.toLowerCase().startsWith("map/")) this.files.add(plainPath(toArchiveName(rel.slice(4))));
      }
    };
    add(w3.workspace.files());
    // A campaign's chapter map also uses the campaign's imports.
    const root = w3.workspace.project()?.root;
    const campaign = root ? /^(.*)[\\/]maps[\\/][^\\/]+[\\/]?$/.exec(root)?.[1] : undefined;
    this.ready = campaign
      ? w3.backend.invoke<FileInfo[]>("project_files", { root: campaign }).then(add, () => {})
      : Promise.resolve();
  }
  inMap(path: string) {
    return this.files.has(plainPath(path));
  }
  inGame(path: string): Promise<boolean> {
    const key = path.replace(/\//g, "\\").toLowerCase();
    let p = this.game.get(key);
    if (!p) {
      p = this.w3.game.resolve(path.replace(/\//g, "\\")).then((r) => !!r, () => false);
      this.game.set(key, p);
    }
    return p;
  }
  /** Whether any variant exists: as written, with the extensions the game also accepts
   *  (models without extension or as .mdl → .mdx; textures as .dds). */
  async exists(path: string, kind: "model" | "texture" | "file"): Promise<boolean> {
    const variants = [path];
    if (kind === "model") {
      if (!/\.\w{3}$/.test(path)) variants.push(`${path}.mdx`);
      else if (/\.mdl$/i.test(path)) variants.push(path.replace(/\.mdl$/i, ".mdx"));
    }
    if (kind === "texture") {
      if (!/\.\w{3}$/.test(path)) variants.push(`${path}.blp`, `${path}.dds`);
      else if (/\.(blp|tif|tga|png)$/i.test(path)) variants.push(path.replace(/\.\w+$/, ".dds"));
    }
    await this.ready;
    if (variants.some((v) => this.inMap(v))) return true;
    for (const v of variants) if (await this.inGame(v)) return true;
    return false;
  }
}

/** A map file's JSON document ("map/x.json"), also from the raw file of older projects. */
export { readMapDoc };
const readJson = readMapDoc;
const capped = (list: Problem[], what: string): Problem[] =>
  list.length > LIMIT ? [...list.slice(0, LIMIT), { severity: "warning", message: `… and ${list.length - LIMIT} more ${what}` }] : list;

export function builtinChecks(w3: W3Api): ProblemCheck[] {
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
        const files = new FileLookup(w3);
        const out: Problem[] = [];
        /** Whether the file an object field names exists. A doodad or destructable with several
         *  variations names its model without the number; the files are X0.mdx, X1.mdx… */
        const pathExists = async (p: string, type: string, kind: string, base: string, mods: Mod[], meta: NonNullable<Awaited<ReturnType<typeof loadKind>>>) => {
          const what = type.startsWith("model") ? "model" : type === "icon" || type.endsWith("exture") ? "texture" : "file";
          const field = what === "model" ? ART[kind]?.variations : undefined;
          let variations = 1;
          if (field) {
            const given = mods.find((m) => m.field === field), f = meta.fieldById.get(field);
            variations = Number(given ? given.value : f ? meta.defaultValue(base, f, 0) : 1) || 1;
          }
          return modelExists(p, variations, (x) => files.exists(x, what));
        };
        for (const kind of KINDS) {
          let meta: Awaited<ReturnType<typeof loadKind>> | null = null;
          for (const file of [`map/war3map.${kind}.json`, `map/war3mapSkin.${kind}.json`, `map/war3campaign.${kind}.json`, `map/war3campaignSkin.${kind}.json`]) {
            const data = await readJson<{ original?: Obj[]; custom?: Obj[] }>(w3, file);
            if (!data) continue;
            meta ??= await loadKind(w3, kind).catch(() => null);
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
                  if (isAbsolute(p)) out.push({ severity: "error", message: `${p}: a path on someone's disk, not in the map`, location: at, reveal });
                  else if (!(await pathExists(p, f.type, kind, o.base, mods, meta))) {
                    out.push({ severity: "warning", message: `${p} not found (neither in the map nor in the game)`, location: at, reveal });
                  }
                }
              }
            }
          }
        }
        return capped(out, "missing files");
      },
    },
    {
      id: "modelTextures",
      title: "Textures of imported models",
      async run() {
        const files = new FileLookup(w3);
        const out: Problem[] = [];
        const models = w3.workspace.files().filter((f) => /^map\/.+\.mdx$/i.test(f.path.replace(/\\/g, "/")));
        for (const f of models) {
          let textures: { replaceableId: number; path: string }[];
          try { textures = parseMdx(await w3.workspace.readBytes(f.path)).textures; } catch (e) {
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
        const { known, inUnits, inDoodads } = await knownPlacedTypes(w3);
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
      run: () => classicModels(w3),
    },
    {
      id: "imports",
      title: "Imported files",
      async run() {
        const files = new FileLookup(w3);
        const out: Problem[] = [];
        for (const [list, folder] of [["map/war3map.imp.json", "war3mapImported"], ["map/war3campaign.imp.json", "war3campImported"]] as const) {
          const data = await readJson<{ files?: { flags: number; path: string }[] }>(w3, list);
          for (const e of data?.files ?? []) {
            // "Standard path" entries (flags 5, 8) name a file inside the import folder.
            const paths = [5, 8].includes(e.flags) ? [`${folder}\\${e.path}`, e.path] : [e.path];
            const sound = /\.(flac|ogg|mp3|wav)$/i.test(e.path);
            const variants = paths.flatMap((p) => (sound ? [".flac", ".ogg", ".mp3", ".wav"].map((x) => p.replace(/\.\w+$/, x)) : [p]));
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
async function classicModels(w3: W3Api): Promise<Problem[]> {
  const info = await readJson<{ supportedModes?: number }>(w3, "map/war3map.w3i.json");
  const supported = MODES.filter((m) => (info?.supportedModes ?? 1) & m.bit);
  if (!supported.length) return [];
  // Game paths (lowercase, without the folder prefix) per art folder: Classic, _hd, _de.
  const stored = new Map<string | null, Set<string>>(MODES.map((m) => [m.layer, new Set()]));
  // The Classic models (as stored, for the picker of the fix).
  const classicModels = new Set<string>();
  // The Reforged models by set, for the picker of the fix (they are converted when chosen).
  const reforgedModels: Record<Source, Set<string>> = { de: new Set(), hd: new Set() };
  for (const full of await w3.game.list()) {
    const path = full.slice(full.lastIndexOf(":") + 1);
    const layer = /:_(hd|de)\.w3mod:/i.exec(full)?.[1].toLowerCase();
    stored.get(layer ? `_${layer}` : null)!.add(path.replace(/\\/g, "/").toLowerCase());
    if (/\.mdx$/i.test(path) && !/_portrait\.mdx$/i.test(path)) {
      if (!layer) classicModels.add(path.replace(/\//g, "\\"));
      else if (/:_(hd|de)\.w3mod:[^:]*$/i.test(full)) reforgedModels[layer as Source].add(path.replace(/\//g, "\\"));
    }
  }
  const files = new FileLookup(w3);
  const kinds = new Map<string, Awaited<ReturnType<typeof loadKind>>>();
  for (const kind of Object.keys(ART)) { const k = await loadKind(w3, kind).catch(() => null); if (k) kinds.set(kind, k); }
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
    // exists() waits until the map's file list is read; only the map's own copy counts here.
    const imported = (await files.exists(path, "file")) && files.inMap(path);
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
          run: async () => {
            const model = value(id, kind, ART[kind].model) ?? "";
            const variations = Number(ART[kind].variations ? value(id, kind, ART[kind].variations!) : 1) || 1;
            const bytes = await convertToClassic(w3, kind, base, id, model, variations, source);
            void w3.window.showInfo(`Converted ${name} from the ${set} model to a Classic model (${(bytes / 1048576).toFixed(1)} MB in the map).`);
          },
        });
      }
      // Without Classic, the Reforged model itself can be imported: both Reforged modes draw it.
      for (const source of modes.has("Classic") ? [] : sources) {
        const set = SOURCE_NAME[source], pick = sources.length > 1 ? ` ${set}` : "";
        fixes.push({
          label: `Import the${pick} Reforged model`,
          title: `Copies the ${set} model (and the textures ${where} lacks) into the map, at the path the type names; the map doesn't support Classic, which couldn't draw it`,
          run: async () => {
            const lacking = supported.filter((m) => m.layer && modes.has(m.name)).map((m) => m.layer!);
            const bytes = await importReforged(w3, [...paths], source, (cands) => lacking.some((l) => !cands.some((c) => stored.get(null)!.has(c.toLowerCase()) || stored.get(l)!.has(c.toLowerCase()))));
            void w3.window.showInfo(`Imported ${name}'s ${set} model (${(bytes / 1048576).toFixed(1)} MB in the map).`);
          },
        });
      }
      fixes.push({
        label: "Replace with a Classic game model…",
        title: "Pick one of the game's own Classic models for this type (every graphics mode can load those); it's written into the map's object data (a modified standard object), and the type's Reforged model is no longer used",
        run: () => useClassicModel(w3, kind, base, id, name, [...paths][0] ?? "", classicModels, reforgedModels, sources),
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

/** Model and variation count fields of a kind's object data. */
const MODEL_FIELDS: Record<string, { model: string; variations?: string }> = ART;

/** Asks for one of the game's models (best name matches first), from the Classic files or, to be
 *  converted, a Reforged set's, and writes it into the type's model field in the map's object data
 *  (a modified standard object, or the custom object itself); variations are set to 1 (the chosen
 *  model has no numbered variants). A Reforged model is converted to a Classic one first. */
async function useClassicModel(
  w3: W3Api, kind: string, base: string, id: string, name: string, current: string,
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
    await setModel(w3, kind, base, id, pick.path.replace(/\.mdx$/i, ".mdl"), 1);
    return;
  }
  const bytes = await convertToClassic(w3, kind, base, id, pick.path, 1, pick.mode);
  void w3.window.showInfo(`Converted ${pick.path.split("\\").pop()} from the ${SOURCE_NAME[pick.mode]} files to a Classic model for ${name} (${(bytes / 1048576).toFixed(1)} MB in the map).`);
}

/** Writes a model (and, for doodads/destructables, the variation count) into a type's object
 *  data: a modified standard object, or the custom object's own entry. */
async function setModel(w3: W3Api, kind: string, base: string, id: string, model: string, variations: number) {
  const fields = MODEL_FIELDS[kind];
  const path = `map/war3map.${kind}.json`;
  const text = await w3.workspace.readText(path).catch(() => null);
  if (text === null && w3.workspace.files().some((f) => f.path.toLowerCase() === `map/war3map.${kind}`)) {
    throw new Error(`war3map.${kind} is kept raw in this project; set the model in the Object Editor.`);
  }
  type Mod = { field: string; type: string; level?: number; data?: number; value: number | string };
  type O = { base: string; id?: string; end?: string; mods?: Mod[] };
  const doc = JSON.parse(text ?? '{"format":"w3proj.objects/1","version":3,"original":[],"custom":[]}') as { version: number; original: O[]; custom: O[] };
  // Standard types are changed as "original" entries; a custom type in its own entry.
  const isCustom = id !== base;
  let o = isCustom ? doc.custom.find((x) => x.id === id) : doc.original.find((x) => x.base === id);
  if (!o) {
    o = doc.version >= 3 ? { base: id, mods: [] } : { base: id, end: id, mods: [] };
    doc.original.push(o);
  }
  // Doodads (and abilities, upgrades) store a level and data column with every field.
  const levels = ["w3d", "w3a", "w3q"].includes(kind);
  const set = (field: string, type: string, value: number | string) => {
    o!.mods = (o!.mods ?? []).filter((m) => m.field !== field);
    o!.mods.push(levels ? { field, type, level: 0, data: 0, value } : { field, type, value });
  };
  set(fields.model, "string", model);
  if (fields.variations) set(fields.variations, "int", variations);
  await w3.workspace.writeText(path, await w3.backend.invoke<string>("objects_canonicalize", { name: path, text: JSON.stringify(doc) }));
  await w3.workspace.refresh();
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

/** Imports Reforged models as they are (from the set `source`) at their own paths, with the textures
 *  `lacks` (the game paths a texture may have) says some mode doesn't have; a texture stored as .dds
 *  under another name is imported as .dds and the model renamed to it. A texture path of a build
 *  machine ("C:/Users/…/Art/HD//Doodads/…") is rewritten to the game path in it. Returns the bytes written. */
async function importReforged(w3: W3Api, models: string[], source: Source, lacks: (candidates: string[]) => boolean): Promise<number> {
  const files = new Map<string, Uint8Array>();
  for (const model of models) {
    const { bytes } = await readReforged(w3, model, source);
    const renamed = new Map<string, string>();
    for (const t of parseMdx(bytes).textures) {
      if (t.replaceableId || !t.path) continue;
      const candidates = textureCandidates(t.path, model);
      if (lacks(candidates)) {
        const tex = await readReforged(w3, t.path, source, model);
        const archive = tex.name.replace(/\//g, "\\");
        files.set(archive, tex.bytes);
        if (archive.toLowerCase() !== t.path.replace(/\//g, "\\").toLowerCase()) renamed.set(t.path, archive);
      } else if (isMachinePath(t.path)) {
        const game = gamePartOf(t.path);
        if (game) renamed.set(t.path, game.replace(/\//g, "\\"));
      }
    }
    files.set(model.replace(/\//g, "\\"), renamed.size ? renameTextures(bytes, (p) => renamed.get(p) ?? p) : bytes);
  }
  for (const [archive, bytes] of files) await w3.workspace.writeBytes(`map/${toProjectPath(archive)}`, bytes);
  await addImports(w3, [...files.keys()]);
  await w3.workspace.refresh();
  return [...files.values()].reduce((n, b) => n + b.length, 0);
}

/** Converts the type's Reforged models (every variation, from the set `source`) to Classic ones in
 *  the map (war3mapImported\Classic\<name>\…: the model as MDX 800, its colour textures as BLP, at
 *  most 512 px), lists them as imports and points the type's model field at them. Nothing is written
 *  unless every texture the new models name is among the files written. */
async function convertToClassic(w3: W3Api, kind: string, base: string, id: string, model: string, variations: number, source: Source): Promise<number> {
  const stem = model.replace(/\.(mdl|mdx)$/i, "").replace(/\//g, "\\");
  const name = stem.split("\\").pop()!;
  const dir = `war3mapImported\\Classic\\${name}`;
  const files = new Map<string, Uint8Array>();
  // Where each source texture goes, and which names are taken.
  const textures = new Map<string, { target: string; model: string }>();
  const used = new Set<string>();
  for (let v = 0; v < Math.max(1, variations); v++) {
    const suffix = variations > 1 ? String(v) : "";
    const modelPath = `${stem}${suffix}.mdx`;
    const parsed = parseMdx((await readReforged(w3, modelPath, source)).bytes);
    const mdx = toClassicMdx(parsed, (i) => {
      const t = parsed.textures[i];
      if (!t.path) return null;
      const known = textures.get(t.path);
      if (known) return known.target;
      // The file name only: the path may be a build machine's.
      const file = (t.path.split(/[\\/]/).pop() ?? "").replace(/\.\w+$/, "");
      const target = uniqueName(dir, `${file}.blp`, used);
      textures.set(t.path, { target, model: modelPath });
      return target;
    });
    files.set(`${dir}\\${name}${suffix}.mdx`, mdx);
  }
  for (const [path, { target, model: owner }] of textures) {
    const tex = await readReforged(w3, path, source, owner);
    const img = decodeImage(tex.bytes, tex.name);
    // The first level at most 512 px wide and high (Reforged textures are 1–2k).
    let k = 0;
    while (k < img.mipCount - 1 && Math.max(img.mip(k).width, img.mip(k).height) > 512) k++;
    const m = img.mip(k);
    files.set(target, encodeBlp1Jpeg(m.width, m.height, m.rgba, 90, { alpha: true, mipmaps: true }));
  }
  // The converted models must find every texture they name, in the map.
  const have = new Set([...files.keys()].map((f) => f.toLowerCase()));
  for (const [file, bytes] of files) {
    if (!/\.mdx$/i.test(file)) continue;
    const missing = missingTextures(parseMdx(bytes).textures, (n) => have.has(n));
    if (missing.length) throw new Error(`${file}: texture ${missing[0]} was not written, nothing changed`);
  }
  for (const [archive, bytes] of files) await w3.workspace.writeBytes(`map/${toProjectPath(archive)}`, bytes);
  await addImports(w3, [...files.keys()]);
  await setModel(w3, kind, base, id, `${dir}\\${name}`, Math.max(1, variations));
  return [...files.values()].reduce((n, b) => n + b.length, 0);
}

/** Adds archive names to war3map.imp (either project form; created when missing). */
async function addImports(w3: W3Api, names: string[]) {
  const root = w3.workspace.project()!.root;
  type Imports = { format?: string; version: number; files: { flags: number; path: string }[] };
  const json = await w3.workspace.readText("map/war3map.imp.json").catch(() => null);
  const raw = json === null ? await w3.backend.invoke<string>("codec_decode", { root, path: "map/war3map.imp" }).catch(() => null) : null;
  const doc: Imports = JSON.parse(json ?? raw ?? '{"format":"w3proj.imports/1","version":1,"files":[]}');
  const have = new Set(doc.files.map((f) => f.path.toLowerCase()));
  // Flag 21 as the Import Manager writes new entries.
  for (const n of names) if (!have.has(n.toLowerCase())) doc.files.push({ flags: 21, path: n });
  if (raw !== null) await w3.backend.invoke("codec_write", { root, path: "map/war3map.imp", text: JSON.stringify(doc) });
  else await w3.workspace.writeText("map/war3map.imp.json", await w3.backend.invoke<string>("codec_canonicalize", { root, path: "map/war3map.imp.json", text: JSON.stringify(doc) }));
}
