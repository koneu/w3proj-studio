// Test AI: makes a copy of the Test Configuration's melee map with its players and AIs (lib/ai/testmap.ts), in a new
// temp folder; the map and the AI files stay as they are. Starting it is Test Map's (map-project).

import type { W3Api } from "../../extensions/api";
import { generateAiScript } from "../../lib/ai/script";
import { testInfo, testPlan, testScript, type MapInfo, type TestPlan, type TestSlot } from "../../lib/ai/testmap";
import { aiArgCount, parseWai, type AiFile } from "../../lib/ai/wai";
import { decodeLossless, encodeLossless } from "../../lib/formats/lossless";
import { checkJass, envFrom } from "../../lib/jass/check";
import { joinPath } from "../../lib/paths";
import type { TriggerData } from "../../lib/triggers/triggerdata";

const RACE_NAMES: Record<number, string> = { 1: "Human", 2: "Orc", 4: "Undead", 8: "Night Elf" };

export interface TestBuild { map: string; plan: TestPlan }

const absolute = (p: string) => /^([A-Za-z]:[\\/]|[\\/])/.test(p);
const installDir = (w3: W3Api) => w3.settings.get<string>("game.installDir") ?? "C:\\Program Files (x86)\\Warcraft III";

/** The bytes of a file a Test Configuration names: a file on disk (as picked), one of the open project, one of the
 *  user's Warcraft III folder (as the World Editor writes "Maps\…"), or the game's own. Null when there is none. */
async function named(w3: W3Api, path: string): Promise<Uint8Array | null> {
  if (!path.trim()) return null;
  const disk: string[] = [];
  if (absolute(path)) disk.push(path);
  else {
    const slashed = path.replace(/\\/g, "/");
    const root = w3.workspace.project()?.root;
    if (root) disk.push(joinPath(root, slashed), joinPath(root, "map", slashed));
    const maps = await w3.backend.invoke<string>("game_maps_folder", { install: installDir(w3) }).catch(() => null);
    if (maps) disk.push(joinPath(maps.replace(/[\\/]Maps$/i, ""), slashed));
  }
  for (const file of disk) {
    if (await w3.backend.invoke<boolean>("fs_exists", { path: file }).catch(() => false)) return w3.backend.readBytes(file);
  }
  if (absolute(path)) return null;
  return w3.game.read(`War3.w3mod:${path.replace(/\\/g, "/")}`).catch(() => w3.game.read(path).catch(() => null));
}

/** The script a computer slot runs, or null for the game's own AI; its name as shown in the game. */
async function slotScript(w3: W3Api, ai: AiFile, data: TriggerData, slot: TestSlot): Promise<{ script: Uint8Array | null; name: string }> {
  const race = RACE_NAMES[slot.source.race] ?? "random race";
  if (slot.ai === "Standard") return { script: null, name: `${race}, standard AI` };
  if (slot.ai === "Current") return { script: encodeLossless(generateAiScript(ai, data)), name: `${race}, ${ai.name}` };
  const path = slot.source.script;
  const bytes = await named(w3, path);
  if (!bytes) throw new Error(`Test AI failed: Unable to open AI script '${path}'`);
  const file = path.split(/[\\/]/).pop()!;
  if (!/\.wai$/i.test(path)) return { script: bytes, name: `${race}, ${file}` };
  let other: AiFile;
  try { other = parseWai(bytes, aiArgCount(data)); } catch (e) { throw new Error(`Test AI failed: Unable to open AI script '${path}' (${(e as Error).message ?? e})`); }
  return { script: encodeLossless(generateAiScript(other, data)), name: `${race}, ${other.name}` };
}

/** Throws when a script has errors, naming the first: such an AI would silently do nothing in the game. */
async function refuseErrors(w3: W3Api, what: string, text: string, libraries: string[]): Promise<void> {
  const env = envFrom(await Promise.all(libraries.map((p) => w3.game.readText(p))));
  const error = checkJass(text, env, { ordered: true }).find((d) => d.severity === "error");
  if (error) throw new Error(`AI test aborted due to script errors. ${what}, line ${text.slice(0, error.from).split("\n").length}: ${error.message}`);
}

