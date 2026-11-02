// Turns placed doodads/destructables/units/items into model batches for the
// terrain renderer: model paths and replaceable textures come from the game's
// skin tables, models and textures are loaded once and shared.

import type { W3Api } from "../../extensions/api";
import { decodeImage } from "../../lib/image/index.ts";
import { parseMdx } from "../../lib/model/mdx";
import { bounds, ModelGpu, uploadTexture, type Mat4 } from "../../lib/model/renderer";
import { parseIni } from "../../lib/formats/text";
import type { ObjectBatch, ObjectInstance } from "./renderer";

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

interface Skin {
  /** Object data file the type belongs to: w3d, w3b, w3u or w3t. */
  kind: string;
  file: string;
  numVar: number;
  /** Replaceable texture this type swaps in (trees, cliffs). */
  texId: number;
  texFile: string;
  /** Extra model scale (units). */
  modelScale: number;
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
      });
    }
  }
  return out;
}

/** Model path of one placed object: variations are numbered files. */
function modelPath(skin: Skin, variation: number): string {
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
  errors: string[];
}

/** Loads models for the terrain view. `readFile` reads map-imported files
 *  first; textures are shared between models. */
export class ObjectLoader {
  private textures = new Map<string, Promise<WebGLTexture | null>>();
  /** Textures that couldn't be read or decoded, with the reason. */
  readonly missing = new Map<string, string>();

  constructor(private gl: WebGL2RenderingContext,
    private readFile: (path: string) => Promise<Uint8Array>, private onTexture: () => void) {}

  private texture(path: string, flags: number): Promise<WebGLTexture | null> {
    const key = `${path.toLowerCase()}|${flags}`;
    let t = this.textures.get(key);
    if (!t) {
      // Reforged models name .tif/.blp sources the game ships as .dds.
      const variants = /\.(blp|tif|tga)$/i.test(path) ? [path, path.replace(/\.\w+$/, ".dds")] : [path];
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
          if (p) this.texture(req.retexture?.(p) ?? p, model.textures[i].flags).then((t) => { gpu.textures[i] = t; });
        });
        return gpu;
      })();
      this.models.set(key, m);
    }
    return m;
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
        batches.push({ group, gpu, instances: req.instances });
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
    for (const [index, p] of placed.entries()) {
      const skin = skins.get(p.id) ?? skins.get(baseOf(p.id) ?? "");
      if (!skin) { unresolved.push(p); continue; }
      const path = modelPath(skin, p.variation);
      const key = `${path}|${skin.texFile}`;
      let entry = byModel.get(key);
      if (!entry) {
        const replaceable = skin.texId > 0 && skin.texFile ? { [skin.texId]: `${skin.texFile}.blp` } : {};
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
    return { batches, unresolved, errors: failed.map((f) => f.error) };
  }
}
