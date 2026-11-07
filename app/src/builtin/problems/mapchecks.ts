// More checks of the Problems view: what GUI triggers refer to, sound files, the terrain's tiles,
// and the art named by Map Properties and the Game Interface.

import type { W3Api } from "../../extensions/api";
import type { Problem, ProblemCheck } from "../../extensions/services";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { ident, placedName, type PlacedJson } from "../../lib/script/jass";
import { parseW3e } from "../../lib/terrain/w3e";
import { readTerrainBytes, terrainPath } from "../../lib/terrain/w3etext";
import { missingRefs, triggerRefs } from "../../lib/triggers/refs";
import { parseTriggerData } from "../../lib/triggers/triggerdata";
import { readWtgFile, wtgPath } from "../../lib/triggers/wtg";
import type { FileKind } from "./lookup";
import { RunScope } from "./runscope";

const WHAT: Record<string, string> = { rct: "region", cam: "camera", snd: "sound", trg: "trigger", unit: "placed unit", item: "placed item", dest: "placed destructable", doodad: "placed doodad" };

/** The map's generated globals. */
async function mapGlobals(s: RunScope, triggers: string[]): Promise<Set<string>> {
  const names = new Set(triggers.map((t) => `gg_trg_${ident(t)}`));
  await s.prefetch(["map/war3map.w3r.json", "map/war3map.w3c.json", "map/war3map.w3s.json", "map/war3mapUnits.doo.json", "map/war3map.doo.json"]);
  for (const r of (await s.doc<{ regions: { name: string }[] }>("map/war3map.w3r.json"))?.regions ?? []) names.add(`gg_rct_${ident(r.name)}`);
  for (const c of (await s.doc<{ cameras: { name: string }[] }>("map/war3map.w3c.json"))?.cameras ?? []) names.add(`gg_cam_${ident(c.name)}`);
  for (const snd of (await s.doc<{ sounds: { name: string }[] }>("map/war3map.w3s.json"))?.sounds ?? []) names.add(snd.name);
  const units = (await s.doc<{ units: PlacedJson[] }>("map/war3mapUnits.doo.json"))?.units ?? [];
  const doodads = (await s.doc<{ doodads: PlacedJson[] }>("map/war3map.doo.json"))?.doodads ?? [];
  for (const p of units) { names.add(placedName(p, "unit")); names.add(placedName(p, "item")); }
  for (const p of doodads) { names.add(placedName(p, "dest")); names.add(placedName(p, "doodad")); }
  return names;
}

