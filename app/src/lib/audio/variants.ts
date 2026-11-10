// A sound is named in a map by one path, but the game and the World Editor take it under its other sound
// extensions too: Blizzard's maps list .flac where the storage holds .ogg (the game has
// AshenvaleBrazierLoop1.ogg for AshenvaleBrazierLoop1.flac), and the editor's SetSoundDuration is the .ogg's length.

const EXTENSIONS = [".flac", ".ogg", ".mp3", ".wav"];

/** The path and its forms under the other sound extensions, the path itself first. */
export function soundVariants(path: string): string[] {
  const rest = EXTENSIONS.map((e) => path.replace(/\.\w+$/, e)).filter((p) => p.toLowerCase() !== path.toLowerCase());
  return [path, ...rest];
}
