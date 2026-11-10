// Turns placed doodads/destructables/units/items into model batches for the
// terrain renderer: model paths and replaceable textures come from the game's
// skin tables, models and textures are loaded once and shared.

import type { W3Api } from "../../extensions/api";
import { decodeImage } from "../../lib/image/index.ts";
import { parseMdx, type Model } from "../../lib/model/mdx";
import { parseAnimProps } from "../../lib/model/stand";
import { neverStoredLast } from "../../lib/model/texpath";
import { createTexture, drawnTextures } from "../../lib/model/gltexture";
import { placeholderImage, placeholderModel } from "../../lib/model/placeholder";
import { worldSphere } from "../../lib/model/frustum";
import { bounds, mat4, ModelGpu, poseNodes, standClock, type Mat4 } from "../../lib/model/renderer";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { artValue } from "../../lib/objects/artset";
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
  /** Units only: the player field's bits above the owner (lib/terrain/owner.ts), e.g. an Ancient placed uprooted. */
  playerFlags?: number;
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
  /** The look of a model that holds several, as its words (Animprops, see lib/model/stand). */
  animProps?: string[];
  /** Units: movement type (UnitData.slk movetp: foot, horse, fly, hover, float, amph), which decides
   *  how high the game puts them (see unitDrawHeight). */
  moveType?: string;
  /** Units: flying height (UnitData.slk moveHeight, field `umvh`), at which a flying or hovering unit is drawn over the
   *  ground (see unitDrawHeight). */
  moveHeight?: number;
  /** Units: the shadow texture under them (ReplaceableTextures\Shadows\<name>, UnitSkin.txt `unitShadow`, field
   *  `ushu`), and its rectangle: `shadowX`/`shadowY` from its south-west corner to the unit, `shadowW` × `shadowH`. */
  unitShadow?: string;
  shadowX?: number;
  shadowY?: number;
  shadowW?: number;
  shadowH?: number;
  /** Buildings (`buildingShadow`, `ushb`) and destructables (`shadow`, `bshd`): a shadow image of one texel per
   *  32 × 32 cell, put into the ground's shadow map (viewshadows.ts). */
  buildingShadow?: string;
  /** Doodads: false when the World Editor leaves them out of the baked shadow map, war3map.shd (DoodadSkins.txt
   *  `shadow=0`, field `dshd`: corn, flowers, rubble, …); otherwise they cast into it. */
  bakesShadow?: boolean;
  /** Units: a team colour of the type's own (UnitSkin.txt `teamColor`, field `utco`; the tavern and the mercenary
   *  camps), drawn whoever owns it; absent: the owner's. */
  teamColor?: number;
  /** Units: a placed one's own colour (war3mapUnits.doo `color`) is drawn (UnitSkin.txt `customTeamColor`, field `utcc`,
   *  Allow Custom Team Color: the waygate's). */
  customColor?: boolean;
  /** Doodads: the World Editor draws its click helper by the model (Doodads.slk `useClickHelper`, field `duch`: fires,
   *  traps, flies, dust, …, whose models are mostly particles; see CLICK_HELPER). */
  clickHelper?: boolean;
}

/**
 * The World Editor's click helper (WorldEditData.txt, [WorldEditArt] ClickHelper, [WorldEditMisc] ClickHelperScale,
 * [WorldEditColors] ClickHelperColor 96,255,255,255): the checkered cube model InvalidObject (128 a side, its texture
 * BTNtempW's white squares coloured magenta by its geoset) at 0.4 of the doodad's size, see-through (alpha 96/255),
 * standing where the doodad stands and turned with it. Only the editor's view shows it, not its game view (we-drive,
 * branch render-fixes-6: a purple cube about 51 a side on every `useClickHelper` doodad, in SD and HD).
 */
export const CLICK_HELPER = { model: "Objects\\InvalidObject\\InvalidObject.mdx", scale: 0.4, tint: [1, 1, 1, 96 / 255] as [number, number, number, number] };

