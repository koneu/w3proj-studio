// The map setup part of war3map.j: player slots, forces and start location
// priorities ("Players"), main ("Main Initialization") and config ("Map
// Configuration"), from war3map.w3i as the World Editor writes them.

import { fixed } from "./units";

const EOL = "\r\n";

export interface PlayerJson {
  id: number; controller: number; race: number; fixedStart: number; name: string; start: number[];
  allyLow: number; allyHigh: number; enemyLow?: number; enemyHigh?: number; hudSkin?: number;
}
export interface ForceJson { flags: number; players: number; name: string }

export interface SetupInput {
  info: {
    version: number; name: string; description: string; flags: number; tileset: string; cameraBounds: number[];
    soundEnvironment: string; lightEnvironment: string; players: PlayerJson[]; forces: ForceJson[];
    water?: Record<string, number>; cameraComplements?: number[]; weather?: string; waterTint?: number[];
    fog?: { style: number; start: number; end: number; density: number; color: number[] };
    terrainFog?: { style: number; overSky: number; linearStart: number; linearEnd: number; maxOpacity: number; height: number };
    [k: string]: unknown;
  };
  /** Day/night models for the map's light environment (WorldEditData [TerrainLights]/[UnitLights]). */
  lights: { terrain: string; unit: string };
  /** Which object sections the script has (main calls their functions). */
  has: { sounds: boolean; regions: boolean; cameras: boolean; upgrades: boolean; techs: boolean;
    destructables: boolean; items: boolean; randomGroups: boolean; units: boolean; triggers: boolean; initTriggers: boolean };
}

/** Ambient sound sets (UI\SoundInfo\AmbientMusic.slk, "<name>Day"/"<name>Night") by tileset. */
export const AMBIENCE: Record<string, string> = {
  A: "Ashenvale", B: "Barrens", C: "Felwood", D: "Dungeon", F: "LordaeronFall", G: "Dungeon", I: "IceCrown",
  J: "DalaranRuins", K: "BlackCitadel", L: "LordaeronSummer", N: "Northrend", O: "BlackCitadel", Q: "VillageFall", V: "Village",
  W: "LordaeronWinter", X: "Dalaran", Y: "CityScape", Z: "SunkenRuins",
};

const r1 = (v: number) => fixed(v, 1);
const str = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const RACES = ["", "HUMAN", "ORC", "UNDEAD", "NIGHTELF"];
const CONTROLLERS = ["", "USER", "COMPUTER", "NEUTRAL", "RESCUABLE"];
/** Map flags: melee map, "fixed player settings for custom forces", "use custom forces", terrain fog, water tint. */
const MELEE = 4, FIXED_SETTINGS = 0x20, CUSTOM_FORCES = 0x40, TERRAIN_FOG = 0x2000, WATER_TINT = 0x10000;
/** RACE_PREF_* by its bit value (HUD skins are stored that way). Anything else is RANDOM: World
 *  Editor 3.0.1 gives its own new maps 32759 and writes that. */
const RACE_PREFS: Record<number, string> = { 1: "HUMAN", 2: "ORC", 4: "UNDEAD", 8: "NIGHTELF", 16: "DEMON", 32: "RANDOM", 64: "USER_SELECTABLE" };
/** Force flags and the alliance they set between the force's members. */
const ALLIANCE: [number, string, string][] = [
  [0x1, "Allied", "SetPlayerAllianceStateAllyBJ"],
  [0x8, "Shared Vision", "SetPlayerAllianceStateVisionBJ"],
  [0x10, "Shared Control", "SetPlayerAllianceStateControlBJ"],
  [0x20, "Shared Advanced Control", "SetPlayerAllianceStateFullControlBJ"],
];

