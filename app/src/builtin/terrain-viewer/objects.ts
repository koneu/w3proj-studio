// Turns placed doodads/destructables/units/items into model batches for the
// terrain renderer: model paths and replaceable textures come from the game's
// skin tables, models and textures are loaded once and shared.

import type { W3Api } from "../../extensions/api";
import { decodeImage } from "../../lib/image/index.ts";
import { parseMdx } from "../../lib/model/mdx";
import { bounds, ModelGpu, poseNodes, standClock, uploadTexture, type Mat4 } from "../../lib/model/renderer";
import { parseIni } from "../../lib/formats/text";
import type { EffectSource, ObjectBatch, ObjectInstance } from "./renderer";

export interface Placed {
  id: string;
  variation: number;
  position: [number, number, number];
  /** Radians. */
  angle: number;
  scale: [number, number, number];
  /** Units only. */
  player?: number;
}

export interface Skin {
  /** Object data file the type belongs to: w3d, w3b, w3u or w3t. */
  kind: string;
  file: string;
  numVar: number;
  /** Replaceable texture this type swaps in (trees, cliffs). */
  texId: number;
  texFile: string;
  /** Extra model scale (units). */
  modelScale: number;
  /** Random scale range for new placements (when canPlaceRandScale). */
  minScale: number;
  maxScale: number;
  randScale: boolean;
  /** Fixed facing in degrees, or null for any. */
  fixedRot: number | null;
  /** Ground mark (Splats\UberSplatData.slk name; buildings), "" for none. */
  uberSplat: string;
}

const SKIN_FILES: [string, string][] = [
  ["Doodads\\DoodadSkins.txt", "w3d"], ["Units\\DestructableSkin.txt", "w3b"], ["Units\\UnitSkin.txt", "w3u"], ["Units\\ItemSkin.txt", "w3t"],
];

/** Model info per object id. Keys with a graphics-mode suffix ("file:hd")
 *  win over plain ones. */
export async function loadSkins(w3: W3Api): Promise<Map<string, Skin>> {
  const mode = w3.settings.get<string>("game.graphicsMode") ?? "hd";
  const out = new Map<string, Skin>();
  for (const [f, kind] of SKIN_FILES) {
    const text = await w3.game.readText(f).catch(() => "");
    for (const [id, sec] of parseIni(text)) {
      const get = (k: string) => sec.get(`${k}:${mode}`) ?? sec.get(k);
      const file = get("file");
      if (!file) continue;
      out.set(id, {
        kind,
        file,
        numVar: Number(get("numvar") ?? 1) || 1,
        texId: Number(get("texid") ?? -1),
        texFile: get("texfile") ?? "",
        modelScale: Number(get("modelscale") ?? 1) || 1,
        minScale: Number(get("minscale") ?? 1) || 1,
        maxScale: Number(get("maxscale") ?? 1) || 1,
        randScale: get("canplacerandscale") === "1",
        fixedRot: Number(get("fixedrot") ?? -1) >= 0 ? Number(get("fixedrot")) : null,
        uberSplat: get("ubersplat") ?? "",
      });
    }
  }
  // Start locations have no skin entry; the World Editor draws them with this model
  // (WorldEditData.txt, StartLocation), which also makes them selectable here.
  if (!out.has("sloc")) {
    out.set("sloc", { kind: "w3u", file: "Objects\\StartLocation\\StartLocation.mdl", numVar: 1, texId: -1, texFile: "", modelScale: 1, minScale: 1, maxScale: 1, randScale: false, fixedRot: null, uberSplat: "" });
  }
  return out;
}

/** Object data fields that change a skin entry, per kind (UnitMetaData & co., "Profile" fields;
 *  units' alternate models umd1/umd2 and selection scale aren't drawn). */
const ART_FIELDS: Record<string, Partial<Record<keyof Skin, string>>> = {
  w3u: { file: "umdl", modelScale: "usca", uberSplat: "uubs" },
  w3t: { file: "ifil", modelScale: "isca" },
  w3d: { file: "dfil", numVar: "dvar", minScale: "dmis", maxScale: "dmas", randScale: "dcpr", fixedRot: "dfxr" },
  w3b: { file: "bfil", numVar: "bvar", texId: "btxi", texFile: "btxf", minScale: "bmis", maxScale: "bmas", randScale: "bcpr", fixedRot: "bfxr" },
};

