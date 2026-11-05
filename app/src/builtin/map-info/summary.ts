// war3map.w3i as the MCP tool tells about it: texts instead of string table keys, words instead of
// numbers. What an old format doesn't store is left out.

const CONTROLLERS = ["none", "user", "computer", "neutral", "rescuable"];
const RACES = ["selectable", "human", "orc", "undead", "night elf"];

interface Info {
  version: number; editorVersion: number; name: string; author: string; description: string; suggestedPlayers: string;
  playableWidth: number; playableHeight: number; tileset: string; scriptType?: number;
  loadingScreen: { model?: string; text: string; title: string; subtitle: string };
  prologue: { text: string; title: string; subtitle: string };
  weather?: string; soundEnvironment?: string; lightEnvironment?: string;
  players: { id: number; controller: number; race: number; name: string; start: number[] }[];
  forces: { players: number; name: string }[];
  upgrades?: unknown[]; techs?: unknown[]; unitTables?: unknown[]; itemTables?: unknown[];
}

export function mapSummary(info: Info, resolve: (value: string) => string) {
  const text = (o: { text: string; title: string; subtitle: string }) => ({ title: resolve(o.title), subtitle: resolve(o.subtitle), text: resolve(o.text) });
  return {
    name: resolve(info.name), author: resolve(info.author), description: resolve(info.description), suggestedPlayers: resolve(info.suggestedPlayers),
    format: info.version, editorVersion: info.editorVersion,
    tileset: info.tileset, playableSize: [info.playableWidth, info.playableHeight],
    scriptLanguage: info.scriptType === 1 ? "lua" : "jass",
    loadingScreen: { ...text(info.loadingScreen), ...(info.loadingScreen.model ? { model: info.loadingScreen.model } : {}) },
    prologue: text(info.prologue),
    ...(info.weather !== undefined ? { environment: { weather: info.weather, sound: info.soundEnvironment, light: info.lightEnvironment } } : {}),
    players: info.players.map((p) => ({
      number: p.id + 1, name: resolve(p.name), controller: CONTROLLERS[p.controller] ?? p.controller, race: RACES[p.race] ?? p.race, start: p.start,
    })),
    forces: info.forces.map((f) => ({
      name: resolve(f.name), players: info.players.filter((p) => f.players & (1 << p.id)).map((p) => p.id + 1),
    })),
    customized: { upgrades: info.upgrades?.length ?? 0, techs: info.techs?.length ?? 0, randomGroups: info.unitTables?.length ?? 0, itemTables: info.itemTables?.length ?? 0 },
  };
}
