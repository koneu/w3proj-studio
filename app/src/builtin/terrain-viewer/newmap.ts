// New Map: asks for name, size, tileset, ground tiles, base tile, initial cliff level,
// water and random hills, and script language, then writes a project folder with
// the map in it, as the World Editor 2.0 makes
// one (World Editor 3.0.1, editor 7003; checked against a new map it saved): no
// map header, map info (w3i v39), terrain (w3e v12, centred on the origin, camera
// margins 6/6/4/8 tiles), one player with a start location, no doodads, the
// default melee trigger (wtg/wct) and the map script it compiles to, and the
// derived files (pathing, shadows, minimap). The project is opened in the
// terrain editor afterwards.

import type { W3Api } from "../../extensions/api";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { heightAt, randomVariation, setGroundHeight, setWaterLevel, waterLevelAt, writeW3e, type Corner, type Terrain } from "../../lib/terrain/w3e";
import { w3eToText } from "../../lib/terrain/w3etext";
import { parseWct, textTriggers, writeWctFile, writeWtgJson, WTG_JSON } from "../../lib/triggers/wtg";
import { h } from "../../workbench/dom";
import { buildMinimap, minimapSettings } from "./minimapgen";
import { buildPathingMap } from "./pathmap";
import { terrainShadows } from "./shadows";
import { defaultTriggerFile, defaultWct, MELEE_ACTIONS } from "./triggers";

export interface NewMapOptions {
  /** Folder to create (must not exist or be empty). */
  dir: string;
  name: string;
  author: string;
  description: string;
  /** Map size in tiles, camera margins included (multiples of 32). */
  width: number;
  height: number;
  tileset: string;
  /** Ground tiles (at most 16: the tileset's own, or a custom list) and the cliff types standing on them. */
  groundTiles: string[];
  cliffTiles: string[];
  /** The tile list differs from the tileset's. */
  customTiles: boolean;
  /** Ground tile the map is covered with (one of groundTiles). */
  baseTile: string;
  /** Cliff level of the ground (0–15; the World Editor starts at 2). */
  layer: number;
  /** Water over the whole map, as the painter's water tools make it: the ground one level
   *  (shallow) or two (deep) below `layer`, the surface just under `layer`'s ground. */
  water: "none" | "shallow" | "deep";
  /** Gentle random hills. */
  noise: boolean;
  lua: boolean;
}

/** Levels the ground goes down for water. */
const WATER_DROP = { none: 0, shallow: 1, deep: 2 } as const;

/** Camera margins (tiles): left, right, bottom, top, as the World Editor sets them. */
const MARGINS = [6, 6, 4, 8] as const;
/** Map flags of a fresh melee map (World Editor 3.0.1): melee, masked areas partially
 *  visible, 0x400, water waves on cliff and rolling shores, item classification. */
const FLAGS = 0x9c14;
/** Ambient sound sets (UI\SoundInfo\AmbientMusic.slk, "<name>Day"/"<name>Night") by tileset. */
const AMBIENCE: Record<string, string> = {
  A: "Ashenvale", B: "Barrens", C: "Felwood", D: "Dungeon", F: "LordaeronFall", G: "DungeonCave", I: "IceCrown",
  J: "DalaranRuins", K: "BlackCitadel", L: "LordaeronSummer", N: "Northrend", Q: "VillageFall", V: "Village",
  W: "LordaeronWinter", X: "Dalaran", Y: "CityScape", Z: "SunkenRuins",
};
const SIZES = Array.from({ length: 15 }, (_, i) => 32 * (i + 1));

interface Tile { id: string; name: string }
interface Tileset { id: string; name: string; tiles: Tile[]; cliffs: string[] }
interface TileData {
  sets: Tileset[];
  /** Every ground tile (Terrain.slk order), for custom tile lists. */
  all: Tile[];
  /** Cliff types standing on the given ground tiles. */
  cliffsOn(tiles: string[]): string[];
}

/** Tilesets with their ground tiles (Terrain.slk ids start with the tileset
 *  letter; that list, in table order, is what new maps get) and the cliff
 *  types standing on those tiles. */
