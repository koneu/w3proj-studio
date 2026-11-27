// The sound changes of the AI tools (MCP set_sound, remove_sound), on the document war3map.w3s.json holds: new sounds
// as the Sound Editor's "Add as sound" / "Add as music" makes them (newSound), numbers within what its fields take.

import type { StoredNumber } from "../../lib/formats/numbers";
import { SOUND_LIMITS, soundNumber } from "./numbers";
import { isUnset, LOOPING, MUSIC, newSound, soundName, STOP_OUT_OF_RANGE, THREE_D, UNSET, type Sound, type SoundLabel } from "./sounds";

export interface ToolSoundsDoc { format?: string; version: number; sounds: Sound[] }
export const emptySounds = (): ToolSoundsDoc => ({ format: "w3proj.sounds/1", version: 3, sounds: [] });

/** What set_sound needs to know of the game and the map. */
export interface SoundFacts {
  /** Where a sound file is: among the game's files, among the map's imports, or nowhere. */
  fileKind(path: string): "game" | "map" | null;
  /** The game's sound label that plays a game file, if one does. */
  label(path: string): SoundLabel | undefined;
  /** The game's channels and effects (EAX), when its data could be read. */
  channels?: readonly number[];
  effects?: readonly string[];
}

const NAME = /^gg_snd_[A-Za-z][A-Za-z0-9_]*$/;
const fullName = (name: string) => (name.startsWith("gg_snd_") ? name : `gg_snd_${name}`);

/** The numbers set_sound takes: how the file stores each, its limits (the Sound Editor's), and what "unset" is (null
 *  given for it: the label's or the game's default applies). */
const NUMBERS: Record<string, { label: string; kind: StoredNumber; min?: number; max?: number; unset?: number; sound?: boolean }> = {
  volume: { label: "Volume", kind: "i32", ...SOUND_LIMITS.volume, unset: -1 },
  fadeInRate: { label: "Fade in rate", kind: "u32", ...SOUND_LIMITS.fadeInRate },
  fadeOutRate: { label: "Fade out rate", kind: "u32", ...SOUND_LIMITS.fadeOutRate },
  pitch: { label: "Pitch", kind: "f32", ...SOUND_LIMITS.pitch, unset: UNSET, sound: true },
  minDistance: { label: "Minimum distance", kind: "f32", ...SOUND_LIMITS.minDistance, unset: UNSET, sound: true },
  maxDistance: { label: "Maximum distance", kind: "f32", ...SOUND_LIMITS.maxDistance, unset: UNSET, sound: true },
  distanceCutoff: { label: "Distance cutoff", kind: "f32", ...SOUND_LIMITS.distanceCutoff, unset: UNSET, sound: true },
};
const FLAGS: Record<string, number> = { looping: LOOPING, is3d: THREE_D, stopOutOfRange: STOP_OUT_OF_RANGE };

/**
 * set_sound on `doc`: the sound `name` (with or without gg_snd_) takes the values given, or is made from `file`, as
 * the Sound Editor adds one (a game sound with a label takes the label's values; without a name it is named after its
 * file). A file neither the game nor the map has, a name that isn't a variable name, a number the editor's field
 * refuses, an option music hasn't: the call is refused, nothing changed. What happened.
 */
