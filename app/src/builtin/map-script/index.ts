import type { ExtensionContext, W3Api } from "../../extensions/api";
import { SCRIPT_LANGUAGES_SERVICE, type ScriptLanguage, type ScriptLanguagesService } from "../../extensions/services";
import { soundDurationMs } from "../../lib/audio/duration";
import { soundVariants } from "../../lib/audio/variants";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { StringTable } from "../../lib/formats/wts";
import { isScriptInput, KEPT_SCRIPT_WORDS, lostFunctions, SCRIPT_FILES, SCRIPT_STAMP, sameButPlacingOrder, scriptDecision, scriptHash, staleScriptReason,
  type ScriptState } from "../../lib/script/guard";
import { isNotFoundError } from "../../lib/oserror";
import { h } from "../../workbench/dom";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { changesToA, eachChangeLastFirst } from "./linediff";
import { getChunks, goToNextChunk, goToPreviousChunk, MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, lineNumbers } from "@codemirror/view";
import { capped, requireProject } from "../../lib/formats/mapdoc";
import { checkJass } from "../../lib/jass/check";
import { gameJassEnv, jassSymbols, triggerOfFunctions } from "../../lib/jass/env";
import { checkLua } from "../../lib/lua/check";
import { describeProblems, findSymbols } from "./scriptinfo";
import { destructableRule, generateScript, parseSoundLabels, scriptSoundDurations, SOUND_INFO, type ScriptInput, type SoundLabel } from "../../lib/script/jass";
import { flagsToFollow, type CreatesInput, type DestructableJson, type FollowFlags } from "../../lib/script/destructables";
import { dayNightModels } from "../../lib/script/setup";
import { ABILITY_FUNC_FILES, abilityOrders, autocastOrdersOf, buildingTypes, customColorTypes, customIdsOf, destructableTints, gameCustomColors, gameTeamColors, heroAbilities, scriptObjectFiles, specialUnits, teamColors, type AbilityOrders, type ObjectFile } from "../../lib/script/objects";
import { campaignOf, findCampaign, readCampaignObjects } from "../../lib/objects/campaign";
import { checkpointBefore } from "../../lib/checkpoint";
import { joinPath } from "../../lib/paths";
import { readImported } from "../../lib/imports";
import { withOwnCommon } from "../../lib/jass/owncommon";
import { hasBetterTriggersHelpers } from "../../lib/script/bthelpers";
import { heightAt, parseW3e } from "../../lib/terrain/w3e";
import { MELEE_MAP, type MeleeInfo } from "../../lib/terrain/owner";
import { meleeFiles, savedMelee } from "../../lib/terrain/meleesave";
import { readTerrainBytes, terrainPath } from "../../lib/terrain/w3etext";
import { parseTriggerData, type TriggerData } from "../../lib/triggers/triggerdata";
import { parseWct, parseWtg, textTriggers, type CustomTextFile, type TriggerFile } from "../../lib/triggers/wtg";
import { WCT_RAW, WTG_RAW } from "../../lib/triggers/project";

/** Hash of the script this app wrote last: a script that still has it holds nothing but what the
 *  map's triggers made, so it's replaced without looking (see lib/script/guard). */
const STAMP = SCRIPT_STAMP;

/** The tab showing how the script differs from what the map's data makes ("w3:script-diff:map/war3map.j"). */
const DIFF = "w3:script-diff:";

const INFO_JSON = "map/war3map.w3i.json";
/** Files whose save can change the Melee flag (lib/terrain/meleesave): the placed units, the map's info, its gameplay
 *  constants, and the ground (a start location under water) take it off; with the triggers and the doodads they can
 *  also put it back. The object data and the game interface (meleesave's CUSTOM_DATA, also as skin files) take it off
 *  and decide flag 0x4000 with the placed objects. Looked at after every save, whatever script.generateOnSave says and
 *  whatever the script's language. */
const MELEE_INPUT = /^map\/(war3mapMisc\.txt|war3mapSkin\.txt|war3mapUnits\.doo(\.json)?|war3map\.doo(\.json)?|war3map\.wtg|triggers\/.+|war3map\.w3i(\.json)?|war3map\.w3e(\.txt)?|war3map(Skin)?\.(w3u|w3t|w3b|w3d|w3a|w3h|w3q)(\.json)?)$/i;
const W3L_RAW = "map/war3map.w3l", W3L_JSON = "map/war3map.w3l.json";

/** The map script: JASS, or Lua for maps set to Lua (war3map.w3i scriptType 1). */
const scriptPath = (lua: boolean) => (lua ? "map/war3map.lua" : "map/war3map.j");