export function playersSection(i: SetupInput): string {
  const players = i.info.players;
  const slots = ["function InitCustomPlayerSlots takes nothing returns nothing", ""];
  // With "fixed player settings" races can't be changed in the lobby (a "selectable" race always can).
  const fixed = (i.info.flags & FIXED_SETTINGS) !== 0;
  players.forEach((p, index) => {
    const pl = `Player(${p.id})`;
    slots.push(`    // Player ${p.id}`, `    call SetPlayerStartLocation( ${pl}, ${index} )`);
    if (p.fixedStart & 1) slots.push(`    call ForcePlayerStartLocation( ${pl}, ${index} )`);
    slots.push(`    call SetPlayerColor( ${pl}, ConvertPlayerColor(${p.id}) )`, `    call SetPlayerRacePreference( ${pl}, RACE_PREF_${RACES[p.race] || "RANDOM"} )`);
    if (p.hudSkin !== undefined) slots.push(`    call SetPlayerRaceSkin( ${pl}, RACE_PREF_${RACE_PREFS[p.hudSkin] ?? "RANDOM"} )`);
    slots.push(`    call SetPlayerRaceSelectable( ${pl}, ${p.race === 0 || !fixed} )`, `    call SetPlayerController( ${pl}, MAP_CONTROL_${CONTROLLERS[p.controller] ?? "USER"} )`);
    // Rescuable players can be rescued by every user player.
    if (p.controller === 4) {
      for (const u of players) if (u.controller === 1) slots.push(`    call SetPlayerAlliance( ${pl}, Player(${u.id}), ALLIANCE_RESCUABLE, true )`);
    }
    slots.push("");
  });
  slots.push("endfunction", "");

  const teams = ["function InitCustomTeams takes nothing returns nothing"];
  let first = true, team = 0;
  i.info.forces.forEach((f) => {
    // Forces without players are left out.
    const members = players.filter((p) => (f.players >>> p.id) & 1);
    if (!members.length) return;
    if (!first) teams.push("");
    first = false;
    const k = team++;
    teams.push(`    // Force: ${f.name}`);
    for (const p of members) {
      teams.push(`    call SetPlayerTeam( Player(${p.id}), ${k} )`);
      if (f.flags & 0x2) teams.push(`    call SetPlayerState( Player(${p.id}), PLAYER_STATE_ALLIED_VICTORY, 1 )`);
    }
    // Alliance settings between the force's members, one block per flag.
    for (const [flag, title, fn] of ALLIANCE) {
      if (!(f.flags & flag) || members.length < 2) continue;
      teams.push("", `    //   ${title}`);
      for (const a of members) for (const b of members) if (a !== b) teams.push(`    call ${fn}( Player(${a.id}), Player(${b.id}), true )`);
    }
  });
  teams.push("", "endfunction", "");

  // Priority masks are by player id (bits of absent players are ignored). The count includes
  // the player's own bit; entries list the others, LOW winning when both masks have the bit.
  const blocks: string[][] = [];
  const priorities = (index: number, p: PlayerJson, low: number, high: number, fn: string) => {
    const mask = (low | high) >>> 0;
    const count = players.filter((q) => (mask >>> q.id) & 1).length;
    if (!count) return;
    const block = [`    call Set${fn}Count( ${index}, ${count} )`];
    let k = 0;
    players.forEach((q, j) => {
      if (q === p || !((mask >>> q.id) & 1)) return;
      block.push(`    call Set${fn}( ${index}, ${k++}, ${j}, MAP_LOC_PRIO_${(low >>> q.id) & 1 ? "LOW" : "HIGH"} )`);
    });
    blocks.push(block);
  };
  players.forEach((p, index) => {
    priorities(index, p, p.allyLow, p.allyHigh, "StartLocPrio");
    priorities(index, p, p.enemyLow ?? 0, p.enemyHigh ?? 0, "EnemyStartLocPrio");
  });
  // Without any priorities the function is left out (config doesn't call it either).
  if (!blocks.length) return [slots.join(EOL), teams.join(EOL)].join(EOL);
  const prio = ["function InitAllyPriorities takes nothing returns nothing", "", ...blocks.map((b) => b.join(EOL)).join(`${EOL}${EOL}`).split(EOL), "endfunction", ""];
  return [slots.join(EOL), teams.join(EOL), prio.join(EOL)].join(EOL);
}

/** Whether any player has start location priorities (InitAllyPriorities exists). */
function hasPriorities(i: SetupInput): boolean {
  const players = i.info.players;
  return players.some((p) => players.some((q) => ((p.allyLow | p.allyHigh | (p.enemyLow ?? 0) | (p.enemyHigh ?? 0)) >>> q.id) & 1));
}

