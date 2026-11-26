// AI Editor's Test AI: a copy of a melee map set up as the AI's Test Configuration says. The World Editor's own way of
// handing the setup to the game isn't known; this makes it part of the copy: war3map.w3i's players, and the map
// script (its config and the melee trigger's AI start). Started like Test Map, a computer slot of such a map joins and
// runs an imported AI (the user's test in the game, 2026-11-26).

import { decodeAiType } from "./slots";
import type { AiFile, TestPlayer } from "./wai";

/** war3map.w3i's flag of a melee map. */
export const MELEE_FLAG = 0x4;
const MAX_PLAYERS = 24;

export interface MapPlayer { id: number; controller: number; race: number; fixedStart: number; start: number[]; name: string; [other: string]: unknown }
export interface MapInfo { flags: number; players: MapPlayer[]; [other: string]: unknown }

export interface TestSlot {
  /** The game's player (0-based). */
  player: number;
  /** The row of the Test Configuration (1-based), for messages. */
  row: number;
  user: boolean;
  /** 0-based team. */
  team: number;
  source: TestPlayer;
  ai: "Standard" | "Custom" | "Current";
}
export interface TestPlan {
  /** The playing slots (not the observer), in the order of the configuration. */
  slots: TestSlot[];
  /** The player the user watches as, without units; null when the user plays. */
  observer: number | null;
  fogOff: boolean;
  /** Victory and defeat conditions left out (asked for, or because a watching user without units would lose at once). */
  noVictory: boolean;
  /** What of the configuration the copy can't do. */
  notes: string[];
}

const fail = (why: string): never => { throw new Error(`Test AI failed: ${why}`); };

/** The slots of `ai`'s Test Configuration on `info`'s map, or why they can't be tested, in the World Editor's words.
 *  The playing slots take the map's players (and their start locations) in order; a watching user takes a player the
 *  map has left over, else one more. */
export function testPlan(ai: AiFile, info: MapInfo): TestPlan {
  if (!(info.flags & MELEE_FLAG)) {
    throw new Error("This map is not a Melee map. The Test AI feature only works with Melee maps. For custom maps, import the AI into the map and use Test Map.");
  }
  const rows = ai.players.map((p, i) => ({ p, row: p.index + 1 || i + 1, ...decodeAiType(p.aiType) }));
  const users = rows.filter((r) => r.control === "User");
  if (!users.length) fail("No user-controlled players specified.");
  if (users.length > 1) fail("Multiple players specified as user-controlled.");
  if (rows.some((r) => r.control === "Computer" && r.observer)) fail("A computer is specified as an observer.");
  const playing = rows.filter((r) => !r.observer);
  if (!playing.length) fail("No non-observing players specified.");
  const places = [...info.players].sort((a, b) => a.id - b.id);
  if (playing.length > places.length) fail(`Too many non-observing players specified (the map has ${places.length}).`);
  const slots = playing.map((r, i): TestSlot => ({ player: places[i].id, row: r.row, user: r.control === "User", team: r.p.team, source: r.p, ai: r.ai }));
  let observer: number | null = null;
  if (users[0].observer) {
    const used = new Set(slots.map((s) => s.player));
    const free = places.find((p) => !used.has(p.id))?.id ?? Array.from({ length: MAX_PLAYERS }, (_, i) => i).find((i) => !used.has(i));
    if (free === undefined) fail("No player is left for the observer.");
    observer = free!;
  }
  const asked = (ai.gameOptions & 2) !== 0;
  const notes: string[] = [];
  if (ai.gameSpeed !== 1) notes.push(`Game Speed ${ai.gameSpeed} × isn't set: a map's script can't run the game faster than its own speeds.`);
  if (slots.some((s) => !s.user && s.source.difficulty !== 1)) notes.push("AI Difficulty isn't set per player: the game takes Test Map's difficulty (setting testMap.difficulty).");
  if (observer !== null && !asked) notes.push("Victory and defeat conditions are left out: watching without units would lose at once.");
  return { slots, observer, fogOff: (ai.gameOptions & 1) !== 0 || observer !== null, noVictory: asked || observer !== null, notes };
}

/** war3map.w3i's race numbers for the configuration's race bits; 0: any. */
const W3I_RACE: Record<number, number> = { 1: 1, 2: 2, 4: 3, 8: 4 };
const RACE_PREF: Record<number, string> = { 1: "HUMAN", 2: "ORC", 4: "UNDEAD", 8: "NIGHTELF" };