/** vJASS in trigger texts (libraries, scopes, structs, block comments, //! directives), or a
 *  script JassHelper compiled ("//globals from <library>:", LIBRARY_<name> constants). Such
 *  maps need a vJASS compiler: writing the triggers into war3map.j as they are breaks the map. */
const VJASS_SOURCE = /^\s*(?:(?:private|public)\s+)?(?:library|scope|struct|module|interface|textmacro|endlibrary|endscope|endstruct)\b|^(?:(?!\/\/).)*\/\*|^\s*\/\/!/m;
const VJASS_OUTPUT = /^\/\/globals from \w+:|^constant boolean LIBRARY_\w+\s*=\s*true/m;

/** Ability files with the orders that switch autocast on and off. */

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
  /** The game's item types' team colours (ItemData teamColor). */
  itemColors: Map<string, number>;
  /** The game's unit types that allow a custom team colour (lib/script/objects gameCustomColors). */
  customColors: Set<string>;
  worldEdit: Map<string, Map<string, string>>;
  /** The game's destructable types (DestructableData.slk). */
  destructables: Set<string>;
}

const DOO_JSON = "map/war3map.doo.json", DOO_RAW = "map/war3map.doo";

/** What the destructables' flag GAME_PLACED follows (flagsToFollow): the made script's rule and which types are
 *  destructables. */
