// Test Map's options, as the World Editor's preferences have them (Test Map tab), turned into the game's
// command line. The flags are the ones the World Editor passes (its executable's strings, 2026-11-08):
// -windowmode windowed|windowedfullscreen|fullscreen, -hd 0|1|2 (SD, HD, DE), -teen 1|0, -nowfpause,
// -mapdiff <n>, -testmapprofile <name>, -fixedseed <n>. "Default" leaves a flag out, so the game uses its own.

import type { Settings } from "../../extensions/api";

export const TEST_MAP_SETTINGS = {
  difficulty: "testMap.difficulty",
  profile: "testMap.profile",
  windowMode: "testMap.windowMode",
  assetMode: "testMap.assetMode",
  teenData: "testMap.teenData",
  fixedSeed: "testMap.fixedSeed",
  noFocusPause: "testMap.noFocusPause",
} as const;

const DIFFICULTY: Record<string, string> = { easy: "0", normal: "1", hard: "2" };
const WINDOW: Record<string, string> = { windowed: "windowed", windowedFullscreen: "windowedfullscreen", fullscreen: "fullscreen" };
const ASSETS: Record<string, string> = { sd: "0", hd: "1", de: "2" };
const TEEN: Record<string, string> = { on: "1", off: "0" };

export interface TestMapOptions {
  difficulty?: string; profile?: string; windowMode?: string; assetMode?: string; teenData?: string; fixedSeed?: boolean; noFocusPause?: boolean;
}

/** The game's arguments after `-launch -loadfile <map>`, in the World Editor's order. With nothing set: what Test Map
 *  always passed (normal difficulty, the WorldEdit profile, a fixed seed). An unknown value is refused, naming the setting. */
export function testMapArgs(o: TestMapOptions): string[] {
  const pick = (table: Record<string, string>, value: string | undefined, key: string, fallback: string | null) => {
    if (value === undefined || value === "" || value === "default") return fallback;
    const v = table[value];
    if (v === undefined) throw new Error(`${key} can't be "${value}": it is one of default, ${Object.keys(table).join(", ")}.`);
    return v;
  };
  const args: string[] = [];
  const window = pick(WINDOW, o.windowMode, TEST_MAP_SETTINGS.windowMode, null);
  if (window) args.push("-windowmode", window);
  const hd = pick(ASSETS, o.assetMode, TEST_MAP_SETTINGS.assetMode, null);
  if (hd) args.push("-hd", hd);
  const teen = pick(TEEN, o.teenData, TEST_MAP_SETTINGS.teenData, null);
  if (teen) args.push("-teen", teen);
  if (o.noFocusPause) args.push("-nowfpause");
  args.push("-mapdiff", pick(DIFFICULTY, o.difficulty, TEST_MAP_SETTINGS.difficulty, "1")!);
  const profile = (o.profile ?? "WorldEdit").trim();
  if (profile.startsWith("-")) throw new Error(`${TEST_MAP_SETTINGS.profile} can't start with "-".`);
  // Empty: the player's own profile, as the game picks it.
  if (profile) args.push("-testmapprofile", profile);
  if (o.fixedSeed ?? true) args.push("-fixedseed", "1");
  return args;
}

/** The options as set. */
export function testMapOptions(settings: Pick<Settings, "get">): TestMapOptions {
  const s = TEST_MAP_SETTINGS;
  return {
    difficulty: settings.get<string>(s.difficulty, "normal"), profile: settings.get<string>(s.profile, "WorldEdit"),
    windowMode: settings.get<string>(s.windowMode, "default"), assetMode: settings.get<string>(s.assetMode, "default"),
    teenData: settings.get<string>(s.teenData, "default"), fixedSeed: settings.get<boolean>(s.fixedSeed, true),
    noFocusPause: settings.get<boolean>(s.noFocusPause, false),
  };
}
