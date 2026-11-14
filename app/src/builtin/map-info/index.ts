import type { ExtensionContext, W3Api } from "../../extensions/api";
import { h } from "../../workbench/dom";
import { parseIni, parseSlk, westring } from "../../lib/formats/text";
import { askWtsCuts, importStrings, StringTable, WtsCutError } from "../../lib/formats/wts";
import { bindUndoKeys, History } from "../../lib/undo";
import { MAP_INFO_SERVICE, OBJECTS_SERVICE, type LiveItemTable, type MapInfoService, type ObjectsService } from "../../extensions/services";
import { Listeners } from "../../lib/listeners";
import { jsonPathOf, mapStrings, projectWithFiles, readMapDoc, requireProject, terrainFacts } from "../../lib/formats/mapdoc";
import { playableArea } from "../../lib/terrain/area";
import { MCP_EDITS_SERVICE, type McpEditsService } from "../../extensions/services";
import { setMapText } from "./summary";
import { applySky, fogViewNote, resolveChoice, type SkyArgs } from "../../lib/terrain/atmosphere";
import { skyList } from "../../lib/terrain/skies";
import { moveTextsToStringTable } from "./movetexts";
import { mapSummary, setW3iColorHex, w3iColorHex } from "./summary";
import { addItemTable, ITEM_TABLES_ANCHOR, itemTableAnchor, itemTablesShown, renderTechtree, type TechInfo } from "./techtree";
import {
  addPlayer, applyAllyPriorities, autoAllyPriorities, editorAllyPriorities, maxPlayers, MODIFY_ALLY_PRIORITIES, removePlayer, startLocations, type PlayerInfo,
} from "../../lib/terrain/startlocations";
import { parseW3e } from "../../lib/terrain/w3e";
import { weatherName } from "../../lib/terrain/weather";
import { readTerrainBytes, terrainPath } from "../../lib/terrain/w3etext";
import { FIXED_START, fixedStartForRace, HUD_SKINS, priorityOf, RACE_SELECTABLE, withPriority, type Priority } from "./priorities";
import { MAP_EXTRA_PATH, readMapExtra, TIMES_OF_DAY, writeMapExtra, type MapExtra } from "../../lib/formats/mapextra";

// Mirrors w3proj::mapinfo (format "w3proj.mapinfo/1"); fields are optional
// where the file version decides whether they exist.
interface Player {
  id: number; controller: number; race: number; hudSkin?: number; fixedStart: number; name: string;
  start: [number, number]; allyLow: number; allyHigh: number; enemyLow?: number; enemyHigh?: number;
}
interface Force { flags: number; players: number; name: string }
interface MapInfo {
  format: string; version: number; saves: number; editorVersion: number; gameVersion?: number[];
  name: string; author: string; description: string; suggestedPlayers: string;
  cameraBounds: number[]; cameraComplements: number[]; playableWidth: number; playableHeight: number;
  flags: number; tileset: string;
  loadingScreen: { number: number; crestRace?: number; model: string; text: string; title: string; subtitle: string };
  gameDataSet: number;
  prologue: { path: string; text: string; title: string; subtitle: string };
  fog: { style: number; start: number; end: number; density: number; color: number[] };
  terrainFog?: { style: number; overSky: number; linearStart: number; linearEnd: number; maxOpacity: number; height: number };
  weather: string; soundEnvironment: string; lightEnvironment: string; waterTint: number[];
  scriptType?: number; supportedModes?: number; gameDataVersion?: number;
  cameraZoom?: { default: number; max: number; min?: number };
  water?: Record<string, number>;
  players: Player[]; forces: Force[];
  upgrades: { players: number; id: string; level: number; availability: number }[];
  techs: { players: number; id: string }[];
  unitTables: unknown[]; itemTables: unknown[];
}

