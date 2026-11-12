import type { ExtensionContext, W3Api } from "../../extensions/api";
import { SCRIPT_LANGUAGES_SERVICE, type ScriptLanguage, type ScriptLanguagesService } from "../../extensions/services";
import { soundDurationMs } from "../../lib/audio/duration";
import { soundVariants } from "../../lib/audio/variants";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { StringTable } from "../../lib/formats/wts";
import { isScriptInput, KEPT_SCRIPT_WORDS, SCRIPT_FILES, SCRIPT_STAMP, sameButPlacingOrder, scriptDecision, scriptHash } from "../../lib/script/guard";
import { isNotFoundError } from "../../lib/oserror";
import { h } from "../../workbench/dom";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { getChunks, goToNextChunk, goToPreviousChunk, MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, lineNumbers } from "@codemirror/view";
import { capped, requireProject } from "../../lib/formats/mapdoc";
import { checkJass } from "../../lib/jass/check";
import { gameJassEnv, jassSymbols, triggerOfFunctions } from "../../lib/jass/env";
import { checkLua } from "../../lib/lua/check";
import { describeProblems, findSymbols } from "./scriptinfo";
import { generateScript, parseSoundLabels, scriptSoundDurations, SOUND_INFO, type ScriptInput, type SoundLabel } from "../../lib/script/jass";
import { dayNightModels } from "../../lib/script/setup";
import { abilityOrders, autocastOrdersOf, buildingTypes, customColorTypes, customIdsOf, destructableTints, gameCustomColors, gameTeamColors, heroAbilities, scriptObjectFiles, specialUnits, teamColors, type AbilityOrders, type ObjectFile } from "../../lib/script/objects";
import { campaignOf, findCampaign, readCampaignObjects } from "../../lib/objects/campaign";
import { checkpointBefore } from "../../lib/checkpoint";
import { joinPath } from "../../lib/paths";
import { heightAt, parseW3e } from "../../lib/terrain/w3e";
import { meleeBlockers, meleeFlagsAfter, type MeleeInfo } from "../../lib/terrain/owner";
import { readTerrainBytes, terrainPath } from "../../lib/terrain/w3etext";
import { parseTriggerData, type TriggerData } from "../../lib/triggers/triggerdata";
import { parseWtg, parseWtgJson, readWctFile, textTriggers, WTG_JSON, WTG_RAW } from "../../lib/triggers/wtg";

/** Hash of the script this app wrote last: a script that still has it holds nothing but what the
 *  map's triggers made, so it's replaced without looking (see lib/script/guard). */
const STAMP = SCRIPT_STAMP;

/** The tab showing how the script differs from what the map's data makes ("w3:script-diff:map/war3map.j"). */
const DIFF = "w3:script-diff:";

const INFO_JSON = "map/war3map.w3i.json";
const W3L_RAW = "map/war3map.w3l", W3L_JSON = "map/war3map.w3l.json";