interface FlagRule { rule: CreatesInput; destructable: (id: string) => boolean }

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
    source: async (held) => {
      const root = requireProject(w3).root;
      const made = await generate(true, held);
      if (w3.workspace.project()?.root !== root) throw new Error("Another project is open now.");
      if (made.path !== scriptPath(false)) throw new Error("This map's script is Lua.");
      return made.text;
    },
  };
  ctx.subscriptions.push(w3.services.provide(SCRIPT_LANGUAGES_SERVICE, languageService));

  let tables: Promise<GameTables> | null = null;
  const gameTables = () => {
    tables ??= (async () => {
      const text = (p: string) => w3.game.readText(p).catch(() => "");
      const balance = parseSlk(await text("Units\\UnitBalance.slk"));
      const orders = abilityOrders(await Promise.all(ABILITY_FUNC_FILES.map(async (f) => parseIni(await text(f)))));
      const abilityRows = parseSlk(await text("Units\\AbilityData.slk"));
      const unitUI = parseSlk(await text("Units\\unitUI.slk"));
      const itemRows = parseSlk(await text("Units\\ItemData.slk"));
      return {
        data: parseTriggerData(await w3.game.readText("UI\\TriggerData.txt")),
        buildings: new Set(balance.filter((r) => r.isbldg === "1").map((r) => r.unitBalanceID)),
        items: new Set(itemRows.map((r) => r.itemID)),
        itemColors: gameTeamColors(itemRows, "itemID"),
        abilities: new Set(abilityRows.map((r) => r.alias)),
        heroAbilities: new Set(abilityRows.filter((r) => r.hero === "1").map((r) => r.alias)),
        orders,
        unitColors: gameTeamColors(unitUI), customColors: gameCustomColors(unitUI),
        worldEdit: parseIni(await text("UI\\WorldEditData.txt")),
        soundLabels: parseSoundLabels(await Promise.all(SOUND_INFO.map((n) => text(`UI\\SoundInfo\\${n}.slk`)))),
        destructables: new Set(parseSlk(await text("Units\\DestructableData.slk")).map((r) => r.DestructableID)),
      };
    })();
    tables.catch(() => { tables = null; });
    return tables;
  };

  /** A script file the map imports (Scripts\common.j), as text; null when the map has none. One that is there but can't
   *  be read rejects: it is never taken for the game's. */
  const ownScript = async (archive: string): Promise<string | null> => {
    const bytes = await readImported(w3, archive);
    return bytes === null ? null : new TextDecoder().decode(bytes);
  };

  // Read directly rather than from the file list, which lags behind fresh saves (New Map).
  const json = async <T>(p: string): Promise<T | null> => {
    // Projects made before a format got its JSON form keep the raw file until they're re-synced.
    const text = await w3.workspace.readText(`${p}.json`).catch(() =>
      w3.backend.invoke<string>("codec_decode", { root: w3.workspace.project()?.root, path: p }).catch(() => null));
    return text === null ? null : JSON.parse(text) as T;
  };

  /** The Melee flag as the World Editor's save leaves it (lib/terrain/meleesave): set in `info`, the flags the script is
   *  made with, and written into war3map.w3i.json unless `look`. Off, or back on when Studio can tell every rule is met.
   *  Not written while Map Properties holds
   *  unsaved changes (it gets its turn when that's saved), nor into a w3i kept raw (left as it is, as the placing tools
   *  do), nor into another project than `root` (the reads take a while). */
  const followMelee = async (info: { flags?: unknown }, look: boolean, root: string | undefined, reason?: string) => {
    if (typeof info.flags !== "number" && typeof info.flags !== "string") return;
    const flags = Number(info.flags);
    if (!Number.isFinite(flags)) return;
    const placed = (await json<{ units?: { id: string; player?: number; position?: number[] }[] }>("map/war3mapUnits.doo"))?.units ?? [];
    const melee = await savedMelee(meleeFiles(w3), { ...info, flags } as MeleeInfo, placed);
    if (melee.flags === flags || w3.editors.isDirty(INFO_JSON)) return;
    info.flags = melee.flags;
    if (look) return;
    const stored = await w3.workspace.readText(INFO_JSON).catch(() => null);
    if (stored === null || w3.workspace.project()?.root !== root || w3.editors.isDirty(INFO_JSON)) return;
    // The file as it is now, with only the flag changed: a save of Map Properties during the reads stays as it was saved.
    const now = JSON.parse(stored) as { flags?: unknown };
    if (Number(now.flags) !== flags) return;
    now.flags = melee.flags;
    const canonical = await w3.backend.invoke<string>("codec_canonicalize", { root, path: INFO_JSON, text: JSON.stringify(now) });
    if (w3.workspace.project()?.root !== root) return;
    await w3.workspace.writeText(INFO_JSON, canonical);
    // Flag 0x4000 (Requires The Frozen Throne data) can change alone; only a changed Melee flag is told.
    if ((melee.flags ^ flags) & MELEE_MAP) {
      out.append(`${reason ? `${reason}: ` : ""}war3map.w3i: ${melee.flags & MELEE_MAP ? "a melee map again (it meets the World Editor's melee rules, whose save makes it one)"
        : `not a melee map any more (as the World Editor's save makes it): ${melee.reasons.join("; ")}`}`);
    }
  };

  /** Builds the map script from the project's files. `look`: only to look at (the difference, whether a fresh import's
 *  script is what the data makes): nothing is written, not even the melee flag a save turns off. `compile: false`: a
 *  map whose texts a language extension compiles (vJASS: JassHelper, seconds per run) isn't compiled; `deferred` names
 *  the language instead (a generated script is made on pack and on request then, never on a save). */
  const generate = async (look = false, held?: { triggers: TriggerFile; custom: CustomTextFile | null }, opts: { compile?: boolean } = {}): Promise<{ path: string; text: string; vjass?: string; language?: string; flags?: FlagRule; deferred?: string }> => {
    const root = w3.workspace.project()?.root;
    const bytes = (p: string) => w3.workspace.readBytes(p).catch(() => null);
    const info = await json<ScriptInput["info"]>("map/war3map.w3i");
    if (!info) throw new Error("map/war3map.w3i is missing or couldn't be read");
    const path = scriptPath(info.scriptType === 1);
    // As the World Editor does when saving, before anything else: a script that isn't made (vJASS) still has a map
    // whose flag follows.
    await followMelee(info as { flags?: unknown }, look, root);
    const g = await gameTables();

    // Either form, read directly (the file list may lag behind a fresh save): map/triggers/ in one read, else a raw
    // war3map.wtg and war3map.wct. A broken one fails the generation; only a missing one means no triggers.
    let triggers: TriggerFile | undefined, custom: CustomTextFile | null = null;
    if (held) ({ triggers, custom } = held);
    else {
      const layout = await w3.workspace.readTriggers();
      if (layout) ({ file: triggers, custom } = layout);
      else {
        const wtg = await bytes(WTG_RAW);
        triggers = wtg ? parseWtg(wtg, g.data) : undefined;
        const wct = triggers ? await bytes(WCT_RAW) : null;
        custom = triggers && wct ? parseWct(wct, textTriggers(triggers).length) : null;
      }
    }
    // A language extension compiles maps written in it (JASS maps only); vJASS without one isn't
    // regenerated (the uncompiled text would break the map).
    const textList = [custom?.header ?? "", ...(custom?.texts ?? []).map((t) => t ?? "")];
    const texts = textList.join("\n");
    const current = await w3.workspace.readText(path).catch(() => "");
    // `held`: the script before any language compiles it (ScriptLanguagesService.source).
    const language = info.scriptType === 1 || held ? undefined : languages.find((l) => l.detect({ texts: textList, script: current }));
    // Lua maps have no vJASS: their texts are Lua (FOE's has lines that read as vJASS, e.g. "module" tables).
    if (!language && !held && info.scriptType !== 1 && (VJASS_SOURCE.test(texts) || VJASS_OUTPUT.test(current))) {
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
    const itemColors = teamColors(objectFiles.w3t, g.itemColors, "itco");
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
      info, data: g.data, triggers, custom, kindOf, autocastOrders: autocastOrdersOf(g.orders, objectFiles.w3a), heroAbility, customAbility: (id) => !g.abilities.has(id), destructableTint, teamColor: (id) => colors.get(id), itemColor: (id) => itemColors.get(id), goldMine: (id) => special.goldMines.has(id), waygate: (id) => special.waygates.has(id),
      customColor: customColorTypes(unitFiles, g.customColors),
      lights,
      groundHeight: terrain ? (x, y) => heightAt(terrain, x, y) : undefined,
      units: (await json<{ units: ScriptInput["units"] }>("map/war3mapUnits.doo"))?.units,
      doodads: (await json<{ doodads: ScriptInput["doodads"] }>("map/war3map.doo"))?.doodads,
      regions: (await json<{ regions: ScriptInput["regions"] }>("map/war3map.w3r"))?.regions,
      cameras: (await json<{ cameras: ScriptInput["cameras"] }>("map/war3map.w3c"))?.cameras,
      sounds, soundDuration, soundLabel: (l) => g.soundLabels.get(l), string: (v) => wts?.resolve(v) ?? v,
      // Helpers of a third-party trigger editor a Lua map's script has stay in it (lib/script/bthelpers).
      betterTriggers: info.scriptType === 1 && hasBetterTriggersHelpers(current),
    });
    // The destructables' GAME_PLACED flag follows this script, as the World Editor's save sets it (followFlags).
    const customDestructables = customIdsOf(objectFiles.w3b);
    const flags: FlagRule = { rule: destructableRule({ info, triggers, custom }), destructable: (id) => g.destructables.has(id) || customDestructables.has(id) };
    if (!language) return { path, text: script, flags };
    if (opts.compile === false) return { path, text: "", deferred: language.title, flags };
    // The language's compiler gets the script as the World Editor hands it to JassHelper, with the map's own common.j
    // declarations (an imported Scripts\common.j: the game reads the map's files first) added to the game's.
    const [gameCommon, blizzardJ, ownCommon] = await Promise.all([w3.game.readText("Scripts\\common.j"), w3.game.readText("Scripts\\Blizzard.j"), ownScript("Scripts\\common.j")]);
    const commonJ = ownCommon === null ? gameCommon : withOwnCommon(gameCommon, ownCommon);
    return { path, text: await language.compile({ script, commonJ, blizzardJ }), language: language.title, flags };
  };

  /** Sound lengths in ms, by file and sound name: imported files (a chapter map's, else its campaign's, as the game
   *  finds them), the game's, else what the current script says (scriptSoundDurations: per sound, so sounds of one
   *  unreadable file each keep their own). `campaign`: a chapter map's campaign project. */
  const soundDurations = async (soundFiles: string[], path: string, campaign?: string): Promise<(file: string, name: string) => number | undefined> => {
    const measured = new Map<string, number>();
    const script = await w3.workspace.readText(path).catch(() => null);
    const old = scriptSoundDurations(script ?? "");
    /** The first of `variants` that `read` finds. */
    const first = async (variants: string[], read: (v: string) => Promise<Uint8Array | null>): Promise<Uint8Array | null> => {
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
      // The map's own under its name on disk, whatever the case the sound names (as the game finds it).
      const buf = await first(variants, (v) => readImported(w3, v))
        ?? (campaign === undefined ? null : await first(variants, (v) => w3.workspace.readBytes(joinPath(campaign, rel(v)))))
        ?? await first(variants, (v) => w3.game.read(v));
      const ms = buf ? soundDurationMs(buf) : null;
      if (ms !== null) measured.set(f, ms);
    }
    return (file, name) => measured.get(file) ?? old(file, name);
  };

  /** Sets GAME_PLACED on the destructables of war3map.doo as the World Editor's save does for the script made with
   *  `f`: on where the script doesn't create one, off where it does (flagsToFollow). The open terrain editor of the
   *  project takes it on its own objects, so its undo history stays (and saves them unless it has unsaved edits, whose
   *  save takes them along); else the file is written, only if it changed and nobody wrote it meanwhile. A war3map.doo
   *  that can't be read is left as it is (said in the output). False: another project is open now. */
  const followFlags = async (f: FlagRule, root: string | undefined, reason: string): Promise<boolean> => {
    const follow: FollowFlags = (doodads) => flagsToFollow(f.rule, doodads, f.destructable);
    // The rule is this project's: another project's terrain editor must never take it.
    if (!root || w3.workspace.project()?.root !== root) return false;
    const held = await w3.commands.execute<boolean>("w3.terrain.followDestructableFlags", follow, root).catch(() => false);
    if (w3.workspace.project()?.root !== root) return false;
    if (held === true) return true;
    /** The file's text and whether it's the JSON form; null when there is none. */
    const read = async (): Promise<{ text: string; json: boolean } | null> => {
      try { return { text: await w3.workspace.readText(DOO_JSON), json: true }; } catch (e) { if (!isNotFoundError(e)) throw e; }
      try { await w3.workspace.readBytes(DOO_RAW); } catch (e) { if (isNotFoundError(e)) return null; throw e; }
      return { text: await w3.backend.invoke<string>("codec_decode", { root, path: DOO_RAW }), json: false };
    };
    try {
      const was = await read();
      if (!was || w3.workspace.project()?.root !== root) return w3.workspace.project()?.root === root;
      const doc = JSON.parse(was.text) as { doodads?: DestructableJson[] };
      const changes = Array.isArray(doc.doodads) ? follow(doc.doodads) : [];
      if (!changes.length) return true;
      for (const c of changes) doc.doodads![c.index].flags = c.flags;
      const text = JSON.stringify(doc);
      const canonical = was.json ? await w3.backend.invoke<string>("codec_canonicalize", { root, path: DOO_JSON, text }) : text;
      // Written meanwhile (a tool, an editor that opened): that write starts another run, which follows it.
      const now = await read();
      if (w3.workspace.project()?.root !== root) return false;
      if (now?.text !== was.text || now.json !== was.json) { out.append(`${reason}: war3map.doo was written meanwhile, its destructables' flags are looked at again after that save`); return true; }
      if (was.json) await w3.workspace.writeText(DOO_JSON, canonical);
      else await w3.backend.invoke("codec_write", { root, path: DOO_RAW, text });
      out.append(`${reason}: war3map.doo: ${changes.length} destructable${changes.length === 1 ? "'s" : "s'"} flag "placed by the game" set to follow the script (as the World Editor's save sets it)`);
    } catch (e) {
      out.append(`${reason}: war3map.doo: its destructables' flags weren't set to follow the script: ${e instanceof Error ? e.message : String(e)}`);
    }
    return w3.workspace.project()?.root === root;
  };

  /** How the project's map script is kept (the backend's script_state, crates/backend/src/script.rs): null when it can't
   *  be told (no project, a backend without the command), taken as a tracked script. */
  const scriptState = (root: string | undefined): Promise<ScriptState | null> =>
    (root ? w3.backend.invoke<ScriptState>("script_state", { root }).catch(() => null) : Promise.resolve(null));

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
   *  wrote last. `onlyFor`: only in that project (else nothing is written). `compile: false`: a generated script whose
   *  texts a language extension compiles (vJASS) isn't made now (a save never waits for JassHelper); it stays stale.
   *  A generated script (map/triggers/triggers.json "script": "generated", kept in .w3proj/derived/) is always the one
   *  the data makes, and what it was made from is recorded (`w3proj pack` checks that record). */
  const write = (reason: string, force = false, onlyFor?: string, opts: { compile?: boolean } = {}): Promise<boolean> => {
    // The queue goes on after a failed run (the caller of that run has its error).
    running = running.catch(() => true).then(async () => {
      try {
        const root = w3.workspace.project()?.root;
        if (onlyFor !== undefined && root !== onlyFor) { out.append(`${reason}: not written: another project is open now`); return false; }
        const generated = (await scriptState(root))?.mode === "generated";
        // Taken before the generator reads anything: a file saved meanwhile shows as changed in the record.
        const sources = generated && root ? await w3.backend.invoke<Record<string, string>>("script_sources", { root }) : null;
        const { path, text, vjass, language, flags, deferred } = await generate(false, undefined, { compile: !generated || opts.compile !== false });
        const file = path.slice(4);
        // Generating can take a while: this script must not land in another project.
        if (w3.workspace.project()?.root !== root) { out.append(`${reason}: ${file} not written: the project was changed meanwhile`); return false; }
        if (deferred) {
          out.append(`${reason}: ${file} not made now: its triggers are compiled with ${deferred}, which runs on pack and on Regenerate Map Script…, never on a save; until then the generated script doesn't follow the triggers`);
          return false;
        }
        /** The record of what the generated script was made from (nothing for a kept one). Not recorded: `w3proj pack`
         *  takes it for outdated, said here. */
        const record = async () => {
          if (!generated || !sources || !root || w3.workspace.project()?.root !== root) return;
          await w3.backend.invoke("script_record", { root, sources }).catch((e) => out.append(`${reason}: what ${file} was made from wasn't recorded (${e instanceof Error ? e.message : String(e)}): \`w3proj pack\` takes it for outdated`));
        };
        /** A generated script of the other language left in the store (the map's language changed): it goes, so the map
         *  gets one script. */
        const dropOther = async () => {
          const other = scriptPath(path === scriptPath(false));
          if (generated && w3.workspace.files().some((f) => f.path.toLowerCase() === other)) await w3.workspace.delete(other);
        };
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
        // A generated script is a build artifact out of git: nothing in it is anybody's but the generator's.
        const decision = scriptDecision(current, text, stamp, force || generated);
        // The script this map runs is this one (written now or already there): the destructables' flags follow it first,
        // so the game places each one once, from war3map.doo or from the script. A kept script is left with them as they are.
        if (decision.action !== "keep" && flags) {
          if (!(await followFlags(flags, root, reason))) { out.append(`${reason}: ${file} not written: the project was changed meanwhile`); return false; }
        }
        if (decision.action === "same") {
          // The data makes this very script (a fresh import, a script put back): it's this app's from now on.
          if (stamp?.trim() !== scriptHash(text)) await w3.workspace.writeText(STAMP, `${scriptHash(text)}
`);
          await dropOther();
          await record();
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
        // Forced over a script that would have been kept: said, naming the file and what of it is gone.
        const before = force && !generated && current !== null ? scriptDecision(current, text, stamp) : null;
        await w3.workspace.writeText(path, text);
        await w3.workspace.writeText(STAMP, `${scriptHash(text)}
`);
        await dropOther();
        await record();
        const how = `${text.length} chars${language ? `, compiled with ${language}` : ""}${generated ? ", generated: in .w3proj/derived/, out of git" : ""}`;
        if (before?.action === "keep") {
          const n = before.lost.length;
          const lost = n ? `; its ${n} function${n === 1 ? "" : "s"} the triggers don't make (${before.lost.slice(0, 5).join(", ")}${n > 5 ? ", …" : ""}) ${n === 1 ? "is" : "are"} gone` : "";
          out.append(`${reason}: ${file} written (${how}), replacing a ${file} that wasn't the script Studio wrote last${lost}`);
        } else {
          out.append(`${reason}: ${file} written (${how})`);
        }
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
  // A generated vJASS script isn't compiled on a save (`compile: false`): JassHelper takes seconds; pack and Regenerate
  // Map Script… make it.
  const afterSave = (path: string) => write(`saved ${path}`, false, undefined, { compile: false }).catch((e) => {
    // Nobody is watching a save's script run, and saving goes on working: say so once.
    const key = `failed:${w3.workspace.project()?.root ?? ""}`;
    if (warned.has(key)) return;
    warned.add(key);
    void w3.window.showWarning(`The map script couldn't be regenerated, so saved changes don't reach it: ${e instanceof Error ? e.message : String(e)}`);
  });
  /** With script.generateOnSave off: only the Melee flag follows the save, in the same queue as the script's runs. */
  const meleeOnly = (path: string): Promise<boolean> => {
    running = running.catch(() => true).then(async () => {
      const root = w3.workspace.project()?.root;
      try {
        const info = root ? await json<{ flags?: unknown }>("map/war3map.w3i") : null;
        if (info && w3.workspace.project()?.root === root) await followMelee(info, false, root, `saved ${path}`);
      } catch (e) {
        out.append(`saved ${path}: the Melee flag wasn't looked at: ${e instanceof Error ? e.message : String(e)}`);
      }
      return true;
    });
    return running;
  };
  /** What a save is due: the script (with the flag), or only the flag. */
  const due = (path: string) => (w3.settings.get<boolean>("script.generateOnSave") ? afterSave(path) : meleeOnly(path));

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
    if (project) void adopt("opened").then(() => refreshChapter(project.root)).then(() => refreshGenerated(project.root));
  };
  /** A generated script that doesn't follow its sources when the project opens (a fresh clone has none, a pull changed
   *  the triggers) is made again, as a save would (vJASS isn't compiled: on pack and on request). Nothing for a kept
   *  script; with script.generateOnSave off, nothing either. */
  const refreshGenerated = async (root: string) => {
    try {
      if (!w3.settings.get<boolean>("script.generateOnSave") || w3.workspace.project()?.root !== root) return;
      const state = await scriptState(root);
      const why = staleScriptReason(state);
      if (!why || w3.workspace.project()?.root !== root) return;
      await write(`opened (${why})`, false, root, { compile: false });
    } catch (e) {
      out.append(`opened: the generated map script wasn't made again: ${e instanceof Error ? e.message : String(e)}`);
    }
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
          // The merge view's own diff works on characters and gives up on a big script (one change for the whole file).
          // So it starts with the same text on both sides and the script is typed into the left one as line hunks,
          // each of which it diffs inside; the unchanged lines are folded once the chunks are known.
          view = new MergeView({ a: { doc: made.text, extensions: ro }, b: { doc: made.text, extensions: ro }, parent: box, gutter: true });
          const edits = changesToA(current ?? "", made.text);
          // One transaction per hunk: many in one are merged by the merge view into a single chunk.
          const typed = view;
          eachChangeLastFirst(edits, (c) => typed.a.dispatch({ changes: c }));
          view.reconfigure({ collapseUnchanged: { margin: 3, minSize: 6 } });
          const chunks = getChunks(view.b.state)?.chunks ?? [];
          const step = (cmd: typeof goToNextChunk) => () => { if (view) { cmd(view.b); view.b.focus(); } };
          const onlyEndings = current !== made.text && !chunks.length;
          head.append(
            h("small.muted", {}, current === made.text ? "  the same" : onlyEndings ? "  only line endings differ" : `  ${chunks.length} change${chunks.length === 1 ? "" : "s"}`),
            h("span.diff-actions", {},
              h("button", { title: "Previous change", onclick: step(goToPreviousChunk) }, "↑"),
              h("button", { title: "Next change", onclick: step(goToNextChunk) }, "↓"),
              h("button", { title: "Read both again", onclick: () => void render().catch((e) => w3.window.showError(String(e))) }, "Refresh"),
              current === made.text ? null : h("button.script-diff-replace", {
                title: "Write what the map's data makes over the script (a checkpoint keeps the script first)",
                onclick: () => void replaceScript(root, file).then(() => render()).catch((e) => w3.window.showError(String(e))),
              }, onlyEndings ? "Replace the script (line endings)" : "Replace the script")));
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
      // Gameplay constants don't make the script, but saving them can take the Melee flag off, which generate does;
      // with generateOnSave off only the flag is looked at (meleeAfterSave).
      const melee = MELEE_INPUT.test(path);
      const input = isScriptInput(path, campaignOf(w3.workspace.project()?.root)) || melee;
      if (!input || !w3.workspace.project() || (!melee && !w3.settings.get<boolean>("script.generateOnSave"))) return;
      clearTimeout(timer);
      pending = path;
      timer = setTimeout(() => { pending = null; void due(path); }, 800);
    }),
    // What packs the map first waits here: a script still due from the last save belongs in it.
    w3.commands.register("w3.script.settle", async () => {
      clearTimeout(timer);
      const path = pending;
      pending = null;
      if (path) await due(path);
      await running.catch(() => true);
    }),
    // Packing, once everything is saved and the script settled: the destructables' flags follow the script on disk again,
    // when it is the one the map's data makes (an editor that held them with unsaved edits may have had those undone
    // since, leaving the file behind the script). Nothing is written otherwise.
    w3.commands.register("w3.script.followFlags", () => {
      running = running.catch(() => true).then(async () => {
        const root = w3.workspace.project()?.root;
        if (!root) return true;
        try {
          const made = await generate(true);
          if (made.vjass || !made.flags || w3.workspace.project()?.root !== root) return true;
          const current = await readScript(made.path);
          if (typeof current !== "string" || current !== made.text) return true;
          await followFlags(made.flags, root, "packing");
        } catch (e) {
          out.append(`packing: the destructables' flags weren't looked at: ${e instanceof Error ? e.message : String(e)}`);
        }
        return true;
      });
      return running.then(() => {}, () => {});
    }),
    // `quiet` (other extensions, e.g. New Map): no message afterwards. `force` (`w3proj rebuild --force`): also over a
    // script that isn't the one this app wrote last (said in the output, naming the file).
    w3.commands.register("w3.script.generate", async (opts?: { quiet?: boolean; force?: boolean }) => {
      const written = await write("command", opts?.force === true);
      if (written && !opts?.quiet) w3.window.showInfo("Map script generated (see the Map Script output).");
    }),
    // Regenerate Map Script…: a generated script made again now, vJASS compiled too. A kept one (a tracked map/war3map.j,
    // the World Editor's or with code no trigger makes) is switched to generated only after saying which of its
    // functions the generator doesn't make (lostFunctions, JassHelper's run-to-run naming aside) and the user agreeing;
    // a checkpoint keeps it first. `yes`: agreed already (MCP, tests). What happened: the mode, the lost functions,
    // whether the script was written; null when the user said no.
    w3.commands.register("w3.script.regenerate", async (opts?: { yes?: boolean }) => {
      const root = requireProject(w3).root;
      const state = await scriptState(root);
      if (state?.mode === "generated") {
        const written = await write("Regenerate Map Script", true, root, { compile: true });
        if (written) void w3.window.showInfo("Map script generated (see the Map Script output).");
        return { mode: "generated", lost: [], written };
      }
      if (state?.mode !== "kept") {
        throw new Error("This project's triggers aren't in map/triggers/ (they are kept raw, or the map has none), so its map script stays a tracked file: Generate Map Script replaces it in place.");
      }
      const made = await generate(true);
      if (w3.workspace.project()?.root !== root) throw new Error("Another project is open now.");
      const file = made.path.slice(4);
      if (made.vjass) throw new Error(`${file} can't be generated: ${made.vjass}, and no script language extension compiles it (vJASS: enable "vJASS (JassHelper)").`);
      const current = await readScript(made.path);
      if (current === undefined) throw new Error(`${file} can't be read as text: delete it or make it readable first.`);
      const lost = current === null ? [] : lostFunctions(current, made.text);
      const what = lost.length
        ? `${file} has ${lost.length} function${lost.length === 1 ? "" : "s"} the map's triggers don't make (${lost.slice(0, 5).join(", ")}${lost.length > 5 ? ", …" : ""}): a generated script doesn't have ${lost.length === 1 ? "it" : "them"}.`
        : `The generator makes every function of ${file}${current === null ? " (there is none yet)" : ""}.`;
      out.append(`Regenerate Map Script: ${what}${lost.length > 5 ? ` All of them: ${lost.join(", ")}` : ""}`);
      const choice = opts?.yes ? "Switch to a Generated Script" : await w3.window.showWarning(
        `${what} Switching makes the map script a build artifact: generated from the triggers and the map's data into .w3proj/derived/, out of git, and made again on saves; map/${file} is no longer tracked (a checkpoint keeps it).`,
        "Switch to a Generated Script", "Show Difference", "Cancel");
      if (choice === "Show Difference") { await showDifference(made.path); return null; }
      if (choice !== "Switch to a Generated Script") return null;
      if (w3.workspace.project()?.root !== root) throw new Error("Another project is open now.");
      if (current !== null && !(await checkpointBefore(w3, `Switch ${file} to a generated script`))) return null;
      await w3.backend.invoke("script_set_mode", { root, mode: "generated" });
      await w3.workspace.refresh();
      out.append(`Regenerate Map Script: map/triggers/triggers.json says "script": "generated"; ${file} moved into .w3proj/derived/`);
      const written = await write("Regenerate Map Script", true, root, { compile: true });
      if (written) void w3.window.showInfo(`${file} is generated now (see the Map Script output).`);
      return { mode: "generated", lost, written };
    }),
    // Packing: a generated script that doesn't follow its sources (a vJASS one isn't made on saves, a fresh clone has
    // none) is made now, compiled. Packing checks afterwards whether it follows (map-project).
    w3.commands.register("w3.script.forPack", async () => {
      const root = w3.workspace.project()?.root;
      if (!root || !staleScriptReason(await scriptState(root))) return;
      await write("packing", false, root, { compile: true }).catch(() => false);
    }),
    // Export Script: the map script as it stands (a script still due from the last save is written first) copied byte for
    // byte to a file the person picks. A map with a Lua script exports that; a missing script isn't an empty one.
    w3.commands.register("w3.script.export", async () => {
      if (!w3.workspace.project()) throw new Error("Open or import a project first.");
      await w3.commands.execute("w3.script.settle");
      const found = await exportableScript((p) => w3.workspace.readBytes(p));
      if (!found) throw new Error("The map has no script yet: generate it first (Generate Map Script).");
      const ext = found.path.endsWith(".lua") ? "lua" : "j";
      const target = await w3.window.pickSaveFile({ title: "Export Script", defaultPath: found.path.slice(4), filters: [{ name: ext === "lua" ? "Lua script" : "JASS script", extensions: [ext] }] });
      if (!target) return null;
      await w3.backend.writeBytes(target, found.bytes);
      void w3.window.showInfo(`Exported ${found.path.slice(4)} to ${target}`);
      return target;
    }),
    { dispose: () => { clearTimeout(timer); questions.abort(); } },
  );
}

/** The script Export Script writes: war3map.lua when the project has one, else war3map.j; null when neither is there.
 *  A file that is there but can't be read is an error, not "no script". */
export async function exportableScript(readBytes: (path: string) => Promise<Uint8Array>): Promise<{ path: string; bytes: Uint8Array } | null> {
  for (const path of [scriptPath(true), scriptPath(false)]) {
    try { return { path, bytes: await readBytes(path) }; } catch (e) { if (!isNotFoundError(e)) throw e; }
  }
  return null;
}
