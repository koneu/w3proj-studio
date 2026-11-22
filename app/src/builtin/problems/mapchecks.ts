// More checks of the Problems view: what GUI triggers refer to, sound files, the terrain's tiles,
// and the art named by Map Properties and the Game Interface.

import type { W3Api } from "../../extensions/api";
import type { Problem, ProblemCheck } from "../../extensions/services";
import { parseIni, parseSlk } from "../../lib/formats/text";
import { ident, placedName, type PlacedJson } from "../../lib/script/jass";
import { parseW3e } from "../../lib/terrain/w3e";
import { readTerrainBytes, terrainPath } from "../../lib/terrain/w3etext";
import { errorText } from "../../lib/oserror";
import { missingRefs, triggerRefs } from "../../lib/triggers/refs";
import type { TriggerIssue } from "../../lib/triggers/validate";
import { isTriggerLayoutPath, TRIGGERS_ROOT, wtgPath } from "../../lib/triggers/project";
import type { FileKind } from "./lookup";
import { RunScope } from "./runscope";
import { fixTriggerTree, treeProblem, type TreeIssue } from "./triggertree";

const GITATTRIBUTES = ".gitattributes";
/** The rule a project with trigger folders needs (written by a new project, crates/w3proj/src/project.rs GITATTRIBUTES). */
export const TRIGGERS_GIT_RULE = "map/triggers/** -text";

/** Whether a .gitattributes has a rule that keeps Git off the trigger texts' line endings: `map/triggers/**` (or a
 *  pattern covering every file) with `-text` or `binary`, the last matching line deciding as Git reads it. */
export function hasTriggerTextRule(text: string): boolean {
  let off: boolean | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const [pattern, ...attrs] = raw.trim().split(/\s+/);
    if (!pattern || pattern.startsWith("#") || !["map/triggers/**", "map/triggers/", "/map/triggers/**", "*", "**"].includes(pattern)) continue;
    if (attrs.includes("-text") || attrs.includes("binary")) off = true;
    else if (attrs.some((a) => a === "text" || a.startsWith("text=") || a.startsWith("eol="))) off = false;
  }
  return off === true;
}

/** At most this many problems per check (the rest is summarised). */
const LIMIT = 200;

const WHAT: Record<string, string> = { rct: "region", cam: "camera", snd: "sound", trg: "trigger", unit: "placed unit", item: "placed item", dest: "placed destructable", doodad: "placed doodad" };

/** The map's generated globals. */
async function mapGlobals(s: RunScope, triggers: string[]): Promise<Set<string>> {
  const names = new Set(triggers.map((t) => `gg_trg_${ident(t)}`));
  await s.prefetch(["map/war3map.w3r.json", "map/war3map.w3c.json", "map/war3map.w3s.json", "map/war3mapUnits.doo.json", "map/war3map.doo.json"]);
  for (const r of (await s.doc<{ regions: { name: string }[] }>("map/war3map.w3r.json"))?.regions ?? []) names.add(`gg_rct_${ident(r.name)}`);
  for (const c of (await s.doc<{ cameras: { name: string }[] }>("map/war3map.w3c.json"))?.cameras ?? []) names.add(`gg_cam_${ident(c.name)}`);
  for (const snd of (await s.doc<{ sounds: { name: string }[] }>("map/war3map.w3s.json"))?.sounds ?? []) names.add(snd.name);
  const units = (await s.doc<{ units: PlacedJson[] }>("map/war3mapUnits.doo.json"))?.units ?? [];
  const doodads = (await s.doc<{ doodads: PlacedJson[] }>("map/war3map.doo.json"))?.doodads ?? [];
  for (const p of units) { names.add(placedName(p, "unit")); names.add(placedName(p, "item")); }
  for (const p of doodads) { names.add(placedName(p, "dest")); names.add(placedName(p, "doodad")); }
  return names;
}