const FORMAT = "w3proj.mapinfo/1";
const SECTIONS = [
  { id: "description", label: "Description" },
  { id: "loading", label: "Loading Screen" },
  { id: "prologue", label: "Prologue Screen" },
  { id: "options", label: "Options" },
  { id: "environment", label: "Environment" },
  { id: "preferences", label: "Preferences" },
  { id: "players", label: "Players" },
  { id: "forces", label: "Forces" },
  { id: "techtree", label: "Techtree & Tables" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

/** Settings outside war3map.w3i (World Editor: Advanced menu), each in its own editor. */
const ADVANCED = [
  { label: "Gameplay Constants", command: "w3.gameplayConstants.open", hint: "war3mapMisc.txt: max hero level, experience, damage tables, …" },
  { label: "Game Interface", command: "w3.gameInterface.open", hint: "war3mapSkin.txt: icons, models, sounds and texts of the interface" },
];

/** Map option flags as the World Editor names them. */
const FLAGS: [number, string][] = [
  [0x0001, "Hide minimap in preview screens"],
  [0x0002, "Modify ally priorities"],
  [0x0004, "Melee map"],
  [0x0010, "Masked areas are partially visible"],
  [0x0020, "Fixed player settings for custom forces"],
  [0x0040, "Use custom forces"],
  [0x0080, "Use custom techtree"],
  [0x0100, "Use custom abilities"],
  [0x0200, "Use custom upgrades"],
  [0x0800, "Show water waves on cliff shores"],
  [0x1000, "Show water waves on rolling shores"],
  [0x2000, "Use terrain fog"],
  [0x8000, "Use item classification system"],
  [0x10000, "Enable water tinting"],
  [0x20000, "Use accurate probability for calculations"],
  [0x40000, "Use custom ability skins"],
  [0x1000000, "Alpha-tile default minimap color"],
  [0x2000000, "Dynamic minimap"],
];
/** Bits the editor sets itself; shown read-only. */
const INTERNAL_FLAGS: [number, string][] = [
  [0x0008, "Playable area was large and never shrunk"],
  [0x0400, "Map properties dialog opened at least once"],
  [0x4000, "Requires The Frozen Throne data"],
];
/** w3i "supported graphics modes" bits (the Problems view checks models per mode). */
const GRAPHICS_MODES: [number, string][] = [[1, "Classic"], [2, "Reforged (HD)"], [4, "Reforged (DE)"]];
const CONTROLLERS = [[1, "User"], [2, "Computer"], [3, "Neutral"], [4, "Rescuable"]] as const;
const RACES = [[0, "Selectable"], [1, "Human"], [2, "Orc"], [3, "Undead"], [4, "Night Elf"]] as const;
const FORCE_FLAGS: [number, string][] = [
  [0x01, "Allied"],
  [0x02, "Allied victory"],
  [0x04, "Share vision"],
  [0x10, "Share unit control"],
  [0x20, "Share advanced unit control"],
];
const FOG_STYLES = [[0, "Linear"], [1, "Exponential 1"], [2, "Exponential 2"]] as const;

/** Labels from the game: tilesets, weather, loading screens. */
interface GameLists {
  tilesets: [string, string][];
  weather: [string, string][];
  loadingScreens: [number, string][];
  /** UI\WorldEditData.txt [SkyModels]: the number war3mapExtra.txt's SkyModel stores, and the sky's name. */
  skies: [number, string][];
}
let gameLists: Promise<GameLists> | null = null;
function loadGameLists(w3: W3Api): Promise<GameLists> {
  gameLists ??= (async () => {
    const we = new Map<string, string>();
    for (const f of ["UI\\WorldEditStrings.txt", "UI\\WorldEditGameStrings.txt"]) {
      for (const s of parseIni(await w3.game.readText(f).catch(() => "")).values()) for (const [k, v] of s) we.set(k.toUpperCase(), v);
    }
    const data = parseIni(await w3.game.readText("UI\\WorldEditData.txt").catch(() => ""));
    const tilesets = [...(data.get("TileSets") ?? new Map())]
      .filter(([k]) => k.length === 1)
      .map(([k, v]) => [k.toUpperCase(), westring(we, v.split(",")[0])] as [string, string])
      .sort((a, b) => a[1].localeCompare(b[1]));
    const loadingScreens = [...(data.get("LoadingScreens") ?? new Map())]
      .filter(([k]) => /^\d+$/.test(k))
      .map(([k, v]) => [Number(k), westring(we, v.split(",")[1] ?? k)] as [number, string]);
    const weather = parseSlk(await w3.game.readText("TerrainArt\\Weather.slk").catch(() => ""))
      .filter((r) => r.effectID)
      .map((r) => [r.effectID, weatherName(r.name, r.effectID, we)] as [string, string]);
    const skies = [...(data.get("SkyModels") ?? new Map())]
      .filter(([k]) => /^\d+$/.test(k))
      .map(([k, v]) => [Number(k), westring(we, v.split(",")[1] ?? k).replace(/^"|"$/g, "")] as [number, string]);
    return { tilesets, weather, loadingScreens, skies };
  })();
  gameLists.catch(() => { gameLists = null; });
  return gameLists;
}

/** war3mapExtra.txt as it is now: its text, null when the map has none, or the error when it's there but couldn't be
 *  read (then it's left alone: treating it as empty would write over it). */
async function readMapPrefs(w3: W3Api): Promise<{ text: string | null; error: string | null }> {
  try {
    return { text: await w3.workspace.readText(MAP_EXTRA_PATH), error: null };
  } catch (e) {
    const listed = w3.workspace.files().some((f) => f.path.toLowerCase() === MAP_EXTRA_PATH.toLowerCase());
    return { text: null, error: listed ? String(e) : null };
  }
}

const PATH = "map/war3map.w3i.json";
/** Section to show when an editor opens or is already open, and the place in it to scroll to. */
let requestedSection: SectionId | null = null;
let requestedAnchor: string | null = null;
/** Section shown last (an editor opened again after another save keeps it). */
let lastSection: SectionId = "description";
/** An open Map Properties editor: its project, showing a section (scrolled to an anchor), adding an item table. */
interface OpenEditor { root: string; show(s: SectionId, anchor?: string): void; createItemTable(): { number: number; name: string }; itemTables(): LiveItemTable[] }
const openEditors = new Set<OpenEditor>();
/** MapInfoService.onDidEdit's listeners. */
const edits = new Listeners();
const isSection = (s: unknown): s is SectionId => SECTIONS.some((x) => x.id === s);

const STRINGS = "map/war3map.wts";

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const service: MapInfoService = {
    liveItemTables: (root) => [...openEditors].filter((e) => e.root === root).at(-1)?.itemTables() ?? null,
    onDidEdit: (listener) => edits.add(listener),
  };
  ctx.subscriptions.push(w3.services.provide(MAP_INFO_SERVICE, service));
  ctx.subscriptions.push(w3.mcp.registerTool("map_info", async () => {
    requireProject(w3);
    const info = await readMapDoc<Parameters<typeof mapSummary>[0]>(w3, PATH);
    if (!info) throw new Error("This map's war3map.w3i can't be read (missing, or damaged by a map protector).");
    const facts = await terrainFacts(w3).catch(() => null);
    return {
      ...mapSummary(info, await mapStrings(w3)),
      ...(facts ? { terrainTileset: facts.tileset, playable: playableArea(info as { cameraComplements?: number[] }, facts) } : {}),
      ...(facts && facts.tileset !== info.tileset ? { tilesetNote: "The terrain's tileset differs from the one in the map's properties. The terrain's is what shows on the ground." } : {}),
    };
  }));
  ctx.subscriptions.push(w3.mcp.registerTool("set_map_text", async ({ field, text }) => {
    const { root } = requireProject(w3);
    if (typeof text !== "string") throw new Error("text must be text.");
    const path = jsonPathOf(w3, "war3map.w3i");
    const edits = await w3.services.get<McpEditsService>(MCP_EDITS_SERVICE);
    const changed = await edits.edit(`Change the map's ${String(field)}`, async (read) => {
      const info = await read(path), wts = await read("map/war3map.wts");
      if (info === null) throw new Error("This map has no war3map.w3i.");
      const doc = JSON.parse(info);
      const table = wts === null ? null : new StringTable(wts);
      setMapText(doc, String(field), text, table);
      return [
        { path, text: await w3.backend.invoke<string>("codec_canonicalize", { root, path, text: JSON.stringify(doc) }) },
        ...(table ? [{ path: "map/war3map.wts", text: table.serialize() }] : []),
      ];
    });
    return changed ? `Changed ${String(field)}.` : "It already said that.";
  }));
  ctx.subscriptions.push(w3.mcp.registerTool("set_sky", async (args) => {
    const { root } = requireProject(w3);
    if (!Object.keys(args).length) throw new Error("set_sky needs at least one setting: sky, lightEnvironment, fogStyle, fogStart, fogEnd, fogDensity, fogColor, useFog, overSky, waterTint, tintWater.");
    const { sky, ...rest } = args as SkyArgs & { sky?: unknown };
    const lists = await loadGameLists(w3);
    // The sky is a view setting (the terrain view's), not part of the map: resolved first, set after the map's edit.
    let skyPath: string | undefined;
    if (sky !== undefined) {
      const skies = skyList(await w3.game.readText("UI\\WorldEditData.txt").catch(() => ""), await w3.game.readText("UI\\WorldEditStrings.txt").catch(() => ""));
      const none = String(sky).trim().toLowerCase() === "none" || sky === "";
      skyPath = none ? "" : resolveChoice("sky", sky, skies.map((x) => [x.path, x.name] as [string, string]));
    }
    const path = jsonPathOf(w3, "war3map.w3i");
    const edits = await w3.services.get<McpEditsService>(MCP_EDITS_SERVICE);
    let changes: string[] = [];
    if (Object.keys(rest).length) {
      await edits.edit("Change the map's sky and light", async (read) => {
        const text = await read(path);
        if (text === null) throw new Error("This map has no readable war3map.w3i.");
        const doc = JSON.parse(text);
        changes = applySky(doc, rest, lists);
        return [{ path, text: await w3.backend.invoke<string>("codec_canonicalize", { root, path, text: JSON.stringify(doc) }) }];
      });
    }
    if (skyPath !== undefined && skyPath !== (w3.settings.get<string>("terrain.sky", "") ?? "")) {
      await w3.settings.set("terrain.sky", skyPath);
      changes.push(`sky model in the terrain view (a view setting, not in the map, not undone by undo_last_edit): ${skyPath || "none"}`);
    }
    const note = fogViewNote(args, w3.settings.get<boolean>("terrain.fog", false) === true);
    const reply = changes.length ? `Changed:\n- ${changes.join("\n- ")}` : "Nothing changed: the map already had these settings.";
    return note ? `${reply}\n${note}` : reply;
  }));
  /** Opens Map Properties (or shows the open one) at `section`, scrolled to `anchor` (a `data-anchor` in it). */
  const openAt = async (section?: SectionId, anchor?: string) => {
    if (!w3.workspace.project()) throw new Error("Open or import a project first.");
    // Right after an open the list may not have the file yet: that isn't "no war3map.w3i".
    await projectWithFiles(w3);
    if (!w3.workspace.files().some((f) => f.path.toLowerCase() === PATH)) {
      const raw = w3.workspace.files().some((f) => f.path.toLowerCase() === "map/war3map.w3i");
      throw new Error(raw
        ? "This map's war3map.w3i could not be converted (unsupported or damaged); it is kept raw. Re-save the map in the World Editor and sync."
        : "This project has no war3map.w3i.");
    }
    // An editor opening now starts there; one already open is shown there once its tab is in front (a hidden one
    // can't scroll).
    const already = [...openEditors];
    requestedSection = section ?? null;
    requestedAnchor = section ? anchor ?? null : null;
    try {
      await w3.editors.open(PATH, "w3.mapInfo");
    } catch (e) {
      requestedSection = requestedAnchor = null;
      throw e;
    }
    // Not taken by an editor opening (a tab restored with the project opens when it's first shown, after this):
    // left for that one, unless an editor was open already.
    if (already.length) requestedSection = requestedAnchor = null;
    if (section) for (const e of already) if (openEditors.has(e)) e.show(section, anchor);
  };
  /** The project's open Map Properties editor; a tab that's still opening is waited for (a while). */
  const editorOf = async (root: string): Promise<OpenEditor | undefined> => {
    const find = () => [...openEditors].filter((e) => e.root === root).at(-1);
    for (const end = Date.now() + 10_000; !find() && Date.now() < end && w3.workspace.project()?.root === root;) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return find();
  };
  /** The section and anchor a command was given: none from the palette or the menu, a known section otherwise. */
  const sectionArgs = (section: unknown, anchor: unknown): [SectionId | undefined, string | undefined] => {
    if (section === undefined || section === null) return [undefined, undefined];
    if (!isSection(section)) throw new Error(`Map Properties has no section "${String(section)}" (${SECTIONS.map((s) => s.id).join(", ")}).`);
    return [section, typeof anchor === "string" ? anchor : undefined];
  };

  ctx.subscriptions.push(
    w3.commands.register("w3.mapInfo.open", (section?: unknown, anchor?: unknown) => openAt(...sectionArgs(section, anchor))),
    w3.commands.register("w3.mapInfo.itemTables", () => openAt("techtree", ITEM_TABLES_ANCHOR)),
    // A new item table, made in Map Properties (one undo step there, saved with it) and shown for editing; gives its
    // number and name, for whoever asked to use it (the terrain editor's drops).
    w3.commands.register("w3.mapInfo.createItemTable", async () => {
      const root = w3.workspace.project()?.root;
      await openAt("techtree", ITEM_TABLES_ANCHOR);
      // Another project meanwhile: its editor isn't the one asked for.
      if (!root || w3.workspace.project()?.root !== root) throw new Error("The project changed meanwhile; no item table was made.");
      const editor = await editorOf(root);
      if (w3.workspace.project()?.root !== root) throw new Error("The project changed meanwhile; no item table was made.");
      if (!editor) throw new Error("Map Properties couldn't be opened, so no item table was made.");
      return editor.createItemTable();
    }),
    // Strings go out as the map's own war3map.wts, a text file a translator can work in.
    w3.commands.register("w3.strings.export", async () => {
      const text = await w3.workspace.readText(STRINGS).catch(() => null);
      if (text === null) throw new Error("This map has no strings.");
      const path = await w3.window.pickSaveFile({ title: "Export strings", defaultPath: "strings.txt", filters: [{ name: "Strings (.txt)", extensions: ["txt"] }] });
      if (!path) return;
      await w3.backend.writeBytes(path, new TextEncoder().encode(text));
      void w3.window.showInfo(`Exported ${[...new StringTable(text).entries()].length} strings.`);
    }),
    // What the World Editor does to the texts when it saves (Studio's save keeps them): see movetexts.ts.
    w3.commands.register("w3.strings.moveToTable", () => moveTextsToStringTable(w3)),
    w3.commands.register("w3.strings.import", async () => {
      const text = await w3.workspace.readText(STRINGS).catch(() => null);
      if (text === null) throw new Error("This map has no strings.");
      const path = await w3.window.pickFile({ title: "Import strings", filters: [{ name: "Strings (.txt, .wts)", extensions: ["txt", "wts"] }] });
      if (!path) return;
      const { text: next, changed, unknown } = importStrings(text, new TextDecoder().decode(await w3.backend.readBytes(path)));
      const extra = unknown ? ` ${unknown} in the file ${unknown === 1 ? "isn't" : "aren't"} in this map, and stay${unknown === 1 ? "s" : ""} out.` : "";
      if (!changed) { void w3.window.showInfo(`No strings to change.${extra}`); return; }
      await w3.workspace.writeText(STRINGS, next);
      void w3.window.showInfo(`Imported ${changed} string${changed === 1 ? "" : "s"}.${extra}`);
    }),
    w3.views.register("w3.scenario.sections", {
      render(el) {
        if (!w3.workspace.project()) {
          el.append(h("div.view-empty", {}, "Open or import a project to edit its map properties."));
          return;
        }
        el.append(h("div.tree", {}, ...SECTIONS.map((s) =>
          h("div.tree-row.obj-kind", { onclick: () => openAt(s.id).catch((e) => w3.window.showError(String(e))) },
            h("span.tree-icon", {}, "›"), h("span.tree-label", {}, s.label)))),
          // The World Editor's Advanced menu (other extensions; shown when they're installed).
          h("div.tree", {}, ...ADVANCED.map((a) =>
            h("div.tree-row.obj-kind", { title: a.hint, onclick: () => w3.commands.execute(a.command).catch((e) => w3.window.showError(String(e))) },
              h("span.tree-icon", {}, "›"), h("span.tree-label", {}, a.label)))));
      },
    }),
    w3.workspace.onDidChange(() => w3.views.refresh("w3.scenario.sections")),

    w3.editors.registerProvider("w3.mapInfo", {
      async resolve(el, doc) {
        const info: MapInfo = JSON.parse(await doc.readText());
        if (info.format !== FORMAT) throw new Error(`unsupported format ${info.format}`);
        // war3map.wts as read or last saved here: saving merges this editor's string edits onto
        // the file as it is then (other editors may have saved strings meanwhile).
        let wtsBase = await w3.workspace.readText("map/war3map.wts").catch(() => null);
        const strings = wtsBase !== null ? new StringTable(wtsBase) : null;
        const v = info.version;
        // Start locations (war3mapUnits.doo, either project form): players without one can't be added.
        const root = w3.workspace.project()!.root;
        const readStarts = async () => {
          const unitsText = await w3.workspace.readText("map/war3mapUnits.doo.json")
            .catch(() => w3.backend.invoke<string>("codec_decode", { root, path: "map/war3mapUnits.doo" })).catch(() => null);
          return startLocations(unitsText ? (JSON.parse(unitsText) as { units?: [] }).units ?? [] : []);
        };
        let starts = await readStarts();
        // The map's preferences (war3mapExtra.txt), edited here and saved with the map info. A missing file is no
        // preferences; one that is there but can't be read is shown as such and never written over.
        const prefs = await readMapPrefs(w3);
        const extra: MapExtra = prefs.text !== null ? readMapExtra(prefs.text) : {};
        /** The preferences as read or last saved here: a save writes the file only when they changed since (so a
         *  change made to the file by another editor meanwhile isn't undone by a save of the map info). */
        let extraSaved = JSON.stringify(extra);

        // Undo: the map info, the string table texts it refers to (the only ones edited here) and the preferences.
        const snapshot = () => {
          const json = JSON.stringify(info);
          const refs = strings ? [...new Set([...json.matchAll(/TRIGSTR_(\d+)/g)].map((m) => Number(m[1])))].filter((n) => strings.has(n)) : [];
          return JSON.stringify({ info, texts: refs.map((n) => [n, strings!.get(n)]), extra });
        };
        const history = new History(snapshot, (state) => {
          const s = JSON.parse(state) as { info: MapInfo; texts: [number, string][]; extra: MapExtra };
          for (const k of Object.keys(info)) delete (info as unknown as Record<string, unknown>)[k];
          Object.assign(info, s.info);
          for (const [n, t] of s.texts) strings!.set(n, t);
          for (const k of Object.keys(extra)) delete extra[k as keyof MapExtra];
          Object.assign(extra, s.extra);
          doc.setDirty(history.dirty);
          show(section);
          edits.fire();
        });
        /** After every change; `group` keeps typing in one field one undo step. */
        const update = (group?: unknown) => { history.commit(group); doc.setDirty(history.dirty); edits.fire(); };
        let section: SectionId = requestedSection ?? lastSection;
        const firstAnchor = requestedSection ? requestedAnchor : null;
        requestedSection = requestedAnchor = null;
        let lists: GameLists | null = null;

        // ---- small form helpers ------------------------------------------------
        const row = (label: string, control: Node, hint?: string) =>
          h("label.form-row", {}, h("span.form-label", {}, label), h("div.form-control", {}, control, hint ? h("small.muted", {}, hint) : null));

        /** String field; TRIGSTR references edit the string table text. */
        const text = (get: () => string, set: (s: string) => void, opts: { multiline?: boolean } = {}) => {
          const ref = StringTable.ref(get());
          const viaTable = ref !== null && strings?.has(ref);
          const value = viaTable ? strings!.get(ref!)! : get();
          const input = opts.multiline
            ? h("textarea.form-input", { rows: 6, value })
            : h("input.form-input", { value });
          // One undo step per visit of the field.
          let visit = {};
          input.addEventListener("input", () => {
            if (viaTable) strings!.set(ref!, input.value);
            else set(input.value);
            update(visit);
          });
          input.addEventListener("blur", () => { visit = {}; });
          return viaTable
            ? h("div.form-stack", {}, input, h("small.muted", { title: "Stored in war3map.wts" }, `string table · ${get()}`))
            : input;
        };
        const num = (get: () => number, set: (n: number) => void, opts: { int?: boolean } = {}) => {
          const input = h("input.form-input.form-num", { type: "number", value: String(get()), step: opts.int ? "1" : "any" });
          input.addEventListener("change", () => {
            const n = Number(input.value);
            if (input.value === "" || Number.isNaN(n) || (opts.int && !Number.isInteger(n))) { input.classList.add("invalid"); return; }
            input.classList.remove("invalid");
            set(n);
            update();
          });
          return input;
        };
        const select = <T extends string | number>(options: readonly (readonly [T, string])[], get: () => T, set: (v: T) => void) => {
          const current = get();
          const opts = options.some(([k]) => k === current) ? options : [[current, `${current} (unknown)`] as const, ...options];
          const sel = h("select.form-input", {}, ...opts.map(([k, label]) => h("option", { value: String(k), selected: k === current }, label)));
          sel.addEventListener("change", () => {
            const picked = opts.find(([k]) => String(k) === sel.value)!;
            set(picked[0] as T);
            update();
          });
          return sel;
        };
        const bit = (get: () => number, set: (n: number) => void, mask: number, label: string, disabled = false) => {
          const box = h("input", { type: "checkbox", checked: (get() & mask) !== 0, disabled });
          box.addEventListener("change", () => { set(box.checked ? get() | mask : get() & ~mask); update(); });
          return h("label.form-check", {}, box, " ", label);
        };
        /** A w3i colour (stored blue, green, red, alpha): colour picker + alpha. */
        const color = (bgra: number[]) => {
          const pick = h("input", { type: "color", value: w3iColorHex(bgra) });
          // Dragging in the colour dialog is one undo step.
          let visit = {};
          pick.addEventListener("input", () => {
            setW3iColorHex(bgra, pick.value);
            update(visit);
          });
          pick.addEventListener("change", () => { visit = {}; });
          return h("div.form-inline", {}, pick, h("span.muted", {}, "alpha"), num(() => bgra[3], (n) => { bgra[3] = Math.max(0, Math.min(255, n)); }, { int: true }));
        };
        const section_ = (title: string, ...children: (Node | null)[]) => h("section.form-section", {}, h("h3", {}, title), ...children.filter((c): c is Node => c !== null));

        /** The terrain file's tileset (it has its own entry), null without a terrain. */
        const terrainTileset = async (): Promise<string | null> => {
          const path = terrainPath(w3.workspace.files().map((f) => f.path));
          if (!path) return null;
          const bytes = await readTerrainBytes(path, { readText: () => w3.workspace.readText(path), readBytes: () => w3.workspace.readBytes(path) });
          return parseW3e(bytes).tileset;
        };
        /** "The terrain uses …" with a button to take it, when the two differ. */
        const tilesetSync = () => {
          const slot = h("div.form-inline");
          void terrainTileset().then((id) => {
            if (!id || id === info.tileset) return;
            const name = lists?.tilesets.find(([k]) => k === id)?.[1] ?? id;
            slot.replaceChildren(h("small.muted", {}, `The terrain uses ${name}.`),
              h("button", { title: "Set this tileset to the terrain's", onclick: () => { info.tileset = id; update(); show(section); } }, "Use the terrain's"));
          }, () => {});
          return slot;
        };

        // ---- sections --------------------------------------------------------------
        const renderers: Record<SectionId, () => Node[]> = {
          description: () => [
            section_("Map",
              row("Name", text(() => info.name, (s) => { info.name = s; })),
              row("Author", text(() => info.author, (s) => { info.author = s; })),
              row("Suggested players", text(() => info.suggestedPlayers, (s) => { info.suggestedPlayers = s; })),
              row("Description", text(() => info.description, (s) => { info.description = s; }, { multiline: true })),
            ),
            section_("Map facts",
              row("Tileset", h("div.form-stack", {},
                lists ? select(lists.tilesets, () => info.tileset, (t) => { info.tileset = t; }) : h("code", {}, info.tileset),
                tilesetSync()),
                "The terrain's own tileset and ground tiles are changed in the terrain editor (Terrain › Tiles…)."),
              row("Playable area", h("span", {}, `${info.playableWidth} × ${info.playableHeight}`)),
              row("Saved", h("span", {}, `${info.saves} times · editor ${info.editorVersion}${info.gameVersion ? ` · game ${info.gameVersion.join(".")}` : ""} · format v${v}`)),
            ),
          ],
          loading: () => [
            section_("Loading screen",
              row("Screen", lists
                ? select<number>([[-1, "None / custom model"], ...lists.loadingScreens], () => info.loadingScreen.number, (n) => { info.loadingScreen.number = n; })
                : num(() => info.loadingScreen.number, (n) => { info.loadingScreen.number = n; }, { int: true })),
              v >= 25 ? row("Custom model", text(() => info.loadingScreen.model, (s) => { info.loadingScreen.model = s; })) : null,
              row("Title", text(() => info.loadingScreen.title, (s) => { info.loadingScreen.title = s; })),
              row("Subtitle", text(() => info.loadingScreen.subtitle, (s) => { info.loadingScreen.subtitle = s; })),
              row("Text", text(() => info.loadingScreen.text, (s) => { info.loadingScreen.text = s; }, { multiline: true })),
              info.loadingScreen.crestRace !== undefined
                ? row("Crest race", num(() => info.loadingScreen.crestRace!, (n) => { info.loadingScreen.crestRace = n; }, { int: true }))
                : null,
            ),
          ],
          prologue: () => [
            section_("Prologue screen",
              v >= 25 ? row("Screen path", text(() => info.prologue.path, (s) => { info.prologue.path = s; })) : null,
              row("Title", text(() => info.prologue.title, (s) => { info.prologue.title = s; })),
              row("Subtitle", text(() => info.prologue.subtitle, (s) => { info.prologue.subtitle = s; })),
              row("Text", text(() => info.prologue.text, (s) => { info.prologue.text = s; }, { multiline: true })),
            ),
          ],
          options: () => {
            const known = [...FLAGS, ...INTERNAL_FLAGS].reduce((a, [m]) => a | m, 0);
            const unknown = info.flags & ~known;
            return [
              section_("Map flags",
                h("div.form-checks", {}, ...FLAGS.map(([m, label]) => bit(() => info.flags, (n) => { info.flags = n >>> 0; }, m, label))),
                h("div.form-checks.muted", {}, ...INTERNAL_FLAGS.map(([m, label]) => bit(() => info.flags, () => {}, m, label, true))),
                unknown ? h("small.muted", {}, `Other flag bits kept as-is: 0x${(unknown >>> 0).toString(16)}`) : null,
              ),
              section_("Game data",
                info.scriptType !== undefined ? row("Script language", select([[0, "JASS"], [1, "Lua"]], () => info.scriptType!, (n) => { info.scriptType = n; }), "Changing this needs the script itself to be converted.") : null,
                v >= 25
                  ? row("Game data set", num(() => info.gameDataSet, (n) => { info.gameDataSet = n; }, { int: true }), "0 = default")
                  : row("Loading screen number", num(() => info.gameDataSet, (n) => { info.gameDataSet = n; }, { int: true })),
                info.gameDataVersion !== undefined ? row("Game data version", num(() => info.gameDataVersion!, (n) => { info.gameDataVersion = n; }, { int: true })) : null,
                // Not row(): that wraps its content in one label, and these are labelled checkboxes.
                info.supportedModes !== undefined ? h("div.form-row", {}, h("span.form-label", {}, "Supported graphics modes"), h("div.form-control", {},
                  ...GRAPHICS_MODES.map(([m, label]) => bit(() => info.supportedModes!, (n) => { info.supportedModes = n; }, m, label)),
                  (info.supportedModes & ~7) ? h("small.muted", {}, `Other bits kept as-is: 0x${(info.supportedModes & ~7).toString(16)}`) : null,
                  h("small.muted", {}, "Problems checks the map's models for each mode ticked here."))) : null,
              ),
              info.cameraZoom ? section_("Camera zoom",
                row("Default", num(() => info.cameraZoom!.default, (n) => { info.cameraZoom!.default = n; }, { int: true })),
                row("Maximum", num(() => info.cameraZoom!.max, (n) => { info.cameraZoom!.max = n; }, { int: true })),
                info.cameraZoom.min !== undefined ? row("Minimum", num(() => info.cameraZoom!.min!, (n) => { info.cameraZoom!.min = n; }, { int: true })) : null,
              ) : null,
            ].filter((x): x is HTMLElement => x !== null);
          },
          // Reign of Chaos maps (format 18) store none of this.
          environment: () => v < 25 ? [h("p.muted", {}, `This map's format (v${v}) has no weather, sound, fog or water settings.`)] : [
            section_("Weather & sound",
              row("Global weather", lists
                ? select<string>([["0x00000000", "None"], ...lists.weather], () => info.weather, (s) => { info.weather = s; })
                : text(() => info.weather, (s) => { info.weather = s; })),
              row("Sound environment", text(() => info.soundEnvironment, (s) => { info.soundEnvironment = s; })),
              row("Light environment", lists
                ? select<string>([["", "Default (map tileset)"], ...lists.tilesets], () => info.lightEnvironment, (s) => { info.lightEnvironment = s; })
                : text(() => info.lightEnvironment, (s) => { info.lightEnvironment = s; })),
              row("Water tint", color(info.waterTint), "Used when “Enable water tinting” is set (Options)."),
            ),
            section_("Fog",
              row("Style", select(FOG_STYLES, () => info.fog.style, (n) => { info.fog.style = n; })),
              row("Start Z", num(() => info.fog.start, (n) => { info.fog.start = n; })),
              row("End Z", num(() => info.fog.end, (n) => { info.fog.end = n; })),
              row("Density", num(() => info.fog.density, (n) => { info.fog.density = n; })),
              row("Color", color(info.fog.color), "Used when “Use terrain fog” is set (Options)."),
            ),
            info.terrainFog ? section_("Terrain fog (3.0)",
              row("Style", num(() => info.terrainFog!.style, (n) => { info.terrainFog!.style = n; }, { int: true })),
              row("Draw over sky", num(() => info.terrainFog!.overSky, (n) => { info.terrainFog!.overSky = n; }, { int: true })),
              row("Linear start", num(() => info.terrainFog!.linearStart, (n) => { info.terrainFog!.linearStart = n; })),
              row("Linear end", num(() => info.terrainFog!.linearEnd, (n) => { info.terrainFog!.linearEnd = n; })),
              row("Max opacity", num(() => info.terrainFog!.maxOpacity, (n) => { info.terrainFog!.maxOpacity = n; })),
              row("Height", num(() => info.terrainFog!.height, (n) => { info.terrainFog!.height = n; })),
            ) : null,
            info.water ? section_("Water rendering (3.0)",
              ...Object.keys(info.water).map((k) => row(k.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()),
                num(() => info.water![k], (n) => { info.water![k] = n; }, { int: true })))) : null,
          ].filter((x): x is HTMLElement => x !== null),
          // The World Editor's Map Properties > Prefs and its Trigger Editor's JassHelper menu: war3mapExtra.txt.
          preferences: () => {
            if (prefs.error) return [h("p.muted", {}, `war3mapExtra.txt couldn't be read (${prefs.error}); its preferences are left as they are.`)];
            const check = (label: string, get: () => boolean, set: (b: boolean) => void, disabled = false) => {
              const box = h("input", { type: "checkbox", checked: get(), disabled });
              box.addEventListener("change", () => { set(box.checked); update(); show(section); });
              return h("label.form-check", {}, box, " ", label);
            };
            const off = extra.jassHelper !== true;
            return [
              section_("JassHelper",
                h("div.form-checks", {},
                  check("Enable JassHelper", () => extra.jassHelper === true, (b) => { extra.jassHelper = b || undefined; }),
                  check("Enable vJass", () => extra.vjass !== false, (b) => { extra.vjass = b ? undefined : false; }, off),
                  check("Enable debug mode", () => extra.debug === true, (b) => { extra.debug = b || undefined; }, off),
                  check("Enable optimizer", () => extra.optimizer === true, (b) => { extra.optimizer = b || undefined; }, off)),
                h("small.muted", {}, "The World Editor's JassHelper menu (Trigger Editor), kept with the map. Studio compiles vJASS with its own "
                  + "settings (vJASS: debug, optimizer): in this World Editor build the map's debug and optimizer switches didn't change the compiled script."),
              ),
              section_("View",
                row("Sky display", select<number>([[-1, "Use Editor Preference"], ...(lists?.skies ?? [])], () => extra.skyModel ?? -1,
                  (n) => { extra.skyModel = n < 0 ? undefined : n; })),
                row("Time of day", select<number>([[-1, "Use Editor Preference"], ...TIMES_OF_DAY], () => extra.timeOfDay ?? -1,
                  (n) => { extra.timeOfDay = n < 0 ? undefined : n; })),
                h("div.form-checks", {}, check("Enforce terrain limits", () => extra.enforceTerrainLimits === true, (b) => { extra.enforceTerrainLimits = b || undefined; })),
                h("small.muted", {}, "What the World Editor's terrain view uses for this map (Map Properties › Prefs). Studio's terrain view keeps its own sky and limits."),
              ),
            ];
          },
          players: () => {
            const ids = [...new Set([...info.players.map((p) => p.id), ...[...starts.keys()].filter((id) => id < maxPlayers(info))])].sort((a, b) => a - b);
            const controller = (id: number) => {
              const p = info.players.find((x) => x.id === id);
              return select<number>([[0, "None (not in the map)"], ...CONTROLLERS], () => p?.controller ?? 0, (n) => {
                if (n === 0) removePlayer(info as unknown as PlayerInfo, id);
                else if (p) p.controller = n;
                else addPlayer(info as unknown as PlayerInfo, id, starts.get(id)!).controller = n;
                if (!p || n === 0) queueMicrotask(() => show(section));
              });
            };
            // HUD Skin: only in files that have it (version 39 with player HUD skins).
            const skins = info.players.some((p) => p.hudSkin !== undefined);
            const nameOf = (p: Player) => `${p.id + 1}. ${StringTable.ref(p.name) !== null && strings?.get(StringTable.ref(p.name)!) || p.name}`;
            // Without "Modify ally priorities" the save works them out from the start locations, as the World Editor's
            // does: shown as they will be saved, and greyed.
            const auto = autoAllyPriorities(info.flags);
            const worked = editorAllyPriorities(info.players);
            /** Ally or enemy priorities: a row per player, a choice per other player. */
            const priorities = (title: string, kind: "ally" | "enemy") => {
              const stored = (p: Player): [number, number] => kind === "ally" ? [p.allyLow, p.allyHigh] : [p.enemyLow ?? 0, p.enemyHigh ?? 0];
              const masks = (p: Player): [number, number] => !auto || !worked.has(p.id) ? stored(p) : kind === "ally" ? worked.get(p.id)! : [0, 0];
              const set = (p: Player, [low, high]: [number, number]) => {
                if (kind === "ally") { p.allyLow = low; p.allyHigh = high; } else { p.enemyLow = low; p.enemyHigh = high; }
              };
              return h(`table.form-table.map-priorities.map-priorities-${kind}`, {},
                h("thead", {}, h("tr", {}, h("th", {}, title), ...info.players.map((q) => h("th", { title: nameOf(q) }, String(q.id + 1))))),
                h("tbody", {}, ...info.players.map((p) => h("tr", {}, h("td", {}, nameOf(p)), ...info.players.map((q) => {
                  if (q === p) return h("td.muted", {}, "—");
                  const sel = select<Priority>([["none", "None"], ["low", "Low"], ["high", "High"]], () => priorityOf(...masks(p), q.id),
                    (v) => set(p, withPriority(...masks(p), q.id, v)));
                  if (auto && worked.has(p.id)) { sel.disabled = true; sel.title = "Worked out from the start locations when saving: turn on Modify ally/enemy priorities to set them."; }
                  return h("td", {}, sel);
                })))));
            };
            const enemies = info.players.some((p) => p.enemyLow !== undefined);
            return [
              section_(`Players (${info.players.length})`,
                h("table.form-table", {},
                  h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Name"), h("th", {}, "Controller"), h("th", {}, "Race"), h("th", {}, "Fixed start"), h("th", {}, "Race selectable"), h("th", {}, "Start X"), h("th", {}, "Start Y"), skins ? h("th", {}, "HUD Skin") : null)),
                  h("tbody", {}, ...ids.map((id) => {
                    const p = info.players.find((x) => x.id === id);
                    // A player with a start location starts there: the terrain editor's next save writes its
                    // position here, so it's shown, not typed. Only players without one keep their own.
                    const followed = starts.get(id);
                    const startCell = (axis: 0 | 1) => followed
                      ? h("td.muted", { title: `Player ${id + 1}'s start location: move it in the terrain editor (Objects ▸ Start location) and save there.` }, String(followed[axis]))
                      : h("td", {}, num(() => p!.start[axis], (n) => { p!.start[axis] = n; }));
                    if (!p) {
                      const at = starts.get(id)!;
                      return h("tr.muted", {}, h("td", {}, String(id + 1)), h("td", {}, `Player ${id + 1}`), h("td", {}, controller(id)),
                        h("td", {}), h("td", {}), h("td", {}), h("td", {}, String(at[0])), h("td", {}, String(at[1])));
                    }
                    return h("tr", {},
                      h("td.muted", {}, String(p.id + 1)),
                      h("td", {}, text(() => p.name, (s) => { p.name = s; })),
                      h("td", {}, controller(id)),
                      h("td", {}, select(RACES, () => p.race as 0 | 1 | 2 | 3 | 4, (n) => {
                        p.race = n;
                        // Race selectable follows the race, as the World Editor pairs them; shown again below.
                        const was = p.fixedStart;
                        p.fixedStart = fixedStartForRace(p.fixedStart, n);
                        if (p.fixedStart !== was) queueMicrotask(() => show(section));
                      })),
                      h("td", {}, bit(() => p.fixedStart, (n) => { p.fixedStart = n >>> 0; }, FIXED_START, "")),
                      h("td", { title: "Whether the race can be chosen in the lobby when Fixed Player Settings is on (Forces)" },
                        bit(() => p.fixedStart, (n) => { p.fixedStart = n >>> 0; }, RACE_SELECTABLE, "")),
                      startCell(0), startCell(1),
                      skins && p.hudSkin !== undefined ? h("td", {}, select<number>(HUD_SKINS, () => p.hudSkin!, (n) => { p.hudSkin = n; })) : skins ? h("td") : null);
                  })))),
              h("small.muted", {}, "To add a player, place its start location in the terrain editor (Objects ▸ Start location) and save there. "
                + "Players set to None keep their start location but aren't in the map. A player with a start location starts there: "
                + "Start X and Y show it, and change by moving it in the terrain editor, whose save writes them here. Only a player without one has them to type."),
              ...(info.players.length > 1 ? [section_("Ally/Enemy Priorities",
                bit(() => info.flags, (n) => {
                  // Turned on, the priorities start as they were shown (and would have been saved).
                  if (n & MODIFY_ALLY_PRIORITIES) applyAllyPriorities(info as unknown as PlayerInfo & { flags: number });
                  info.flags = n >>> 0;
                  queueMicrotask(() => show(section));
                }, MODIFY_ALLY_PRIORITIES, "Modify ally/enemy priorities"),
                h("small.muted", {}, "Which start locations a player's allies (and enemies) get near its own when start locations are random. "
                  + "Unless modified here, saving works them out from the user players' start locations, as the World Editor does: "
                  + "starts up to 1.25 times as far as the nearest get High, up to 1.5 times Low."),
                priorities("Allies", "ally"),
                enemies ? priorities("Enemies", "enemy") : null)] : []),
            ];
          },
          forces: () => [
            section_(`Forces (${info.forces.length})`,
              bit(() => info.flags, (n) => { info.flags = n >>> 0; }, 0x40, "Use custom forces"),
              bit(() => info.flags, (n) => { info.flags = n >>> 0; }, 0x20, "Fixed player settings"),
              ...info.forces.map((f) => h("div.force", {},
                row("Name", text(() => f.name, (s) => { f.name = s; })),
                h("div.form-checks", {}, ...FORCE_FLAGS.map(([m, label]) => bit(() => f.flags, (n) => { f.flags = n >>> 0; }, m, label))),
                h("div.form-checks", {}, h("span.muted", {}, "Members:"), ...info.players.map((p) =>
                  bit(() => f.players, (n) => { f.players = n >>> 0; }, 1 << p.id, `${p.id + 1}. ${StringTable.ref(p.name) !== null && strings?.get(StringTable.ref(p.name)!) || p.name}`))),
              )),
            ),
          ],
          techtree: () => renderTechtree(info as unknown as TechInfo, {
            players: info.players.map((p) => ({ id: p.id, label: `Player ${p.id + 1}: ${StringTable.ref(p.name) !== null && strings?.get(StringTable.ref(p.name)!) || p.name}` })),
            pick: async (title, kinds) => (await (await w3.services.get<ObjectsService>(OBJECTS_SERVICE)).pick(el, { title, kinds }))?.id,
            name: async (id) => (await w3.services.get<ObjectsService>(OBJECTS_SERVICE)).name(id),
            changed: (rerender) => { update(); if (rerender) show(section); },
            flag: (mask, label) => bit(() => info.flags, (n) => { info.flags = n >>> 0; }, mask, label),
            setFlag: (mask) => { const was = (info.flags & mask) === mask; info.flags = (info.flags | mask) >>> 0; return !was; },
          }),
        };

        const nav = h("nav.form-nav");
        const body = h("div.form-body");
        /** Shows a section; `anchor` (a `data-anchor` in it) is scrolled to the top, and its first box gets the focus when asked. */
        const show = (s: SectionId, anchor?: string | null, focus = false) => {
          section = lastSection = s;
          nav.replaceChildren(...SECTIONS.map((x) => h(`button.form-nav-item${x.id === section ? ".active" : ""}`, { onclick: () => show(x.id) }, x.label)),
            h("div.form-nav-sep", {}, "Advanced"),
            ...ADVANCED.map((a) => h("button.form-nav-item", { title: a.hint,
              onclick: () => w3.commands.execute(a.command).catch((e) => w3.window.showError(String(e))) }, `${a.label} ↗`)));
          body.replaceChildren(h("h2", {}, SECTIONS.find((x) => x.id === section)!.label), ...renderers[section]());
          if (!anchor) return;
          const target = [...body.querySelectorAll<HTMLElement>("[data-anchor]")].find((x) => x.dataset.anchor === anchor);
          target?.scrollIntoView({ block: "start" });
          if (focus) target?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
        };
        el.append(h("div.map-info", {}, nav, body));
        const unbindKeys = bindUndoKeys(el, () => history.undo(), () => history.redo(), (e) => w3.keybindings.commandsFor(e));
        show(section, firstAnchor);
        const controller: OpenEditor = {
          root,
          show: (s, anchor) => show(s, anchor),
          createItemTable: () => {
            if (doc.readOnly) throw new Error("This map is read-only.");
            const table = addItemTable(info as unknown as TechInfo);
            update();
            show("techtree", itemTableAnchor(table.number), true);
            return { number: table.number, name: table.name };
          },
          itemTables: () => itemTablesShown(info as unknown as TechInfo, (value) => {
            const ref = StringTable.ref(value);
            return ref !== null && strings?.has(ref) ? strings.get(ref)! : value;
          }),
        };
        openEditors.add(controller);
        // The game's labels come in later. The techtree doesn't use them: drawn again, it would lose what was scrolled to.
        loadGameLists(w3).then((l) => { lists = l; if (section !== "techtree") show(section); }, () => {});

        return {
          undo: () => { history.undo(); },
          redo: () => { history.redo(); },
          async save() {
            // A text with a `}` line would be cut by the game: change it (one undo step) or save nothing.
            const cuts = strings?.cuts() ?? [];
            if (cuts.length) {
              if (!(await askWtsCuts((m, yes, ms) => w3.window.confirm(m, yes, ms), cuts))) throw new WtsCutError(cuts);
              if (strings!.fixCuts().length) { update(); show(section); }
            }
            // The ally priorities as the World Editor saves them (shown so above); the editor's own values stay, so an
            // undo isn't mixed up with the save.
            const taken = history.mark();
            // The preferences on top of the file as it is now (its other lines stay); a file that has become
            // unreadable stops the save before anything is written.
            const extraNow = JSON.stringify(extra);
            let extraWrite: string | null = null;
            if (extraNow !== extraSaved && !prefs.error) {
              const now = await readMapPrefs(w3);
              if (now.error) throw new Error(`war3mapExtra.txt couldn't be read (${now.error}); nothing was saved.`);
              const base = now.text ?? "";
              const next = writeMapExtra(base, extra);
              if (next !== base && !(now.text === null && next === "")) extraWrite = next;
            }
            const saved = structuredClone(info);
            applyAllyPriorities(saved as unknown as PlayerInfo & { flags: number });
            const text = await w3.backend.invoke<string>("codec_canonicalize", { root: w3.workspace.project()!.root, path: doc.path, text: JSON.stringify(saved) });
            await doc.writeText(text);
            if (extraWrite !== null) await w3.workspace.writeText(MAP_EXTRA_PATH, extraWrite);
            extraSaved = extraNow;
            if (strings && wtsBase !== null) {
              const base = wtsBase;
              const current = await w3.workspace.readText("map/war3map.wts").catch(() => base);
              const merged = StringTable.merge(base, strings, current);
              if (merged !== current) await w3.workspace.writeText("map/war3map.wts", merged);
              strings.rebase(merged);
              wtsBase = merged;
            }
            history.markSaved(taken);
            doc.setDirty(history.dirty);
          },
          // Closed: the saved file is what there is again.
          dispose: () => { openEditors.delete(controller); unbindKeys(); edits.fire(); },
          // Strings shown here, and the start locations behind the player list.
          // Terrain and units only feed the tileset hint and the start locations: taken in place, so the undo history stays.
          reloadFile: async (path: string) => {
            const units = path.startsWith("map/war3mapunits.doo");
            if (!units && !path.startsWith("map/war3map.w3e")) return false;
            if (units) {
              const fresh = await readStarts().catch(() => null);
              if (!fresh) return false;
              starts = fresh;
            }
            show(section);
            return true;
          },
          watches: ["map/war3map.wts", "map/war3mapUnits.doo.json", "map/war3mapUnits.doo", "map/war3map.w3e", "map/war3map.w3e.txt"],
        };
      },
    }),
  );
}
