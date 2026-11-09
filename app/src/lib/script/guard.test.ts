import assert from "node:assert/strict";
import { test } from "node:test";
import { lostFunctions, SCRIPT_INPUTS, scriptDecision, scriptHash } from "./guard";

test("saving what the script is made from regenerates it: the destructables' and the skin files' object data too", () => {
  // Destructable tints (war3map.w3b, war3mapSkin.w3b) and hero abilities (war3mapSkin.w3a) go into the script.
  for (const p of ["map/war3map.w3b.json", "map/war3mapSkin.w3b.json", "map/war3mapSkin.w3a.json", "map/war3mapSkin.w3u", "map/war3map.w3u.json", "map/war3map.wtg"]) assert.ok(SCRIPT_INPUTS.test(p), p);
  for (const p of ["map/war3map.w3q.json", "map/war3mapSkin.w3h.json", "map/war3map.wpm"]) assert.ok(!SCRIPT_INPUTS.test(p), p);
});

test("code that isn't made from the triggers is noticed, in JASS and Lua", () => {
  const generated = "function main takes nothing returns nothing\nendfunction\n";
  assert.deepEqual(lostFunctions("function Helper takes nothing returns nothing\nendfunction\nfunction main takes nothing returns nothing\nendfunction\n", generated), ["Helper"]);
  assert.deepEqual(lostFunctions("function main()\nend\nlocal function hidden()\nend\nfunction Reader.prototype.read(self)\nend\n", "function main()\nend\n"), ["hidden", "Reader.prototype.read"]);
});

test("Lua functions kept in variables count too", () => {
  assert.deepEqual(lostFunctions("function main()\nend\nHelper = function()\nend\nlocal api = function(x)\nend\nM.run = function()\nend\n", "function main()\nend\n"), ["Helper", "api", "M.run"]);
});

test("what the generator writes may come and go", () => {
  const current = ["main", "config", "InitTrig_Foo", "Trig_Foo_Actions", "CreateRegions", "CreateUnitsForPlayer3", "CreateNeutralPassive",
    "Unit000012_DropItems", "ItemTable000001_DropItems", "InitUpgrades_Player2", "InitTechTree"].map((f) => `function ${f}()\nend`).join("\n");
  assert.deepEqual(lostFunctions(current, "function main()\nend"), []);
});

test("the same names in both, and nested functions, aren't lost", () => {
  assert.deepEqual(lostFunctions("function Helper()\nend", "function Helper()\n  print(1)\nend"), []);
  assert.deepEqual(lostFunctions("function main()\n  function inner()\n  end\nend", "function main()\nend"), []);
});

test("a script changed inside the functions the generator writes is kept, not replaced", () => {
  const made = "function main takes nothing returns nothing\n    call InitBlizzard()\nendfunction\n";
  const mine = made.replace("call InitBlizzard()", "call InitBlizzard()\n    call BJDebugMsg(\"mine\")");
  // The one this app wrote last (stamp matches): replaced. Changed since (stamp is the old one's): kept, nothing lost
  // by name, since main is the generator's.
  const old = "function main takes nothing returns nothing\nendfunction\n";
  assert.deepEqual(scriptDecision(old, made, scriptHash(old)), { action: "write" });
  assert.deepEqual(scriptDecision(mine, made, scriptHash(old)), { action: "keep", lost: [] });
  // No stamp yet (a fresh import): kept when it differs, the same needs nothing.
  assert.deepEqual(scriptDecision(mine, made, null), { action: "keep", lost: [] });
  assert.deepEqual(scriptDecision(made, made, null), { action: "same" });
  // A stamp with its line end, as written, still counts.
  assert.deepEqual(scriptDecision(old, made, `${scriptHash(old)}\n`), { action: "write" });
});

test("no script is written, one that can't be read is kept, force replaces, functions of its own are named", () => {
  const made = "function main takes nothing returns nothing\nendfunction\n";
  assert.deepEqual(scriptDecision(null, made, null), { action: "write" });
  assert.deepEqual(scriptDecision(undefined, made, null), { action: "keep", lost: [] });
  assert.deepEqual(scriptDecision(undefined, made, scriptHash("")), { action: "keep", lost: [] });
  assert.deepEqual(scriptDecision("x", made, null, true), { action: "write" });
  assert.deepEqual(scriptDecision(undefined, made, null, true), { action: "write" });
  const helper = `function Helper takes nothing returns nothing\nendfunction\n${made}`;
  assert.deepEqual(scriptDecision(helper, made, null), { action: "keep", lost: ["Helper"] });
});

// A script as the generator writes one: placed destructables, items and units, a random unit, then main.
const placing = (dests: string[], items: string[], units: string[], eol = "\r\n") => [
  "function CreateAllDestructables takes nothing returns nothing", "    local destructable d", "    local trigger t", "    local real life", ...dests, "endfunction", "",
  "function CreateAllItems takes nothing returns nothing", "    local integer itemID", "", ...items, "endfunction", "",
  "function CreateUnitsForPlayer0 takes nothing returns nothing", "    local player p = Player(0)", "    local unit u", "    local integer unitID",
  "    local trigger t", "    local real life", "", ...units, "endfunction", "",
  "function main takes nothing returns nothing", "    call CreateAllDestructables(  )", "    call CreateUnitsForPlayer0(  )", "endfunction", "",
].join(eol);
const tree = ["    set d = BlzCreateDestructableWithSkin( 'LTlt', 0.0, 0.0, 270.000, 1.000, 0, 'LTlt' )",
  "    set life = GetDestructableLife( d )", "    call SetDestructableLife( d, 0.50 * life )"];