/** Problems of Validate Map Triggers; a click shows the trigger, the line and the parameter. */
function triggerProblems(issues: TriggerIssue[], what: string, limit = LIMIT, about = false): Problem[] {
  const out = issues.slice(0, limit).map((i): Problem => ({
    severity: i.severity,
    message: `${i.where ? `${i.where}: ` : ""}${i.message}${i.trigger.enabled ? "" : " (disabled trigger)"}`,
    location: i.trigger.name,
    ...(about ? { about: i.trigger.name } : {}),
    reveal: { command: "w3.triggers.reveal", args: [i.trigger.name, { id: i.trigger.id, ...(i.path ? { path: i.path } : {}), ...(i.param ? { param: i.param } : {}) }] },
  }));
  if (issues.length > limit) out.push({ severity: "warning", message: `… and ${issues.length - LIMIT} more ${what}` });
  return out;
}

/** `scope`: what the checks of the current run share (see builtinChecks). */
export function mapChecks(w3: W3Api, scope: () => RunScope = () => new RunScope(w3, false)): ProblemCheck[] {
  return [
    {
      id: "triggerRefs",
      title: "References in triggers",
      async run() {
        // A trigger file that can't be read is the Trigger validation's to report.
        const file = await scope().triggers().catch(() => null);
        if (!file) return [];
        const items = file.items.filter((i) => "ecas" in i && i.type !== 16);
        const triggers = items.map((i) => i.name);
        // A disabled trigger isn't in the script: nothing breaks, it's just out of date.
        const live = new Set(items.filter((i) => "ecas" in i && i.enabled).map((i) => i.name));
        const missing = missingRefs(triggerRefs(file), await mapGlobals(scope(), triggers), file.variables);
        return missing.map(({ ref, triggers: users }): Problem => {
          const gg = /^gg_([a-z]+)_(.*)$/.exec(ref);
          const what = gg ? `${WHAT[gg[1]] ?? "object"} ${gg[2]}` : `variable ${ref.slice(4)}`;
          const running = users.some((u) => live.has(u));
          return { severity: running ? "error" : "warning", message: `${what} doesn't exist in this map${running ? "" : " (disabled trigger)"}`, location: users.length > 1 ? `${users[0]} and ${users.length - 1} more` : users[0],
            reveal: { command: "w3.triggers.reveal", args: [users[0]] } };
        });
      },
    },
    {
      id: "triggerValidate",
      title: "Trigger validation",
      async run() {
        const path = wtgPath(w3.workspace.files());
        if (!path) return [];
        // Without the game's TriggerData nothing can be judged: the check fails (it isn't "no problems").
        await scope().triggerData();
        let issues: TriggerIssue[] | null;
        try { issues = await scope().triggerIssues(); } catch (e) {
          // There and unreadable is not "no triggers".
          return [{ severity: "error", message: `The triggers can't be read: ${errorText(e)}`, location: path.slice(4), reveal: { command: "w3.problems.open", args: [path] } }];
        }
        return triggerProblems((issues ?? []).filter((i) => i.kind !== "noEvents"), "trigger problems");
      },
    },
    {
      id: "triggerNoEvents",
      title: "Triggers nothing runs",
      async run() {
        // A trigger file that can't be read is the Trigger validation's to report.
        const issues = await scope().triggerIssues().catch(() => null);
        return triggerProblems((issues ?? []).filter((i) => i.kind === "noEvents"), "triggers nothing runs", 5000, true);
      },
    },
    {
      // Check Trigger Tree (crates/w3proj/src/trigger_check.rs, as `w3proj triggers --check` and pack run it): what the
      // files of map/triggers/ get wrong, mostly after a Git merge. Fixes are listed, never applied unasked.
      id: "triggerFolders",
      title: "Check Trigger Tree",
      async run() {
        const root = w3.workspace.project()?.root;
        if (!root || !w3.workspace.files().some((f) => isTriggerLayoutPath(f.path))) return [];
        const issues = await w3.backend.invoke<TreeIssue[]>("triggers_check", { root });
        const out = issues.slice(0, LIMIT).map((i) => treeProblem(i, (fix) => fixTriggerTree(w3, [fix])));
        if (issues.length > LIMIT) out.push({ severity: "warning", message: `… and ${issues.length - LIMIT} more` });
        return out;
      },
    },
    {
      // The trigger folders keep each text's own line endings (CRLF in one file, LF in the next): Git must not convert
      // them, or a checkout on another system changes the map's texts (openpoints spec, section 3B).
      id: "triggerFoldersGit",
      title: "Trigger folders and Git",
      async run() {
        if (!w3.workspace.files().some((f) => f.path.toLowerCase() === TRIGGERS_ROOT)) return [];
        const text = await w3.workspace.readText(GITATTRIBUTES).catch(async (e) => {
          // Absent is a warning of its own; there and unreadable is not "no rule".
          if (!(await w3.workspace.exists(GITATTRIBUTES).catch(() => true))) return null;
          throw e;
        }).catch((e) => e as Error);
        if (text instanceof Error) return [{ severity: "error", message: `.gitattributes can't be read (${errorText(text)}), so whether Git keeps the trigger texts' line endings can't be told`, location: GITATTRIBUTES, reveal: { command: "w3.problems.open", args: [GITATTRIBUTES] } }];
        if (text !== null && hasTriggerTextRule(text)) return [];
        return [{
          severity: "warning",
          message: `${text === null ? "The project has no .gitattributes" : ".gitattributes has no rule for map/triggers/"}: add the line "${TRIGGERS_GIT_RULE}", or Git may change the line endings of the trigger texts (map/triggers/) on another system`,
          location: GITATTRIBUTES,
          ...(text === null ? {} : { reveal: { command: "w3.problems.open", args: [GITATTRIBUTES] } }),
        }];
      },
    },
    {
      id: "soundFiles",
      title: "Sound files",
      async run() {
        const shared = scope(), files = shared.lookup();
        const out: Problem[] = [];
        const sounds = (await shared.doc<{ sounds: { name: string; file: string }[] }>("map/war3map.w3s.json"))?.sounds ?? [];
        // The game takes a sound under its other extensions too.
        const names = (file: string) => { const stem = file.replace(/\.\w+$/, ""); return [file.slice(stem.length), ".flac", ".ogg", ".mp3", ".wav"].map((ext) => `${stem}${ext}`); };
        await files.prefetch(sounds.filter((s) => s.file).flatMap((s) => names(s.file).map((n): [string, "file"] => [n, "file"])));
        for (const s of sounds) {
          if (!s.file) continue;
          let found = false;
          for (const name of names(s.file)) {
            if (await files.exists(name, "file")) { found = true; break; }
          }
          if (!found) out.push({ severity: "warning", message: files.notFound(s.file), location: s.name.replace(/^gg_snd_/, ""), reveal: { command: "w3.sounds.open" } });
        }
        return out;
      },
    },
    {
      id: "terrainTiles",
      title: "Terrain tiles",
      async run() {
        const path = terrainPath(w3.workspace.files().map((f) => f.path));
        if (!path) return [];
        const terrain = parseW3e(await readTerrainBytes(path, { readText: () => w3.workspace.readText(path), readBytes: () => w3.workspace.readBytes(path) }));
        const ids = async (file: string, key: string) => new Set(parseSlk(await w3.game.readText(file, { background: true })).map((r) => r[key]));
        const ground = await ids("TerrainArt\\Terrain.slk", "tileID"), cliffs = await ids("TerrainArt\\CliffTypes.slk", "cliffID");
        // A list entry no corner uses is only a warning: a stale slot in the file's list (the W3Champions TurtleRock's
        // third cliff type is CLno, which the game doesn't define, and no corner has it).
        const unknown = (list: string[], known: Set<string>, what: string, used: (index: number) => boolean) => list.flatMap((id, i): Problem[] => known.has(id) ? [] : [{
          severity: used(i) ? "error" : "warning", message: `${what} ${id} isn't one of the game's${used(i) ? "" : " (no corner uses it)"}`, location: path.slice(4), reveal: { command: "w3.terrain.open" },
        }]);
        const usedCliffs = new Set(terrain.corners.map((c) => c.cliffTexture));
        return [...unknown(terrain.groundTiles, ground, "Ground tile", () => true), ...unknown(terrain.cliffTiles, cliffs, "Cliff type", (i) => usedCliffs.has(i))];
      },
    },
    {
      id: "interfaceArt",
      title: "Map Properties and Game Interface art",
      async run() {
        const shared = scope(), files = shared.lookup();
        const out: Problem[] = [];
        // What to look at, in order; then the game paths of all of it at once.
        const values: [value: string, location: string, command: string, args?: unknown[]][] = [];
        const info = await shared.doc<{ loadingScreen?: { model?: string }; prologue?: { path?: string } }>("map/war3map.w3i.json");
        if (info?.loadingScreen?.model) values.push([info.loadingScreen.model, "Map Properties › Loading screen", "w3.mapInfo.open", ["loading"]]);
        if (info?.prologue?.path) values.push([info.prologue.path, "Map Properties › Prologue", "w3.mapInfo.open", ["prologue"]]);
        const skin = await w3.workspace.readText("map/war3mapSkin.txt").catch(() => null);
        for (const [section, keys] of skin === null ? [] : parseIni(skin)) {
          for (const [key, value] of keys) for (const part of value.split(",")) values.push([part, `Game Interface › ${section} › ${key}`, "w3.gameInterface.open"]);
        }
        const art = (value: string) => { const p = value.trim(); return /\.(blp|dds|tga|mdx|mdl)$/i.test(p) ? { p, kind: /\.md[xl]$/i.test(p) ? "model" as const : "texture" as const } : null; };
        await files.prefetch(values.flatMap(([value]) => { const a = art(value); return a ? [[a.p, a.kind] as [string, FileKind]] : []; }));
        for (const [value, location, command, args] of values) {
          const a = art(value);
          if (!a || (await files.exists(a.p, a.kind))) continue;
          out.push({ severity: "warning", message: files.notFound(a.p), location, reveal: { command, ...(args ? { args } : {}) } });
        }
        return out.slice(0, 200);
      },
    },
    {
      id: "creationIds",
      title: "Duplicate creation numbers",
      async run() {
        const root = w3.workspace.project()?.root;
        if (!root) return [];
        // A project without terrain files has none; the plan itself changes nothing.
        const plan = await w3.backend.invoke<{ groups: { kind: string; number: number; members: { file: string; index: number }[] }[] }>("terrain_fix_ids", { root, mode: null }).catch(() => null);
        if (!plan?.groups.length) return [];
        const fix = (mode: "renumber" | "deleteCopies") => async () => { await w3.commands.execute("w3.terrainLayout.fixIds", { mode, quiet: false }); };
        const fixes = [
          { label: "Renumber", title: "Every object of a number but the first gets the next free number", run: fix("renumber") },
          { label: "Delete Copies", title: "Remove the objects that are exact copies of an earlier one", run: fix("deleteCopies") },
        ];
        const out = plan.groups.slice(0, LIMIT).map((g): Problem => ({
          severity: "error",
          message: `Creation number ${g.number} (${g.kind}) is held by ${g.members.length} objects: ${g.members.slice(0, 4).map((m) => `${m.file.replace(/^.*[\\/]/, "")}[${m.index}]`).join(", ")}${g.members.length > 4 ? ", …" : ""}. Split Terrain and pack refuse it.`,
          location: g.members[0]?.file,
          about: `${g.kind}:${g.number}`,
          fixes,
        }));
        if (plan.groups.length > LIMIT) out.push({ severity: "warning", message: `… and ${plan.groups.length - LIMIT} more creation numbers held twice` });
        return out;
      },
    },
  ];
}
