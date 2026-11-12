// Sound data helpers: game paths as maps refer to them, new entries the way
// the World Editor writes them, and the game's sound labels (UI\SoundInfo), and where a map uses its sounds.

import { triggerRefs } from "../../lib/triggers/refs";
import { customScriptParams } from "../../lib/triggers/rename";
import type { TriggerFile } from "../../lib/triggers/wtg";

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
 *  Editor writes them), other files the editor's usual defaults. The word after the facial animation file (`unknown2`)
 *  is 1, as on every sound without a dialogue in the game's maps (plain, labelled, imported and music alike; 0 only on
 *  dialogue): the generated script's dialogue keys go by it (lib/script/jass.ts). */
export function newSound(name: string, file: string, opts: { music?: boolean; imported?: boolean; label?: SoundLabel }): Sound {
  const common = {
    name, file, variableName: name, dialogueTextKey: -1, dialogueText: "", speakerNameKey: -1, speakerName: "", unknown1: 0,
    speakerUnitType: "", facialAnimationLabel: "", facialAnimationGroupLabel: "", facialAnimationSetFile: "", unknown2: 1,
  };
  if (opts.music) {
    return { ...common, eaxEffect: "DefaultEAXON", flags: MUSIC | (opts.imported ? IMPORTED : 0), fadeInRate: 0, fadeOutRate: 0, volume: 127,
      pitch: 1, pitchVariance: 0, priority: 8, channel: 0, minDistance: 0, maxDistance: 10000, distanceCutoff: 3000, coneInside: 0, coneOutside: 0,
      coneOutsideVolume: 0, coneOrientation: [0, 0, 0], assetLabel: "", assetFile: "" };
  }
  if (opts.label) {
    const l = opts.label;
    const flags = (/LOOPING/.test(l.flags) ? LOOPING : 0) | (/WANT3D/.test(l.flags) ? THREE_D | STOP_OUT_OF_RANGE : 0);
    return { ...common, eaxEffect: l.eax, flags, fadeInRate: 10, fadeOutRate: 10, volume: 127, pitch: UNSET, pitchVariance: UNSET, priority: 8,
      channel: -1, minDistance: UNSET, maxDistance: UNSET, distanceCutoff: UNSET, coneInside: UNSET, coneOutside: UNSET, coneOutsideVolume: 0,
      coneOrientation: [UNSET, UNSET, UNSET], assetLabel: l.name, assetFile: file };
  }
  return { ...common, eaxEffect: "DefaultEAXON", flags: opts.imported ? IMPORTED : 0, fadeInRate: 10, fadeOutRate: 10, volume: 127, pitch: 1,
    pitchVariance: 0, priority: 8, channel: 0, minDistance: 0, maxDistance: 10000, distanceCutoff: 3000, coneInside: 0, coneOutside: 0,
    coneOutsideVolume: 0, coneOrientation: [0, 0, 0], assetLabel: "", assetFile: "" };
}

// ---- where the map's sounds are used ---------------------------------------------------

/** One place that names a sound. */
export interface SoundUse {
  kind: "trigger" | "script" | "region";
  /** A trigger's or region's name, or a script's file/part ("war3map.j", "Custom script header"). */
  where: string;
  /** The 1-based line in a script text. */
  line?: number;
}

/** What names the map's sounds besides the sound list: the GUI triggers (parameters and Custom Script actions), script
 *  texts (the map script, the custom script header and texts) and the regions' ambient sounds. */
export interface SoundUsageInput {
  triggers?: TriggerFile | null;
  /** Script texts; `generated`: the map script as the generator writes it (its sound declarations and InitSounds
   *  don't count as use). */
  scripts?: { where: string; text: string | null; generated?: boolean }[];
  regions?: { name: string; sound?: string }[];
}

/** The generator's own sound lines: the declarations (`sound gg_snd_X = null`, Lua `gg_snd_X = nil`) and the InitSounds
 *  function, in JASS and Lua. Line numbers stay (the lines become empty). */
export function withoutSoundSetup(text: string): string {
  const lines = text.split("\n");
  let inInit = false;
  return lines.map((line) => {
    if (inInit) { if (/^\s*(?:endfunction|end)\b/.test(line)) inInit = false; return ""; }
    if (/^\s*function\s+InitSounds\b/.test(line)) { inInit = true; return ""; }
    if (/^\s*(?:(?:sound|string)\s+)?gg_snd_\w+\s*(?:=\s*(?:null|nil))?\s*$/.test(line)) return "";
    return line;
  }).join("\n");
}

/** Where each sound of `names` (gg_snd_…) is used; every name has an entry, [] when it is unused. Names compare
 *  without regard to case (GUI lookups do; a sound counted used by mistake only stays). A text that is null counts
 *  as nothing. */
export function soundUsages(names: readonly string[], input: SoundUsageInput): Map<string, SoundUse[]> {
  const out = new Map<string, SoundUse[]>(names.map((n) => [n, []]));
  const byLower = new Map<string, string[]>();
  for (const n of names) { const k = n.toLowerCase(); byLower.set(k, [...(byLower.get(k) ?? []), n]); }
  const add = (ref: string, use: SoundUse) => {
    for (const n of byLower.get(ref.toLowerCase()) ?? []) {
      const list = out.get(n)!;
      if (!list.some((u) => u.kind === use.kind && u.where === use.where && u.line === use.line)) list.push(use);
    }
  };
  const scan = (text: string | null, where: string, kind: SoundUse["kind"], lines: boolean) => {
    if (!text) return;
    const rows = lines ? text.split("\n") : [text];
    rows.forEach((row, i) => { for (const m of row.matchAll(/(?<![A-Za-z0-9_])gg_snd_\w+/g)) add(m[0], lines ? { kind, where, line: i + 1 } : { kind, where }); });
  };
  const file = input.triggers;
  if (file) {
    for (const [ref, users] of triggerRefs(file)) if (ref.startsWith("gg_snd_")) for (const t of users) add(ref, { kind: "trigger", where: t });
    for (const it of file.items) {
      if (!("ecas" in it) || it.type === 16) continue;
      for (const p of customScriptParams({ ...file, items: [it] })) scan(p.value, it.name, "trigger", false);
    }
  }
  for (const s of input.scripts ?? []) scan(s.generated && s.text ? withoutSoundSetup(s.text) : s.text, s.where, "script", true);
  for (const r of input.regions ?? []) if (r.sound) add(r.sound, { kind: "region", where: r.name });
  return out;
}

/** The sounds of `names` that nothing uses. */
export function unusedSounds(names: readonly string[], input: SoundUsageInput): string[] {
  const used = soundUsages(names, input);
  return names.filter((n) => !used.get(n)!.length);
}

/** A use as a line of text. */
export function describeUse(u: SoundUse): string {
  return u.kind === "trigger" ? `trigger ${u.where}` : u.kind === "region" ? `region ${u.where} (ambient sound)` : `${u.where}${u.line ? `, line ${u.line}` : ""}`;
}
