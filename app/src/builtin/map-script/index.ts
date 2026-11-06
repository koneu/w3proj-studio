import type { ExtensionContext, W3Api } from "../../extensions/api";
import { SCRIPT_LANGUAGES_SERVICE, type ScriptLanguage, type ScriptLanguagesService } from "../../extensions/services";
import { soundDurationMs } from "../../lib/audio/duration";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { StringTable } from "../../lib/formats/wts";
import { lostFunctions, scriptHash } from "../../lib/script/guard";
import { capped, requireProject } from "../../lib/formats/mapdoc";
import { checkJass } from "../../lib/jass/check";
import { gameJassEnv, jassSymbols, triggerOfFunctions } from "../../lib/jass/env";
import { checkLua } from "../../lib/lua/check";
import { describeProblems, findSymbols } from "./scriptinfo";
import { generateScript, parseSoundLabels, SOUND_INFO, type ScriptInput, type SoundLabel } from "../../lib/script/jass";
import { abilityOrders, gameTeamColors, specialUnits, teamColors, type AbilityOrders, type ObjectFile } from "../../lib/script/objects";
import { heightAt, parseW3e } from "../../lib/terrain/w3e";
import { readTerrainBytes, terrainPath } from "../../lib/terrain/w3etext";
import { parseTriggerData, type TriggerData } from "../../lib/triggers/triggerdata";
import { parseWtg, parseWtgJson, readWctFile, textTriggers, WTG_JSON, WTG_RAW } from "../../lib/triggers/wtg";

/** Hash of the script this app wrote last: a script that still has it holds nothing but what the
 *  map's triggers made, so it's replaced without looking (see lib/script/guard). */
const STAMP = ".w3proj/generated-script";

/** The map script: JASS, or Lua for maps set to Lua (war3map.w3i scriptType 1). */
const scriptPath = (lua: boolean) => (lua ? "map/war3map.lua" : "map/war3map.j");

/** Files war3map.j is made from (also as their .json documents). */
const INPUTS = /^map\/(war3map\.(wtg|wct|wts|w3i|w3r|w3c|w3s|doo|w3e|w3u|w3t|w3a)|war3mapUnits\.doo|war3mapSkin\.w3u)(\.json)?$/i;

/** vJASS in trigger texts (libraries, scopes, structs, block comments, //! directives), or a
 *  script JassHelper compiled ("//globals from <library>:", LIBRARY_<name> constants). Such
 *  maps need a vJASS compiler: writing the triggers into war3map.j as they are breaks the map. */
const VJASS_SOURCE = /^\s*(?:(?:private|public)\s+)?(?:library|scope|struct|module|interface|textmacro|endlibrary|endscope|endstruct)\b|^(?:(?!\/\/).)*\/\*|^\s*\/\/!/m;
const VJASS_OUTPUT = /^\/\/globals from \w+:|^constant boolean LIBRARY_\w+\s*=\s*true/m;

/** Ability files with the orders that switch autocast on and off. */
const ABILITY_FUNC = ["Campaign", "Common", "Human", "Item", "Neutral", "NightElf", "Orc", "Undead"].map((r) => `Units\\${r}AbilityFunc.txt`);

/** UI\SoundInfo tables with the sound labels' settings, in the order the first match wins. */

interface GameTables {
  data: TriggerData;
  soundLabels: Map<string, SoundLabel>;
  buildings: Set<string>;
  items: Set<string>;
  abilities: Set<string>;
  orders: Map<string, AbilityOrders>;
  unitColors: Map<string, number>;
  worldEdit: Map<string, Map<string, string>>;
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const out = w3.output.channel("Map Script");
  // Script languages (extensions) that compile trigger texts into JASS.
  const languages: ScriptLanguage[] = [];
  const languageService: ScriptLanguagesService = {
    register(language) {
      languages.push(language);
      return { dispose: () => { const i = languages.indexOf(language); if (i >= 0) languages.splice(i, 1); } };
    },
    languages: () => [...languages],
  };
  ctx.subscriptions.push(w3.services.provide(SCRIPT_LANGUAGES_SERVICE, languageService));

  let tables: Promise<GameTables> | null = null;
  const gameTables = () => {
    tables ??= (async () => {
      const text = (p: string) => w3.game.readText(p).catch(() => "");
      const balance = parseSlk(await text("Units\\UnitBalance.slk"));
      const orders = abilityOrders(await Promise.all(ABILITY_FUNC.map(async (f) => parseIni(await text(f)))));
      return {
        data: parseTriggerData(await w3.game.readText("UI\\TriggerData.txt")),
        buildings: new Set(balance.filter((r) => r.isbldg === "1").map((r) => r.unitBalanceID)),
        items: new Set(parseSlk(await text("Units\\ItemData.slk")).map((r) => r.itemID)),
        abilities: new Set(parseSlk(await text("Units\\AbilityData.slk")).map((r) => r.alias)),
        orders,
        unitColors: gameTeamColors(parseSlk(await text("Units\\unitUI.slk"))),
        worldEdit: parseIni(await text("UI\\WorldEditData.txt")),
        soundLabels: parseSoundLabels(await Promise.all(SOUND_INFO.map((n) => text(`UI\\SoundInfo\\${n}.slk`)))),
      };
    })();
    tables.catch(() => { tables = null; });
    return tables;
  };