/** `info` with the players of `plan`: the playing slots on their map players, the observer; the others go. */
export function testInfo(info: MapInfo, plan: TestPlan): MapInfo {
  const byId = new Map(info.players.map((p) => [p.id, p]));
  const players: MapPlayer[] = plan.slots.map((s) => ({ ...byId.get(s.player)!, controller: s.user ? 1 : 2, race: W3I_RACE[s.source.race] ?? 0 }));
  if (plan.observer !== null) {
    const base = byId.get(plan.observer) ?? { ...info.players[0], name: "Observer" };
    players.push({ ...base, id: plan.observer, controller: 1, race: 1 });
  }
  return { ...info, players: players.sort((a, b) => a.id - b.id) };
}

/** A string as JASS writes it. */
const quoted = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Where the body of function `name` ends: the index of its `endfunction` line. */
function endOf(lines: string[], name: string): number {
  const start = lines.findIndex((l) => new RegExp(`^\\s*function\\s+${name}\\s+takes\\b`).test(l));
  if (start < 0) fail(`The map's script has no function ${name}.`);
  for (let i = start + 1; i < lines.length; i++) if (/^\s*endfunction\b/.test(lines[i])) return i;
  return fail(`The map's script's function ${name} doesn't end.`);
}

/**
 * The map's JASS script set up for the test: its config gets the slots (after its own settings, so these hold), its
 * own start of the melee AIs goes (and the victory conditions when left out), and a function of our own, called at the
 * end of main, starts each computer's AI. `scripts`: the imported AI script of each player that doesn't run the
 * game's own; `names`: what each player runs, shown in the game when it starts.
 */
