// Export Sound and Replace Internal Sound: a sound file out of the map (or the game), and a file from
// disk into its place. A sound is named in the map by one path; the game takes it under its other
// sound extensions too (Blizzard's maps list .flac where the archive holds .ogg), so a replacement in
// another format keeps the sound's own path.

import type { W3Api } from "../../extensions/api";
import { toArchiveName, toProjectPath } from "../../lib/formats/archivepath";
import { SOUND_EXTENSIONS } from "./sounds";

export const SOUND_FILTER = [{ name: "Sound files", extensions: ["flac", "wav", "mp3", "ogg"] }];
const EXTENSIONS = [".flac", ".ogg", ".mp3", ".wav"];

/** An import list entry (war3map.imp). */
export interface ImportEntry { flags: number; path: string }
/** Flags of an entry with a path of its own, as the Import Manager writes it. */
const CUSTOM_PATH_FLAGS = 13;
const STANDARD_FLAGS = [5, 8];
const IMPORT_FOLDER = "war3mapImported";

const extOf = (p: string) => (/\.(\w+)$/.exec(p)?.[1] ?? "").toLowerCase();
const withExt = (p: string, ext: string) => p.replace(/\.\w+$/, `.${ext}`);
const projectOf = (archive: string) => `map/${toProjectPath(archive)}`;

/** The path and its forms under the other sound extensions, the path itself first. */
export function soundVariants(path: string): string[] {
  const rest = EXTENSIONS.map((e) => path.replace(/\.\w+$/, e)).filter((p) => p.toLowerCase() !== path.toLowerCase());
  return [path, ...rest];
}

export interface FoundSound { bytes: Uint8Array; path: string; source: "map" | "game" }

/** A sound file's bytes: the map's own first, then the game's (`gameFiles`: logical path → storage path,
 *  or null to ask the game by plain path). Null when neither has it, under any sound extension. */
export async function findSoundFile(w3: W3Api, path: string, gameFiles: Map<string, string> | null): Promise<FoundSound | null> {
  for (const variant of soundVariants(path)) {
    const bytes = await w3.workspace.readBytes(projectOf(variant)).catch(() => null);
    if (bytes) return { bytes, path: variant, source: "map" };
  }
  for (const variant of soundVariants(path)) {
    const bytes = await w3.game.read(gameFiles?.get(variant) ?? variant).catch(() => null);
    if (bytes) return { bytes, path: variant, source: "game" };
  }
  return null;
}

/** Export Sound: asks for a file and writes the sound there; its path, null when cancelled. */
export async function exportSound(w3: W3Api, path: string, gameFiles: Map<string, string> | null): Promise<string | null> {
  if (!path.trim()) throw new Error("This sound has no file.");
  const found = await findSoundFile(w3, path, gameFiles);
  if (!found) throw new Error(`Can't find ${path}, neither in the map nor in the game.`);
  const name = found.path.split(/[\\/]/).pop()!;
  const ext = extOf(name);
  const target = await w3.window.pickSaveFile({ title: "Export Sound", defaultPath: name, filters: [{ name: `${ext.toUpperCase()} sound`, extensions: [ext] }] });
  if (!target) return null;
  await w3.backend.writeBytes(target, found.bytes);
  void w3.window.showInfo(`Exported ${name} (${found.source === "map" ? "from the map" : "from the game"}) to ${target}`);
  return target;
}

export interface ReplacePlan {
  /** Project path the new file is copied to. */
  write: string;
  /** Project path of the file it replaces and that goes, when the format changes; else null. */
  remove: string | null;
  /** The sound's path as the archive will hold it. */
  archive: string;
  /** The import list afterwards, and whether it differs. */
  imports: ImportEntry[];
  importsChanged: boolean;
  /** Whether the sound's file was in the map (replaced) or only in the game (overridden). */
  inMap: boolean;
}

/** What replacing the sound at `soundFile` with a file called `sourceName` does. `projectFiles`: the
 *  project's files (any case); `imports`: the import list as it is. Throws for a source that is no sound. */
