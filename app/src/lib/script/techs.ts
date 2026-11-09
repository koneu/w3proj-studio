// "Upgrades" and "TechTree" of war3map.j: per player the upgrades the map
// starts researched or limits, and the units/buildings/abilities it disables,
// from the upgrade and tech lists in war3map.w3i.

const EOL = "\r\n";

export interface UpgradeJson { players: number; id: string; level: number; availability: number }
export interface TechJson { players: number; id: string }

function perPlayer(prefix: string, playerIds: number[], body: (p: number) => string[]): { text: string; called: string[] } {
  const parts: string[] = [], called: string[] = [];
  for (const p of playerIds) {
    const lines = body(p);
    if (!lines.length) continue;
    parts.push([`function ${prefix}_Player${p} takes nothing returns nothing`, ...lines, "endfunction", ""].join(EOL));
    called.push(`${prefix}_Player${p}`);
  }
  return { text: parts.join(EOL), called };
}

function wrapper(name: string, called: string[]): string {
  return [`function ${name} takes nothing returns nothing`, ...called.map((c) => `    call ${c}(  )`), "endfunction", ""].join(EOL);
}

/** The Upgrades section body, or "" without upgrade settings. */
export function upgradesSection(playerIds: number[], upgrades: UpgradeJson[]): string {
  const { text, called } = perPlayer("InitUpgrades", playerIds, (p) => {
    const mine = upgrades.filter((u) => (u.players >>> p) & 1);
    const lines: string[] = [];
    for (const id of [...new Set(mine.map((u) => u.id))]) {
      const levels = mine.filter((u) => u.id === id);
      // Unavailable levels (availability 0) cap the upgrade; researched ones (2) start done. The cap comes
      // first, as the World Editor writes it (9 of the game's maps have both for one upgrade).
      const off = levels.filter((u) => u.availability === 0).map((u) => u.level);
      if (off.length) lines.push(`    call SetPlayerTechMaxAllowed( Player(${p}), '${id}', ${Math.min(...off)} )`);
      const done = levels.filter((u) => u.availability === 2).map((u) => u.level);
      if (done.length) lines.push(`    call SetPlayerTechResearched( Player(${p}), '${id}', ${Math.max(...done) + 1} )`);
    }
    return lines;
  });
  return called.length ? `${text}${EOL}${wrapper("InitUpgrades", called)}` : "";
}

/** The TechTree section body, or "" without disabled objects. */
export function techTreeSection(playerIds: number[], techs: TechJson[], isAbility: (id: string) => boolean = () => false): string {
  // Abilities are switched off, units and buildings limited to 0.
  const { text, called } = perPlayer("InitTechTree", playerIds, (p) =>
    techs.filter((t) => (t.players >>> p) & 1).map((t) => (isAbility(t.id)
      ? `    call SetPlayerAbilityAvailable( Player(${p}), '${t.id}', false )`
      : `    call SetPlayerTechMaxAllowed( Player(${p}), '${t.id}', 0 )`)));
  return called.length ? `${text}${EOL}${wrapper("InitTechTree", called)}` : "";
}