/** The map script: JASS, or Lua for maps set to Lua (war3map.w3i scriptType 1). */
const scriptPath = (lua: boolean) => (lua ? "map/war3map.lua" : "map/war3map.j");

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
  heroAbilities: Set<string>;
  orders: Map<string, AbilityOrders>;
  unitColors: Map<string, number>;
  /** The game's unit types that allow a custom team colour (lib/script/objects gameCustomColors). */
  customColors: Set<string>;
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
      const abilityRows = parseSlk(await text("Units\\AbilityData.slk"));
      const unitUI = parseSlk(await text("Units\\unitUI.slk"));
      return {
        data: parseTriggerData(await w3.game.readText("UI\\TriggerData.txt")),
        buildings: new Set(balance.filter((r) => r.isbldg === "1").map((r) => r.unitBalanceID)),
        items: new Set(parseSlk(await text("Units\\ItemData.slk")).map((r) => r.itemID)),
        abilities: new Set(abilityRows.map((r) => r.alias)),
        heroAbilities: new Set(abilityRows.filter((r) => r.hero === "1").map((r) => r.alias)),
        orders,
        unitColors: gameTeamColors(unitUI), customColors: gameCustomColors(unitUI),
        worldEdit: parseIni(await text("UI\\WorldEditData.txt")),
        soundLabels: parseSoundLabels(await Promise.all(SOUND_INFO.map((n) => text(`UI\\SoundInfo\\${n}.slk`)))),
      };
    })();
    tables.catch(() => { tables = null; });
    return tables;
  };

  /** Builds the map script from the project's files. `look`: only to look at (the difference, whether a fresh import's
 *  script is what the data makes): nothing is written, not even the melee flag a save turns off. */
  const generate = async (look = false): Promise<{ path: string; text: string; vjass?: string; language?: string }> => {
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

    // Custom objects: their base decides, unless the map sets "is a building" (ubdg). A chapter map has its campaign's
    // object data too, under its own (scriptObjectFiles). Whether there is a campaign, and its files, must be known: an
    // unknown answer fails the generation rather than leaving the campaign's objects out.
    const campaign = await findCampaign(w3);
    const objectFiles = await scriptObjectFiles((kind, skin, inCampaign) => (inCampaign
      ? readCampaignObjects<ObjectFile>(w3, campaign!, kind, skin)
      : json<ObjectFile>(`map/war3map${skin ? "Skin" : ""}.${kind}`)), campaign !== undefined);
    const unitFiles = objectFiles.w3u;
    const colors = teamColors(unitFiles, g.unitColors), special = specialUnits(unitFiles);
    const isBuilding = buildingTypes(unitFiles, g.buildings);
    const customAbilities = customIdsOf(objectFiles.w3a), customItems = customIdsOf(objectFiles.w3t);
    const heroAbility = heroAbilities(objectFiles.w3a, g.heroAbilities);
    const destructableTint = destructableTints(objectFiles.w3b);
    const kindOf = (id: string): ReturnType<NonNullable<ScriptInput["kindOf"]>> => {
      if (id === "sloc") return "sloc";
      // A random item has no type of its own.
      if (id === "iDNR") return "item";
      if (g.abilities.has(id) || customAbilities.has(id)) return "ability";
      if (g.items.has(id) || customItems.has(id)) return "item";
      return isBuilding(id) ? "building" : "unit";
    };

    // As the World Editor does when saving. Only ever off (see meleeFlagsAfter). An open, changed Map Properties gets
    // its turn when that's saved.
    const placed = (await json<{ units?: { id: string; player?: number }[] }>("map/war3mapUnits.doo"))?.units ?? [];
    const meleeInfo = { ...info, flags: Number(info.flags) } as MeleeInfo;
    const flags = meleeInfo.flags, unmelee = meleeFlagsAfter(meleeInfo, placed);
    if (unmelee !== flags && !w3.editors.isDirty(INFO_JSON)) {
      info.flags = unmelee;
      if (!look) {
        const canonical = await w3.backend.invoke<string>("codec_canonicalize", { root: w3.workspace.project()?.root, path: INFO_JSON, text: JSON.stringify(info) });
        await w3.workspace.writeText(INFO_JSON, canonical);
        out.append(`war3map.w3i: not a melee map any more (as the World Editor's save makes it): ${meleeBlockers(meleeInfo, placed).join("; ")}`);
      }
    }

    const lightEnv = ((info.lightEnvironment as string) || (info.tileset as string)).toLowerCase();
    const light = (sec: string, kind: string) =>
      g.worldEdit.get(sec)?.get(lightEnv) ?? `Environment\\DNC\\DNCLordaeron\\DNCLordaeron${kind}\\DNCLordaeron${kind}.mdl`;
    // The map's own lighting models (lighting editor). Only a missing war3map.w3l means the light
    // environment's: a broken one fails the generation rather than losing the map's lighting.
    const w3lJson = await w3.workspace.readText(W3L_JSON).catch(() => null);
    const w3lRaw = w3lJson === null && (await bytes(W3L_RAW)) !== null
      ? await w3.backend.invoke<string>("codec_decode", { root: w3.workspace.project()?.root, path: W3L_RAW }) : null;
    const w3lText = w3lJson ?? w3lRaw;
    const lights = dayNightModels(w3lText === null ? null : JSON.parse(w3lText), { terrain: light("TerrainLights", "Terrain"), unit: light("UnitLights", "Unit") });

    const sounds = (await json<{ sounds: NonNullable<ScriptInput["sounds"]> }>("map/war3map.w3s"))?.sounds ?? [];
    const soundDuration = await soundDurations(sounds.map((s) => s.file), path, campaign);

    const script = generateScript({
      info, data: g.data, triggers, custom, kindOf, autocastOrders: autocastOrdersOf(g.orders, objectFiles.w3a), heroAbility, destructableTint, teamColor: (id) => colors.get(id), goldMine: (id) => special.goldMines.has(id), waygate: (id) => special.waygates.has(id),
      customColor: customColorTypes(unitFiles, g.customColors),
      lights,
      groundHeight: terrain ? (x, y) => heightAt(terrain, x, y) : undefined,
      units: (await json<{ units: ScriptInput["units"] }>("map/war3mapUnits.doo"))?.units,
      doodads: (await json<{ doodads: ScriptInput["doodads"] }>("map/war3map.doo"))?.doodads,
      regions: (await json<{ regions: ScriptInput["regions"] }>("map/war3map.w3r"))?.regions,
      cameras: (await json<{ cameras: ScriptInput["cameras"] }>("map/war3map.w3c"))?.cameras,
      sounds, soundDuration, soundLabel: (l) => g.soundLabels.get(l), string: (v) => wts?.resolve(v) ?? v,
    });
    if (!language) return { path, text: script };
    // The language's compiler gets the script as the World Editor hands it to JassHelper.
    const [commonJ, blizzardJ] = await Promise.all([w3.game.readText("Scripts\\common.j"), w3.game.readText("Scripts\\Blizzard.j")]);
    return { path, text: await language.compile({ script, commonJ, blizzardJ }), language: language.title };
  };

  /** Sound lengths in ms, by file and sound name: imported files (a chapter map's, else its campaign's, as the game
   *  finds them), the game's, else what the current script says (scriptSoundDurations: per sound, so sounds of one
   *  unreadable file each keep their own). `campaign`: a chapter map's campaign project. */
  const soundDurations = async (soundFiles: string[], path: string, campaign?: string): Promise<(file: string, name: string) => number | undefined> => {
    const measured = new Map<string, number>();
    const script = await w3.workspace.readText(path).catch(() => null);
    const old = scriptSoundDurations(script ?? "");
    /** The first of `variants` that `read` finds. */
    const first = async (variants: string[], read: (v: string) => Promise<Uint8Array>): Promise<Uint8Array | null> => {
      for (const v of variants) {
        const buf = await read(v).catch(() => null);
        if (buf) return buf;
      }
      return null;
    };
    for (const f of new Set(soundFiles)) {
      // Under any of its sound extensions, as the game takes it (soundVariants): its own name first in each place.
      const variants = soundVariants(f);
      const rel = (v: string) => `map/${v.replace(/\\/g, "/")}`;
      const buf = await first(variants, (v) => w3.workspace.readBytes(rel(v)))
        ?? (campaign === undefined ? null : await first(variants, (v) => w3.workspace.readBytes(joinPath(campaign, rel(v)))))
        ?? await first(variants, (v) => w3.game.read(v));
      const ms = buf ? soundDurationMs(buf) : null;
      if (ms !== null) measured.set(f, ms);
    }
    return (file, name) => measured.get(file) ?? old(file, name);
  };

  let running: Promise<boolean> = Promise.resolve(true);
  /** Projects already told that their vJASS script isn't regenerated. */
  const warned = new Set<string>();
  /** The script's text; null when there is none, undefined when it's there but can't be read (not taken for none). */
  const readScript = (path: string): Promise<string | null | undefined> =>
    w3.workspace.readText(path).then((t) => t, (e) => (isNotFoundError(e) ? null : undefined));
  /** The script as the map's data makes it now, replacing what is there, for the project at `root` only (a question
   *  answered after switching projects must not reach the next one). A checkpoint first: what it replaces exists
   *  nowhere else (where they're enabled; a failed one asks before going on). */
  const replaceScript = async (root: string, file: string) => {
    if (w3.workspace.project()?.root !== root) {
      void w3.window.showWarning(`${file} wasn't replaced: another project is open now.`);
      return;
    }
    if (!(await checkpointBefore(w3, `Replace ${file}`))) return;
    await write("replaced on request", true, root).catch(() => {});
  };
  const showDifference = (path: string) => w3.editors.open(`${DIFF}${path}`, "w3.scriptDiff");
  /** Closes the open questions about the project's script when another project (or the same folder again) opens:
   *  answering one there only says it's no longer about the open project. */
  let questions = new AbortController();
  /** Asks what to do with a script that is kept (Replace, Show Difference, Keep), for the open project only. */
  const ask = (message: string) => w3.window.notify("warning", message, ["Replace the script", "Show Difference", "Keep it"], { signal: questions.signal });
  /** Writes the script; false when it stays as it is. `force`: also over a script that isn't the one this app
   *  wrote last. `onlyFor`: only in that project (else nothing is written). */
  const write = (reason: string, force = false, onlyFor?: string): Promise<boolean> => {
    // The queue goes on after a failed run (the caller of that run has its error).
    running = running.catch(() => true).then(async () => {
      try {
        const root = w3.workspace.project()?.root;
        if (onlyFor !== undefined && root !== onlyFor) { out.append(`${reason}: not written: another project is open now`); return false; }
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
        const current = await readScript(path);
        const stamp = await w3.workspace.readText(STAMP).catch(() => null);
        const decision = scriptDecision(current, text, stamp, force);
        if (decision.action === "same") {
          // The data makes this very script (a fresh import, a script put back): it's this app's from now on.
          if (stamp?.trim() !== scriptHash(text)) await w3.workspace.writeText(STAMP, `${scriptHash(text)}
`);
          out.append(`${reason}: ${file} up to date`);
          return true;
        }
        if (decision.action === "keep") {
          const { lost } = decision;
          const here = root ?? "";
          // Once per project on saves; asked for by name, always.
          const key = `${lost.length ? "custom" : "edited"}:${here}`;
          const tell = reason === "command" || !warned.has(key);
          warned.add(key);
          const answer = (c: string | undefined) => {
            if (c === "Replace the script") void replaceScript(here, file);
            else if (c === "Show Difference") void showDifference(path).catch((e) => w3.window.showError(String(e)));
          };
          if (lost.length) {
            out.append(`${reason}: ${file} not written: it has ${lost.length} functions the triggers don't make (${lost.slice(0, 5).join(", ")}${lost.length > 5 ? ", …" : ""}); the script stays as it is.`);
            if (tell) {
              void ask(`${file} has ${lost.length} function${lost.length === 1 ? "" : "s"} that the map's triggers don't make (${lost.slice(0, 3).join(", ")}${lost.length > 3 ? ", …" : ""}), ${KEPT_SCRIPT_WORDS} and changed triggers don't reach it. Replacing it deletes that code (a checkpoint keeps it).`).then(answer);
            }
            return false;
          }
          const why = current === undefined ? "can't be read as text" : "isn't the script Studio wrote last (it was changed by hand or by another program, or comes from the World Editor and differs from what Studio makes)";
          out.append(`${reason}: ${file} not written: it ${why}; the script stays as it is. "Replace the script" in the warning (Generate Map Script shows it again) replaces it.`);
          if (tell) {
            void ask(`${file} ${why}, ${KEPT_SCRIPT_WORDS}: saved changes to triggers, regions, cameras, sounds, placed objects or map info don't reach it. Replacing it writes over its changes (a checkpoint keeps them).`).then(answer);
          }
          return false;
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

  /** A project whose script isn't stamped as this app's (a fresh import, a sync from the World Editor, a project from
   *  before the stamp): if the script is what the map's data makes, but perhaps for the order of its placed objects,
   *  it gets the stamp, so the next save regenerates it without a question (also when that save changes the data, which
   *  the order check alone wouldn't see through). Writes nothing else; a failure only leaves the stamp out. */
  const adopt = (why: string): Promise<void> => {
    running = running.catch(() => true).then(async () => {
      try {
        const root = w3.workspace.project()?.root;
        if (!root || !w3.settings.get<boolean>("script.generateOnSave")) return true;
        const stamp = (await w3.workspace.readText(STAMP).catch(() => null))?.trim();
        for (const p of SCRIPT_FILES) {
          const t = await w3.workspace.readText(p).catch(() => null);
          if (t !== null && stamp === scriptHash(t)) return true;
        }
        const { path, text, vjass } = await generate(true);
        if (vjass || w3.workspace.project()?.root !== root) return true;
        const current = await readScript(path);
        if (typeof current !== "string" || !sameButPlacingOrder(current, text) || w3.workspace.project()?.root !== root) return true;
        // The stamp is the hash of the script as it is on disk: one that differs only in the order of its placed objects
        // (the World Editor's order) is replaced by the next save without a question too.
        await w3.workspace.writeText(STAMP, `${scriptHash(current)}
`);
        out.append(`${why}: ${path.slice(4)} is what the map's data makes${current === text ? "" : " (but for the order of its placed objects)"}, so saves regenerate it`);
      } catch (e) {
        out.append(`${why}: couldn't compare the map script with what the map's data makes: ${e instanceof Error ? e.message : String(e)}`);
      }
      return true;
    });
    return running.then(() => {}, () => {});
  };
  /** The project last seen opened: each opening is a new one, the same folder opened again too (an import over it). */
  let openProject: object | null = null;
  const opened = () => {
    const project = w3.workspace.project();
    if (project === openProject) return;
    openProject = project;
    questions.abort();
    questions = new AbortController();
    if (project) void adopt("opened").then(() => refreshChapter(project.root));
  };
  /** A chapter map's script that is this app's (stamped) is made again when the project opens: its campaign's object
   *  data may have changed while it was closed (edited in the campaign project), and no save in this project tells.
   *  Nothing is written when it comes out the same; a script that isn't this app's is left alone (no question). */
  const refreshChapter = async (root: string) => {
    try {
      if (!campaignOf(root) || !w3.settings.get<boolean>("script.generateOnSave") || w3.workspace.project()?.root !== root) return;
      if (!(await findCampaign(w3, root))) return;
      const stamp = (await w3.workspace.readText(STAMP).catch(() => null))?.trim();
      let ours = false;
      for (const p of SCRIPT_FILES) {
        const t = await w3.workspace.readText(p).catch(() => null);
        if (t !== null && stamp === scriptHash(t)) ours = true;
      }
      if (ours && w3.workspace.project()?.root === root) await write("opened (a chapter of a campaign)", false, root);
    } catch (e) {
      out.append(`opened: the chapter's map script wasn't made again: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  opened();

  ctx.subscriptions.push(
    w3.workspace.onDidChange(opened),
    // After a sync from a map (the World Editor's save): a script it wrote that Studio would write too is Studio's.
    w3.commands.register("w3.script.adopt", () => adopt("synced")),
    w3.editors.registerProvider("w3.scriptDiff", {
      async resolve(el, doc) {
        const path = doc.path.slice(DIFF.length);
        const file = path.slice(4);
        el.classList.add("diff-pane");
        let view: MergeView | null = null;
        const render = async () => {
          const root = w3.workspace.project()?.root;
          if (!root) throw new Error("No project is open.");
          const [current, made] = await Promise.all([readScript(path), generate(true)]);
          view?.destroy();
          view = null;
          const head = h("div.diff-head", {}, h("span", {}, file), h("small.muted", {}, "  the script now ↔ what the map's data makes"));
          if (made.vjass) { el.replaceChildren(head, h("div.view-empty", {}, `Not regenerated: ${made.vjass}.`)); return; }
          if (made.path !== path) { el.replaceChildren(head, h("div.view-empty", {}, `This map's script is ${made.path.slice(4)}.`)); return; }
          if (current === undefined) { el.replaceChildren(head, h("div.view-empty", {}, `${file} can't be read as text.`)); return; }
          const box = h("div.diff-view");
          // Long lines wrap, as in a diff view: cut at the pane's edge, a change past it couldn't be seen.
          const ro = [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping, lineNumbers(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }), oneDark];
          view = new MergeView({ a: { doc: current ?? "", extensions: ro }, b: { doc: made.text, extensions: ro }, parent: box, collapseUnchanged: { margin: 3, minSize: 6 }, gutter: true });
          const chunks = getChunks(view.b.state)?.chunks ?? [];
          const step = (cmd: typeof goToNextChunk) => () => { if (view) { cmd(view.b); view.b.focus(); } };
          head.append(
            h("small.muted", {}, current === made.text ? "  the same" : `  ${chunks.length} change${chunks.length === 1 ? "" : "s"}`),
            h("span.diff-actions", {},
              h("button", { title: "Previous change", onclick: step(goToPreviousChunk) }, "↑"),
              h("button", { title: "Next change", onclick: step(goToNextChunk) }, "↓"),
              h("button", { title: "Read both again", onclick: () => void render().catch((e) => w3.window.showError(String(e))) }, "Refresh"),
              current === made.text ? null : h("button.script-diff-replace", {
                title: "Write what the map's data makes over the script (a checkpoint keeps the script first)",
                onclick: () => void replaceScript(root, file).then(() => render()).catch((e) => w3.window.showError(String(e))),
              }, "Replace the script")));
          el.replaceChildren(head, box);
        };
        await render();
        return { focus: () => view?.b.focus(), dispose: () => { view?.destroy(); view = null; } };
      },
    }),
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
        rebuilt: built, ...(built ? {} : { note: "The script wasn't rebuilt: it isn't the script Studio wrote last (changed by hand or by another program, or code the triggers don't make; the user can replace it from the warning in the app), or it's in a language no extension compiles. See the Map Script output in the app. What follows is about the old script." }),
        language: lua !== null ? "lua" : "jass", lines: text.split("\n").length, ...describeProblems(text, found, triggerOfFunctions(text)),
      };
    }),
    w3.mcp.registerTool("search_script_api", async ({ filter, kind, limit }) => {
      if (typeof filter !== "string" || !filter) throw new Error("search_script_api needs a filter.");
      const env = await gameJassEnv((p) => w3.game.readText(p));
      return capped(findSymbols(jassSymbols(env, ""), filter, typeof kind === "string" ? kind : undefined), limit, 80);
    }),
    w3.workspace.onDidSave((path) => {
      // A chapter map's script is made from its campaign's object files too.
      if (!isScriptInput(path, campaignOf(w3.workspace.project()?.root)) || !w3.settings.get<boolean>("script.generateOnSave") || !w3.workspace.project()) return;
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
    { dispose: () => { clearTimeout(timer); questions.abort(); } },
  );
}