async function loadTilesets(w3: W3Api): Promise<TileData> {
  const strings = new Map<string, string>();
  for (const f of ["UI\\WorldEditStrings.txt", "UI\\WorldEditGameStrings.txt"]) {
    for (const sec of parseIni(await w3.game.readText(f).catch(() => "")).values()) for (const [k, v] of sec) strings.set(k.toUpperCase(), v);
  }
  // Read by hand: tileset letters are case-sensitive ("e" isn't "E") and parseIni lowercases keys.
  const text = await w3.game.readText("UI\\WorldEditData.txt");
  const section = text.slice(text.indexOf("[TileSets]") + "[TileSets]".length).split(/^\[/m)[0];
  const entries = [...section.matchAll(/^(\w)=([^,\r\n]*)/gm)].map((m) => [m[1], m[2]] as const);
  const tiles = parseSlk(await w3.game.readText("TerrainArt\\Terrain.slk")).filter((r) => r.tileID);
  const cliffs = parseSlk(await w3.game.readText("TerrainArt\\CliffTypes.slk")).filter((r) => r.cliffID);
  const cliffsOn = (ids: string[]) => cliffs.filter((r) => ids.includes(r.groundTile)).map((r) => r.cliffID);
  const tile = (r: Record<string, string>): Tile => ({ id: r.tileID, name: r.comment || r.tileID });
  const out: Tileset[] = [];
  for (const [id, label] of entries) {
    const own = tiles.filter((r) => r.tileID[0] === id).slice(0, 16);
    if (!own.length) continue;
    out.push({ id, name: (strings.get(label.toUpperCase()) ?? id).replace(/&/g, ""), tiles: own.map(tile), cliffs: cliffsOn(own.map((r) => r.tileID)) });
  }
  return { sets: out.sort((a, b) => a.name.localeCompare(b.name)), all: tiles.map(tile), cliffsOn };
}

/** The New Map dialog; resolves with the choices, or null when cancelled. */
/** Preset for the dialog (e.g. a campaign's chapter map): parent folder, a suffix for the folder
 *  name (".w3x": chapter projects are named like their map file), dialog title. */
export interface NewMapPreset { parent?: string; suffix?: string; title?: string }

export async function askNewMap(w3: W3Api, preset: NewMapPreset = {}): Promise<NewMapOptions | null> {
  const data = await loadTilesets(w3);
  const tilesets = data.sets;
  if (!tilesets.length) throw new Error("No tilesets found in the game data.");
  return new Promise((resolve) => {
    let parent = preset.parent ?? "";
    const name = h("input.newmap-input", { type: "text", value: "Untitled", placeholder: "Map name" });
    const author = h("input.newmap-input", { type: "text", value: "", placeholder: "Author" });
    const description = h("textarea.newmap-input", { rows: 2, placeholder: "Description" });
    const sizeSelect = (value: number) => h("select", {}, ...SIZES.map((s) => h("option", { value: String(s), selected: s === value }, String(s))));
    const width = sizeSelect(96), height = sizeSelect(96);
    const playable = h("span.muted");
    const tileset = h("select", {}, ...tilesets.map((t) => h("option", { value: t.id, selected: t.id === "L" }, t.name)));
    const base = h("select");
    const layer = h("select", {}, ...Array.from({ length: 15 }, (_, i) => h("option", { value: String(i), selected: i === 2 }, String(i))));
    const water = h("select", {}, h("option", { value: "none" }, "None"), h("option", { value: "shallow" }, "Shallow water"), h("option", { value: "deep" }, "Deep water"));
    const noise = h("input", { type: "checkbox" });
    const script = h("select", {}, h("option", { value: "jass" }, "JASS"), h("option", { value: "lua" }, "Lua"));
    const folder = h("span.newmap-folder.muted", {}, "Choose a parent folder…");
    const error = h("div.newmap-error");
    const current = () => tilesets.find((t) => t.id === tileset.value)!;
    /** The ground tile list: the tileset's, until edited. */
    let tiles: string[] = current().tiles.map((x) => x.id);
    let custom = false;
    const tileName = (id: string) => data.all.find((x) => x.id === id)?.name ?? id;
    const tilesSummary = h("span.muted");
    const fillTiles = () => {
      if (!custom) tiles = current().tiles.map((x) => x.id);
      // Grass where the list has one (as the World Editor's default), else the first tile.
      const keep = tiles.includes(base.value) ? base.value : null;
      const pick = keep ?? tiles.find((x) => /^grass$/i.test(tileName(x))) ?? tiles.find((x) => /grass/i.test(tileName(x))) ?? tiles[0];
      base.replaceChildren(...tiles.map((x) => h("option", { value: x, selected: x === pick }, `${tileName(x)} (${x})`)));
      tilesSummary.textContent = `${tiles.length} tiles${custom ? " (custom)" : ""} `;
    };
    // Custom tile list: up to 16 ground tiles from any tileset.
    const tileList = h("div.newmap-tiles", { hidden: true });
    const editTiles = () => {
      const count = h("div.muted");
      const boxes = data.all.map((t) => {
        const box = h("input", { type: "checkbox", checked: tiles.includes(t.id) });
        return { t, box, label: h("label.newmap-tile", {}, box, ` ${t.name} (${t.id})`) };
      });
      const sync = () => {
        const picked = boxes.filter((b) => b.box.checked).map((b) => b.t.id);
        for (const b of boxes) b.box.disabled = !b.box.checked && picked.length >= 16;
        count.textContent = `${picked.length} of at most 16 tiles`;
        if (picked.length) {
          tiles = picked;
          custom = picked.join() !== current().tiles.map((x) => x.id).join();
          fillTiles();
        }
      };
      for (const b of boxes) b.box.addEventListener("change", sync);
      tileList.replaceChildren(count,
        h("div.newmap-tile-grid", {}, ...boxes.map((b) => b.label)),
        h("button", { onclick: (e: Event) => { e.preventDefault(); custom = false; fillTiles(); editTiles(); } }, "Tileset's tiles"));
      tileList.hidden = false;
      sync();
    };
    const folderName = () => name.value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/[. ]+$/, "") || "Untitled";
    const target = () => (parent ? `${parent.replace(/[\\/]+$/, "")}\\${folderName()}${preset.suffix ?? ""}` : "");
    const update = () => {
      playable.textContent = `playable ${Number(width.value) - MARGINS[0] - MARGINS[1]} × ${Number(height.value) - MARGINS[2] - MARGINS[3]}`;
      // Shown right-aligned to clip the start of long paths; the mark keeps them left-to-right.
      folder.textContent = parent ? `‎${target()}` : "Choose a parent folder…";
      folder.title = target();
      folder.classList.toggle("muted", !parent);
    };
    tileset.addEventListener("change", () => { fillTiles(); if (!tileList.hidden) editTiles(); });
    for (const el of [name, width, height]) el.addEventListener("input", update);
    fillTiles();
    update();

    const close = (value: Parameters<typeof resolve>[0]) => { overlay.remove(); resolve(value); };
    const create = () => {
      if (!parent) { error.textContent = "Choose where to create the project."; return; }
      if (!name.value.trim()) { error.textContent = "The map needs a name."; return; }
      const w = water.value as NewMapOptions["water"];
      if (Number(layer.value) < WATER_DROP[w]) { error.textContent = `${w === "deep" ? "Deep" : "Shallow"} water needs cliff level ${WATER_DROP[w]} or higher.`; return; }
      close({
        dir: target(), name: name.value.trim(), author: author.value.trim(), description: description.value.trim(),
        width: Number(width.value), height: Number(height.value), tileset: tileset.value,
        groundTiles: tiles, cliffTiles: data.cliffsOn(tiles), customTiles: custom, baseTile: base.value,
        layer: Number(layer.value), water: w, noise: noise.checked, lua: script.value === "lua",
      });
    };
    const row = (label: string, ...content: (HTMLElement | string)[]) => h("label.newmap-row", {}, h("span.newmap-label", {}, label), ...content);
    const overlay = h("div.picker-overlay.newmap-overlay", {
      tabindex: -1,
      onmousedown: (e: MouseEvent) => { if (e.target === overlay) close(null); },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Escape") close(null);
        if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) create();
      },
    }, h("div.picker.newmap-dialog", {},
      h("div.picker-header", {}, h("strong", {}, preset.title ?? "New Map"), h("button.icon-button", { title: "Close (Esc)", onclick: () => close(null) }, "×")),
      row("Name", name),
      row("Author", author),
      row("Description", description),
      row("Size", width, " × ", height, playable),
      row("Tileset", tileset),
      h("div.newmap-row", {}, h("span.newmap-label", {}, "Ground tiles"), tilesSummary,
        h("button", { title: "Choose up to 16 ground tiles from any tileset", onclick: (e: Event) => { e.preventDefault(); if (tileList.hidden) editTiles(); else tileList.hidden = true; } }, "Edit…")),
      tileList,
      row("Base tile", base),
      row("Cliff level", layer, h("span.muted", {}, " initial ground height")),
      row("Water", water),
      row("Random hills", noise),
      row("Script", script),
      row("Folder", h("button", { onclick: async (e: Event) => {
        e.preventDefault();
        const p = await w3.window.pickFolder({ title: "Create the project in…" });
        if (p) { parent = p; update(); }
      } }, "Browse…"), folder),
      error,
      h("div.newmap-buttons", {},
        h("button", { onclick: () => close(null) }, "Cancel"),
        h("button.primary", { onclick: create }, "Create"))));
    document.body.append(overlay);
    name.focus();
    name.select();
  });
}