/** Puts Doodads.slk's click helpers on the doodads' skins. */
export function addClickHelpers(skins: Map<string, Skin>, rows: readonly Record<string, string>[]) {
  for (const r of rows) {
    const skin = r.doodID ? skins.get(r.doodID) : undefined;
    if (skin?.kind === "w3d" && r.useClickHelper?.trim() === "1") skin.clickHelper = true;
  }
}

/** Player colours a placed object can be drawn in (0 Red … 23 Peanut). */
const PLAYER_COLORS = 24;

/** The team colour a placed object of this type is drawn in: its own colour (`color`, 0–23) where the type allows one
 *  (Skin.customColor: a waygate's Custom Color), else the type's own (Skin.teamColor), else its owner's. As the World
 *  Editor draws them (we-drive, 2026-11-10): a waygate in its colour, one of a type without utcc and a footman with a
 *  stored colour in the owner's. */
export const drawnTeam = (skin: Skin, owner: number, color?: number): number =>
  skin.customColor && color !== undefined && Number.isInteger(color) && color >= 0 && color < PLAYER_COLORS ? color : skin.teamColor ?? owner;

/** Random unit, building and item (war3mapUnits.doo) and the object kind each is placed as. */
export const RANDOM_KINDS: readonly (readonly [string, string])[] = [["uDNR", "w3u"], ["bDNR", "w3u"], ["iDNR", "w3t"]];
const RANDOM_MODEL = "Objects\\RandomObject\\RandomObject.mdl";

/** The tables with units' Animprops, which the skin table doesn't carry. */
const UNIT_FUNC = ["Human", "Orc", "Undead", "NightElf", "Neutral", "Campaign"].map((r) => `Units\\${r}UnitFunc.txt`);

/** Puts a unit table's Animprops on the skins. */
export function addAnimProps(skins: Map<string, Skin>, text: string) {
  for (const [id, sec] of parseIni(text)) {
    const skin = skins.get(id.trim()), props = parseAnimProps(sec.get("animprops") ?? "");
    if (skin && props.length) skin.animProps = props;
  }
}

/** Puts the unit table's movement types and flying heights on the skins. */
export function addMoveTypes(skins: Map<string, Skin>, rows: readonly Record<string, string>[]) {
  for (const r of rows) {
    const skin = r.unitID ? skins.get(r.unitID) : undefined;
    if (!skin) continue;
    if (r.movetp) skin.moveType = r.movetp;
    const height = Number(r.moveHeight);
    if (r.moveHeight?.trim() && Number.isFinite(height)) skin.moveHeight = height;
  }
}

const SKIN_FILES: [string, string][] = [
  ["Doodads\\DoodadSkins.txt", "w3d"], ["Units\\DestructableSkin.txt", "w3b"], ["Units\\UnitSkin.txt", "w3u"], ["Units\\ItemSkin.txt", "w3t"],
];

/** Every game table the skins are made from, in the order they're read. */
const SKIN_TABLES = [...SKIN_FILES.map(([f]) => f), ...UNIT_FUNC, "Units\\UnitData.slk", "Doodads\\Doodads.slk"];

/** The skins last made, with what they were made from: reading the tables again is cheap (the game's
 *  files are kept, see workbench/game.ts), parsing them isn't (tens of ms, on each reload of the
 *  placed objects). Made again when the install, the graphics mode or any table's text differs, so a
 *  reloaded or patched game (w3.game.reload) is seen too, and a table that couldn't be read (taken as
 *  empty, as without the cache) is parsed again once it can be. */
let skinCache: { install: string; mode: string; texts: string[]; skins: Map<string, Skin> } | null = null;
/** Times the skins were parsed: for the tests. */
export const skinParses = { count: 0 };

/** Model info per object id. Keys with a graphics-mode suffix ("file:hd")
 *  win over plain ones. The game's own: a map's object data goes on top with withObjectArt. The
 *  entries are shared between callers and frozen; the map is the caller's own. */
