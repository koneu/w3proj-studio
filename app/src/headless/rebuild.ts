// `w3proj rebuild`: the derived files of a project made by the app's own code, without the app. The CLI (crates/cli,
// rebuild.rs) decides what is due, starts this in Node with the job as its argument, answers its backend commands
// over the pipe (ipc.ts) and prints the report this ends with.
//
//   wpm      war3map.wpm, as a rebuild after an edit writes it (terrain-viewer/derive.ts deriveFromProject, with the
//            Pathing tool's saved overrides: terrain-pathing's filterSavedPathing)
//   shd      war3map.shd made again in whole, as Calculate Shadows does (derive.ts fullShadows): the record of what
//            the stored one was made from isn't kept, so it can't be updated only where something changed
//   minimap  war3mapMap.blp and its icons war3map.mmp, as the rebuild writes them
//   script   war3map.j / war3map.lua from the triggers, as the Map Script extension's Generate Map Script: a script
//            that isn't the one Studio wrote last is kept (lib/script/guard.ts), vJASS isn't compiled

import { headless, type Message } from "./host";
import type { ExtensionManifest } from "../extensions/api";
import { TERRAIN_SERVICE, type TerrainToolGroup } from "../extensions/services";
import { terrainPath } from "../lib/terrain/w3etext";
import { deriveFromProject, fullShadows } from "../builtin/terrain-viewer/derive";
import { readFile, savedObjects } from "../builtin/terrain-viewer/projectfiles";
import * as pathingExtension from "../builtin/terrain-pathing/index";
import * as scriptExtension from "../builtin/map-script/index";
import terrainManifest from "../builtin/terrain-viewer/extension.json";
import pathingManifest from "../builtin/terrain-pathing/extension.json";
import scriptManifest from "../builtin/map-script/extension.json";

export type Part = "wpm" | "shd" | "minimap" | "script";

export interface Job {
  /** The project folder. */
  root: string;
  parts: Part[];
  /** Settings that win over the project's and the defaults (the game folder, the graphics mode). */
  settings: Record<string, unknown>;
}

export interface PartResult {
  part: Part;
  /** The project files it writes. */
  files: string[];
  /** written: changed on disk; unchanged: made again, the same bytes; kept: not written on purpose (note says why);
   *  failed: not made (note says why). */
  status: "written" | "unchanged" | "kept" | "failed";
  note?: string;
}

export interface Report { parts: PartResult[]; messages: Message[]; alsoChanged: string[] }

const PART_FILES: Record<Part, string[]> = {
  wpm: ["map/war3map.wpm"],
  shd: ["map/war3map.shd"],
  minimap: ["map/war3mapMap.blp", "map/war3map.mmp", "map/war3map.mmp.json"],
  script: ["map/war3map.j", "map/war3map.lua"],
};
/** Written along with the script when a save would write them (the Melee flag, lib/terrain/meleesave). */
const SIDE_FILES = ["map/war3map.w3i.json"];