/** Gentle random hills (world units, about ±50): smooth value noise over two grid sizes. */
function hills(width: number, height: number): (x: number, y: number) => number {
  const octave = (cell: number, amp: number) => {
    const gw = Math.ceil(width / cell) + 2, gh = Math.ceil(height / cell) + 2;
    const g = Float32Array.from({ length: gw * gh }, () => (Math.random() * 2 - 1) * amp);
    const smooth = (t: number) => t * t * (3 - 2 * t);
    return (x: number, y: number) => {
      const fx = x / cell, fy = y / cell, ix = Math.floor(fx), iy = Math.floor(fy);
      const u = smooth(fx - ix), v = smooth(fy - iy), at = (i: number, j: number) => g[(iy + j) * gw + ix + i];
      return (at(0, 0) * (1 - u) + at(1, 0) * u) * (1 - v) + (at(0, 1) * (1 - u) + at(1, 1) * u) * v;
    };
  };
  const big = octave(8, 40), small = octave(3, 12);
  return (x, y) => big(x, y) + small(x, y);
}

/** The terrain of `o.width` × `o.height` tiles, centred on the origin. */
export function newTerrain(o: NewMapOptions): Terrain {
  const width = o.width + 1, height = o.height + 1;
  const texture = Math.max(0, o.groundTiles.indexOf(o.baseTile));
  const layer = Math.max(0, Math.min(15, o.layer - WATER_DROP[o.water]));
  // The surface sits where the painter's water tools put it: just under the ground of `o.layer`.
  const level = o.water === "none" ? null : waterLevelAt((o.layer - 2) * 128 - 8);
  const lift = o.noise ? hills(width, height) : () => 0;
  const corners: Corner[] = Array.from({ length: width * height }, (_, i) => {
    const c: Corner = {
      height: 0, water: -89.6, texture, variation: randomVariation(), cliffVariation: 0, cliffTexture: 15, layer,
      ramp: false, blight: false, hasWater: false, boundary: false, rawHeight: 0x2000, rawWater: 0x2000, texExtra: 0,
    };
    setGroundHeight(c, lift(i % width, Math.floor(i / width)));
    if (level !== null) setWaterLevel(c, level);
    return c;
  });
  return {
    version: 12, tileset: o.tileset, customTilesets: o.customTiles, customTilesetsRaw: o.customTiles ? 1 : 0,
    groundTiles: o.groundTiles, cliffTiles: o.cliffTiles,
    width, height, offsetX: -o.width * 64, offsetY: -o.height * 64, corners, trailer: new Uint8Array(0),
  };
}

