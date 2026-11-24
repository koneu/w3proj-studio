// The environment code is checked against, and where the cursor is for completion. Own file: gameJassEnv caches in
// the module, so these tests decide what it has seen.

import assert from "node:assert/strict";
import { test } from "node:test";
import { codeSpot, paramOf } from "./callsite";
import { gameJassEnv, jassSymbols, mapJass, mapScriptJassEnv } from "./env";
import { MINI_BLIZZARD_J, MINI_COMMON_J } from "./mini-game.fixture";

const files: Record<string, string> = { "Scripts\\common.j": MINI_COMMON_J, "Scripts\\Blizzard.j": MINI_BLIZZARD_J };
const read = async (p: string) => {
  const f = files[p];
  if (f === undefined) throw new Error(`no ${p}`);
  return f;
};

test("the game's environment is read once; a failed read isn't kept, so the next call tries again", async () => {
  let reads = 0;
  await assert.rejects(gameJassEnv(async (p) => { reads++; throw new Error(`can't read ${p}`); }), /can't read/);
  const counted = async (p: string) => { reads++; return read(p); };
  const env = await gameJassEnv(counted);
  assert.equal(env.functions.get("KillUnit")?.source, "game:Scripts\\common.j");
  assert.equal(env.functions.get("BJDebugMsg")?.source, "game:Scripts\\Blizzard.j");
  const after = reads;
  assert.equal(after, 3, "one failed read, then both files");
  assert.equal(await gameJassEnv(counted), env, "cached");
  assert.equal(reads, after);
});

test("a map without its own scripts is checked against the game's; its own Blizzard.j replaces the game's", async () => {
  const none = async () => null;
  assert.equal(await mapScriptJassEnv(read, none), await gameJassEnv(read));
  const ownBlizzard = "function OnlyMine takes nothing returns nothing\nendfunction\n";
  const env = await mapScriptJassEnv(read, async (p) => (p === "Scripts\\Blizzard.j" ? ownBlizzard : null));
  assert.equal(env.functions.get("OnlyMine")?.source, "map:Scripts\\Blizzard.j");
  assert.equal(env.functions.get("KillUnit")?.source, "game:Scripts\\common.j");
  assert.ok(!env.functions.has("BJDebugMsg"), "the game's Blizzard.j isn't merged in");
});

test("a map's common.j that lacks the game's declarations is refused with a warning; one that is unreadable rejects", async () => {
  const warnings: string[] = [];
  const env = await mapScriptJassEnv(read, async (p) => (p === "Scripts\\common.j" ? "type agent extends handle\n" : null), (m) => warnings.push(m));
  assert.equal(warnings.length, 1);
  assert.equal(env, await gameJassEnv(read), "the game's, as if the map had none");
  // There but unreadable is not the same as absent: never silently the game's.
  await assert.rejects(mapScriptJassEnv(read, async () => { throw new Error("locked"); }), /locked/);
});

test("a map's common.j that is compatible is taken as it is", async () => {
  const own = `${MINI_COMMON_J}\nglobals\n    constant integer MY_HERO = 'H000'\nendglobals\n`;
  const env = await mapScriptJassEnv(read, async (p) => (p === "Scripts\\common.j" ? own : null));
  assert.equal(env.globals.get("MY_HERO")?.source, "map:Scripts\\common.j");
  assert.equal(env.functions.get("BJDebugMsg")?.source, "game:Scripts\\Blizzard.j");
});

test("symbols of code in a map say which trigger declares a name, gg_trg_ variables included", async () => {
  const script = [
    "globals", "    trigger gg_trg_Spawn = null", "    integer udg_Count = 0", "endglobals",
    "//*  Triggers", "// Trigger: Spawn", "function Trig_Spawn_Actions takes nothing returns nothing", "endfunction",
    "function InitTrig_Spawn takes nothing returns nothing", "endfunction",
    "//*  Players", "function InitCustomPlayerSlots takes nothing returns nothing", "endfunction", "",
  ].join("\n");
  const m = mapJass(read, Promise.resolve(script));
  const symbols = new Map((await m.symbols("function Local takes integer a returns nothing\nendfunction\n")).map((s) => [s.name, s]));
  assert.equal(symbols.get("Trig_Spawn_Actions")?.location, "trigger:Spawn");
  assert.equal(symbols.get("gg_trg_Spawn")?.location, "trigger:Spawn");
  // After a section banner the functions belong to no trigger; a global not from a trigger has no location.
  assert.equal(symbols.get("InitCustomPlayerSlots")?.location, undefined);
  assert.equal(symbols.get("udg_Count")?.location, undefined);
  assert.equal(symbols.get("KillUnit")?.location, "game:Scripts\\common.j");
  // The text's own names come first, with their positions.
  assert.equal(symbols.get("Local")?.at, "function ".length);
  assert.equal(symbols.get("a")?.kind, "param");
  assert.equal(symbols.get("unit")?.detail, "type unit extends widget");
  assert.equal(symbols.get("endfunction")?.kind, "keyword");
  // without() leaves out what the checked text declares itself.
  assert.ok(!(await m.without("function Trig_Spawn_Actions takes nothing returns nothing\nendfunction\n")).functions.has("Trig_Spawn_Actions"));
});

test("a map without a script: the game's names only", async () => {
  const m = mapJass(read, Promise.resolve(null));
  const names = (await m.symbols("")).map((s) => s.name);
  assert.ok(names.includes("KillUnit") && !names.includes("Trig_Spawn_Actions"));
  assert.ok(jassSymbols(await gameJassEnv(read), "").length === names.length);
});

test("codeSpot: inside a string (escapes resolved), a rawcode, a comment, and nested calls", () => {
  const s = 'call AddSpecialEffect( "Abil\\\\Fx', pos = s.length;
  assert.deepEqual(codeSpot(s, pos), { inString: true, inRawcode: false, prefix: "Abil\\Fx", from: s.indexOf('"') + 1, call: { name: "AddSpecialEffect", argIndex: 0 } });
  const r = "call CreateUnit( p, 'hf";
  assert.deepEqual(codeSpot(r, r.length), { inString: false, inRawcode: true, prefix: "hf", from: r.length - 2, call: { name: "CreateUnit", argIndex: 1 } });
  const c = "call F( 1 ) // F( x";
  assert.deepEqual(codeSpot(c, c.length), { inString: false, inRawcode: false, prefix: "", from: c.length });
  // A comment closed by its line end is skipped; a closed string doesn't count its commas.
  const n = 'call F( "a,b", G( 1, // (\n Unit';
  assert.deepEqual(codeSpot(n, n.length), { inString: false, inRawcode: false, prefix: "Unit", from: n.length - 4, call: { name: "G", argIndex: 1 } });
  // A parenthesis that's no call (an expression) has no name, so it offers no call.
  const e = "set x = ( 1 + ";
  assert.equal(codeSpot(e, e.length).call, undefined);
  // After the call closed, it's over.
  const done = "call F( 1 ) ";
  assert.equal(codeSpot(done, done.length).call, undefined);
});

test("codeSpot looks back only so far, from a line start", () => {
  const far = `call F( ${"x".repeat(5000)}\ncall G( "ab`;
  const spot = codeSpot(far, far.length);
  assert.deepEqual([spot.inString, spot.prefix, spot.call?.name], [true, "ab", "G"]);
  // Control: the window starts after F's "(": F isn't seen even from inside its own argument list on the next line.
  const inF = `call F( ${"x".repeat(5000)}\n, `;
  assert.equal(codeSpot(inF, inF.length).call, undefined);
});

test("paramOf reads a parameter of a signature", () => {
  assert.deepEqual(paramOf("native AddSpecialEffect takes string modelName, real x, real y returns effect", 2), { type: "real", name: "y" });
  assert.equal(paramOf("native F takes integer a returns nothing", 1), undefined);
  assert.equal(paramOf("not a signature", 0), undefined);
});