/** `scope`: what the checks of the current run share (see builtinChecks). */
export function mapChecks(w3: W3Api, scope: () => RunScope = () => new RunScope(w3, false)): ProblemCheck[] {
  return [
    {
      id: "triggerRefs",
      title: "References in triggers",
      async run() {
        const path = wtgPath(w3.workspace.files());
        if (!path) return [];
        const file = await readWtgFile(w3.workspace, path, async () => parseTriggerData(await w3.game.readText("UI\\TriggerData.txt"))).catch(() => null);
        if (!file) return [];
        const items = file.items.filter((i) => "ecas" in i && i.type !== 16);
        const triggers = items.map((i) => i.name);
        // A disabled trigger isn't in the script: nothing breaks, it's just out of date.
        const live = new Set(items.filter((i) => "ecas" in i && i.enabled).map((i) => i.name));
        const missing = missingRefs(triggerRefs(file), await mapGlobals(scope(), triggers), file.variables);
        return missing.map(({ ref, triggers: users }): Problem => {
          const gg = /^gg_([a-z]+)_(.*)$/.exec(ref);
          const what = gg ? `${WHAT[gg[1]] ?? "object"} ${gg[2]}` : `variable ${ref.slice(4)}`;
          const running = users.some((u) => live.has(u));
          return { severity: running ? "error" : "warning", message: `${what} doesn't exist in this map${running ? "" : " (disabled trigger)"}`, location: users.length > 1 ? `${users[0]} and ${users.length - 1} more` : users[0],
            reveal: { command: "w3.triggers.reveal", args: [users[0]] } };
        });
      },
    },
    {
      id: "soundFiles",
      title: "Sound files",
      async run() {
        const shared = scope(), files = shared.lookup();
        const out: Problem[] = [];
        const sounds = (await shared.doc<{ sounds: { name: string; file: string }[] }>("map/war3map.w3s.json"))?.sounds ?? [];
        // The game takes a sound under its other extensions too.
        const names = (file: string) => { const stem = file.replace(/\.\w+$/, ""); return [file.slice(stem.length), ".flac", ".ogg", ".mp3", ".wav"].map((ext) => `${stem}${ext}`); };
        await files.prefetch(sounds.filter((s) => s.file).flatMap((s) => names(s.file).map((n): [string, "file"] => [n, "file"])));
        for (const s of sounds) {
          if (!s.file) continue;
          let found = false;
          for (const name of names(s.file)) {
            if (await files.exists(name, "file")) { found = true; break; }
          }
          if (!found) out.push({ severity: "warning", message: `${s.file} not found (neither in the map nor in the game)`, location: s.name.replace(/^gg_snd_/, ""), reveal: { command: "w3.sounds.open" } });
        }
        return out;
      },
    },
    {
      id: "terrainTiles",
      title: "Terrain tiles",
      async run() {
        const path = terrainPath(w3.workspace.files().map((f) => f.path));
        if (!path) return [];
        const terrain = parseW3e(await readTerrainBytes(path, { readText: () => w3.workspace.readText(path), readBytes: () => w3.workspace.readBytes(path) }));
        const ids = async (file: string, key: string) => new Set(parseSlk(await w3.game.readText(file)).map((r) => r[key]));
        const ground = await ids("TerrainArt\\Terrain.slk", "tileID"), cliffs = await ids("TerrainArt\\CliffTypes.slk", "cliffID");
        const unknown = (list: string[], known: Set<string>, what: string) => list.filter((id) => !known.has(id)).map((id): Problem => ({
          severity: "error", message: `${what} ${id} isn't one of the game's`, location: path.slice(4), reveal: { command: "w3.terrain.open" },
        }));
        return [...unknown(terrain.groundTiles, ground, "Ground tile"), ...unknown(terrain.cliffTiles, cliffs, "Cliff type")];
      },
    },
    {
      id: "interfaceArt",
      title: "Map Properties and Game Interface art",
      async run() {
        const shared = scope(), files = shared.lookup();
        const out: Problem[] = [];
        // What to look at, in order; then the game paths of all of it at once.
        const values: [value: string, location: string, command: string][] = [];
        const info = await shared.doc<{ loadingScreen?: { model?: string }; prologue?: { path?: string } }>("map/war3map.w3i.json");
        if (info?.loadingScreen?.model) values.push([info.loadingScreen.model, "Map Properties › Loading screen", "w3.mapInfo.open"]);
        if (info?.prologue?.path) values.push([info.prologue.path, "Map Properties › Prologue", "w3.mapInfo.open"]);
        const skin = await w3.workspace.readText("map/war3mapSkin.txt").catch(() => null);
        for (const [section, keys] of skin === null ? [] : parseIni(skin)) {
          for (const [key, value] of keys) for (const part of value.split(",")) values.push([part, `Game Interface › ${section} › ${key}`, "w3.gameInterface.open"]);
        }
        const art = (value: string) => { const p = value.trim(); return /\.(blp|dds|tga|mdx|mdl)$/i.test(p) ? { p, kind: /\.md[xl]$/i.test(p) ? "model" as const : "texture" as const } : null; };
        await files.prefetch(values.flatMap(([value]) => { const a = art(value); return a ? [[a.p, a.kind] as [string, FileKind]] : []; }));
        for (const [value, location, command] of values) {
          const a = art(value);
          if (!a || (await files.exists(a.p, a.kind))) continue;
          out.push({ severity: "warning", message: `${a.p} not found (neither in the map nor in the game)`, location, reveal: { command } });
        }
        return out.slice(0, 200);
      },
    },
  ];
}