export async function loadSkins(w3: W3Api): Promise<Map<string, Skin>> {
  const install = w3.settings.get<string>("game.installDir") ?? "";
  const mode = w3.settings.get<string>("game.graphicsMode") ?? "hd";
  const texts = await Promise.all(SKIN_TABLES.map((f) => w3.game.readText(f).catch(() => "")));
  const kept = skinCache;
  if (kept && kept.install === install && kept.mode === mode && kept.texts.every((t, i) => t === texts[i])) return new Map(kept.skins);
  const skins = parseSkins(mode, texts);
  for (const s of skins.values()) { if (s.animProps) Object.freeze(s.animProps); Object.freeze(s); }
  // The install or mode changed during the reads: they may be of either, so they aren't kept.
  const settled = install === (w3.settings.get<string>("game.installDir") ?? "") && mode === (w3.settings.get<string>("game.graphicsMode") ?? "hd");
  skinCache = settled ? { install, mode, texts, skins } : null;
  return new Map(skins);
}

/** A shadow image's name as the tables give it: "", "_" and "none" are none. */
export function shadowName(v: string | undefined): string | undefined {
  const s = v?.trim();
  return s && s !== "_" && s.toLowerCase() !== "none" ? s : undefined;
}

/** The shadow fields of a skin table entry (units and destructables; doodads' `shadow` is whether the World
 *  Editor bakes them into war3map.shd). */
function shadowFields(get: (k: string) => string | undefined, kind: string): Partial<Skin> {
  if (kind === "w3d") return get("shadow")?.trim() === "0" ? { bakesShadow: false } : {};
  if (kind === "w3b") {
    const building = shadowName(get("shadow"));
    return building ? { buildingShadow: building } : {};
  }
  if (kind !== "w3u") return {};
  const out: Partial<Skin> = {};
  const unit = shadowName(get("unitshadow")), building = shadowName(get("buildingshadow"));
  if (unit) {
    out.unitShadow = unit;
    for (const [k, f] of [["shadowX", "shadowx"], ["shadowY", "shadowy"], ["shadowW", "shadoww"], ["shadowH", "shadowh"]] as const) {
      const n = Number(get(f));
      if (Number.isFinite(n)) out[k] = n;
    }
  }
  if (building) out.buildingShadow = building;
  const team = Number(get("teamcolor"));
  if (get("teamcolor")?.trim() && Number.isInteger(team) && team >= 0) out.teamColor = team;
  if (get("customteamcolor")?.trim() === "1") out.customColor = true;
  return out;
}

/** The skins from the tables' texts, in SKIN_TABLES' order. */
function parseSkins(mode: string, texts: string[]): Map<string, Skin> {
  skinParses.count++;
  const out = new Map<string, Skin>();
  const tables = new Map(SKIN_TABLES.map((f, i) => [f, texts[i]]));
  for (const [f, kind] of SKIN_FILES) {
    const text = tables.get(f) ?? "";
    for (const [id, sec] of parseIni(text)) {
      const get = (k: string) => artValue((key) => sec.get(key), k, mode);
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
        ...shadowFields(get, kind),
      });
    }
  }
  for (const f of UNIT_FUNC) addAnimProps(out, tables.get(f) ?? "");
  addMoveTypes(out, parseSlk(tables.get("Units\\UnitData.slk") ?? ""));
  addClickHelpers(out, parseSlk(tables.get("Doodads\\Doodads.slk") ?? ""));
  // Start locations have no skin entry; the World Editor draws them with this model
  // (WorldEditData.txt, StartLocation), which also makes them selectable here.
  if (!out.has("sloc")) {
    out.set("sloc", { kind: "w3u", file: "Objects\\StartLocation\\StartLocation.mdl", numVar: 1, texId: -1, texFile: "", modelScale: 1, minScale: 1, maxScale: 1, randScale: false, fixedRot: null, uberSplat: "" });
  }
  // Random units, buildings and items (chosen when the game starts) have no type either: the World Editor draws
  // them with its question mark (WorldEditData.txt, RandomUnitModel).
  for (const [id, kind] of RANDOM_KINDS) {
    if (!out.has(id)) out.set(id, { kind, file: RANDOM_MODEL, numVar: 1, texId: -1, texFile: "", modelScale: 1, minScale: 1, maxScale: 1, randScale: false, fixedRot: null, uberSplat: "" });
  }
  return out;
}

/** Object data fields that change a skin entry, per kind (UnitMetaData & co., "Profile" fields;
 *  units' alternate models umd1/umd2 and selection scale aren't drawn). */