export function planReplace(opts: { soundFile: string; sourceName: string; projectFiles: Iterable<string>; imports: ImportEntry[] }): ReplacePlan {
  const newExt = extOf(opts.sourceName);
  if (!SOUND_EXTENSIONS.test(opts.sourceName)) throw new Error(`${opts.sourceName} isn't a sound file (flac, wav, mp3 or ogg).`);
  if (!opts.soundFile.trim() || !/\.\w+$/.test(opts.soundFile)) throw new Error("This sound has no file name to replace.");
  const files = new Set([...opts.projectFiles].map((p) => p.replace(/\\/g, "/").toLowerCase()));
  const existing = soundVariants(opts.soundFile).find((v) => files.has(projectOf(v).toLowerCase()));
  // The sound keeps its own path; only the extension follows the new file.
  const archive = withExt(opts.soundFile, newExt);
  const write = projectOf(archive);
  const remove = existing && projectOf(existing).toLowerCase() !== write.toLowerCase() ? projectOf(existing) : null;

  let changed = false;
  const imports = opts.imports.map((e) => ({ ...e }));
  const listed = (e: ImportEntry, project: string) => {
    const forms = STANDARD_FLAGS.includes(e.flags) ? [`${IMPORT_FOLDER}\\${e.path}`, e.path] : [e.path];
    return forms.some((f) => soundVariants(f).some((v) => projectOf(v).toLowerCase() === project.toLowerCase()));
  };
  let found = false;
  for (const e of imports) {
    if (existing && listed(e, projectOf(existing))) {
      found = true;
      if (remove) { e.path = withExt(e.path, newExt); changed = true; }
    } else if (listed(e, write)) found = true;
  }
  if (!found) { imports.push({ flags: CUSTOM_PATH_FLAGS, path: archive }); changed = true; }
  return { write, remove, archive, imports, importsChanged: changed, inMap: !!existing };
}

/** Replace Internal Sound: asks for a sound file and puts it in the sound's place in the map. A sound the
 *  map has no file of (one of the game's) gets the file as an override under the same path. Asks first
 *  and makes a checkpoint. The sound entry itself (war3map.w3s) doesn't change. Returns the project path
 *  written, null when cancelled. */
export async function replaceSound(w3: W3Api, soundFile: string): Promise<string | null> {
  if (!w3.workspace.project()) throw new Error("Open or import a project first.");
  const open = w3.editors.unsavedPaths().filter((p) => /^map\/war3map\.imp(\.json)?$/i.test(p));
  if (open.length) throw new Error(`Save or discard the changes of ${open.join(", ")} first.`);
  const source = await w3.window.pickFile({ title: "Replace Internal Sound", filters: SOUND_FILTER });
  if (!source) return null;
  const name = source.split(/[\\/]/).pop()!;
  const listPath = "map/war3map.imp.json";
  const raw = w3.workspace.files().some((f) => f.path.toLowerCase() === "map/war3map.imp") && !w3.workspace.files().some((f) => f.path.toLowerCase() === listPath);
  const root = w3.workspace.project()!.root;
  const text = w3.workspace.files().some((f) => f.path.toLowerCase() === listPath) ? await w3.workspace.readText(listPath)
    : raw ? await w3.backend.invoke<string>("codec_decode", { root, path: "map/war3map.imp" }) : null;
  const doc = text === null ? { format: "w3proj.imports/1", version: 1, files: [] as ImportEntry[] } : JSON.parse(text) as { format?: string; version: number; files: ImportEntry[] };
  doc.files ??= [];
  const plan = planReplace({ soundFile, sourceName: name, projectFiles: w3.workspace.files().map((f) => f.path), imports: doc.files });
  const what = plan.inMap ? `The map's ${toArchiveName(plan.write.slice(4))} is replaced` : `The game's ${soundFile} is overridden by a file of the map at ${plan.archive}`;
  if (!(await w3.window.confirm(`Replace the sound ${soundFile} with ${name}? ${what}${plan.remove ? `, and ${toArchiveName(plan.remove.slice(4))} removed` : ""}. A checkpoint is made first, to come back to.`, "Replace", 60_000))) return null;
  await w3.commands.execute("w3.checkpoints.create", { quiet: true });
  await w3.workspace.copy(source, plan.write);
  if (plan.remove) await w3.workspace.delete(plan.remove);
  if (plan.importsChanged) {
    doc.files = plan.imports;
    if (raw) await w3.backend.invoke("codec_write", { root, path: "map/war3map.imp", text: JSON.stringify({ format: "w3proj.imports/1", ...doc }) });
    else await w3.workspace.writeText(listPath, await w3.backend.invoke<string>("codec_canonicalize", { root, path: listPath, text: JSON.stringify(doc) }));
  }
  await w3.workspace.refresh();
  void w3.window.showInfo(`Replaced ${soundFile} with ${name}.`);
  return plan.write;
}