export function testScript(jass: string, info: MapInfo, plan: TestPlan, scripts: ReadonlyMap<number, string>, names: ReadonlyMap<number, string>): string {
  const eol = jass.includes("\r\n") ? "\r\n" : "\n";
  let lines = jass.split(/\r?\n/);
  const drop = ["MeleeStartingAI", ...(plan.noVictory ? ["MeleeInitVictoryDefeat"] : [])];
  lines = lines.filter((l) => !drop.some((fn) => new RegExp(`^\\s*call\\s+${fn}\\s*\\(\\s*\\)\\s*(//.*)?$`).test(l)));

  const everyone = [...plan.slots.map((s) => s.player), ...(plan.observer === null ? [] : [plan.observer])];
  const setup: string[] = [
    "    // Test AI: the players of the AI's Test Configuration.",
    `    call SetPlayers( ${everyone.length} )`,
    `    call SetTeams( ${new Set(plan.slots.map((s) => s.team)).size + (plan.observer === null ? 0 : 1)} )`,
    "    call SetGamePlacement( MAP_PLACEMENT_USE_MAP_SETTINGS )",
  ];
  for (const p of info.players.filter((p) => !everyone.includes(p.id))) {
    setup.push(`    call SetPlayerController( Player(${p.id}), MAP_CONTROL_NONE )`, `    call SetPlayerSlotAvailable( Player(${p.id}), MAP_CONTROL_NONE )`);
  }
  const starts = [...info.players].sort((a, b) => a.id - b.id).map((p) => p.id);
  /** The map's start location of a player: the config defines them in the players' order. */
  const startOf = (player: number) => Math.max(0, starts.indexOf(player));
  for (const s of plan.slots) {
    const pl = `Player(${s.player})`, control = s.user ? "USER" : "COMPUTER";
    setup.push(`    call SetPlayerStartLocation( ${pl}, ${startOf(s.player)} )`, `    call ForcePlayerStartLocation( ${pl}, ${startOf(s.player)} )`,
      `    call SetPlayerColor( ${pl}, ConvertPlayerColor(${s.source.color}) )`, `    call SetPlayerRacePreference( ${pl}, RACE_PREF_${RACE_PREF[s.source.race] ?? "RANDOM"} )`,
      `    call SetPlayerRaceSelectable( ${pl}, true )`, `    call SetPlayerController( ${pl}, MAP_CONTROL_${control} )`,
      `    call SetPlayerSlotAvailable( ${pl}, MAP_CONTROL_${control} )`, `    call SetPlayerTeam( ${pl}, ${s.team} )`);
  }
  if (plan.observer !== null) {
    const pl = `Player(${plan.observer})`;
    setup.push(`    call SetPlayerStartLocation( ${pl}, ${startOf(plan.observer)} )`, `    call SetPlayerController( ${pl}, MAP_CONTROL_USER )`,
      `    call SetPlayerSlotAvailable( ${pl}, MAP_CONTROL_USER )`, `    call SetPlayerTeam( ${pl}, ${Math.max(0, ...plan.slots.map((s) => s.team)) + 1} )`);
  }
  lines.splice(endOf(lines, "config"), 0, ...setup);

  const start: string[] = [
    "//===========================================================================",
    "// Test AI (W3Proj Studio)",
    "//===========================================================================",
    "function W3ProjTestAI_Say takes string s returns nothing",
    "    call DisplayTimedTextToPlayer( GetLocalPlayer(), 0.0, 0.0, 30.0, s )",
    "endfunction",
    "",
    "function W3ProjTestAI_Standard takes player p returns nothing",
    "    local race r = GetPlayerRace(p)",
    "    if r == RACE_HUMAN then",
    '        call PickMeleeAI( p, "human.ai", null, null )',
    "    elseif r == RACE_ORC then",
    '        call PickMeleeAI( p, "orc.ai", null, null )',
    "    elseif r == RACE_UNDEAD then",
    '        call PickMeleeAI( p, "undead.ai", null, null )',
    "        call RecycleGuardPosition( bj_ghoul[GetPlayerId(p)] )",
    "    elseif r == RACE_NIGHTELF then",
    '        call PickMeleeAI( p, "elf.ai", null, null )',
    "    endif",
    "endfunction",
    "",
    "function W3ProjTestAI_Start takes nothing returns nothing",
  ];
  for (const a of plan.slots) {
    for (const b of plan.slots) {
      if (a.player !== b.player) start.push(`    call SetPlayerAllianceStateBJ( Player(${a.player}), Player(${b.player}), ${a.team === b.team ? "bj_ALLIANCE_ALLIED_VISION" : "bj_ALLIANCE_UNALLIED"} )`);
    }
    if (a.source.handicap !== 100) start.push(`    call SetPlayerHandicap( Player(${a.player}), ${(a.source.handicap / 100).toFixed(2)} )`);
  }
  if (plan.observer !== null) {
    const watched = plan.slots.find((s) => !s.user) ?? plan.slots[0];
    start.push("    // The observer has no units.",
      "    call W3ProjTestAI_RemoveUnits()",
      `    call PanCameraToTimedForPlayer( Player(${plan.observer}), GetStartLocationX(GetPlayerStartLocation(Player(${watched.player}))), GetStartLocationY(GetPlayerStartLocation(Player(${watched.player}))), 0.0 )`);
    const at = start.indexOf("function W3ProjTestAI_Start takes nothing returns nothing");
    start.splice(at, 0,
      "function W3ProjTestAI_RemoveUnits takes nothing returns nothing",
      "    local group g = CreateGroup()",
      "    local unit u",
      `    call GroupEnumUnitsOfPlayer( g, Player(${plan.observer}), null )`,
      "    loop",
      "        set u = FirstOfGroup(g)",
      "        exitwhen u == null",
      "        call GroupRemoveUnit( g, u )",
      "        call RemoveUnit( u )",
      "    endloop",
      "    call DestroyGroup( g )",
      "endfunction",
      "");
  }
  if (plan.fogOff) start.push("    call FogEnable( false )", "    call FogMaskEnable( false )");
  for (const s of plan.slots.filter((s) => !s.user)) {
    const pl = `Player(${s.player})`, file = scripts.get(s.player);
    start.push(`    if GetPlayerSlotState(${pl}) == PLAYER_SLOT_STATE_PLAYING then`,
      file ? `        call StartMeleeAI( ${pl}, ${quoted(file)} )` : `        call W3ProjTestAI_Standard( ${pl} )`,
      `        call ShareEverythingWithTeamAI( ${pl} )`,
      `        call W3ProjTestAI_Say( ${quoted(`Test AI: player ${s.player + 1}, team ${s.team + 1}: ${names.get(s.player) ?? s.ai}`)} )`,
      "    else",
      `        call W3ProjTestAI_Say( ${quoted(`Test AI: player ${s.player + 1} did NOT join (${names.get(s.player) ?? s.ai})`)} )`,
      "    endif");
  }
  start.push("endfunction", "");

  const mainAt = lines.findIndex((l) => /^\s*function\s+main\s+takes\b/.test(l));
  if (mainAt < 0) fail("The map's script has no function main.");
  lines.splice(mainAt, 0, ...start);
  const end = endOf(lines, "main");
  lines.splice(end, 0, "    call W3ProjTestAI_Start()");
  return lines.join(eol);
}
