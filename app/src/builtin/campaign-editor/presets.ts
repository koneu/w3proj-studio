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

/** A campaign picture the game offers: the file stored in the campaign, named by the game. */
export interface ImagePreset { path: string; name: string }

/** The entries of [CampaignImages] ("NN=WESTRING_NAME,path"). */
export function parseImagePresets(section: ReadonlyMap<string, string> | undefined, we: ReadonlyMap<string, string>): ImagePreset[] {
  const out: ImagePreset[] = [];
  for (const [k, v] of section ?? []) {
    if (!/^\d+$/.test(k)) continue;
    const i = v.indexOf(",");
    if (i < 0) continue;
    const name = westring(we, v.slice(0, i)).trim();
    const path = v.slice(i + 1).trim();
    if (name && path) out.push({ path, name });
  }
  return out;
}

/** The preset a stored picture path is: the same file, ignoring case, slash direction and a texture extension; undefined for a custom file. */
export function imagePresetOf(presets: readonly ImagePreset[], stored: string): ImagePreset | undefined {
  const norm = (p: string) => p.trim().replaceAll("/", String.fromCharCode(92)).replace(/[.](blp|tga)$/i, "").toLowerCase();
  const s = norm(stored);
  return s ? presets.find((p) => norm(p.path) === s) : undefined;
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