interface ArtMod { field: string; value: number | string }
interface ArtObject { base: string; id?: string; mods?: ArtMod[]; sets?: { mods: ArtMod[] }[] }
/** A map's (or campaign's) object data file of one kind, as its project JSON. */
export interface ObjectArt { kind: string; original?: ArtObject[]; custom?: ArtObject[] }

/** The skins with the map's object data applied: custom objects get their base's entry with
 *  the fields the map sets (model, scale, variations, texture, …), modified standard objects
 *  their own. Later files win (campaign, then map, then the map's Skin files). */
export function withObjectArt(skins: Map<string, Skin>, files: ObjectArt[]): Map<string, Skin> {
  const out = new Map(skins);
  for (const f of files) {
    const fields = ART_FIELDS[f.kind];
    if (!fields) continue;
    for (const o of [...(f.original ?? []), ...(f.custom ?? [])]) {
      const id = o.id ?? o.base;
      const mods = [...(o.mods ?? []), ...(o.sets ?? []).flatMap((x) => x.mods)];
      const art = mods.filter((m) => Object.values(fields).includes(m.field));
      if (!art.length && o.id === undefined) continue;
      const base = out.get(id) ?? out.get(o.base);
      const skin: Skin = base ? { ...base } : { kind: f.kind, file: "", numVar: 1, texId: -1, texFile: "", modelScale: 1, minScale: 1, maxScale: 1, randScale: false, fixedRot: null, uberSplat: "" };
      for (const [key, field] of Object.entries(fields) as [keyof Skin, string][]) {
        const m = art.find((x) => x.field === field);
        if (!m) continue;
        const n = Number(m.value);
        if (key === "file" || key === "texFile" || key === "uberSplat") skin[key] = String(m.value);
        else if (key === "randScale") skin.randScale = n === 1;
        else if (key === "fixedRot") skin.fixedRot = n >= 0 ? n : null;
        else if ((key === "numVar" || key === "texId" || key === "modelScale" || key === "minScale" || key === "maxScale") && Number.isFinite(n)) skin[key] = n;
      }
      if (skin.file) out.set(id, skin);
    }
  }
  return out;
}

/** The skin's replaceable texture. Destructable skins give the extension
 *  (ReplaceableTextures\Cliff\Cliff1.blp), doodad skins don't. */
function skinTextures(skin: Skin): Record<number, string> {
  if (!(skin.texId > 0 && skin.texFile)) return {};
  return { [skin.texId]: /\.\w{3}$/.test(skin.texFile) ? skin.texFile : `${skin.texFile}.blp` };
}

/** Model path of one placed object: variations are numbered files. */
export function modelPath(skin: Skin, variation: number): string {
  const base = skin.file.replace(/\.(mdl|mdx)$/i, "");
  return `${base}${skin.numVar > 1 ? variation : ""}.mdx`;
}

/** World matrix: translate · rotate about z · scale (column-major). */
export function placement(p: Placed, extraScale: number): Mat4 {
  const c = Math.cos(p.angle), s = Math.sin(p.angle);
  const [sx, sy, sz] = p.scale.map((v) => v * extraScale);
  const [x, y, z] = p.position;
  return new Float32Array([c * sx, s * sx, 0, 0, -s * sy, c * sy, 0, 0, 0, 0, sz, 0, x, y, z, 1]);
}

/** One model to draw at the given places. */
export interface ModelRequest {
  path: string;
  /** Replaceable texture id → path (e.g. a tree type's own texture). */
  replaceable: Record<number, string>;
  instances: ObjectInstance[];
  /** Swaps texture paths the game substitutes at runtime (HD cliff placeholders). */
  retexture?: (path: string) => string;
}

export interface LoadResult {
  batches: ObjectBatch[];
  /** Objects without a drawable model (start locations, unknown ids, load errors). */
  unresolved: Placed[];
  /** Models that didn't load and ids without a model, with the placements concerned. */
  problems: LoadProblem[];
}

export interface LoadProblem { message: string; items: Placed[] }

/** Loads models for the terrain view. `readFile` reads map-imported files
 *  first; textures are shared between models. */
export class ObjectLoader {
  private textures = new Map<string, Promise<WebGLTexture | null>>();
  /** Textures that couldn't be read or decoded, with the reason. */
  readonly missing = new Map<string, string>();
  /** Texture path (lower case) → model paths (lower case) that use it. */
  private textureUsers = new Map<string, Set<string>>();