/** Camera bounds as the World Editor sets them: 4 tiles inside the left
 *  margin, 2 inside the bottom one, 2 inside the right and top ones. */
function cameraBounds(t: Terrain): { left: number; bottom: number; right: number; top: number } {
  const [l, , b] = MARGINS;
  return {
    left: t.offsetX + (l + 4) * 128, bottom: t.offsetY + (b + 2) * 128,
    right: t.offsetX + (t.width - 1 - 10) * 128, top: t.offsetY + (t.height - 1 - 10) * 128,
  };
}

/** Centre of the playable area. */
function playableCentre(t: Terrain): [number, number] {
  const [l, r, b, top] = MARGINS;
  return [t.offsetX + (l + (t.width - 1 - l - r) / 2) * 128, t.offsetY + (b + (t.height - 1 - b - top) / 2) * 128];
}

/** The minimap icon of a start location (war3map.mmp): its pixel on the 256×256 minimap of the
 *  playable area (scaled to fit, centred), red as player 1. Rounding as the World Editor's
 *  icons fit it best (x: 622 of 680 game map icons exact, y: 633; the rest 1 pixel off). */
export function startIcon(t: Terrain, x: number, y: number) {
  const [ml, mr, mb, mt] = MARGINS;
  const pw = t.width - 1 - ml - mr, ph = t.height - 1 - mb - mt, s = 256 / Math.max(pw, ph);
  const px = (256 - pw * s) / 2 + ((x - t.offsetX) / 128 - ml) * s;
  const py = 256 - ((256 - ph * s) / 2 + ((y - t.offsetY) / 128 - mb) * s);
  return { type: 2, x: Math.floor(px), y: Math.round(py + 0.38), color: { blue: 3, green: 3, red: 255, alpha: 255 } };
}

