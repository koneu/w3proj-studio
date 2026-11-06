// The game's skies, as the World Editor lists them: UI\WorldEditData.txt, [SkyModels], "00=path,WESTRING_NAME".

export interface SkyChoice { path: string; name: string }

export function skyList(worldEditData: string, strings: string): SkyChoice[] {
  const names = new Map([...strings.matchAll(/^(WESTRING_\w+)=(.*?)\r?$/gm)].map((m) => [m[1], m[2].replace(/&/g, "").replace(/^"|"$/g, "")]));
  const at = worldEditData.search(/^\[SkyModels\]/m);
  if (at < 0) return [];
  const out: SkyChoice[] = [];
  for (const line of worldEditData.slice(at).split(/\r?\n/).slice(1)) {
    if (line.startsWith("[")) break;
    const m = /^\d+=([^,]+),(\S+)/.exec(line.trim());
    if (m) out.push({ path: m[1], name: names.get(m[2]) ?? m[1].split("\\").pop()!.replace(/\.mdl$/i, "") });
  }
  return out;
}
