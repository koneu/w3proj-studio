// Sound data helpers: game paths as maps refer to them, new entries the way
// the World Editor writes them, and the game's sound labels (UI\SoundInfo).

/** A war3map.w3s entry (format definition "sounds", v3). */
export interface Sound {
  name: string; file: string; eaxEffect: string; flags: number; fadeInRate: number; fadeOutRate: number; volume: number;
  pitch: number; pitchVariance: number; priority: number; channel: number; minDistance: number; maxDistance: number;
  distanceCutoff: number; coneInside: number; coneOutside: number; coneOutsideVolume: number; coneOrientation: number[];
  variableName?: string; assetLabel?: string; assetFile?: string; dialogueTextKey?: number; dialogueText?: string;
  speakerNameKey?: number; speakerName?: string; unknown1?: number; speakerUnitType?: string;
  facialAnimationLabel?: string; facialAnimationGroupLabel?: string; facialAnimationSetFile?: string; unknown2?: number;
  [k: string]: unknown;
}

/** Flags: looping, 3D, stop when out of range, music; 0x10 is set on imported sounds (meaning unconfirmed). */
export const LOOPING = 1, THREE_D = 2, STOP_OUT_OF_RANGE = 4, MUSIC = 8, IMPORTED = 16;

/** Unset float fields hold this (the World Editor's "use the default"). */
export const UNSET = 4294967300;
export const isUnset = (v: number) => v >= 4e9;

export const SOUND_EXTENSIONS = /\.(flac|wav|mp3|ogg)$/i;

/** "War3.w3mod:_Locales/deDE.w3mod:Sound/X.mp3" → "Sound\X.mp3" (the path maps store). */
export function logicalPath(full: string): string {
  let p = full.replace(/^War3\.w3mod:/i, "");
  for (let m; (m = /^(?:_Locales\/[^:]+\.w3mod|_[A-Za-z]+\.w3mod):/i.exec(p));) p = p.slice(m[0].length);
  return p.replace(/\//g, "\\");
}

/** A sound's global name from a file name: gg_snd_<letters, digits, _>. */
export function soundName(file: string, taken: Set<string>): string {
  const base = (file.split(/[\\/]/).pop() ?? "Sound").replace(SOUND_EXTENSIONS, "").replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "Sound";
  const stem = /^[A-Za-z]/.test(base) ? base : `Snd${base}`;
  for (let n = 1; ; n++) {
    const name = `gg_snd_${stem}${n > 1 ? n : ""}`;
    if (!taken.has(name)) return name;
  }
}

/** A game sound label (UI\SoundInfo\*.slk row) as the World Editor fills a sound from it. */
export interface SoundLabel { name: string; files: string[]; eax: string; channel: number; volume: number; flags: string }

/** Labels by the files they play: full paths (without extension, lower case, backslashes) and,
 *  for rows that list bare names (unit acknowledgements), "name:<file name>". */
export function labelIndex(tables: Record<string, string>[][]): Map<string, SoundLabel> {
  const out = new Map<string, SoundLabel>();
  const add = (key: string, l: SoundLabel) => { if (!out.has(key)) out.set(key, l); };
  for (const rows of tables) {
    for (const r of rows) {
      if (!r.SoundName || !r.FileNames) continue;
      const label: SoundLabel = { name: r.SoundName, files: [], eax: r.EAXFlags || "DefaultEAXON", channel: Number(r.Channel) || 0, volume: Number(r.Volume) || 127, flags: r.Flags ?? "" };
      for (const f of r.FileNames.split(",")) {
        const path = f.trim().replace(/\//g, "\\");
        label.files.push(path);
        add(path.includes("\\") ? labelKey(path) : `name:${labelKey(path)}`, label);
      }
    }
  }
  return out;
}
const labelKey = (path: string) => path.replace(/\//g, "\\").replace(SOUND_EXTENSIONS, "").toLowerCase();

/** The label that plays `file` (by its path, else by its bare name). */
export function findLabel(index: Map<string, SoundLabel>, file: string): SoundLabel | undefined {
  const key = labelKey(file);
  return index.get(key) ?? index.get(`name:${key.split("\\").pop()}`);
}

/** A new entry for `file`: labelled game sounds take the label (settings unset, as the World
 *  Editor writes them), other files the editor's usual defaults. */
export function newSound(name: string, file: string, opts: { music?: boolean; imported?: boolean; label?: SoundLabel }): Sound {
  const common = {
    name, file, variableName: name, dialogueTextKey: -1, dialogueText: "", speakerNameKey: -1, speakerName: "", unknown1: 0,
    speakerUnitType: "", facialAnimationLabel: "", facialAnimationGroupLabel: "", facialAnimationSetFile: "",
  };
  if (opts.music) {
    return { ...common, eaxEffect: "DefaultEAXON", flags: MUSIC | (opts.imported ? IMPORTED : 0), fadeInRate: 0, fadeOutRate: 0, volume: 127,
      pitch: 1, pitchVariance: 0, priority: 8, channel: 0, minDistance: 0, maxDistance: 10000, distanceCutoff: 3000, coneInside: 0, coneOutside: 0,
      coneOutsideVolume: 0, coneOrientation: [0, 0, 0], assetLabel: "", assetFile: "", unknown2: 0 };
  }
  if (opts.label) {
    const l = opts.label;
    const flags = (/LOOPING/.test(l.flags) ? LOOPING : 0) | (/WANT3D/.test(l.flags) ? THREE_D | STOP_OUT_OF_RANGE : 0);
    return { ...common, eaxEffect: l.eax, flags, fadeInRate: 10, fadeOutRate: 10, volume: 127, pitch: UNSET, pitchVariance: UNSET, priority: 8,
      channel: -1, minDistance: UNSET, maxDistance: UNSET, distanceCutoff: UNSET, coneInside: UNSET, coneOutside: UNSET, coneOutsideVolume: 0,
      coneOrientation: [UNSET, UNSET, UNSET], assetLabel: l.name, assetFile: file, unknown2: 0 };
  }
  return { ...common, eaxEffect: "DefaultEAXON", flags: opts.imported ? IMPORTED : 0, fadeInRate: 10, fadeOutRate: 10, volume: 127, pitch: 1,
    pitchVariance: 0, priority: 8, channel: 0, minDistance: 0, maxDistance: 10000, distanceCutoff: 3000, coneInside: 0, coneOutside: 0,
    coneOutsideVolume: 0, coneOrientation: [0, 0, 0], assetLabel: "", assetFile: "", unknown2: opts.imported ? 1 : 0 };
}