export function setSound(doc: ToolSoundsDoc, args: Record<string, unknown>, facts: SoundFacts): { created: boolean; changed: boolean; sound: Sound } {
  const given = typeof args.name === "string" && args.name.trim() ? fullName(args.name.trim()) : null;
  const file = args.file === undefined ? null : typeof args.file === "string" && args.file.trim() ? args.file.trim() : undefined;
  if (file === undefined) throw new Error("file must be a sound file's path, like Sound\\\\Ambient\\\\Rain.flac or war3mapImported\\\\Horn.mp3.");
  if (args.music !== undefined && typeof args.music !== "boolean") throw new Error("music must be true or false.");
  if (!given && !file) throw new Error("set_sound needs a name, or a file to make a sound from.");
  const kind = file ? facts.fileKind(file) : null;
  if (file && !kind) throw new Error(`Neither the game nor the map's imports have the sound file ${file}. search_game_files finds the game's (filter "Sound"); list_imports gives the map's.`);
  const old = given ? doc.sounds.find((s) => s.name === given) : undefined;
  const created = !old;
  let next: Sound;
  if (old) {
    next = structuredClone(old);
    if (args.music !== undefined && args.music !== !!(old.flags & MUSIC)) throw new Error(`${old.name} is ${old.flags & MUSIC ? "music" : "a sound"}: remove it and add it again to change that.`);
    if (file) {
      next.file = file.replace(/\\/g, "/");
      if (next.assetFile) next.assetFile = next.file;
    }
  } else {
    if (!file) throw new Error(`There's no sound ${given}: to make it, give file. Sounds: ${doc.sounds.map((s) => s.name).join(", ") || "(none)"}.`);
    const name = given ?? soundName(file, new Set(doc.sounds.map((s) => s.name)));
    if (!NAME.test(name) || name.endsWith("_")) throw new Error("A sound's name starts with a letter and uses letters, digits and _ (not at the end).");
    const music = args.music === true;
    next = newSound(name, file, { music, imported: kind === "map", label: !music && kind === "game" ? facts.label(file) : undefined });
  }
  const music = !!(next.flags & MUSIC);
  for (const [key, bit] of Object.entries(FLAGS)) {
    if (args[key] === undefined) continue;
    if (typeof args[key] !== "boolean") throw new Error(`${key} must be true or false.`);
    if (music) throw new Error(`${key} is for sounds; ${next.name} is music.`);
    next.flags = args[key] ? next.flags | bit : next.flags & ~bit;
  }
  for (const [key, n] of Object.entries(NUMBERS)) {
    const v = args[key];
    if (v === undefined) continue;
    if (n.sound && music) throw new Error(`${key} is for sounds; ${next.name} is music.`);
    if (v === null) {
      if (n.unset === undefined) throw new Error(`${n.label} can't be unset: give a number.`);
      (next[key] as number) = n.unset;
      continue;
    }
    if (typeof v !== "number") throw new Error(`${n.label} must be a number${n.unset !== undefined ? ", or null for the default" : ""}.`);
    // Music's fade rates aren't held to the sound dialog's limits (the Sound Editor's own fields aren't either).
    const limits = music && (key === "fadeInRate" || key === "fadeOutRate") ? {} : { min: n.min, max: n.max };
    const t = soundNumber(n.kind, String(v), n.label, limits);
    if ("refused" in t) throw new Error(`Not ${created ? "added" : "changed"}: ${t.refused}`);
    (next[key] as number) = t.value;
  }
  if (args.channel !== undefined) {
    if (music) throw new Error(`channel is for sounds; ${next.name} is music.`);
    const c = args.channel;
    if (!Number.isInteger(c) || (facts.channels?.length ? !facts.channels.includes(c as number) && !(c === -1 && next.assetLabel) : (c as number) < -1)) {
      throw new Error(`channel must be one of the game's channels${facts.channels?.length ? ` (${facts.channels.join(", ")})` : ""}${next.assetLabel ? ", or -1 for the label's" : ""}.`);
    }
    next.channel = c as number;
  }
  if (args.effect !== undefined) {
    if (music) throw new Error(`effect is for sounds; ${next.name} is music.`);
    if (typeof args.effect !== "string" || (facts.effects?.length && !facts.effects.includes(args.effect))) {
      throw new Error(`effect must be one of the game's sound effects${facts.effects?.length ? `: ${facts.effects.join(", ")}` : ""}.`);
    }
    next.eaxEffect = args.effect;
  }
  const changed = created || JSON.stringify(next) !== JSON.stringify(old);
  if (created) doc.sounds.push(next);
  else if (changed) doc.sounds[doc.sounds.indexOf(old!)] = next;
  return { created, changed, sound: next };
}

/** remove_sound on `doc`; the sound that went. */
export function removeSound(doc: ToolSoundsDoc, name: unknown): Sound {
  const at = typeof name === "string" ? doc.sounds.findIndex((s) => s.name === fullName(name.trim())) : -1;
  if (at < 0) throw new Error(`There's no sound ${typeof name === "string" ? fullName(name.trim()) : String(name)}. Sounds: ${doc.sounds.map((s) => s.name).join(", ") || "(none)"}.`);
  return doc.sounds.splice(at, 1)[0];
}

/** A sound as list_sounds and set_sound's answer show it: unset numbers (the label's or the game's default) left out. */
export function describeSound(s: Sound) {
  const music = !!(s.flags & MUSIC);
  const num = (key: string) => {
    const v = s[key] as number, unset = NUMBERS[key].unset;
    return unset !== undefined && (unset === UNSET ? isUnset(v) : v === unset) ? {} : { [key]: v };
  };
  return {
    name: s.name, file: s.file, ...(music ? { music: true } : {}), ...(s.assetLabel ? { label: s.assetLabel } : {}),
    ...(music ? {} : { looping: !!(s.flags & LOOPING), is3d: !!(s.flags & THREE_D), stopOutOfRange: !!(s.flags & STOP_OUT_OF_RANGE), channel: s.channel, effect: s.eaxEffect }),
    ...num("volume"), fadeInRate: s.fadeInRate, fadeOutRate: s.fadeOutRate,
    ...(music ? {} : { ...num("pitch"), ...num("minDistance"), ...num("maxDistance"), ...num("distanceCutoff") }),
  };
}
