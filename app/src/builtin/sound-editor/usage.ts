// Reading what names the map's sounds (GUI triggers, custom script texts, the map script, regions) from the
// project's saved files, and the two commands built on it: Find Usages and Remove Unused Sounds.

import type { W3Api } from "../../extensions/api";
import { checkpointIfOn } from "../../lib/checkpoint";
import { readMapDocStrict } from "../../lib/formats/mapdoc";
import { parseTriggerData } from "../../lib/triggers/triggerdata";
import { readWctFile, readWtgFile, textTriggers, wtgPath } from "../../lib/triggers/wtg";
import { describeUse, soundUsages, unusedSounds, type SoundUsageInput } from "./sounds";

const SOUNDS_FILE = /^map\/war3map\.w3s(\.json)?$/i;
/** Saved files the scan reads: unsaved edits of these aren't seen by it. */
const READ_FILES = /^map\/war3map\.(wtg(\.json)?|wct(\.txt)?|w3r(\.json)?|j|lua)$/i;

/** Open documents with unsaved changes that the scan would miss. */
export function unsavedInputs(w3: W3Api): string[] {
  return w3.editors.unsavedPaths().filter((p) => {
    const q = p.replace(/\\/g, "/");
    return READ_FILES.test(q) && !SOUNDS_FILE.test(q);
  });
}

/** What names sounds, from the saved files. A file that is there and can't be read throws (it isn't "no use"). */
export async function readSoundUsageInput(w3: W3Api): Promise<SoundUsageInput> {
  const files = new Set(w3.workspace.files().map((f) => f.path.replace(/\\/g, "/").toLowerCase()));
  const path = wtgPath(w3.workspace.files());
  const triggers = path
    ? await readWtgFile(w3.workspace, path, async () => parseTriggerData(await w3.game.readText("UI\\TriggerData.txt")))
    : null;
  const custom = await readWctFile(w3.workspace, triggers ? textTriggers(triggers).length : 0);
  const scripts: NonNullable<SoundUsageInput["scripts"]> = [];
  if (custom) {
    scripts.push({ where: "Custom script header", text: custom.header });
    const names = triggers ? textTriggers(triggers).map((t) => t.name) : [];
    custom.texts.forEach((text, i) => scripts.push({ where: names[i] ? `Custom text of ${names[i]}` : `Custom text ${i + 1}`, text }));
  }
  for (const f of ["map/war3map.j", "map/war3map.lua"]) {
    if (files.has(f)) scripts.push({ where: f, text: await w3.workspace.readText(f), generated: true });
  }
  const regions = await readMapDocStrict<{ regions?: { name: string; sound?: string }[] }>(w3, "map/war3map.w3r.json");
  return { triggers, scripts, regions: regions?.regions ?? [] };
}

/** Find Usages: the places that name `name` (gg_snd_…); picking a trigger or script shows it. */
export async function findSoundUsages(w3: W3Api, name: string): Promise<number> {
  const input = await readSoundUsageInput(w3);
  const uses = soundUsages([name], input).get(name) ?? [];
  const unsaved = unsavedInputs(w3);
  const note = unsaved.length ? ` (not counting unsaved changes in ${unsaved.join(", ")})` : "";
  const short = name.replace(/^gg_snd_/, "");
  if (!uses.length) { void w3.window.showInfo(`The sound ${short} is not used by any trigger, script or region${note}.`); return 0; }
  const pick = await w3.window.quickPick(uses.map((u) => ({ label: describeUse(u), description: u.kind, value: u })), { placeholder: `${uses.length} use${uses.length === 1 ? "" : "s"} of ${short}${note}` });
  const u = pick?.value;
  if (u?.kind === "trigger") await w3.commands.execute("w3.triggers.reveal", u.where).catch(() => undefined);
  else if (u?.kind === "script" && u.where.startsWith("map/")) await w3.editors.open(u.where);
  return uses.length;
}

/** The question for the unused sounds. */
export function describeUnused(names: readonly string[]): string {
  const shown = names.slice(0, 8).map((n) => n.replace(/^gg_snd_/, "")).join(", ");
  const more = names.length > 8 ? ` and ${names.length - 8} more` : "";
  return `Remove ${names.length} unused sound${names.length === 1 ? "" : "s"} (${shown}${more})? No trigger, script or region names them. `
    + "A checkpoint is made first, to come back to, where they're enabled; the removal is an unsaved step you can undo.";
}

/** Remove Unused Sounds: asks, makes a checkpoint, then `remove` takes the sounds out of the open list (one undo step).
 *  `live`: the names of the sounds in the editor now. Returns how many were removed. */
export async function removeUnusedSounds(w3: W3Api, live: () => readonly string[], remove: (names: string[]) => void): Promise<number> {
  const unsaved = unsavedInputs(w3);
  if (unsaved.length) throw new Error(`Save or discard the changes of ${unsaved.join(", ")} first: Remove Unused Sounds reads the saved files.`);
  const root = w3.workspace.project()?.root;
  const unused = unusedSounds(live(), await readSoundUsageInput(w3));
  if (!unused.length) { void w3.window.showInfo("No unused sounds: every sound is named by a trigger, script or region."); return 0; }
  if (!(await w3.window.confirm(describeUnused(unused), "Remove", 60_000))) return 0;
  // After the question: the project or the files may have changed meanwhile, so it's worked out again.
  if (w3.workspace.project()?.root !== root) return 0;
  const again = unsavedInputs(w3);
  if (again.length) throw new Error(`Save or discard the changes of ${again.join(", ")} first: Remove Unused Sounds reads the saved files.`);
  const now = new Set(unusedSounds(live(), await readSoundUsageInput(w3)));
  const names = unused.filter((n) => now.has(n));
  if (!names.length) return 0;
  const checkpointed = await checkpointIfOn(w3, "Remove Unused Sounds");
  if (w3.workspace.project()?.root !== root) return 0;
  remove(names);
  void w3.window.showInfo(`Removed ${names.length} unused sound${names.length === 1 ? "" : "s"} (unsaved; undo takes them back).${checkpointed ? " A checkpoint was made before." : ""}`);
  return names.length;
}
