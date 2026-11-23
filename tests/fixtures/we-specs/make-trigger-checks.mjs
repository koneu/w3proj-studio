// Makes the input of the trigger specs (tests/we-compare/trigger-checks.json) from the World Editor's own empty
// 64x64 map:
//
//   node tests/fixtures/we-specs/make-trigger-checks.mjs <empty_map_on_newest_world_editor.w3m> <w3proj cli> <out.w3m>
//
// Two cameras "Alpha" and "Bravo"; the trigger "Use Cams" (GUI: a map-initialization event, Apply Alpha for
// Player 1, a disabled Apply Bravo, a Custom Script action naming gg_cam_Alpha); "Block" (an If/Then/Else with a condition, an action and a comment); the custom text trigger "Textual"
// (JASS naming gg_cam_Bravo). The trigger editor's Copy As Text and a camera rename have something to work on.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addLookCameras, lookCamera, parseLook, resolveLook, terrainHead } from "../../../app/scripts/we-camera.mjs";
import { requireFresh } from "../../binfresh.mjs";
import { addGuiTrigger, addScriptTrigger } from "./trigger-folder.mjs";
import { gamePath } from "../../gamepath.mjs";

const [empty, cli, out] = process.argv.slice(2).filter((a) => !a.startsWith("--")).map((p) => (p ? resolve(p) : p));
if (!out) { console.error("usage: make-trigger-checks.mjs <empty map> <w3proj cli> <out.w3m>"); process.exit(2); }
requireFresh(cli, "cli"); // refuses a stale binary (--allow-stale / W3_ALLOW_STALE=1 overrides)
const run = (...args) => {
  const r = spawnSync(cli, args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`w3proj ${args.join(" ")}: ${r.stderr}${r.stdout}`);
};
const eca = (kind, name, params, extra = {}) => ({ kind, name, enabled: true, params, children: [], ...extra });
const apply = (cam, extra) => eca(2, "CameraSetupApplyForPlayer", [
  { type: 0, value: "CameraApply" }, { type: 1, value: `gg_cam_${cam}` }, { type: 0, value: "Player00" }, { type: 3, value: "2.00" },
], extra);
const scratch = mkdtempSync(join(tmpdir(), "we-specs-trigger-checks-"));
try {
  const dir = join(scratch, "p");
  run("unpack", empty, dir, "--game", gamePath()); // the trigger file needs the game's TriggerData
  const map = join(dir, "map");
  const head = terrainHead(readFileSync(join(map, "war3map.w3e.txt"), "utf8"));
  const camerasFile = join(map, "war3map.w3c.json");
  const cameras = addLookCameras(JSON.parse(readFileSync(camerasFile, "utf8")), []);
  const look = resolveLook(parseLook("0,0,1500"), head);
  cameras.cameras.push(lookCamera(look, 0, cameras.version, cameras.localAngles === true, "Alpha"), lookCamera(look, 1, cameras.version, cameras.localAngles === true, "Bravo"));
  writeFileSync(camerasFile, `${JSON.stringify(cameras, null, 2)}\n`);
  const plain = { description: "", isComment: 0, enabled: true, initiallyOff: false, runOnInit: false };
  addGuiTrigger(dir, { ...plain, name: "Use Cams", ecas: [
    eca(0, "MapInitializationEvent", []),
    apply("Alpha"),
    apply("Bravo", { enabled: false }),
    eca(2, "CustomScriptCode", [{ type: 3, value: "// gg_cam_Alpha is named here in script" }]),
  ] });
  addGuiTrigger(dir, { ...plain, name: "Block", ecas: [
    eca(0, "TriggerRegisterTimerEventSingle", [{ type: 3, value: "5.00" }]),
    eca(2, "IfThenElseMultiple", [], { children: [
      eca(1, "OperatorCompareInteger", [{ type: 3, value: "1" }, { type: 0, value: "OperatorEqual" }, { type: 3, value: "1" }], { group: 0 }),
      eca(2, "DoNothing", [], { group: 1 }),
      eca(2, "CommentString", [{ type: 3, value: "else part" }], { group: 2 }),
    ] }),
  ] });
  addScriptTrigger(dir, { ...plain, name: "Textual" },
    "function InitTrig_Textual takes nothing returns nothing\n    call CameraSetupApplyForPlayer(true, gg_cam_Bravo, Player(0), 0)\nendfunction\n");
  run("pack", dir, "-o", out, "--force-stale");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
