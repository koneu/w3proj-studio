// A campaign's chapter maps as files: export, replace and remove. A map is a project of its own under maps/<file>/
// (packed into the campaign when it is built) or a packed file in map/. Nothing is deleted: a removed or replaced map
// moves into the project's build/ folder (which git ignores and nothing packs), so undo can put it back.

import { toProjectPath } from "../../lib/formats/archivepath";
import { wouldDelete } from "../../lib/syncdeletes";

/** Where removed and replaced maps wait, below the project root. */
export const HOLD = "build/campaign-maps";

/** The file operations the campaign's maps need (project paths; a test stands in for them). */
export interface CampaignFs {
  /** Whether a project path is there (a file, or a folder with something in it). */
  exists(projectPath: string): Promise<boolean>;
  /** Moves a file or folder within the project (fails if the target exists). */
  rename(from: string, to: string): Promise<void>;
  /** Unpacks the map file `src` (on disk) as a project into the project folder `dir`. With `replaces` (the project
   *  folder `dir` will take the place of), it writes nothing and throws the backend's `WOULD_DELETE: <list>` when
   *  that one has files the map doesn't (lib/syncdeletes, paths from `replaces`). */
  unpack(src: string, dir: string, replaces?: string): Promise<void>;
  /** Copies a file (disk or project paths). */
  copy(from: string, to: string): Promise<void>;
  /** Packs the project folder `dir` into the map file `output` (on disk). */
  pack(dir: string, output: string): Promise<void>;
}

/** A done file change, for the editor's undo and redo. */
export interface FileStep { undo(): Promise<void>; redo(): Promise<void> }

/** The project path of a campaign map: its project folder, or its packed file. */
export const mapPlace = (map: string, project: boolean) => `${project ? "maps" : "map"}/${toProjectPath(map)}`;

let counter = 0;
/** A fresh folder name below HOLD for one operation. */
const holdDir = () => `${HOLD}/${Date.now()}-${++counter}`;
const base = (place: string) => place.split("/").pop()!;

/** Moves `from` to `to`, refusing when `to` is taken or `from` is gone (something changed since). */
async function move(fs: CampaignFs, from: string, to: string) {
  if (!(await fs.exists(from))) throw new Error(`${from} isn't there any more.`);
  if (await fs.exists(to)) throw new Error(`${to} is in the way.`);
  await fs.rename(from, to);
}

/** Removes a map from the campaign: it moves below HOLD. */
export async function removeMap(fs: CampaignFs, map: string, project: boolean): Promise<FileStep> {
  const place = mapPlace(map, project), held = `${holdDir()}/${base(place)}`;
  await move(fs, place, held);
  return { undo: () => move(fs, held, place), redo: () => move(fs, place, held) };
}

/** Replaces a map with the map file `src`: unpacked (a project map) or copied (a packed one) below HOLD first, so a
 *  file that can't be read changes nothing; then the old one moves away and the new one into its place. When the old
 *  project has files the new map doesn't (ones the user added under map/), `askLoss` is asked first with them (from
 *  the project root), as a sync asks before deleting; null when it says no (nothing changed). */
export async function replaceMap(
  fs: CampaignFs, map: string, project: boolean, src: string, askLoss: (gone: string[]) => Promise<boolean>,
): Promise<FileStep | null> {
  const place = mapPlace(map, project);
  if (!(await fs.exists(place))) throw new Error(`${place} isn't there.`);
  const dir = holdDir(), incoming = `${dir}/new/${base(place)}`, old = `${dir}/old/${base(place)}`;
  if (project) {
    try {
      await fs.unpack(src, incoming, place);
    } catch (e) {
      const gone = wouldDelete(e);
      if (!gone) throw e;
      if (!(await askLoss(gone.map((g) => `${place}/${g}`)))) return null;
      await fs.unpack(src, incoming);
    }
  } else await fs.copy(src, incoming);
  await move(fs, place, old);
  try {
    await move(fs, incoming, place);
  } catch (e) {
    await fs.rename(old, place);
    throw e;
  }
  /** `out` leaves the map's place, `back` takes it; if that fails, `out` comes back. */
  const swap = async (out: string, back: string) => {
    await move(fs, place, out);
    try { await move(fs, back, place); } catch (e) { await fs.rename(out, place); throw e; }
  };
  return { undo: () => swap(incoming, old), redo: () => swap(old, incoming) };
}

/** Saves a map as a map file `target` on disk: a project map packed, a packed one copied. */
export async function exportMap(fs: CampaignFs, map: string, project: boolean, target: string): Promise<void> {
  const place = mapPlace(map, project);
  if (!(await fs.exists(place))) throw new Error(`${place} isn't there.`);
  if (project) await fs.pack(place, target); else await fs.copy(place, target);
}
