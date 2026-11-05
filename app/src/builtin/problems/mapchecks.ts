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
import { FileLookup, readMapDoc } from "./checks";

const WHAT: Record<string, string> = { rct: "region", cam: "camera", snd: "sound", trg: "trigger", unit: "placed unit", item: "placed item", dest: "placed destructable", doodad: "placed doodad" };

/** The map's generated globals. */
async function mapGlobals(w3: W3Api, triggers: string[]): Promise<Set<string>> {
  const names = new Set(triggers.map((t) => `gg_trg_${ident(t)}`));
  for (const r of (await readMapDoc<{ regions: { name: string }[] }>(w3, "map/war3map.w3r.json"))?.regions ?? []) names.add(`gg_rct_${ident(r.name)}`);
  for (const c of (await readMapDoc<{ cameras: { name: string }[] }>(w3, "map/war3map.w3c.json"))?.cameras ?? []) names.add(`gg_cam_${ident(c.name)}`);
  for (const s of (await readMapDoc<{ sounds: { name: string }[] }>(w3, "map/war3map.w3s.json"))?.sounds ?? []) names.add(s.name);
  const units = (await readMapDoc<{ units: PlacedJson[] }>(w3, "map/war3mapUnits.doo.json"))?.units ?? [];
  const doodads = (await readMapDoc<{ doodads: PlacedJson[] }>(w3, "map/war3map.doo.json"))?.doodads ?? [];
  for (const p of units) { names.add(placedName(p, "unit")); names.add(placedName(p, "item")); }
  for (const p of doodads) { names.add(placedName(p, "dest")); names.add(placedName(p, "doodad")); }
  return names;
}

export function mapChecks(w3: W3Api): ProblemCheck[] {
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
        const missing = missingRefs(triggerRefs(file), await mapGlobals(w3, triggers), file.variables);
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
        const files = new FileLookup(w3);
        const out: Problem[] = [];
        for (const s of (await readMapDoc<{ sounds: { name: string; file: string }[] }>(w3, "map/war3map.w3s.json"))?.sounds ?? []) {
          if (!s.file) continue;
          // The game takes a sound under its other extensions too.
          const stem = s.file.replace(/\.\w+$/, "");
          let found = false;
          for (const ext of [s.file.slice(stem.length), ".flac", ".ogg", ".mp3", ".wav"]) {
            if (await files.exists(`${stem}${ext}`, "file")) { found = true; break; }
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
        const files = new FileLookup(w3);
        const out: Problem[] = [];
        const check = async (value: string, location: string, command: string) => {
          const p = value.trim();
          if (!/\.(blp|dds|tga|mdx|mdl)$/i.test(p) || (await files.exists(p, /\.md[xl]$/i.test(p) ? "model" : "texture"))) return;
          out.push({ severity: "warning", message: `${p} not found (neither in the map nor in the game)`, location, reveal: { command } });
        };
        const info = await readMapDoc<{ loadingScreen?: { model?: string }; prologue?: { path?: string } }>(w3, "map/war3map.w3i.json");
        if (info?.loadingScreen?.model) await check(info.loadingScreen.model, "Map Properties › Loading screen", "w3.mapInfo.open");
        if (info?.prologue?.path) await check(info.prologue.path, "Map Properties › Prologue", "w3.mapInfo.open");
        const skin = await w3.workspace.readText("map/war3mapSkin.txt").catch(() => null);
        for (const [section, keys] of skin === null ? [] : parseIni(skin)) {
          for (const [key, value] of keys) for (const part of value.split(",")) await check(part, `Game Interface › ${section} › ${key}`, "w3.gameInterface.open");
        }
        return out.slice(0, 200);
      },
    },
  ];
}
