import type { ExtensionContext, W3Api } from "../../extensions/api";
import { soundDurationMs } from "../../lib/audio/duration";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { StringTable } from "../../lib/formats/wts";
import { generateScript, parseSoundLabels, type ScriptInput, type SoundLabel } from "../../lib/script/jass";
import { heightAt, parseW3e } from "../../lib/terrain/w3e";
import { parseTriggerData, type TriggerData } from "../../lib/triggers/triggerdata";
import { parseWct, parseWtg, textTriggers } from "../../lib/triggers/wtg";

/** The map script: JASS, or Lua for maps set to Lua (war3map.w3i scriptType 1). */
const scriptPath = (lua: boolean) => (lua ? "map/war3map.lua" : "map/war3map.j");

/** Files war3map.j is made from (also as their .json documents). */
const INPUTS = /^map\/(war3map\.(wtg|wct|wts|w3i|w3r|w3c|w3s|doo|w3e|w3u|w3t|w3a)|war3mapUnits\.doo|war3mapSkin\.w3u)(\.json)?$/i;

/** vJASS in trigger texts (libraries, scopes, structs, block comments, //! directives), or a
 *  script JassHelper compiled ("//globals from <library>:", LIBRARY_<name> constants). Such
 *  maps need a vJASS compiler: writing the triggers into war3map.j as they are breaks the map. */
const VJASS_SOURCE = /^\s*(?:(?:private|public)\s+)?(?:library|scope|struct|module|interface|textmacro|endlibrary|endscope|endstruct)\b|\/\*|^\s*\/\/!/m;
const VJASS_OUTPUT = /^\/\/globals from \w+:|^constant boolean LIBRARY_\w+\s*=\s*true/m;

/** Ability files with the orders that switch autocast on and off. */
const ABILITY_FUNC = ["Campaign", "Common", "Human", "Item", "Neutral", "NightElf", "Orc", "Undead"].map((r) => `Units\\${r}AbilityFunc.txt`);

/** UI\SoundInfo tables with the sound labels' settings, in the order the first match wins. */
const SOUND_INFO = ["AbilitySounds", "AmbienceSounds", "AmbientMusic", "AnimSounds", "CinematicSounds", "DialogSounds", "DialogueCreepsBase",
  "DialogueDemonBase", "DialogueHumanBase", "DialogueNagaBase", "DialogueNightElfBase", "DialogueOrcBase", "DialogueUndeadBase", "EAXDefs",
  "EnvironmentSounds", "Music", "PortraitAnims", "SoundAssetCombat", "UISounds", "UnitAckSounds", "UnitCombatSounds"];

interface GameTables {
  data: TriggerData;
  soundLabels: Map<string, SoundLabel>;
  buildings: Set<string>;
  items: Set<string>;
  abilities: Set<string>;
  orders: Map<string, { on: string; off: string }>;
  worldEdit: Map<string, Map<string, string>>;
}