export function mainSection(i: SetupInput): string {
  const b = i.info.cameraBounds;
  // The script's bounds lie 4 tiles (x) and 2 tiles (y) outside those in war3map.w3i.
  const L = r1(b[0] - 512), B = r1(b[1] - 256), R = r1(b[2] + 512), T = r1(b[3] + 256);
  const m = (s: string) => `GetCameraMargin(CAMERA_MARGIN_${s})`;
  // Weather covers the whole map: the bounds plus the unplayable border (complements, in tiles).
  const weather = i.info.weather && i.info.weather !== "0x00000000" ? i.info.weather : null;
  const lines = ["//===========================================================================", "function main takes nothing returns nothing",
    ...(weather ? ["    local weathereffect we"] : []),
    `    call SetCameraBounds( ${L} + ${m("LEFT")}, ${B} + ${m("BOTTOM")}, ${R} - ${m("RIGHT")}, ${T} - ${m("TOP")}, ${L} + ${m("LEFT")}, ${T} - ${m("TOP")}, ${R} - ${m("RIGHT")}, ${B} + ${m("BOTTOM")} )`,
    `    call SetDayNightModels( ${str(i.lights.terrain)}, ${str(i.lights.unit)} )`];
  // Colours are stored blue, green, red, alpha.
  const fog = i.info.fog, tf = i.info.terrainFog;
  if (fog && i.info.flags & TERRAIN_FOG) {
    const [fb, fg, fr] = fog.color.map((c) => fixed(c / 255, 3));
    if (tf) {
      lines.push(`    call SetTerrainFogExV( ${fog.style}, ${r1(fog.start)}, ${r1(fog.end)}, ${fixed(fog.density, 3)}, ${r1(tf.height)}, ${r1(tf.style)}, ${r1(tf.linearStart)}, ${r1(tf.linearEnd)}, ${fr}, ${fg}, ${fb} )`,
        `    call BlzSetTerrainFogMaxLinearDensity( ${r1(tf.maxOpacity)} )`, `    call BlzSetTerrainFogDrawOverSky( ${tf.overSky ? "true" : "false"} )`);
    } else lines.push(`    call SetTerrainFogEx( ${fog.style}, ${r1(fog.start)}, ${r1(fog.end)}, ${fixed(fog.density, 3)}, ${fr}, ${fg}, ${fb} )`);
  }
  const tint = i.info.waterTint;
  if (tint && i.info.flags & WATER_TINT) lines.push(`    call SetWaterBaseColor( ${tint[2]}, ${tint[1]}, ${tint[0]}, ${tint[3]} )`);
  const w = i.info.water;
  if (w) {
    lines.push(`    call SetHDWaterParamsEx( 0, 0, 0, ${w.overrideColor ? "true" : "false"}, ${w.wavesVertexDisplacement}, ${w.minOpacity}, ${w.maxOpacity}, ${w.reflectivity}, ${w.emissivity}, ${w.edgeSoftness}, ${w.wavesNormalMapStrength}, ${w.environmentMapReflectivity} )`);
  }
  if (weather) {
    const c = i.info.cameraComplements ?? [0, 0, 0, 0];
    lines.push(`    set we = AddWeatherEffect( Rect(${r1(b[0] - 512 - c[0] * 128)},${r1(b[1] - 256 - c[2] * 128)},${r1(b[2] + 512 + c[1] * 128)},${r1(b[3] + 256 + c[3] * 128)}), '${weather}' )`,
      "    call EnableWeatherEffect( we, true )");
  }
  lines.push(`    call NewSoundEnvironment( ${str(i.info.soundEnvironment || "Default")} )`);
  const amb = AMBIENCE[i.info.tileset];
  if (amb) lines.push(`    call SetAmbientDaySound( "${amb}Day" )`, `    call SetAmbientNightSound( "${amb}Night" )`);
  lines.push(`    call SetMapMusic( "Music", true, 0 )`);
  const h = i.has, call = (f: string) => `    call ${f}(  )`;
  if (h.sounds) lines.push(call("InitSounds"));
  if (h.regions) lines.push(call("CreateRegions"));
  if (h.cameras) lines.push(call("CreateCameras"));
  if (h.upgrades) lines.push(call("InitUpgrades"));
  if (h.techs) lines.push(call("InitTechTree"));
  if (h.destructables) lines.push(call("CreateAllDestructables"));
  if (h.items) lines.push(call("CreateAllItems"));
  if (h.randomGroups) lines.push(call("InitRandomGroups"));
  if (h.units) lines.push(call("CreateAllUnits"));
  lines.push(call("InitBlizzard"), call("InitGlobals"));
  // A map without war3map.wtg has no trigger section to call.
  if (h.triggers) lines.push(call("InitCustomTriggers"));
  if (h.initTriggers) lines.push(call("RunInitializationTriggers"));
  lines.push("", "endfunction", "");
  return lines.join(EOL);
}

/** Editors before 6116 always wrote TEAMS_TOGETHER (bit 0 of the flags fits the game's maps as well;
 *  nothing separates the two, and this way maps from today's editors can't be affected). After that
 *  a melee map gets it and others USE_MAP_SETTINGS, with custom forces or without. */
const oldPlacement = (i: SetupInput) => ((i.info.editorVersion as number | undefined) ?? 6116) < 6116;

export function configSection(i: SetupInput): string {
  const players = i.info.players;
  const lines = ["function config takes nothing returns nothing", `    call SetMapName( ${str(i.info.name)} )`, `    call SetMapDescription( ${str(i.info.description)} )`,
    `    call SetPlayers( ${players.length} )`, `    call SetTeams( ${players.length} )`,
    `    call SetGamePlacement( MAP_PLACEMENT_${i.info.flags & MELEE || oldPlacement(i) ? "TEAMS_TOGETHER" : "USE_MAP_SETTINGS"} )`, ""];
  players.forEach((p, index) => lines.push(`    call DefineStartLocation( ${index}, ${r1(p.start[0])}, ${r1(p.start[1])} )`));
  lines.push("", "    // Player setup", "    call InitCustomPlayerSlots(  )");
  // Without custom forces the lobby sets up teams: every slot is offered, then the generic setup.
  if (i.info.flags & CUSTOM_FORCES) lines.push("    call InitCustomTeams(  )");
  else lines.push(...players.map((p) => `    call SetPlayerSlotAvailable( Player(${p.id}), MAP_CONTROL_${CONTROLLERS[p.controller] ?? "USER"} )`), "    call InitGenericPlayerSlots(  )");
  if (hasPriorities(i)) lines.push("    call InitAllyPriorities(  )");
  lines.push("endfunction", "");
  return lines.join(EOL);
}