export function mapInfo(o: NewMapOptions, t: Terrain): unknown {
  const c = cameraBounds(t), [sx, sy] = playableCentre(t);
  return {
    format: "w3proj.mapinfo/1", version: 39, saves: 1, editorVersion: 7003, gameVersion: [3, 0, 1, 24371],
    name: o.name, author: o.author, description: o.description, suggestedPlayers: "Any",
    cameraBounds: [c.left, c.bottom, c.right, c.top, c.left, c.top, c.right, c.bottom],
    cameraComplements: [...MARGINS],
    playableWidth: t.width - 1 - MARGINS[0] - MARGINS[1], playableHeight: t.height - 1 - MARGINS[2] - MARGINS[3],
    flags: FLAGS, tileset: o.tileset,
    loadingScreen: { number: -1, crestRace: 64, model: "", text: "", title: "", subtitle: "" },
    gameDataSet: 0xffffffff,
    prologue: { path: "", text: "", title: "", subtitle: "" },
    fog: { style: 0, start: 3000, end: 5000, density: 0.5, color: [0, 0, 0, 255] },
    terrainFog: { style: 0, overSky: 0, linearStart: 10000, linearEnd: 10000, maxOpacity: 1, height: 0 },
    weather: "0x00000000", soundEnvironment: "", lightEnvironment: "", waterTint: [255, 255, 255, 255],
    scriptType: o.lua ? 1 : 0, supportedModes: 3, gameDataVersion: 2,
    cameraZoom: { default: 0, max: 0, min: 0 },
    water: {
      minOpacity: 0, maxOpacity: 100, reflectivity: 10, emissivity: 0, edgeSoftness: 50, wavesVertexDisplacement: 20,
      wavesNormalMapStrength: 100, overrideColor: 0, environmentMapReflectivity: 100, unknown: -1,
    },
    playerHudSkins: true,
    // Names live in war3map.wts (STRINGS), as the World Editor keeps them.
    players: [{ id: 0, controller: 1, race: 1, hudSkin: 32759, fixedStart: 0, name: "TRIGSTR_001", start: [sx, sy], allyLow: 0, allyHigh: 0, enemyLow: 0, enemyHigh: 0 }],
    forces: [{ flags: 0, players: 0xffffffff, name: "TRIGSTR_002" }],
    upgrades: [], techs: [], unitTables: [], itemTables: [],
  };
}

export function placements(t: Terrain): { doodads: unknown; units: unknown } {
  const [sx, sy] = playableCentre(t);
  return {
    doodads: { format: "w3proj.doodads/1", magic: "W3do", version: 13, subversion: 11, doodads: [], specialVersion: 0, specials: [] },
    units: {
      format: "w3proj.units/1", magic: "W3do", version: 13, subversion: 9, units: [{
        id: "sloc", variation: 0, position: [sx, sy, heightAt(t, sx, sy)], angle: 4.712389, scale: [1, 1, 1], skinId: "sloc",
        preFlags: 0xffffffff, flags: 2, player: 0, unknown1: 0, unknown2: 0, hp: 0, mana: 0, itemSets: [], gold: 0,
        targetAcquisition: 0, level: 0, inventory: [], abilities: [], randomType: 0, randomLevel: "010000", randomClass: 0,
        color: -1, waygate: -1, editorId: 0, trailer: [0, 0], extras: [],
      }],
    },
  };
}

/** The map script: camera bounds, day/night models, ambience, one player
 *  slot and the melee initialization trigger, in JASS or Lua. */