const ART_FIELDS: Record<string, Partial<Record<keyof Skin, string>>> = {
  w3u: {
    file: "umdl", modelScale: "usca", uberSplat: "uubs", animProps: "uani", moveType: "umvt", moveHeight: "umvh",
    unitShadow: "ushu", shadowX: "ushx", shadowY: "ushy", shadowW: "ushw", shadowH: "ushh", buildingShadow: "ushb", teamColor: "utco",
    customColor: "utcc",
  },
  w3t: { file: "ifil", modelScale: "isca" },
  w3d: { file: "dfil", numVar: "dvar", minScale: "dmis", maxScale: "dmas", randScale: "dcpr", fixedRot: "dfxr", bakesShadow: "dshd", clickHelper: "duch" },
  w3b: { file: "bfil", numVar: "bvar", texId: "btxi", texFile: "btxf", minScale: "bmis", maxScale: "bmas", randScale: "bcpr", fixedRot: "bfxr", buildingShadow: "bshd" },
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
        if (key === "file" || key === "texFile" || key === "uberSplat" || key === "moveType") skin[key] = String(m.value);
        else if (key === "unitShadow" || key === "buildingShadow") skin[key] = shadowName(String(m.value));
        else if (key === "animProps") skin.animProps = parseAnimProps(String(m.value));
        else if (key === "randScale") skin.randScale = n === 1;
        else if (key === "bakesShadow") skin.bakesShadow = n !== 0;
        else if (key === "clickHelper") { if (n === 1) skin.clickHelper = true; else delete skin.clickHelper; }
        else if (key === "customColor") { if (n === 1) skin.customColor = true; else delete skin.customColor; }
        else if (key === "fixedRot") skin.fixedRot = n >= 0 ? n : null;
        else if (key === "teamColor") { if (Number.isInteger(n) && n >= 0) skin.teamColor = n; else delete skin.teamColor; }
        else if ((key === "numVar" || key === "texId" || key === "modelScale" || key === "minScale" || key === "maxScale"
          || key === "shadowX" || key === "shadowY" || key === "shadowW" || key === "shadowH" || key === "moveHeight") && Number.isFinite(n)) skin[key] = n;
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

/** Whether a model's own particle effects show anything. Some Reforged models keep their classic emitters as empty
 *  placeholders (the Lordaeron brazier LObr: colours and alphas all 0) next to their PopcornFX fire: those count as
 *  none, so the classic model's emitters stand in as for the others. */
export function drawsParticles(m: Pick<Model, "particleEmitters2" | "ribbons">): boolean {
  return m.ribbons.length > 0 || m.particleEmitters2.some((e) => e.segmentAlpha.some((a) => a > 0));
}

/** The model to read when a variation's file isn't stored: the type's file without a number. The classic game
 *  keeps some types of several variations in one file (the City wall endcap YSw5: numVar 2, but only
 *  CityWallEndcap.mdx in War3.w3mod; the numbered files are Reforged's), which the World Editor's SD view shows. */
export function plainModelPath(skin: Skin): string | undefined {
  return skin.numVar > 1 ? `${skin.file.replace(/\.(mdl|mdx)$/i, "")}.mdx` : undefined;
}

/** The scales a placed object of this type is drawn within, [least, most], or undefined for any: a doodad's or
 *  destructable's type's minScale and maxScale. The World Editor draws one stored outside them at the nearest end
 *  (ZZdt, 1 to 1, placed at 4 shows at 1; the armor rack LOam, 0.8 to 2, placed at 3 shows at 2; the hay cart LOch,
 *  0.8 to 1.2, placed at 2, 1, 1 is longer than one at 0.3; Lordaeron's tree LTlt, 0.8 to 1.2, placed at 0.4 and 3
 *  about as big as one at 1: we-drive, SD and HD, branch render-fixes-6), each axis on its own; the stored scale
 *  stays as it is. Units and items have no such range. */
export function scaleRange(skin: Pick<Skin, "kind" | "minScale" | "maxScale">): readonly [number, number] | undefined {
  if (skin.kind !== "w3d" && skin.kind !== "w3b") return undefined;
  const { minScale: lo, maxScale: hi } = skin;
  return Number.isFinite(lo) && Number.isFinite(hi) && lo > 0 && hi >= lo ? [lo, hi] : undefined;
}

/** World matrix: translate · rotate about z · scale (column-major). `z`: drawn at another height than
 *  the stored one (a ship on the water, see unitDrawHeight). `range`: the scales it's drawn within (scaleRange). */
export function placement(p: Placed, extraScale: number, z = p.position[2], range?: readonly [number, number]): Mat4 {
  const c = Math.cos(p.angle), s = Math.sin(p.angle);
  // A mirrored axis (a negative scale) stays mirrored.
  const [sx, sy, sz] = p.scale.map((v) => (range ? Math.sign(v || 1) * Math.min(range[1], Math.max(range[0], Math.abs(v))) : v) * extraScale);
  const [x, y] = p.position;
  return new Float32Array([c * sx, s * sx, 0, 0, -s * sy, c * sy, 0, 0, 0, 0, sz, 0, x, y, z, 1]);
}

/** One model to draw at the given places. */
export interface ModelRequest {
  path: string;
  /** Read instead when `path` isn't stored (plainModelPath). */
  plain?: string;
  /** Replaceable texture id → path (e.g. a tree type's own texture). */
  replaceable: Record<number, string>;
  instances: ObjectInstance[];
  /** The look to stand in (Animprops). */
  props?: readonly string[];
  /** Swaps texture paths the game substitutes at runtime (HD cliff placeholders). */
  retexture?: (path: string) => string;
}

export interface LoadResult {
  batches: ObjectBatch[];
  /** Objects without a drawable model (start locations, unknown ids, load errors). */
  unresolved: Placed[];
  /** Selection stand-ins for the unresolved objects (not start locations). */
  strays: Stray[];
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
  /** Models, textures and effects still loading. */
  private running = 0;

  /** Whether anything asked for is still loading: the view then draws less often (see the terrain viewer's tick). */
  get busy(): boolean { return this.running > 0; }

  private track<T>(load: Promise<T>): Promise<T> {
    this.running++;
    const done = () => { this.running--; };
    load.then(done, done);
    return load;
  }

  /** Forgets every loaded model and texture (and what was missing): files the map imports
   *  changed, so they're read again on the next load. */
  reset() {
    this.textures.clear();
    this.missing.clear();
    this.textureUsers.clear();
    this.models.clear();
    this.effectSources.clear();
  }

  /** Resolves when everything asked for so far has loaded. Models draw before their textures
   *  are there (white), and a model can ask for more while loading. */
  async settled() {
    let seen = -1;
    while (seen !== this.textures.size + this.models.size) {
      seen = this.textures.size + this.models.size;
      await Promise.allSettled([...this.textures.values(), ...this.models.values()]);
    }
    // Whoever waits for a texture takes it in a callback of its own.
    await new Promise((done) => setTimeout(done));
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
      const variants = neverStoredLast(tails.flatMap((t) => (/\.(blp|tif|tga)$/i.test(t) ? [t, t.replace(/\.\w+$/, ".dds")] : [t])));
      t = this.track((async () => {
        let error = "";
        for (const v of variants) {
          try {
            const tex = createTexture(this.gl, decodeImage(await this.readFile(v), v), { repeat: [(flags & 1) !== 0, (flags & 2) !== 0] });
            this.onTexture();
            return tex;
          } catch (e) { error += `${error ? " | " : ""}${v}: ${(e as Error).message ?? e}`; }
        }
        this.missing.set(path, error);
        this.onTexture();
        return null;
      })());
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
    if (drawsParticles(m)) return Promise.resolve({ model: m, textures: gpu.textures, nodeWorld: gpu.nodeWorld, clock: gpu.poseClock, classic: false });
    if (!m.skipped.includes("CORN")) return Promise.resolve(null);
    const key = `${req.path.toLowerCase()}|${req.props ?? ""}`;
    let e = this.effectSources.get(key);
    if (!e) {
      e = this.track((async () => {
        let sd;
        try { sd = parseMdx(await this.readFile(`War3.w3mod:${req.path.replace(/\\/g, "/")}`)); } catch { return null; }
        if (!sd.particleEmitters2.length && !sd.ribbons.length) return null;
        const clock = standClock(sd, req.props);
        const textures: (WebGLTexture | null)[] = sd.textures.map(() => null);
        sd.textures.forEach((t, i) => {
          if (t.replaceableId === 0 && t.path) void this.texture(t.path, t.flags).then((tex) => { textures[i] = tex; });
        });
        return { model: sd, textures, nodeWorld: poseNodes(sd, clock), clock, classic: true };
      })());
      this.effectSources.set(key, e);
    }
    return e;
  }

  private model(req: ModelRequest): Promise<ModelGpu> {
    const key = `${req.path.toLowerCase()}|${JSON.stringify(req.replaceable)}|${req.props ?? ""}`;
    let m = this.models.get(key);
    if (!m) {
      m = this.track((async () => {
        const model = parseMdx(await this.readFile(req.path).catch((e: unknown) => {
          if (req.plain) return this.readFile(req.plain);
          throw e;
        }));
        const gpu = new ModelGpu(this.gl, model);
        // Stand still at the start of its "Stand" animation.
        gpu.props = req.props ?? [];
        gpu.pose(standClock(model, gpu.props));
        const drawn = drawnTextures(model);
        gpu.texturePaths(req.replaceable).forEach((p, i) => {
          if (!p || !drawn.has(i)) return;
          const tex = req.retexture?.(p) ?? p;
          let users = this.textureUsers.get(tex.toLowerCase());
          if (!users) this.textureUsers.set(tex.toLowerCase(), (users = new Set()));
          users.add(req.path.toLowerCase());
          this.texture(tex, model.textures[i].flags).then((t) => { gpu.textures[i] = t; });
        });
        return gpu;
      })());
      this.models.set(key, m);
    }
    return m;
  }

  /** The GPU model for a placed type (shared with the batches; for previews). */
  modelFor(skin: Skin, variation: number): Promise<ModelGpu> {
    const replaceable = skinTextures(skin);
    return this.model({ path: modelPath(skin, variation), plain: plainModelPath(skin), replaceable, props: skin.animProps, instances: [] });
  }

  /** Loads each requested model; failed ones are reported by index. The batches keep the order of
   *  the requests, whichever model loads first: see-through layers blend in drawing order. */
  async loadModels(group: string, requests: ModelRequest[]): Promise<{ batches: ObjectBatch[]; failed: { index: number; error: string }[] }> {
    const loaded: (ObjectBatch | undefined)[] = [], failed: { index: number; error: string }[] = [];
    await Promise.all(requests.map(async (req, index) => {
      try {
        const gpu = await this.model(req);
        const model = gpu.model;
        // Bounding sphere per instance, for picking and culling; the model's own is kept for when the object turns.
        const b = bounds(model);
        const local: [number, number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2,
          Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2];
        for (const inst of req.instances) {
          inst.bounds = local;
          inst.sphere = worldSphere(inst.world, local);
        }
        loaded[index] = { group, gpu, instances: req.instances, effects: await this.effects(req, gpu) ?? undefined };
      } catch (e) {
        failed.push({ index, error: `${req.path}: ${(e as Error).message ?? e}` });
      }
    }));
    failed.sort((a, b) => a.index - b.index);
    return { batches: loaded.filter((b): b is ObjectBatch => b !== undefined), failed };
  }

  private placeholderGpu: ModelGpu | null = null;

  /** The World Editor's checkered cube (placeholder.ts), made once. */
  private placeholder(): ModelGpu {
    if (!this.placeholderGpu) {
      // Kept only once whole: a context lost on the way throws, and the next load tries again.
      const gpu = new ModelGpu(this.gl, placeholderModel());
      gpu.pose(standClock(gpu.model));
      gpu.textures[0] = createTexture(this.gl, placeholderImage(), { repeat: [false, false] });
      this.placeholderGpu = gpu;
    }
    return this.placeholderGpu;
  }

  /** Placed doodads/units: models from the skin tables. Custom object ids
   *  use their base object's model (`baseOf`, from the map's object data). An object whose model doesn't load
   *  (or whose id is unknown) is drawn as the World Editor's checkered cube, a batch of its own in the group, and
   *  selected like any other; without `placeholders` (the start buildings' previews) it's only a stray.
   *  `looksOf`: looks a placed object stands in besides its type's Animprops (a swimming unit's "swim"). */
  async load(group: string, placed: Placed[], skins: Map<string, Skin>, teamOf: (p: Placed) => number,
    baseOf: (id: string) => string | undefined = () => undefined, heightOf?: (p: Placed, skin: Skin) => number,
    placeholders = true, shownAs?: (p: Placed) => string | undefined,
    looksOf?: (p: Placed, skin: Skin) => readonly string[]): Promise<LoadResult> {
    const byModel = new Map<string, { req: ModelRequest; items: Placed[] }>();
    const unresolved: Placed[] = [];
    // Ids without a model (start locations have none on purpose).
    const unknown = new Map<string, Placed[]>();
    // `shownAs`: drawn as another type (Cycle Random Groups shows a group's unit), its own when that has no model.
    const skinFor = (id: string) => skins.get(id) ?? skins.get(baseOf(id) ?? "");
    for (const [index, p] of placed.entries()) {
      const other = shownAs?.(p);
      const skin = (other !== undefined ? skinFor(other) : undefined) ?? skinFor(p.id);
      if (!skin) {
        unresolved.push(p);
        if (p.id !== "sloc") unknown.set(p.id, [...(unknown.get(p.id) ?? []), p]);
        continue;
      }
      const path = modelPath(skin, p.variation);
      const more = looksOf?.(p, skin).filter((l) => !skin.animProps?.includes(l)) ?? [];
      const props = more.length ? [...(skin.animProps ?? []), ...more] : skin.animProps;
      const key = `${path}|${skin.texFile}|${props ?? ""}`;
      let entry = byModel.get(key);
      if (!entry) {
        const replaceable = skinTextures(skin);
        entry = { req: { path, plain: plainModelPath(skin), replaceable, props, instances: [] }, items: [] };
        byModel.set(key, entry);
      }
      entry.items.push(p);
      const range = scaleRange(skin);
      entry.req.instances.push({
        world: placement(p, skin.modelScale, heightOf?.(p, skin), range), team: drawnTeam(skin, teamOf(p), (p as Placed & { color?: number }).color),
        pick: { kind: skin.kind, id: p.id, base: skins.has(p.id) ? undefined : baseOf(p.id), index, placed: p, model: path, extraScale: skin.modelScale, ...(range ? { scaleRange: range } : {}) },
      });
    }
    const entries = [...byModel.values()];
    const { batches, failed } = await this.loadModels(group, entries.map((e) => e.req));
    for (const f of failed) unresolved.push(...entries[f.index].items);
    const problems: LoadProblem[] = [
      ...failed.map((f) => ({ message: f.error, items: entries[f.index].items })),
      ...[...unknown].map(([id, items]) => ({ message: `${id}: unknown object (no model; not in the game's or the map's object data)`, items })),
    ];
    const helpers = await this.clickHelpers(group, batches, (inst) => !!inst.pick && !!skinFor(inst.pick.id)?.clickHelper);
    if (helpers) batches.push(helpers);
    const strays = strayInstances(group, placed, unresolved, skins, teamOf, baseOf, heightOf);
    if (!placeholders || !strays.length) return { batches, unresolved, strays, problems };
    let gpu: ModelGpu;
    // A lost context can't compile the model shader: the objects stay markers (the view is reopened anyway).
    try { gpu = this.placeholder(); } catch { return { batches, unresolved, strays, problems }; }
    const instances = placeholderInstances(strays, bounds(gpu.model));
    const cubes = new Set(instances.map((inst) => inst.pick?.placed));
    return { batches: [...batches, { group, gpu, instances }], unresolved: unresolved.filter((p) => !cubes.has(p)), strays: [], problems };
  }

  /** The click helpers (CLICK_HELPER) of the batches' instances that `wanted` says have one: a batch of their own,
   *  see-through and only in the editor's view, each following its doodad. Null when there are none, or the cube's
   *  model doesn't load (then the doodads are drawn without; it isn't one of theirs that failed). */
  private async clickHelpers(group: string, batches: readonly ObjectBatch[], wanted: (inst: ObjectInstance) => boolean): Promise<ObjectBatch | null> {
    const owners = batches.flatMap((b) => b.instances.filter(wanted));
    if (!owners.length) return null;
    let gpu: ModelGpu;
    try { gpu = await this.model({ path: CLICK_HELPER.model, replaceable: {}, instances: [] }); } catch { return null; }
    const b = bounds(gpu.model);
    const local: [number, number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2,
      Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2];
    const instances = owners.map((owner): ObjectInstance => {
      const follows = { owner, local: clickHelperLocal(owner) };
      const world = mat4.mul(owner.world, follows.local);
      return { world, team: owner.team, bounds: local, sphere: worldSphere(world, local), follows };
    });
    return { group, gpu, instances, tint: [...CLICK_HELPER.tint], editorOnly: true };
  }
}

/** Where a doodad's click helper stands in the doodad's own space (its world matrix times this): CLICK_HELPER.scale. */
export function clickHelperLocal(_owner: ObjectInstance): Mat4 {
  const s = CLICK_HELPER.scale;
  return new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);
}