  /** Forgets every loaded model and texture (and what was missing): files the map imports
   *  changed, so they're read again on the next load. */
  reset() {
    this.textures.clear();
    this.missing.clear();
    this.textureUsers.clear();
    this.models.clear();
    this.effectSources.clear();
  }

  /** Model paths (lower case) that use a texture (as listed in `missing`). */
  modelsUsing(texture: string): Set<string> {
    return this.textureUsers.get(texture.toLowerCase()) ?? new Set();
  }

  constructor(private gl: WebGL2RenderingContext,
    private readFile: (path: string) => Promise<Uint8Array>, private onTexture: () => void) {}

  private texture(path: string, flags: number): Promise<WebGLTexture | null> {
    const key = `${path.toLowerCase()}|${flags}`;
    let t = this.textures.get(key);
    if (!t) {
      // Reforged models name .tif/.blp sources the game ships as .dds. Some (even the game's own DE
      // Goldmine) name a texture by an absolute path on the artist's machine
      // ("C:/Users/…/Art/HD//Buildings/Other/Goldmine/…"): its tail parts are tried as game paths.
      const tails = /^([a-z]:)?[\\/]/i.test(path)
        ? path.split(/[\\/]+/).map((_, i, parts) => parts.slice(i).join("\\")).slice(1).filter((t) => t.includes("\\"))
        : [path];
      const variants = tails.flatMap((t) => (/\.(blp|tif|tga)$/i.test(t) ? [t, t.replace(/\.\w+$/, ".dds")] : [t]));
      t = (async () => {
        let error = "";
        for (const v of variants) {
          try {
            const tex = uploadTexture(this.gl, decodeImage(await this.readFile(v), v).mip(0), flags);
            this.onTexture();
            return tex;
          } catch (e) { error += `${error ? " | " : ""}${v}: ${(e as Error).message ?? e}`; }
        }
        this.missing.set(path, error);
        this.onTexture();
        return null;
      })();
      this.textures.set(key, t);
    }
    return t;
  }

  /** GPU models by path + replaceable textures, so re-planning (e.g. cliffs
   *  after an edit) doesn't load them again. */
  private models = new Map<string, Promise<ModelGpu>>();

  private effectSources = new Map<string, Promise<EffectSource | null>>();

  /** Particle effects of a model: its own emitters (PRE2), or for a Reforged model whose effects
   *  are PopcornFX (CORN, not drawn here) the emitters of the game's classic model of the same
   *  path, which keeps the classic models' scale and layout. */
  private effects(req: ModelRequest, gpu: ModelGpu): Promise<EffectSource | null> {
    const m = gpu.model;
    if (m.particleEmitters2.length || m.ribbons.length) return Promise.resolve({ model: m, textures: gpu.textures, nodeWorld: gpu.nodeWorld, clock: gpu.poseClock, classic: false });
    if (!m.skipped.includes("CORN")) return Promise.resolve(null);
    const key = req.path.toLowerCase();
    let e = this.effectSources.get(key);
    if (!e) {
      e = (async () => {
        let sd;
        try { sd = parseMdx(await this.readFile(`War3.w3mod:${req.path.replace(/\\/g, "/")}`)); } catch { return null; }
        if (!sd.particleEmitters2.length && !sd.ribbons.length) return null;
        const clock = standClock(sd);
        const textures: (WebGLTexture | null)[] = sd.textures.map(() => null);
        sd.textures.forEach((t, i) => {
          if (t.replaceableId === 0 && t.path) void this.texture(t.path, t.flags).then((tex) => { textures[i] = tex; });
        });
        return { model: sd, textures, nodeWorld: poseNodes(sd, clock), clock, classic: true };
      })();
      this.effectSources.set(key, e);
    }
    return e;
  }