export function activate(w3: W3Api, ctx: ExtensionContext) {
  const out = w3.output.channel("Map Script");

  let tables: Promise<GameTables> | null = null;
  const gameTables = () => {
    tables ??= (async () => {
      const text = (p: string) => w3.game.readText(p).catch(() => "");
      const balance = parseSlk(await text("Units\\UnitBalance.slk"));
      const orders = new Map<string, { on: string; off: string }>();
      for (const f of ABILITY_FUNC) {
        for (const [id, sec] of parseIni(await text(f))) {
          const on = sec.get("orderon"), off = sec.get("orderoff");
          if (on && off && !orders.has(id)) orders.set(id, { on, off });
        }
      }
      return {
        data: parseTriggerData(await w3.game.readText("UI\\TriggerData.txt")),
        buildings: new Set(balance.filter((r) => r.isbldg === "1").map((r) => r.unitBalanceID)),
        items: new Set(parseSlk(await text("Units\\ItemData.slk")).map((r) => r.itemID)),
        abilities: new Set(parseSlk(await text("Units\\AbilityData.slk")).map((r) => r.alias)),
        orders,
        worldEdit: parseIni(await text("UI\\WorldEditData.txt")),
        soundLabels: parseSoundLabels(await Promise.all(SOUND_INFO.map((n) => text(`UI\\SoundInfo\\${n}.slk`)))),
      };
    })();
    tables.catch(() => { tables = null; });
    return tables;
  };

  /** Builds the map script from the project's files. */
  const generate = async (): Promise<{ path: string; text: string; vjass?: string }> => {
    // Read directly rather than from the file list, which lags behind fresh saves (New Map).
    const json = async <T>(p: string): Promise<T | null> => {
      const text = await w3.workspace.readText(`${p}.json`).catch(() => null);
      return text === null ? null : JSON.parse(text) as T;
    };
    const bytes = (p: string) => w3.workspace.readBytes(p).catch(() => null);
    const info = await json<ScriptInput["info"]>("map/war3map.w3i");
    if (!info) throw new Error("map/war3map.w3i.json is missing");
    const path = scriptPath(info.scriptType === 1);
    const g = await gameTables();

    const wtg = await bytes("map/war3map.wtg"), wct = await bytes("map/war3map.wct");
    const triggers = wtg ? parseWtg(wtg, g.data) : undefined;
    const custom = triggers && wct ? parseWct(wct, textTriggers(triggers).length) : null;
    // vJASS maps aren't regenerated (no vJASS compiler yet).
    const texts = [custom?.header ?? "", ...(custom?.texts ?? []).map((t) => t ?? "")].join("\n");
    const current = await w3.workspace.readText(path).catch(() => "");
    if (VJASS_SOURCE.test(texts) || VJASS_OUTPUT.test(current)) {
      return { path, text: "", vjass: VJASS_OUTPUT.test(current) ? "its script was compiled from vJASS" : "its triggers contain vJASS" };
    }
    const wtsText = await w3.workspace.readText("map/war3map.wts").catch(() => null);
    const wts = wtsText === null ? null : new StringTable(wtsText);
    const w3e = await bytes("map/war3map.w3e");
    const terrain = w3e ? parseW3e(w3e) : null;

    // Custom objects: their base decides, unless the map sets "is a building" (ubdg).
    type Objects = { custom?: { id: string; base: string; mods?: { field: string; value: unknown }[] }[] };
    const customUnits = new Map<string, { base: string; bldg?: boolean }>();
    for (const f of ["map/war3map.w3u", "map/war3mapSkin.w3u"]) {
      for (const o of (await json<Objects>(f))?.custom ?? []) {
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

    return { path, text: generateScript({
      info, data: g.data, triggers, custom, kindOf, autocastOrders: (a) => g.orders.get(a),
      lights: { terrain: light("TerrainLights", "Terrain"), unit: light("UnitLights", "Unit") },
      groundHeight: terrain ? (x, y) => heightAt(terrain, x, y) : undefined,
      units: (await json<{ units: ScriptInput["units"] }>("map/war3mapUnits.doo"))?.units,
      doodads: (await json<{ doodads: ScriptInput["doodads"] }>("map/war3map.doo"))?.doodads,
      regions: (await json<{ regions: ScriptInput["regions"] }>("map/war3map.w3r"))?.regions,
      cameras: (await json<{ cameras: ScriptInput["cameras"] }>("map/war3map.w3c"))?.cameras,
      sounds, soundDuration: (f) => durations.get(f), soundLabel: (l) => g.soundLabels.get(l), string: (v) => wts?.resolve(v) ?? v,
    }) };
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

  let running: Promise<void> = Promise.resolve();
  /** Projects already told that their vJASS script isn't regenerated. */
  const warned = new Set<string>();
  const write = (reason: string) => {
    running = running.then(async () => {
      try {
        const { path, text, vjass } = await generate();
        const file = path.slice(4);
        if (vjass) {
          out.append(`${reason}: ${file} not written: ${vjass}, which needs a vJASS compiler (JassHelper); the script stays as it is.`);
          const root = w3.workspace.project()?.root ?? "";
          if (!warned.has(root)) {
            warned.add(root);
            void w3.window.showWarning(`This map uses vJASS (${vjass}), so ${file} isn't regenerated from the triggers: changed triggers don't reach the map script. ` +
              "Compile it in the World Editor (JassHelper) for now.");
          }
          return;
        }
        const current = await w3.workspace.readText(path).catch(() => null);
        if (current === text) { out.append(`${reason}: ${file} up to date`); return; }
        await w3.workspace.writeText(path, text);
        out.append(`${reason}: ${file} written (${text.length} chars)`);
      } catch (e) {
        out.append(`${reason}: map script not written: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    });
    return running;
  };

  // Saves come in bursts (a map save writes several files): wait for the last one.
  let timer: ReturnType<typeof setTimeout> | undefined;
  ctx.subscriptions.push(
    w3.workspace.onDidSave((path) => {
      if (!INPUTS.test(path) || !w3.settings.get<boolean>("script.generateOnSave") || !w3.workspace.project()) return;
      clearTimeout(timer);
      timer = setTimeout(() => void write(`saved ${path}`).catch(() => {}), 800);
    }),
    w3.commands.register("w3.script.generate", async () => {
      await write("command");
      w3.window.showInfo("Map script generated (see the Map Script output).");
    }),
    { dispose: () => clearTimeout(timer) },
  );
}