const same = (a: Uint8Array | null, b: Uint8Array | null) => a === b || (!!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]));
const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function rebuild(job: Job): Promise<Report> {
  const parts = new Set(job.parts);
  const h = headless([terrainManifest, pathingManifest, scriptManifest] as ExtensionManifest[], {
    ...job.settings,
    // Shadows are made in whole on their own (fullShadows); the rebuild writes pathing and the minimap only when asked.
    "terrain.shadows.update": false,
    "terrain.pathing.regenerate": parts.has("wpm"),
    "terrain.minimap.regenerate": parts.has("minimap") ? "always" : "never",
    "script.generateOnSave": true,
  });
  const { w3, workspace, messages } = h;
  await workspace.open(job.root);
  const files = () => new Set(w3.workspace.files().map((f) => f.path.toLowerCase()));
  /** A project file's bytes; null when it isn't there. One that is there but can't be read fails the job: it would
   *  be reported as made when it wasn't. */
  const bytes = async (p: string) => (files().has(p.toLowerCase()) ? w3.workspace.readBytes(p) : null);
  const snapshot = async (paths: string[]) => new Map(await Promise.all(paths.map(async (p) => [p, await bytes(p)] as const)));
  const watched = [...Object.values(PART_FILES).flat(), ...SIDE_FILES];
  const before = await snapshot(watched);
  const saved = new Set<string>();
  w3.workspace.onDidSave((p) => saved.add(p.toLowerCase()));
  const results: PartResult[] = [];
  /** What changed on disk of `paths` since the start. */
  const changed = async (paths: string[]) => {
    await workspace.refresh();
    const now = await snapshot(paths);
    return paths.filter((p) => !same(before.get(p) ?? null, now.get(p) ?? null));
  };
  const result = async (part: Part, ok: boolean, note?: string): Promise<PartResult> => {
    const all = PART_FILES[part];
    const differ = await changed(all);
    const files = all.filter((p) => differ.includes(p) || before.get(p));
    return { part, files: files.length ? files : [all[0]], status: !ok ? "failed" : differ.length ? "written" : "unchanged", note };
  };

  const terrain = parts.has("wpm") || parts.has("shd") || parts.has("minimap") ? terrainPath(w3.workspace.files().map((f) => f.path)) : null;
  for (const part of (["wpm", "shd", "minimap"] as const).filter((p) => parts.has(p) && !terrain)) {
    results.push({ part, files: [PART_FILES[part][0]], status: "kept", note: "the project has no terrain (map/war3map.w3e or war3map.w3e.txt)" });
  }
  if (terrain) {
    const read = (p: string) => readFile(w3, { path: terrain }, p);
    const objects = () => savedObjects(w3);
    if (parts.has("shd")) {
      try {
        const { shd, stored } = await fullShadows(w3, { terrainPath: terrain, objects, read });
        if (!same(shd, stored)) await w3.workspace.writeBytes("map/war3map.shd", shd);
        results.push(await result("shd", true));
      } catch (e) {
        results.push(await result("shd", false, text(e)));
      }
    }
    if (parts.has("wpm") || parts.has("minimap")) {
      // The Pathing tool's overrides (.w3proj/pathing.json) go into the pathing map as the app's rebuild puts them.
      const groups: TerrainToolGroup[] = [];
      w3.services.provide(TERRAIN_SERVICE, { registerToolGroup: (g: TerrainToolGroup) => { groups.push(g); return { dispose() {} }; } });
      await h.activate(pathingManifest.id, pathingExtension);
      await Promise.resolve();
      const from = messages.length;
      let failure: string | undefined;
      try {
        await deriveFromProject(w3, { terrainPath: terrain, from: { doodads: [] }, objects, read, groups, stillOpen: () => true });
      } catch (e) {
        failure = text(e);
      }
      // Each part's failure is shown as an error naming its file (writeDerived); a part that went through wrote its
      // file (pathing and the minimap are written whether or not they changed).
      const errors = (file: RegExp) => messages.slice(from).filter((m) => m.severity === "error" && file.test(m.text)).map((m) => m.text).join(" ");
      for (const [part, written, file] of [["wpm", "map/war3map.wpm", /war3map\.wpm/i], ["minimap", "map/war3mapmap.blp", /war3mapMap\.blp|war3map\.mmp/i]] as const) {
        if (!parts.has(part)) continue;
        const why = failure ?? errors(file);
        results.push(await result(part, !why && saved.has(written), why || (saved.has(written) ? undefined : "not written")));
      }
    }
  }
  if (parts.has("script")) {
    await h.activate(scriptManifest.id, scriptExtension);
    let failure: string | undefined;
    try {
      await w3.commands.execute("w3.script.generate", { quiet: true });
    } catch (e) {
      failure = text(e);
    }
    const lines = h.output.get("Map Script") ?? [];
    const last = lines[lines.length - 1];
    const r = await result("script", !failure, failure ?? last);
    // Generate Map Script says when it left the script as it is (edited by hand, vJASS): kept, not made.
    if (r.status === "unchanged" && last && / not written: /.test(last)) r.status = "kept";
    results.push(r);
  }
  return { parts: results, messages, alsoChanged: await changed(SIDE_FILES) };
}