const gate = ["    set gg_dest_DTg1_0001 = BlzCreateDestructableWithSkin( 'DTg1', 64.0, 0.0, 270.000, 1.000, 0, 'DTg1' )"];
const sword = ["    call BlzCreateItemWithSkin( 'ratc', 10.0, 20.0, 'ratc' )"], ring = ["    call BlzCreateItemWithSkin( 'rde1', 30.0, 40.0, 'rde1' )"];
const footman = ["    set u = BlzCreateUnitWithSkin( p, 'hfoo', 0.0, 0.0, 270.000, 'hfoo' )", "    set life = GetUnitState( u, UNIT_STATE_LIFE )",
  "    call SetUnitState( u, UNIT_STATE_LIFE, 0.50 * life )"];
const knight = ["    set u = BlzCreateUnitWithSkin( p, 'hkni', 100.0, 0.0, 270.000, 'hkni' )", "    call SetUnitAcquireRange( u, 200.0 )"];
const random = ["    call RandomDistReset(  )", "    call RandomDistAddItem( 'hfoo', 50 )", "    call RandomDistAddItem( 'hkni', 50 )",
  "    set unitID = RandomDistChoose(  )", "    if (unitID != -1) then", "        set u = BlzCreateUnitWithSkin( p, unitID, 0.0, 0.0, 270.000, unitID )",
  "        call SetUnitAcquireRange( u, 200.0 )", "    endif"];

test("a World Editor script whose placed objects only come in another order is replaced without asking", () => {
  const made = placing([...tree, ...gate], [...sword, ...ring], [...footman, ...random, ...knight]);
  const theirs = placing([...gate, ...tree], [...ring, ...sword], [...knight, ...footman, ...random]);
  assert.notEqual(theirs, made);
  assert.deepEqual(scriptDecision(theirs, made, null), { action: "write" });
  // Line feeds only, too.
  assert.deepEqual(scriptDecision(theirs.replace(/\r\n/g, "\n"), made.replace(/\r\n/g, "\n"), null), { action: "write" });
});

test("a placed object's own lines, anything outside the placing functions and other contents still ask", () => {
  const made = placing([...tree, ...gate], [...sword, ...ring], [...footman, ...knight]);
  const keep = { action: "keep", lost: [] };
  // A line that sets up an object moved to another: the footman's life would go to the knight.
  assert.deepEqual(scriptDecision(placing([...tree, ...gate], [...sword, ...ring], [footman[0], ...knight, ...footman.slice(1)]), made, null), keep);
  // Within a block, lines keep their order (the life is read before it's set).
  assert.deepEqual(scriptDecision(placing([...tree, ...gate], [...sword, ...ring], [footman[0], footman[2], footman[1], ...knight]), made, null), keep);
  // Another object, a missing one, a changed one.
  assert.deepEqual(scriptDecision(placing([...tree, ...gate], [...sword, ...sword], [...footman, ...knight]), made, null), keep);
  assert.deepEqual(scriptDecision(placing([...gate, ...tree], [...ring, ...sword], [...knight, footman[0], footman[1], footman[2].replace("0.50", "0.40")]), made, null), keep);
  // The calls in main are in order.
  const swapped = made.replace("    call CreateAllDestructables(  )\r\n    call CreateUnitsForPlayer0(  )", "    call CreateUnitsForPlayer0(  )\r\n    call CreateAllDestructables(  )");
  assert.notEqual(swapped, made);
  assert.deepEqual(scriptDecision(swapped, made, null), keep);
  // A random pick's lines stay with it.
  const withRandom = placing([], [], [...random, ...knight]);
  assert.deepEqual(scriptDecision(placing([], [], [...knight, ...random]), withRandom, null), { action: "write" });
  assert.deepEqual(scriptDecision(placing([], [], [...random.slice(0, 4), ...knight, ...random.slice(4)]), withRandom, null), keep);
  // The acquisition range may come anywhere in its unit's lines (the World Editor sets it after level and mana), but
  // only its own unit's.
  const hero = ["    set u = BlzCreateUnitWithSkin( p, 'Hpal', 0.0, 0.0, 270.000, 'Hpal' )", "    call SetUnitAcquireRange( u, 200.0 )",
    "    call SetHeroLevel( u, 3, false )", "    call SetUnitState( u, UNIT_STATE_MANA, 200 )"];
  const withHero = placing([], [], [...hero, ...knight]);
  assert.deepEqual(scriptDecision(placing([], [], [...knight, hero[0], hero[2], hero[3], hero[1]]), withHero, null), { action: "write" });
  assert.deepEqual(scriptDecision(placing([], [], [hero[0], hero[2], ...knight, hero[1], hero[3]]), withHero, null), keep);
  const other = hero.map((l) => l.replace("( u,", "( gg_unit_Hpal_0001,"));
  assert.deepEqual(scriptDecision(placing([], [], [hero[0], other[2], other[3], other[1]]), placing([], [], [hero[0], ...other.slice(1)]), null), keep);
  // A function's locals aren't objects.
  assert.deepEqual(scriptDecision(made.replace("    local unit u\r\n    local integer unitID", "    local integer unitID\r\n    local unit u"), made, null), keep);
});

test("a script's hash follows its text", () => {
  assert.equal(scriptHash("abc"), scriptHash("abc"));
  assert.notEqual(scriptHash("abc"), scriptHash("abd"));
  assert.match(scriptHash(""), /^[0-9a-f]{8}$/);
});
