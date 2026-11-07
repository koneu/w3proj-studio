// Where a texture named by a Reforged model lives in the game's data.
//
// The game's HD and DE models were exported on the artists' machines, and many keep that machine's
// folder in front of the game path: "C:/Users/<artist>/Box/Classic Games/Warcraft3/assets/Art/HD//
// Doodads/Terrain/X/X_Diffuse.tif". Looking that up as it stands finds nothing. The part that
// counts is what follows the art folder ("Art/HD//", "Art/DE/") or the game's own mod folders
// ("War3.w3mod/_DE.w3mod/"); the file itself is stored as .dds. Paths without a drive are game
// paths already ("Textures/CityWall_Diffuse.tif").

/** What stands in front of the game path on a build machine: the art folder of a mode, or the
 *  game's mod folders. The last match in the path wins. */
const ART_FOLDER = /^(?:.*[\\/])?art[\\/](?:hd|de|sd|classic)[\\/]+/i;
const MOD_FOLDERS = /^(?:.*[\\/])?war3\.w3mod[\\/](?:_(?:hd|de|teen)\.w3mod[\\/])*/i;
const DRIVE_OR_UNC = /^(?:[a-z]:[\\/]|[\\/]{2})/i;

/** Whether a path names a place on someone's disk instead of a game or map file. */
export const isMachinePath = (p: string) => DRIVE_OR_UNC.test(p);

/** The game path ("/" separators, no leading slash) a model's texture path stands for, or null
 *  when it is an absolute path with no recognisable game part (only the file name is left). */
export function gamePartOf(raw: string): string | null {
  const p = raw.trim();
  if (!isMachinePath(p)) return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  for (const re of [ART_FOLDER, MOD_FOLDERS]) {
    const m = re.exec(p);
    if (m && m[0].length < p.length) return p.slice(m[0].length).replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  }
  return null;
}

/** A name the game never stores: HD models name their textures as the artists exported them
 *  (.tif), and the game has none of those (0 of its files in November 2026; it keeps them as .dds).
 *  Asking for one is a read that always fails: on GoldRush 297 of 994. */
const NEVER_IN_GAME = /\.tif$/i;

/** `names` in the order to read them: those the game never stores (.tif) last, the others in
 *  their order. As a .tif is never found in the game, the first game file found doesn't change; it
 *  is only found sooner. (A map's own .tif import now loses to a .dds of the same name, the
 *  game's or the map's.) */
export function neverStoredLast(names: string[]): string[] {
  return [...names.filter((n) => !NEVER_IN_GAME.test(n)), ...names.filter((n) => NEVER_IN_GAME.test(n))];
}

/** Game paths to try for a model's texture, best first: the game part as written, then as .dds
 *  (what the game stores .blp, .tif, .tga and .png names as). `modelPath`: the model that names
 *  it, for paths with no game part (the file next to the model, then in Textures). */
export function textureCandidates(raw: string, modelPath = ""): string[] {
  const base = gamePartOf(raw);
  const names = base ? [base] : (() => {
    const file = raw.replace(/\\/g, "/").split("/").pop() ?? "";
    const dir = modelPath.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    return [dir ? `${dir}/${file}` : file, `Textures/${file}`].filter(Boolean);
  })();
  const out: string[] = [];
  for (const n of names) {
    out.push(n);
    if (/\.(blp|tif|tiff|tga|png|jpg)$/i.test(n)) out.push(n.replace(/\.\w+$/, ".dds"));
  }
  return [...new Set(out)];
}
