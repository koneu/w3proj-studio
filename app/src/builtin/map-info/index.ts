import type { ExtensionContext, W3Api } from "../../extensions/api";
import { h } from "../../workbench/dom";
import { parseIni, parseSlk, westring } from "../../lib/formats/text";
import { StringTable } from "../../lib/formats/wts";
import { bindUndoKeys, History } from "../../lib/undo";
import { OBJECTS_SERVICE, type ObjectsService } from "../../extensions/services";
import { renderTechtree, type TechInfo } from "./techtree";
import { addPlayer, maxPlayers, removePlayer, startLocations, type PlayerInfo } from "../../lib/terrain/startlocations";

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
      .map((r) => [r.effectID, westring(we, r.name ?? r.effectID)] as [string, string]);
    return { tilesets, weather, loadingScreens };
  })();
  gameLists.catch(() => { gameLists = null; });
  return gameLists;
}

const PATH = "map/war3map.w3i.json";
/** Section to show when an editor opens or is already open. */
let requestedSection: SectionId | null = null;
const openEditors = new Set<(s: SectionId) => void>();

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const openAt = async (section?: SectionId) => {
    if (!w3.workspace.project()) throw new Error("Open or import a project first.");
    if (!w3.workspace.files().some((f) => f.path.toLowerCase() === PATH)) {
      const raw = w3.workspace.files().some((f) => f.path.toLowerCase() === "map/war3map.w3i");
      throw new Error(raw
        ? "This map's war3map.w3i could not be converted (unsupported or damaged); it is kept raw. Re-save the map in the World Editor and sync."
        : "This project has no war3map.w3i.");
    }
    requestedSection = section ?? null;
    for (const show of openEditors) if (section) show(section);
    await w3.editors.open(PATH, "w3.mapInfo");
  };

  ctx.subscriptions.push(
    w3.commands.register("w3.mapInfo.open", (section?: SectionId) => openAt(section)),
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
        const wtsText = await w3.workspace.readText("map/war3map.wts").catch(() => null);
        const strings = wtsText !== null ? new StringTable(wtsText) : null;
        const v = info.version;
        // Start locations (war3mapUnits.doo, either project form): players without one can't be added.
        const root = w3.workspace.project()!.root;
        const unitsText = await w3.workspace.readText("map/war3mapUnits.doo.json")
          .catch(() => w3.backend.invoke<string>("codec_decode", { root, path: "map/war3mapUnits.doo" })).catch(() => null);
        const starts = startLocations(unitsText ? (JSON.parse(unitsText) as { units?: [] }).units ?? [] : []);

        // Undo: the map info and the string table texts it refers to (the only ones edited here).
        const snapshot = () => {
          const json = JSON.stringify(info);
          const refs = strings ? [...new Set([...json.matchAll(/TRIGSTR_(\d+)/g)].map((m) => Number(m[1])))].filter((n) => strings.has(n)) : [];
          return JSON.stringify({ info, texts: refs.map((n) => [n, strings!.get(n)]) });
        };
        const history = new History(snapshot, (state) => {
          const s = JSON.parse(state) as { info: MapInfo; texts: [number, string][] };
          for (const k of Object.keys(info)) delete (info as unknown as Record<string, unknown>)[k];
          Object.assign(info, s.info);
          for (const [n, t] of s.texts) strings!.set(n, t);
          doc.setDirty(history.dirty);
          show(section);
        });
        /** After every change; `group` keeps typing in one field one undo step. */
        const update = (group?: unknown) => { history.commit(group); doc.setDirty(history.dirty); };
        let section: SectionId = requestedSection ?? "description";
        requestedSection = null;
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
        /** RGBA colour: colour picker + alpha. */
        const color = (rgba: number[]) => {
          const hex = "#" + rgba.slice(0, 3).map((c) => c.toString(16).padStart(2, "0")).join("");
          const pick = h("input", { type: "color", value: hex });
          // Dragging in the colour dialog is one undo step.
          let visit = {};
          pick.addEventListener("input", () => {
            const m = /^#(..)(..)(..)$/.exec(pick.value)!;
            for (let i = 0; i < 3; i++) rgba[i] = parseInt(m[i + 1], 16);
            update(visit);
          });
          pick.addEventListener("change", () => { visit = {}; });
          return h("div.form-inline", {}, pick, h("span.muted", {}, "alpha"), num(() => rgba[3], (n) => { rgba[3] = Math.max(0, Math.min(255, n)); }, { int: true }));
        };
        const section_ = (title: string, ...children: (Node | null)[]) => h("section.form-section", {}, h("h3", {}, title), ...children.filter((c): c is Node => c !== null));

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
              row("Tileset", lists ? select(lists.tilesets, () => info.tileset, (t) => { info.tileset = t; }) : h("code", {}, info.tileset),
                "The terrain itself is changed in the World Editor."),
              row("Playable area", h("span", {}, `${info.playableWidth} × ${info.playableHeight}`)),
              row("Saved", h("span", {}, `${info.saves} times · editor ${info.editorVersion}${info.gameVersion ? ` · game ${info.gameVersion.join(".")}` : ""} · format v${v}`)),
            ),
          ],
          loading: () => [
            section_("Loading screen",
              row("Screen", lists
                ? select<number>([[-1, "None / custom model"], ...lists.loadingScreens], () => info.loadingScreen.number, (n) => { info.loadingScreen.number = n; })
                : num(() => info.loadingScreen.number, (n) => { info.loadingScreen.number = n; }, { int: true })),
              row("Custom model", text(() => info.loadingScreen.model, (s) => { info.loadingScreen.model = s; })),
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
              row("Screen path", text(() => info.prologue.path, (s) => { info.prologue.path = s; })),
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
                row("Game data set", num(() => info.gameDataSet, (n) => { info.gameDataSet = n; }, { int: true }), "0 = default"),
                info.gameDataVersion !== undefined ? row("Game data version", num(() => info.gameDataVersion!, (n) => { info.gameDataVersion = n; }, { int: true })) : null,
                info.supportedModes !== undefined ? row("Supported graphics modes", num(() => info.supportedModes!, (n) => { info.supportedModes = n; }, { int: true }), "bit flags (SD / HD …)") : null,
              ),
              info.cameraZoom ? section_("Camera zoom",
                row("Default", num(() => info.cameraZoom!.default, (n) => { info.cameraZoom!.default = n; }, { int: true })),
                row("Maximum", num(() => info.cameraZoom!.max, (n) => { info.cameraZoom!.max = n; }, { int: true })),
                info.cameraZoom.min !== undefined ? row("Minimum", num(() => info.cameraZoom!.min!, (n) => { info.cameraZoom!.min = n; }, { int: true })) : null,
              ) : null,
            ].filter((x): x is HTMLElement => x !== null);
          },
          environment: () => [
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
            return [
              section_(`Players (${info.players.length})`,
                h("table.form-table", {},
                  h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Name"), h("th", {}, "Controller"), h("th", {}, "Race"), h("th", {}, "Fixed start"), h("th", {}, "Start X"), h("th", {}, "Start Y"))),
                  h("tbody", {}, ...ids.map((id) => {
                    const p = info.players.find((x) => x.id === id);
                    if (!p) {
                      const at = starts.get(id)!;
                      return h("tr.muted", {}, h("td", {}, String(id + 1)), h("td", {}, `Player ${id + 1}`), h("td", {}, controller(id)),
                        h("td", {}), h("td", {}), h("td", {}, String(at[0])), h("td", {}, String(at[1])));
                    }
                    return h("tr", {},
                      h("td.muted", {}, String(p.id + 1)),
                      h("td", {}, text(() => p.name, (s) => { p.name = s; })),
                      h("td", {}, controller(id)),
                      h("td", {}, select(RACES, () => p.race as 0 | 1 | 2 | 3 | 4, (n) => { p.race = n; })),
                      h("td", {}, bit(() => p.fixedStart, (n) => { p.fixedStart = n; }, 1, "")),
                      h("td", {}, num(() => p.start[0], (n) => { p.start[0] = n; })),
                      h("td", {}, num(() => p.start[1], (n) => { p.start[1] = n; })));
                  })))),
              h("small.muted", {}, "To add a player, place its start location in the terrain editor (Objects ▸ Start location) and save there. "
                + "Players set to None keep their start location but aren't in the map. Saving the terrain editor moves each player's start to its start location."),
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
            setFlag: (mask) => { info.flags = (info.flags | mask) >>> 0; },
          }),
        };

        const nav = h("nav.form-nav");
        const body = h("div.form-body");
        const show = (s: SectionId) => {
          section = s;
          nav.replaceChildren(...SECTIONS.map((x) => h(`button.form-nav-item${x.id === section ? ".active" : ""}`, { onclick: () => show(x.id) }, x.label)),
            h("div.form-nav-sep", {}, "Advanced"),
            ...ADVANCED.map((a) => h("button.form-nav-item", { title: a.hint,
              onclick: () => w3.commands.execute(a.command).catch((e) => w3.window.showError(String(e))) }, `${a.label} ↗`)));
          body.replaceChildren(h("h2", {}, SECTIONS.find((x) => x.id === section)!.label), ...renderers[section]());
        };
        el.append(h("div.map-info", {}, nav, body));
        const unbindKeys = bindUndoKeys(el, () => history.undo(), () => history.redo());
        show(section);
        openEditors.add(show);
        loadGameLists(w3).then((l) => { lists = l; show(section); }, () => {});

        return {
          async save() {
            const text = await w3.backend.invoke<string>("codec_canonicalize", { root: w3.workspace.project()!.root, path: doc.path, text: JSON.stringify(info) });
            await doc.writeText(text);
            if (strings?.dirty) {
              await w3.workspace.writeText("map/war3map.wts", strings.serialize());
              strings.markSaved();
            }
            history.markSaved();
            doc.setDirty(false);
          },
          dispose: () => { openEditors.delete(show); unbindKeys(); },
        };
      },
    }),
  );
}
