// New Map: asks for name, size, tileset, base tile and script language, then
// writes a project folder with a flat map in it, as the World Editor 2.0 makes
// one: map info (w3i v33), terrain (w3e v12, centred on the origin, camera
// margins 6/6/4/8 tiles), one player with a start location, no doodads, the
// default melee trigger (wtg/wct) and the map script it compiles to, and the
// derived files (pathing, shadows, minimap). The project is opened in the
// terrain editor afterwards.

import type { W3Api } from "../../extensions/api";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { randomVariation, writeW3e, type Corner, type Terrain } from "../../lib/terrain/w3e";
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
  /** Ground tile the map is covered with (one of the tileset's tiles). */
  baseTile: string;
  lua: boolean;
}

/** Camera margins (tiles): left, right, bottom, top, as the World Editor sets them. */
const MARGINS = [6, 6, 4, 8] as const;
/** Map flags of a fresh melee map: melee, masked areas partially visible, water
 *  waves on cliff and rolling shores, item classification, water tinting,
 *  accurate random. */
const FLAGS = 0x2d814;
/** Ambient sound sets (UI\SoundInfo\AmbientMusic.slk, "<name>Day"/"<name>Night") by tileset. */
const AMBIENCE: Record<string, string> = {
  A: "Ashenvale", B: "Barrens", C: "Felwood", D: "Dungeon", F: "LordaeronFall", G: "DungeonCave", I: "IceCrown",
  J: "DalaranRuins", K: "BlackCitadel", L: "LordaeronSummer", N: "Northrend", Q: "VillageFall", V: "Village",
  W: "LordaeronWinter", X: "Dalaran", Y: "CityScape", Z: "SunkenRuins",
};
const SIZES = Array.from({ length: 15 }, (_, i) => 32 * (i + 1));

interface Tileset { id: string; name: string; tiles: { id: string; name: string }[]; cliffs: string[] }

/** Tilesets with their ground tiles (Terrain.slk ids start with the tileset
 *  letter; that list, in table order, is what new maps get) and the cliff
 *  types standing on those tiles. */
