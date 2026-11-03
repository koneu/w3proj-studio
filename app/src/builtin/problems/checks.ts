// The built-in checks of the Problems view: the map script's JASS errors, file
// paths in object data that don't exist (or point to someone's disk),
// textures of imported models, placed objects of unknown types, and import list
// entries without their file.

import type { W3Api } from "../../extensions/api";
import type { Problem, ProblemCheck } from "../../extensions/services";
import type { FileInfo } from "../../extensions/api";
import { toArchiveName } from "../../lib/formats/archivepath";
import { checkJass } from "../../lib/jass/check";
import { gameJassEnv } from "../../lib/jass/env";
import { parseMdx } from "../../lib/model/mdx";
import { loadKind } from "../../lib/objects/metadata";

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

const readJson = async <T>(w3: W3Api, path: string): Promise<T | null> => {
  const text = await w3.workspace.readText(path).catch(() => null);
  if (text === null) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
};
const capped = (list: Problem[], what: string): Problem[] =>
  list.length > LIMIT ? [...list.slice(0, LIMIT), { severity: "warning", message: `… and ${list.length - LIMIT} more ${what}` }] : list;

export function builtinChecks(w3: W3Api): ProblemCheck[] {
  return [
    {
      id: "jass",
      title: "Map script (war3map.j)",
      async run() {
        const path = "map/war3map.j";
        const src = await w3.workspace.readText(path).catch(() => null);
        if (src === null) return [];
        const env = await gameJassEnv((p) => w3.game.readText(p));
        const lineOf = (at: number) => src.slice(0, at).split("\n").length;
        return capped(checkJass(src, env).map((d): Problem => ({
          severity: d.severity, message: d.message, location: `war3map.j:${lineOf(d.from)}`,
          reveal: { command: "w3.text.revealAt", args: [path, d.from] },
        })), "script problems");
      },
    },
    {
      id: "objectPaths",
      title: "Files used by object data",
      async run() {
        const files = new FileLookup(w3);
        const out: Problem[] = [];
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
                  else if (!(await files.exists(p, f.type.startsWith("model") ? "model" : f.type === "icon" || f.type.endsWith("exture") ? "texture" : "file"))) {
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
        const known = new Set<string>(["sloc"]);
        for (const kind of ["w3u", "w3t", "w3b", "w3d"]) {
          const k = await loadKind(w3, kind).catch(() => null);
          for (const id of k?.baseIds ?? []) known.add(id);
          for (const file of [`map/war3map.${kind}.json`, `map/war3mapSkin.${kind}.json`]) {
            for (const o of (await readJson<{ custom?: Obj[] }>(w3, file))?.custom ?? []) if (o.id) known.add(o.id);
          }
        }
        // A campaign's chapter map also has the campaign's custom objects.
        const root = w3.workspace.project()?.root;
        const campaign = root ? /^(.*)[\\/]maps[\\/][^\\/]+[\\/]?$/.exec(root)?.[1] : undefined;
        if (campaign) {
          for (const kind of ["w3u", "w3t", "w3b", "w3d"]) {
            for (const o of (await readJson<{ custom?: Obj[] }>(w3, `${campaign}\\map\\war3campaign.${kind}.json`))?.custom ?? []) if (o.id) known.add(o.id);
          }
        }
        // Random units/items/buildings ("uDNR", "iDNR", "bDNR") and random items by level ("YiI1").
        const random = (id: string) => /^[uib]DNR$/.test(id) || /^Y.I\d$/.test(id);
        const unknown = new Map<string, { n: number; x: number; y: number; file: string }>();
        for (const [file, key] of [["map/war3mapUnits.doo.json", "units"], ["map/war3map.doo.json", "doodads"]] as const) {
          const list = (await readJson<Record<string, { id: string; position: number[] }[]>>(w3, file))?.[key] ?? [];
          for (const p of list) {
            if (known.has(p.id) || random(p.id)) continue;
            const u = unknown.get(p.id) ?? { n: 0, x: p.position[0], y: p.position[1], file };
            u.n++;
            unknown.set(p.id, u);
          }
        }
        return capped([...unknown].map(([id, u]): Problem => ({
          severity: "warning", message: `${id}: unknown object type (not in the game's or the map's object data), placed ${u.n}×`,
          location: u.file.slice(4), reveal: { command: "w3.terrain.showPoint", args: [u.x, u.y] },
        })), "unknown types");
      },
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