export function mapScript(o: NewMapOptions, t: Terrain, lights: { terrain: string; unit: string }): string {
  const c = cameraBounds(t), [sx, sy] = playableCentre(t);
  const num = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
  const str = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n")}"`;
  const m = (side: string) => `GetCameraMargin(CAMERA_MARGIN_${side})`;
  const bounds = [
    `${num(c.left)} + ${m("LEFT")}`, `${num(c.bottom)} + ${m("BOTTOM")}`, `${num(c.right)} - ${m("RIGHT")}`, `${num(c.top)} - ${m("TOP")}`,
    `${num(c.left)} + ${m("LEFT")}`, `${num(c.top)} - ${m("TOP")}`, `${num(c.right)} - ${m("RIGHT")}`, `${num(c.bottom)} + ${m("BOTTOM")}`,
  ].join(", ");
  const amb = AMBIENCE[o.tileset];
  const melee = MELEE_ACTIONS;
  const mainCalls = [
    `SetCameraBounds(${bounds})`,
    `SetDayNightModels(${str(lights.terrain)}, ${str(lights.unit)})`,
    `NewSoundEnvironment("Default")`,
    ...(amb ? [`SetAmbientDaySound("${amb}Day")`, `SetAmbientNightSound("${amb}Night")`] : []),
    `SetMapMusic("Music", true, 0)`,
    "InitBlizzard()", "InitGlobals()", "InitCustomTriggers()", "RunInitializationTriggers()",
  ];
  const slotCalls = [
    "SetPlayerStartLocation(Player(0), 0)", "SetPlayerColor(Player(0), ConvertPlayerColor(0))",
    "SetPlayerRacePreference(Player(0), RACE_PREF_USER_SELECTABLE)", "SetPlayerRaceSelectable(Player(0), true)",
    "SetPlayerController(Player(0), MAP_CONTROL_USER)",
  ];
  const configCalls = [
    `SetMapName(${str(o.name)})`, `SetMapDescription(${str(o.description)})`, "SetPlayers(1)", "SetTeams(1)",
    "SetGamePlacement(MAP_PLACEMENT_USE_MAP_SETTINGS)", `DefineStartLocation(0, ${num(sx)}, ${num(sy)})`,
    "InitCustomPlayerSlots()", "SetPlayerSlotAvailable(Player(0), MAP_CONTROL_USER)", "InitGenericPlayerSlots()",
  ];
  const header = [`${o.name}`, "", "  Warcraft III map script", "  Generated by W3Proj Studio", ...(o.author ? [`  Map Author: ${o.author}`] : [])];

  if (o.lua) {
    const fn = (name: string, body: string[]) => [`function ${name}()`, ...body.map((l) => `    ${l}`), "end", ""];
    return [
      "--" + "=".repeat(75), ...header.map((l) => `-- ${l}`.trimEnd()), "--" + "=".repeat(75), "",
      "gg_trg_Melee_Initialization = nil", "",
      ...fn("InitGlobals", []),
      ...fn("Trig_Melee_Initialization_Actions", melee.map((f) => `${f}()`)),
      ...fn("InitTrig_Melee_Initialization", ["gg_trg_Melee_Initialization = CreateTrigger()", "TriggerAddAction(gg_trg_Melee_Initialization, Trig_Melee_Initialization_Actions)"]),
      ...fn("InitCustomTriggers", ["InitTrig_Melee_Initialization()"]),
      ...fn("RunInitializationTriggers", ["ConditionalTriggerExecute(gg_trg_Melee_Initialization)"]),
      ...fn("InitCustomPlayerSlots", slotCalls),
      ...fn("main", mainCalls),
      ...fn("config", configCalls),
    ].join("\r\n");
  }
  const fn = (name: string, body: string[]) => [`function ${name} takes nothing returns nothing`, ...body.map((l) => `    call ${l.replace(/\((.*)\)$/, "( $1 )").replace("(  )", "( )")}`), "endfunction", ""];
  return [
    "//" + "=".repeat(75), ...header.map((l) => `// ${l}`.trimEnd()), "//" + "=".repeat(75), "",
    "globals", "    trigger gg_trg_Melee_Initialization = null", "endglobals", "",
    "function InitGlobals takes nothing returns nothing", "endfunction", "",
    ...fn("Trig_Melee_Initialization_Actions", melee.map((f) => `${f}()`)),
    "function InitTrig_Melee_Initialization takes nothing returns nothing",
    "    set gg_trg_Melee_Initialization = CreateTrigger( )",
    "    call TriggerAddAction( gg_trg_Melee_Initialization, function Trig_Melee_Initialization_Actions )",
    "endfunction", "",
    ...fn("InitCustomTriggers", ["InitTrig_Melee_Initialization()"]),
    ...fn("RunInitializationTriggers", ["ConditionalTriggerExecute(gg_trg_Melee_Initialization)"]),
    ...fn("InitCustomPlayerSlots", slotCalls),
    ...fn("main", mainCalls),
    ...fn("config", configCalls),
  ].join("\r\n");
}

