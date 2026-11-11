// Checkpoints are packed maps named after the time they were made ("My Map 2026-11-05 10-30-00.w3x"
// in build/checkpoints). Nothing else records them: the names are the list.

import type { FileInfo } from "../../extensions/api";

const two = (n: number) => String(n).padStart(2, "0");
const STAMP = /(\d{4})-(\d\d)-(\d\d) (\d\d)-(\d\d)-(\d\d)\.\w+$/;

/** File name of a checkpoint of `output` (the project's packed map) made at `at`. */
export function checkpointName(output: string, at: Date): string {
  const file = output.split(/[\\/]/).pop() ?? "map.w3x";
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file, ext = dot > 0 ? file.slice(dot) : ".w3x";
  return `${stem} ${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}-${two(at.getMinutes())}-${two(at.getSeconds())}${ext}`;
}

/** When a checkpoint was made (ms), null for other files. */
export function checkpointTime(name: string): number | null {
  const m = STAMP.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return new Date(y, mo - 1, d, h, mi, s).getTime();
}

/** The checkpoints among `names` (paths below build/checkpoints, `/` between folders), newest first. Only files
 *  directly in the folder are checkpoints: what is in a folder below (recovered/: strays an older version left)
 *  is never counted toward the number kept, nor pruned. */
export function newestFirst(names: string[]): { name: string; time: number }[] {
  return names.flatMap((name) => {
    if (/[\\/]/.test(name)) return [];
    const time = checkpointTime(name);
    return time === null ? [] : [{ name, time }];
  }).sort((a, b) => b.time - a.time);
}

/** The folder below build/checkpoints that stray checkpoints of an older version were moved to (src-tauri strays.rs). */
export const RECOVERED = "recovered";

/** The recovered checkpoints among `names` (files directly in recovered/, as `names` has them), with the time their
 *  name carries, null when it carries none (a stray may be named anything): the caller falls back to the file's
 *  last write. Offered to restore only; newestFirst and toPrune never see them. */
export function recoveredOf(names: string[]): { name: string; time: number | null }[] {
  return names.flatMap((name) => {
    const parts = name.split(/[\\/]/);
    if (parts.length !== 2 || parts[0] !== RECOVERED || !parts[1]) return [];
    return [{ name, time: checkpointTime(parts[1]) }];
  });
}

/** The checkpoints to delete so that `keep` remain. */
export function toPrune(names: string[], keep: number): string[] {
  return newestFirst(names).slice(Math.max(1, keep)).map((c) => c.name);
}

export type CheckpointState = "due" | "unchanged" | "wait" | "too large";

/** Whether an automatic checkpoint is due: something changed since the last one, and the last one
 *  is `interval` old. The first one comes at once, so the state a session starts from is kept. */
export function checkpointState(files: FileInfo[], newest: number | null, now: number, interval: number, maxBytes: number): CheckpointState {
  if (files.reduce((n, f) => n + f.size, 0) > maxBytes) return "too large";
  if (newest === null) return files.length ? "due" : "unchanged";
  if (!files.some((f) => f.modified > newest)) return "unchanged";
  return now - newest >= interval ? "due" : "wait";
}