export async function buildTestMap(w3: W3Api, ai: AiFile, data: TriggerData): Promise<TestBuild> {
  const mapBytes = await named(w3, ai.mapPath);
  if (!mapBytes) throw new Error(`Test AI failed: Unable to open map file '${ai.mapPath}'`);
  const temp = await w3.backend.invoke<string>("tool_temp_dir");
  const source = joinPath(temp, `source.${/\.w3x$/i.test(ai.mapPath) ? "w3x" : "w3m"}`), project = joinPath(temp, "project");
  await w3.backend.writeBytes(source, mapBytes);
  try {
    await w3.backend.invoke("project_unpack", { map: source, dir: project, allowIncomplete: false, install: installDir(w3) });
  } catch (e) {
    throw new Error(`Test AI failed: Unable to open map file '${ai.mapPath}' (${(e as Error).message ?? e})`);
  }
  const file = (name: string) => joinPath(project, "map", name);
  const exists = (name: string) => w3.backend.invoke<boolean>("fs_exists", { path: file(name) });
  if (!(await exists("war3map.w3i.json"))) throw new Error(`Test AI failed: '${ai.mapPath}' has no map info that can be read.`);
  const info = JSON.parse(await w3.backend.invoke<string>("fs_read_text", { path: file("war3map.w3i.json") })) as MapInfo;
  const plan = testPlan(ai, info);
  if (!(await exists("war3map.j"))) throw new Error("Test AI failed: only a map with a JASS script (war3map.j) can be tested; this one has none.");
  const jass = decodeLossless(await w3.backend.readBytes(file("war3map.j")));

  const scripts = new Map<number, string>(), names = new Map<number, string>();
  const added: { path: string; bytes: Uint8Array }[] = [];
  for (const slot of plan.slots.filter((s) => !s.user)) {
    const { script, name } = await slotScript(w3, ai, data, slot);
    names.set(slot.player, name);
    if (!script) continue;
    await refuseErrors(w3, name, decodeLossless(script), ["Scripts\\common.j", "Scripts\\common.ai"]);
    const path = `war3mapImported\\w3proj-testai-${slot.player + 1}.ai`;
    scripts.set(slot.player, path);
    added.push({ path, bytes: script });
  }
  const patched = testScript(jass, info, plan, scripts, names);
  await refuseErrors(w3, "The test map's script", patched, ["Scripts\\common.j", "Scripts\\Blizzard.j"]);

  const writeText = (path: string, text: string) => w3.backend.invoke("fs_write_text", { path, text });
  const canonical = async (name: string, value: unknown) => writeText(file(name),
    await w3.backend.invoke<string>("codec_canonicalize", { root: project, path: `map/${name}`, text: JSON.stringify(value) }));
  await canonical("war3map.w3i.json", testInfo(info, plan));
  await w3.backend.writeBytes(file("war3map.j"), encodeLossless(patched));
  if (added.length) {
    await w3.backend.invoke("fs_mkdir", { path: file("war3mapImported") }).catch(() => {});
    for (const a of added) await w3.backend.writeBytes(joinPath(project, "map", a.path.replace(/\\/g, "/")), a.bytes);
    const imports = (await exists("war3map.imp.json"))
      ? (JSON.parse(await w3.backend.invoke<string>("fs_read_text", { path: file("war3map.imp.json") })) as { files: { flags: number; path: string }[] })
      : { format: "w3proj.imports/1", version: 1, files: [] as { flags: number; path: string }[] };
    imports.files.push(...added.map((a) => ({ flags: 21, path: a.path })));
    await canonical("war3map.imp.json", imports);
  }
  const map = joinPath(temp, "W3ProjTestAI.w3x");
  await w3.backend.invoke("project_pack", { root: project, output: map });
  return { map, plan };
}
