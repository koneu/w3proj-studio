/**
 * The campaign screen's Background and Ambient Sound presets. The game lists them in UI/WorldEditData.txt
 * ([CampaignScreens], [AmbientSounds]: "NN=version,WESTRING_NAME,…"); a campaign stores the entry's number NN,
 * or -1 for the file named next to it.
 */
import { westring } from "../../lib/formats/text";

export interface Preset { n: number; name: string }

/** The preset number meaning "the custom file below". */
export const CUSTOM_PRESET = -1;

/** The entries of one WorldEditData.txt section, named through the WESTRING table `we` (keys upper case). */
export function parsePresets(section: ReadonlyMap<string, string> | undefined, we: ReadonlyMap<string, string>): Preset[] {
  const out: Preset[] = [];
  for (const [k, v] of section ?? []) {
    if (!/^\d+$/.test(k)) continue;
    const name = westring(we, v.split(",")[1] ?? "").trim();
    if (name) out.push({ n: Number(k), name });
  }
  return out;
}

/** The label of a number that is not in the list. */
const unknownName = (n: number) => `Preset ${n}`;
const CUSTOM_NAME = "Custom file";

/** What the dropdown shows for `n`. */
export function presetName(presets: readonly Preset[], n: number): string {
  if (n === CUSTOM_PRESET) return CUSTOM_NAME;
  return presets.find((p) => p.n === n)?.name ?? unknownName(n);
}

/** The number a dropdown entry stands for; undefined for a name that is none of them. */
export function presetNumber(presets: readonly Preset[], name: string): number | undefined {
  if (name === CUSTOM_NAME) return CUSTOM_PRESET;
  const p = presets.find((x) => x.name === name);
  if (p) return p.n;
  const m = /^Preset (-?\d+)$/.exec(name);
  return m ? Number(m[1]) : undefined;
}

/** The dropdown's entries: the custom file, the presets, and `current` as "Preset N" when it is none of those. */
export function presetOptions(presets: readonly Preset[], current: number): [number, string][] {
  const o: [number, string][] = [[CUSTOM_PRESET, CUSTOM_NAME], ...presets.map((p): [number, string] => [p.n, p.name])];
  if (!o.some(([n]) => n === current)) o.push([current, unknownName(current)]);
  return o;
}