async function loadTilesets(w3: W3Api): Promise<Tileset[]> {
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
  const out: Tileset[] = [];
  for (const [id, label] of entries) {
    const own = tiles.filter((r) => r.tileID[0] === id).slice(0, 16);
    if (!own.length) continue;
    const ids = new Set(own.map((r) => r.tileID));
    out.push({
      id,
      name: (strings.get(label.toUpperCase()) ?? id).replace(/&/g, ""),
      tiles: own.map((r) => ({ id: r.tileID, name: r.comment || r.tileID })),
      cliffs: cliffs.filter((r) => ids.has(r.groundTile)).map((r) => r.cliffID),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The New Map dialog; resolves with the choices, or null when cancelled. */
/** Preset for the dialog (e.g. a campaign's chapter map): parent folder, a suffix for the folder
 *  name (".w3x": chapter projects are named like their map file), dialog title. */
export interface NewMapPreset { parent?: string; suffix?: string; title?: string }

export async function askNewMap(w3: W3Api, preset: NewMapPreset = {}): Promise<(NewMapOptions & { tilesetInfo: Tileset }) | null> {
  const tilesets = await loadTilesets(w3);
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
    const script = h("select", {}, h("option", { value: "jass" }, "JASS"), h("option", { value: "lua" }, "Lua"));
    const folder = h("span.newmap-folder.muted", {}, "Choose a parent folder…");
    const error = h("div.newmap-error");
    const current = () => tilesets.find((t) => t.id === tileset.value)!;
    const fillTiles = () => {
      const t = current();
      // Grass where the tileset has one (as the World Editor's default), else the first tile.
      const pick = t.tiles.find((x) => /^grass$/i.test(x.name)) ?? t.tiles.find((x) => /grass/i.test(x.name)) ?? t.tiles[0];
      base.replaceChildren(...t.tiles.map((x) => h("option", { value: x.id, selected: x === pick }, `${x.name} (${x.id})`)));
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
    tileset.addEventListener("change", fillTiles);
    for (const el of [name, width, height]) el.addEventListener("input", update);
    fillTiles();
    update();

    const close = (value: Parameters<typeof resolve>[0]) => { overlay.remove(); resolve(value); };
    const create = () => {
      if (!parent) { error.textContent = "Choose where to create the project."; return; }
      if (!name.value.trim()) { error.textContent = "The map needs a name."; return; }
      close({
        dir: target(), name: name.value.trim(), author: author.value.trim(), description: description.value.trim(),
        width: Number(width.value), height: Number(height.value), tileset: tileset.value, baseTile: base.value,
        lua: script.value === "lua", tilesetInfo: current(),
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
      row("Base tile", base),
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

/** A flat terrain of `o.width` × `o.height` tiles, centred on the origin. */
export function newTerrain(o: NewMapOptions, tiles: string[], cliffs: string[]): Terrain {
  const width = o.width + 1, height = o.height + 1;
  const texture = Math.max(0, tiles.indexOf(o.baseTile));
  const corners: Corner[] = Array.from({ length: width * height }, () => ({
    height: 0, water: -89.6, texture, variation: randomVariation(), cliffVariation: 0, cliffTexture: 15, layer: 2,
    ramp: false, blight: false, hasWater: false, boundary: false, rawHeight: 0x2000, rawWater: 0x2000, texExtra: 0,
  }));
  return {
    version: 12, tileset: o.tileset, customTilesets: false, customTilesetsRaw: 0, groundTiles: tiles, cliffTiles: cliffs,
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

function mapInfo(o: NewMapOptions, t: Terrain): unknown {
  const c = cameraBounds(t), [sx, sy] = playableCentre(t);
  return {
    format: "w3proj.mapinfo/1", version: 33, saves: 1, editorVersion: 6116, gameVersion: [2, 0, 3, 23101],
    name: o.name, author: o.author, description: o.description, suggestedPlayers: "Any",
    cameraBounds: [c.left, c.bottom, c.right, c.top, c.left, c.top, c.right, c.bottom],
    cameraComplements: [...MARGINS],
    playableWidth: t.width - 1 - MARGINS[0] - MARGINS[1], playableHeight: t.height - 1 - MARGINS[2] - MARGINS[3],
    flags: FLAGS, tileset: o.tileset,
    loadingScreen: { number: -1, model: "", text: "", title: "", subtitle: "" },
    gameDataSet: 0,
    prologue: { path: "", text: "", title: "", subtitle: "" },
    fog: { style: 0, start: 3000, end: 5000, density: 0.5, color: [0, 0, 0, 255] },
    weather: "0x00000000", soundEnvironment: "", lightEnvironment: "", waterTint: [255, 255, 255, 255],
    scriptType: o.lua ? 1 : 0, supportedModes: 3, gameDataVersion: 1,
    cameraZoom: { default: 1250, max: 1250, min: 1250 },
    players: [{ id: 0, controller: 1, race: 0, fixedStart: 0, name: "Player 1", start: [sx, sy], allyLow: 0, allyHigh: 0, enemyLow: 0, enemyHigh: 0 }],
    forces: [{ flags: 0, players: 0xffffffff, name: "Force 1" }],
    upgrades: [], techs: [], unitTables: [], itemTables: [],
  };
}

function placements(t: Terrain): { doodads: unknown; units: unknown } {
  const [sx, sy] = playableCentre(t);
  const head = { magic: "W3do", version: 8, subversion: 11, skinIds: true };
  return {
    doodads: { format: "w3proj.doodads/1", ...head, doodads: [], specialVersion: 0, specials: [] },
    units: {
      format: "w3proj.units/1", ...head, units: [{
        id: "sloc", variation: 0, position: [sx, sy, 0], angle: 4.712389, scale: [1, 1, 1], skinId: "sloc", flags: 2, player: 0,
        unknown1: 0, unknown2: 0, hp: -1, mana: -1, itemTable: -1, itemSets: [], gold: 0, targetAcquisition: 0, level: 0,
        strength: 0, agility: 0, intelligence: 0, inventory: [], abilities: [], randomType: 0, randomLevel: "010000",
        randomClass: 0, color: -1, waygate: -1, editorId: 0,
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
export async function createMap(w3: W3Api, o: NewMapOptions & { tilesetInfo: Tileset }): Promise<void> {
  const t = newTerrain(o, o.tilesetInfo.tiles.map((x) => x.id), o.tilesetInfo.cliffs);
  const data = parseIni(await w3.game.readText("UI\\WorldEditData.txt"));
  const light = (section: string, kind: string) => data.get(section)?.get(o.tileset.toLowerCase())
    ?? `Environment\\DNC\\DNCLordaeron\\DNCLordaeron${kind}\\DNCLordaeron${kind}.mdl`;
  const lights = { terrain: light("TerrainLights", "Terrain"), unit: light("UnitLights", "Unit") };

  await w3.backend.invoke("project_create", { dir: o.dir, name: o.name, flags: FLAGS, maxPlayers: 1 });
  // Switching projects closes the other project's editors (as Open Project does).
  await w3.editors.closeAll();
  await w3.workspace.open(o.dir);
  const root = w3.workspace.project()!.root;
  const json = async (path: string, value: unknown) =>
    w3.workspace.writeText(path, await w3.backend.invoke<string>("codec_canonicalize", { root, path, text: JSON.stringify(value) }));
  const { doodads, units } = placements(t);
  await json("map/war3map.w3i.json", mapInfo(o, t));
  await json("map/war3map.doo.json", doodads);
  await json("map/war3mapUnits.doo.json", units);
  // Empty regions, cameras and sounds, and the default trigger (the World Editor needs the trigger files).
  await json("map/war3map.w3r.json", { format: "w3proj.regions/1", version: 5, regions: [] });
  await json("map/war3map.w3c.json", { format: "w3proj.cameras/1", version: 0, cameras: [] });
  await json("map/war3map.w3s.json", { format: "w3proj.sounds/1", version: 3, sounds: [] });
  await w3.workspace.writeText(WTG_JSON, writeWtgJson(defaultTriggerFile()));
  await writeWctFile(w3.workspace, parseWct(defaultWct(), 1), textTriggers(defaultTriggerFile()).map((t) => t.name));
  await w3.workspace.writeText("map/war3map.w3e.txt", w3eToText(writeW3e(t)));
  await w3.workspace.writeText(o.lua ? "map/war3map.lua" : "map/war3map.j", mapScript(o, t, lights));
  await w3.workspace.writeBytes("map/war3map.shd", terrainShadows(t));
  await w3.workspace.refresh();
  const read = (p: string) => w3.game.read(p);
  const { wpm } = await buildPathingMap(w3, t, [], read, w3.settings.get<number>("terrain.pathing.deepWater"));
  await w3.workspace.writeBytes("map/war3map.wpm", wpm);
  await w3.workspace.writeBytes("map/war3mapMap.blp", await buildMinimap(w3, t, [], read, minimapSettings(w3), w3.settings.get<number>("terrain.minimap.jpegQuality")));
  await w3.workspace.refresh();
  await w3.editors.open("map/war3map.w3e.txt", "w3.terrainViewer");
}