  private model(req: ModelRequest): Promise<ModelGpu> {
    const key = `${req.path.toLowerCase()}|${JSON.stringify(req.replaceable)}`;
    let m = this.models.get(key);
    if (!m) {
      m = (async () => {
        const model = parseMdx(await this.readFile(req.path));
        const gpu = new ModelGpu(this.gl, model);
        // Stand still at the start of the first "Stand" animation.
        const stand = model.sequences.find((s) => /^stand/i.test(s.name)) ?? model.sequences[0];
        gpu.pose({ frame: stand?.start ?? 0, seqStart: stand?.start ?? 0, seqEnd: stand?.end ?? 0, time: 0 });
        gpu.texturePaths(req.replaceable).forEach((p, i) => {
          if (!p) return;
          const tex = req.retexture?.(p) ?? p;
          let users = this.textureUsers.get(tex.toLowerCase());
          if (!users) this.textureUsers.set(tex.toLowerCase(), (users = new Set()));
          users.add(req.path.toLowerCase());
          this.texture(tex, model.textures[i].flags).then((t) => { gpu.textures[i] = t; });
        });
        return gpu;
      })();
      this.models.set(key, m);
    }
    return m;
  }

  /** The GPU model for a placed type (shared with the batches; for previews). */
  modelFor(skin: Skin, variation: number): Promise<ModelGpu> {
    const replaceable = skinTextures(skin);
    return this.model({ path: modelPath(skin, variation), replaceable, instances: [] });
  }

  /** Loads each requested model; failed ones are reported by index. */
  async loadModels(group: string, requests: ModelRequest[]): Promise<{ batches: ObjectBatch[]; failed: { index: number; error: string }[] }> {
    const batches: ObjectBatch[] = [], failed: { index: number; error: string }[] = [];
    await Promise.all(requests.map(async (req, index) => {
      try {
        const gpu = await this.model(req);
        const model = gpu.model;
        // Bounding sphere per instance, for picking.
        const b = bounds(model);
        const c = [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2);
        const r = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2;
        for (const inst of req.instances) {
          const m = inst.world;
          const s = Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]));
          inst.sphere = [
            m[0] * c[0] + m[4] * c[1] + m[8] * c[2] + m[12],
            m[1] * c[0] + m[5] * c[1] + m[9] * c[2] + m[13],
            m[2] * c[0] + m[6] * c[1] + m[10] * c[2] + m[14],
            Math.max(16, r * s),
          ];
        }
        batches.push({ group, gpu, instances: req.instances, effects: await this.effects(req, gpu) ?? undefined });
      } catch (e) {
        failed.push({ index, error: `${req.path}: ${(e as Error).message ?? e}` });
      }
    }));
    return { batches, failed };
  }

  /** Placed doodads/units: models from the skin tables. Custom object ids
   *  use their base object's model (`baseOf`, from the map's object data). */
  async load(group: string, placed: Placed[], skins: Map<string, Skin>, teamOf: (p: Placed) => number,
    baseOf: (id: string) => string | undefined = () => undefined): Promise<LoadResult> {
    const byModel = new Map<string, { req: ModelRequest; items: Placed[] }>();
    const unresolved: Placed[] = [];
    // Ids without a model (start locations have none on purpose).
    const unknown = new Map<string, Placed[]>();
    for (const [index, p] of placed.entries()) {
      const skin = skins.get(p.id) ?? skins.get(baseOf(p.id) ?? "");
      if (!skin) {
        unresolved.push(p);
        if (p.id !== "sloc") unknown.set(p.id, [...(unknown.get(p.id) ?? []), p]);
        continue;
      }
      const path = modelPath(skin, p.variation);
      const key = `${path}|${skin.texFile}`;
      let entry = byModel.get(key);
      if (!entry) {
        const replaceable = skinTextures(skin);
        entry = { req: { path, replaceable, instances: [] }, items: [] };
        byModel.set(key, entry);
      }
      entry.items.push(p);
      entry.req.instances.push({
        world: placement(p, skin.modelScale), team: teamOf(p),
        pick: { kind: skin.kind, id: p.id, base: skins.has(p.id) ? undefined : baseOf(p.id), index, placed: p, model: path, extraScale: skin.modelScale },
      });
    }
    const entries = [...byModel.values()];
    const { batches, failed } = await this.loadModels(group, entries.map((e) => e.req));
    for (const f of failed) unresolved.push(...entries[f.index].items);
    const problems: LoadProblem[] = [
      ...failed.map((f) => ({ message: f.error, items: entries[f.index].items })),
      ...[...unknown].map(([id, items]) => ({ message: `${id}: unknown object (no model; not in the game's or the map's object data)`, items })),
    ];
    return { batches, unresolved, problems };
  }
}