  /** Builds the map script from the project's files. */
  const generate = async (): Promise<{ path: string; text: string; vjass?: string; language?: string }> => {
    // Read directly rather than from the file list, which lags behind fresh saves (New Map).
    const json = async <T>(p: string): Promise<T | null> => {
      // Projects made before a format got its JSON form keep the raw file until they're re-synced.
      const text = await w3.workspace.readText(`${p}.json`).catch(() =>
        w3.backend.invoke<string>("codec_decode", { root: w3.workspace.project()?.root, path: p }).catch(() => null));
      return text === null ? null : JSON.parse(text) as T;
    };
    const bytes = (p: string) => w3.workspace.readBytes(p).catch(() => null);
    const info = await json<ScriptInput["info"]>("map/war3map.w3i");
    if (!info) throw new Error("map/war3map.w3i is missing or couldn't be read");
    const path = scriptPath(info.scriptType === 1);
    const g = await gameTables();

    // Either form, read directly (the file list may lag behind a fresh save).
    // A broken file fails the generation; only a missing one means no triggers.
    const wtgJson = await w3.workspace.readText(WTG_JSON).catch(() => null);
    const wtg = wtgJson === null ? await bytes(WTG_RAW) : null;
    const triggers = wtgJson !== null ? parseWtgJson(wtgJson) : wtg ? parseWtg(wtg, g.data) : undefined;
    const custom = triggers ? await readWctFile(w3.workspace, textTriggers(triggers).length) : null;
    // A language extension compiles maps written in it (JASS maps only); vJASS without one isn't
    // regenerated (the uncompiled text would break the map).
    const textList = [custom?.header ?? "", ...(custom?.texts ?? []).map((t) => t ?? "")];
    const texts = textList.join("\n");
    const current = await w3.workspace.readText(path).catch(() => "");
    const language = info.scriptType === 1 ? undefined : languages.find((l) => l.detect({ texts: textList, script: current }));
    if (!language && (VJASS_SOURCE.test(texts) || VJASS_OUTPUT.test(current))) {
      return { path, text: "", vjass: VJASS_OUTPUT.test(current) ? "its script was compiled from vJASS" : "its triggers contain vJASS" };
    }
    const wtsText = await w3.workspace.readText("map/war3map.wts").catch(() => null);
    const wts = wtsText === null ? null : new StringTable(wtsText);
    const w3ePath = terrainPath(w3.workspace.files().map((f) => f.path));
    const w3e = w3ePath ? await readTerrainBytes(w3ePath, { readText: () => w3.workspace.readText(w3ePath), readBytes: () => w3.workspace.readBytes(w3ePath) }).catch(() => null) : null;
    const terrain = w3e ? parseW3e(w3e) : null;

    // Custom objects: their base decides, unless the map sets "is a building" (ubdg).
    type Objects = { custom?: { id: string; base: string; mods?: { field: string; value: unknown }[] }[] };
    const customUnits = new Map<string, { base: string; bldg?: boolean }>();
    const unitFiles = await Promise.all(["map/war3map.w3u", "map/war3mapSkin.w3u"].map((f) => json<Objects & ObjectFile>(f)));
    const colors = teamColors(unitFiles, g.unitColors), special = specialUnits(unitFiles);
    for (const file of unitFiles) {
      for (const o of file?.custom ?? []) {
        const b = o.mods?.find((m) => m.field === "ubdg");
        customUnits.set(o.id, { base: o.base, bldg: b ? b.value === 1 : undefined });
      }
    }
    const customIds = async (f: string) => new Set(((await json<Objects>(f))?.custom ?? []).map((o) => o.id));
    const customAbilities = await customIds("map/war3map.w3a"), customItems = await customIds("map/war3map.w3t");
    const kindOf = (id: string): ReturnType<NonNullable<ScriptInput["kindOf"]>> => {
      if (id === "sloc") return "sloc";
      if (g.abilities.has(id) || customAbilities.has(id)) return "ability";
      if (g.items.has(id) || customItems.has(id)) return "item";
      const c = customUnits.get(id);
      if (c) return (c.bldg ?? g.buildings.has(c.base)) ? "building" : "unit";
      return g.buildings.has(id) ? "building" : "unit";
    };

    const lightEnv = ((info.lightEnvironment as string) || (info.tileset as string)).toLowerCase();
    const light = (sec: string, kind: string) =>
      g.worldEdit.get(sec)?.get(lightEnv) ?? `Environment\\DNC\\DNCLordaeron\\DNCLordaeron${kind}\\DNCLordaeron${kind}.mdl`;

    const sounds = (await json<{ sounds: NonNullable<ScriptInput["sounds"]> }>("map/war3map.w3s"))?.sounds ?? [];
    const durations = await soundDurations(sounds.map((s) => s.file), path);

    const script = generateScript({
      info, data: g.data, triggers, custom, kindOf, autocastOrders: (a) => g.orders.get(a), teamColor: (id) => colors.get(id), goldMine: (id) => special.goldMines.has(id), waygate: (id) => special.waygates.has(id),
      lights: { terrain: light("TerrainLights", "Terrain"), unit: light("UnitLights", "Unit") },
      groundHeight: terrain ? (x, y) => heightAt(terrain, x, y) : undefined,
      units: (await json<{ units: ScriptInput["units"] }>("map/war3mapUnits.doo"))?.units,
      doodads: (await json<{ doodads: ScriptInput["doodads"] }>("map/war3map.doo"))?.doodads,
      regions: (await json<{ regions: ScriptInput["regions"] }>("map/war3map.w3r"))?.regions,
      cameras: (await json<{ cameras: ScriptInput["cameras"] }>("map/war3map.w3c"))?.cameras,
      sounds, soundDuration: (f) => durations.get(f), soundLabel: (l) => g.soundLabels.get(l), string: (v) => wts?.resolve(v) ?? v,
    });
    if (!language) return { path, text: script };
    // The language's compiler gets the script as the World Editor hands it to JassHelper.
    const [commonJ, blizzardJ] = await Promise.all([w3.game.readText("Scripts\\common.j"), w3.game.readText("Scripts\\Blizzard.j")]);
    return { path, text: await language.compile({ script, commonJ, blizzardJ }), language: language.title };
  };