/** The strays as instances of the placeholder cube: picked and culled by the cube's bounds (`box`, model space). */
export function placeholderInstances(strays: readonly Stray[], box: { min: readonly number[]; max: readonly number[] }): ObjectInstance[] {
  const local: [number, number, number, number] = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2,
    Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2];
  return strays.map(({ inst }) => ({ ...inst, bounds: local, sphere: worldSphere(inst.world, local) }));
}

/** A placed object without a model (an unknown id, a model that didn't load). Only a marker
 *  shows it, so selection works on this stand-in instance: its position and a small sphere. */
export interface Stray { group: string; inst: ObjectInstance }

/** Stand-ins for the unresolved objects of one group. Start locations are left out: they stay
 *  markers that can't be moved or deleted (a player needs one). */
export function strayInstances(group: string, placed: readonly Placed[], unresolved: readonly Placed[], skins: Map<string, Skin>,
  teamOf: (p: Placed) => number, baseOf: (id: string) => string | undefined = () => undefined, heightOf?: (p: Placed, skin: Skin) => number): Stray[] {
  const index = new Map(placed.map((p, i) => [p, i]));
  return unresolved.filter((p) => p.id !== "sloc").map((p) => {
    const skin = skins.get(p.id) ?? skins.get(baseOf(p.id) ?? "");
    // A known type whose model didn't load stands where its model would (a ship on the water).
    const [x, y] = p.position, z = skin && heightOf ? heightOf(p, skin) : p.position[2];
    return {
      group,
      inst: {
        world: placement(p, 1, z), team: teamOf(p), sphere: [x, y, z, 32] as [number, number, number, number],
        pick: { kind: skin?.kind ?? (group === "doodads" ? "w3d" : "w3u"), id: p.id, base: skins.has(p.id) ? undefined : baseOf(p.id), index: index.get(p) ?? -1, placed: p, model: "", extraScale: 1 },
      },
    };
  });
}

/** The placed objects whose position projects into a rectangle of the canvas (CSS pixels), among
 *  the doodads and units not hidden, of the kinds wanted. */
export function objectsInRect(sources: Iterable<Stray>, project: (position: [number, number, number]) => [number, number] | null | undefined,
  hidden: ReadonlySet<string>, kinds: ReadonlySet<string>, x0: number, y0: number, x1: number, y1: number): Placed[] {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  const out: Placed[] = [];
  for (const { group, inst } of sources) {
    if ((group !== "doodads" && group !== "units") || hidden.has(group)) continue;
    if (!inst.pick || !kinds.has(inst.pick.kind)) continue;
    // Where it's drawn: a ship sits on the water, above its stored height.
    const s = project([inst.world[12], inst.world[13], inst.world[14]]);
    if (s && s[0] >= ax && s[0] <= bx && s[1] >= ay && s[1] <= by) out.push(inst.pick.placed);
  }
  return out;
}