/** Writes the project for `o` and opens it in the terrain editor. */
export async function createMap(w3: W3Api, o: NewMapOptions): Promise<void> {
  const t = newTerrain(o);
  const data = parseIni(await w3.game.readText("UI\\WorldEditData.txt"));
  const light = (section: string, kind: string) => data.get(section)?.get(o.tileset.toLowerCase())
    ?? `Environment\\DNC\\DNCLordaeron\\DNCLordaeron${kind}\\DNCLordaeron${kind}.mdl`;
  const lights = { terrain: light("TerrainLights", "Terrain"), unit: light("UnitLights", "Unit") };

  await w3.backend.invoke("project_create", { dir: o.dir, name: o.name, flags: FLAGS, maxPlayers: 1, header: false });
  // Switching projects closes the other project's editors (as Open Project does).
  await w3.editors.closeAll();
  await w3.workspace.open(o.dir);
  const root = w3.workspace.project()!.root;
  const json = async (path: string, value: unknown) =>
    w3.workspace.writeText(path, await w3.backend.invoke<string>("codec_canonicalize", { root, path, text: JSON.stringify(value) }));
  const { doodads, units } = placements(t);
  const [sx, sy] = playableCentre(t);
  await json("map/war3map.w3i.json", mapInfo(o, t));
  await json("map/war3map.doo.json", doodads);
  await json("map/war3mapUnits.doo.json", units);
  // Empty regions and cameras, the default trigger (the World Editor needs the trigger files),
  // the player and force names, the start location's minimap icon, and the empty lights, object
  // groups and conversation files World Editor 3.0.1 writes (their formats aren't known yet).
  await json("map/war3map.w3r.json", { format: "w3proj.regions/1", version: 7, regions: [] });
  await json("map/war3map.w3c.json", { format: "w3proj.cameras/1", version: 3, cameras: [] });
  await w3.workspace.writeText(WTG_JSON, writeWtgJson(defaultTriggerFile(o.name)));
  await writeWctFile(w3.workspace, parseWct(defaultWct(), 1), textTriggers(defaultTriggerFile(o.name)).map((t) => t.name));
  await w3.workspace.writeText("map/war3map.wts", "\uFEFFSTRING 1\r\n{\r\nPlayer 1\r\n}\r\n\r\nSTRING 2\r\n{\r\nForce 1\r\n}\r\n\r\n");
  await json("map/war3map.mmp.json", { format: "w3proj.minimap/1", version: 0, icons: [startIcon(t, sx, sy)] });
  await w3.workspace.writeBytes("map/war3map.w3l", Uint8Array.from([0x57, 0x33, 0x4c, 0x21, 3, ...new Array<number>(17).fill(0)]));
  await w3.workspace.writeBytes("map/war3map.w3grp", new Uint8Array(12));
  await w3.workspace.writeText("map/conversation.json", '{\n    "stringTablePath": "war3map.wts",\n    "conversation": {}\n}');
  await w3.workspace.writeText("map/war3map.w3e.txt", w3eToText(writeW3e(t)));
  await w3.workspace.writeText(o.lua ? "map/war3map.lua" : "map/war3map.j", mapScript(o, t, lights));
  await w3.workspace.writeBytes("map/war3map.shd", terrainShadows(t));
  await w3.workspace.refresh();
  const read = (p: string) => w3.game.read(p);
  const { wpm } = await buildPathingMap(w3, t, [], read, w3.settings.get<number>("terrain.pathing.deepWater"));
  await w3.workspace.writeBytes("map/war3map.wpm", wpm);
  await w3.workspace.writeBytes("map/war3mapMap.blp", await buildMinimap(w3, t, [], read, minimapSettings(w3), w3.settings.get<number>("terrain.minimap.jpegQuality")));
  await w3.workspace.refresh();
  // The map script from the files above, by the same generator as on save (the simple script
  // written above stays if the Map Script extension is off).
  await w3.commands.execute("w3.script.generate", { quiet: true }).catch(() => {});
  await w3.editors.open("map/war3map.w3e.txt", "w3.terrainViewer");
}