  /** Sound lengths in ms: imported files, the game's, else what the current script says. */
  const soundDurations = async (soundFiles: string[], path: string) => {
    const out = new Map<string, number>();
    const old = new Map<string, number>();
    const script = await w3.workspace.readText(path).catch(() => null);
    // JASS ("set x = CreateSound( "…"") or Lua ("x = CreateSound("…"").
    if (script !== null) {
      const fileOf = new Map<string, string>();
      for (const m of script.matchAll(/(\w+) = CreateSound\( ?"((?:[^"\\]|\\.)*)"/g)) fileOf.set(m[1], m[2].replace(/\\\\/g, "\\"));
      for (const m of script.matchAll(/SetSoundDuration\( ?(\w+), (\d+) ?\)/g)) { const f = fileOf.get(m[1]); if (f) old.set(f, Number(m[2])); }
    }
    for (const f of new Set(soundFiles)) {
      const buf = await w3.workspace.readBytes(`map/${f.replace(/\\/g, "/")}`).catch(() => w3.game.read(f)).catch(() => null);
      const ms = buf ? soundDurationMs(buf) : null;
      const d = ms ?? old.get(f);
      if (d !== undefined) out.set(f, d);
    }
    return out;
  };

  let running: Promise<boolean> = Promise.resolve(true);
  /** Projects already told that their vJASS script isn't regenerated. */
  const warned = new Set<string>();
  /** Writes the script; false when it stays as it is. `force`: also over code of its own. */
  const write = (reason: string, force = false): Promise<boolean> => {
    // The queue goes on after a failed run (the caller of that run has its error).
    running = running.catch(() => true).then(async () => {
      try {
        const root = w3.workspace.project()?.root;
        const { path, text, vjass, language } = await generate();
        const file = path.slice(4);
        // Generating can take a while: this script must not land in another project.
        if (w3.workspace.project()?.root !== root) { out.append(`${reason}: ${file} not written: the project was changed meanwhile`); return false; }
        if (vjass) {
          out.append(`${reason}: ${file} not written: ${vjass}, and no script language extension compiles it (vJASS: enable "vJASS (JassHelper)"); the script stays as it is.`);
          const root = w3.workspace.project()?.root ?? "";
          if (!warned.has(root)) {
            warned.add(root);
            void w3.window.showWarning(`This map uses vJASS (${vjass}), so ${file} isn't regenerated from the triggers: changed triggers don't reach the map script. ` +
              "Enable the vJASS (JassHelper) extension, or compile it in the World Editor.");
          }
          return false;
        }
        const current = await w3.workspace.readText(path).catch(() => null);
        if (current === text) { out.append(`${reason}: ${file} up to date`); return true; }
        const stamp = await w3.workspace.readText(STAMP).catch(() => null);
        if (!force && current !== null && stamp?.trim() !== scriptHash(current)) {
          const lost = lostFunctions(current, text);
          if (lost.length) {
            out.append(`${reason}: ${file} not written: it has ${lost.length} functions the triggers don't make (${lost.slice(0, 5).join(", ")}${lost.length > 5 ? ", …" : ""}); the script stays as it is.`);
            // Once per project on saves; asked for by name, always.
            const key = `custom:${w3.workspace.project()?.root ?? ""}`;
            if (reason !== "command" && warned.has(key)) return false;
            warned.add(key);
            void w3.window.showWarning(`${file} has ${lost.length} function${lost.length === 1 ? "" : "s"} that the map's triggers don't make (${lost.slice(0, 3).join(", ")}${lost.length > 3 ? ", …" : ""}), so it isn't regenerated and changed triggers don't reach it. Replacing it deletes that code.`,
              "Replace the script", "Keep it").then(async (c) => {
                if (c !== "Replace the script") return;
                // That code exists nowhere else: a checkpoint keeps it, where they're enabled.
                await w3.commands.execute("w3.checkpoints.create", { quiet: true }).catch(() => {});
                await write("replaced on request", true).catch(() => {});
              });
            return false;
          }
        }
        await w3.workspace.writeText(path, text);
        await w3.workspace.writeText(STAMP, `${scriptHash(text)}
`);
        out.append(`${reason}: ${file} written (${text.length} chars${language ? `, compiled with ${language}` : ""})`);
        return true;
      } catch (e) {
        out.append(`${reason}: map script not written: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    });
    return running;
  };

  // Saves come in bursts (a map save writes several files): wait for the last one.
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The file that started the waiting, while a run is due. */
  let pending: string | null = null;
  const afterSave = (path: string) => write(`saved ${path}`).catch((e) => {
    // Nobody is watching a save's script run, and saving goes on working: say so once.
    const key = `failed:${w3.workspace.project()?.root ?? ""}`;
    if (warned.has(key)) return;
    warned.add(key);
    void w3.window.showWarning(`The map script couldn't be regenerated, so saved changes don't reach it: ${e instanceof Error ? e.message : String(e)}`);
  });
  ctx.subscriptions.push(
    w3.mcp.registerTool("build_script", async () => {
      requireProject(w3);
      clearTimeout(timer);
      const built = await write("build_script");
      const lua = await w3.workspace.readText("map/war3map.lua").catch(() => null);
      const path = lua !== null ? "map/war3map.lua" : "map/war3map.j";
      const text = lua ?? await w3.workspace.readText(path);
      const found = lua !== null ? checkLua(text).map((d) => ({ ...d, severity: "error" })) : checkJass(text, await gameJassEnv((p) => w3.game.readText(p)));
      return {
        // Not rebuilt: what's checked is the old script, so it can't say anything about the latest change.
        rebuilt: built, ...(built ? {} : { note: "The script wasn't rebuilt: it has code the triggers don't make, or a language no extension compiles. See the Map Script output in the app. What follows is about the old script." }),
        language: lua !== null ? "lua" : "jass", lines: text.split("\n").length, ...describeProblems(text, found, triggerOfFunctions(text)),
      };
    }),
    w3.mcp.registerTool("search_script_api", async ({ filter, kind, limit }) => {
      if (typeof filter !== "string" || !filter) throw new Error("search_script_api needs a filter.");
      const env = await gameJassEnv((p) => w3.game.readText(p));
      return capped(findSymbols(jassSymbols(env, ""), filter, typeof kind === "string" ? kind : undefined), limit, 80);
    }),
    w3.workspace.onDidSave((path) => {
      if (!INPUTS.test(path) || !w3.settings.get<boolean>("script.generateOnSave") || !w3.workspace.project()) return;
      clearTimeout(timer);
      pending = path;
      timer = setTimeout(() => { pending = null; void afterSave(path); }, 800);
    }),
    // What packs the map first waits here: a script still due from the last save belongs in it.
    w3.commands.register("w3.script.settle", async () => {
      clearTimeout(timer);
      const path = pending;
      pending = null;
      if (path) await afterSave(path);
      await running.catch(() => true);
    }),
    // `quiet` (other extensions, e.g. New Map): no message afterwards.
    w3.commands.register("w3.script.generate", async (opts?: { quiet?: boolean }) => {
      const written = await write("command");
      if (written && !opts?.quiet) w3.window.showInfo("Map script generated (see the Map Script output).");
    }),
    { dispose: () => clearTimeout(timer) },
  );
}
