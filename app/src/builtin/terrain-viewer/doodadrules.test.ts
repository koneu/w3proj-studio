import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { doodadFixes, savedFlags, savedLife, savedScale, type RuledDoodad, type ScaleRule } from "./doodadrules";
import { inArea } from "../../lib/terrain/area";

/** tests/fixtures/doodad-grid-we/<name>, found from where the tests run (app/ or the repository). */
function fixture(name: string): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, "tests", "fixtures", "doodad-grid-we", name);
    if (existsSync(p)) return readFileSync(p, "utf8");
    if (dirname(dir) === dir) throw new Error(`tests/fixtures/doodad-grid-we/${name} not found`);
  }
}

const lines = fixture("saverules-cases.txt").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
const triple = (s: string) => s.split(",").map(Number) as [number, number, number];
const scales = lines.filter((l) => l.startsWith("scale ")).map((line) => {
  const [, id, kind, min, max, stored, , saved] = line.split(" ");
  return { line, id, rule: { kind, min: Number(min), max: Number(max) } as ScaleRule, stored: triple(stored), saved: triple(saved) };
});
const flags = lines.filter((l) => l.startsWith("flags ")).map((line) => {
  const [, id, x, y, stored, , saved] = line.split(" ");
  return { line, id, x: Number(x), y: Number(y), stored: Number(stored), saved: Number(saved) };
});
/** The test map's playable area (64x64 at -4096, camera complements 6, 6, 4, 8). */
const PLAYABLE = { left: -3328, right: 3328, bottom: -3584, top: 3072 };
const f32 = (v: readonly number[]) => v.map((x) => Math.fround(x));
/** No random number may be drawn. */
const never = () => { throw new Error("random drawn"); };

test("every measured scale is what the World Editor saved (128 cases, 0 aside)", () => {
  assert.equal(scales.length, 128);
  const wrong: string[] = [];
  for (const c of scales.filter((c) => !c.stored.includes(0))) {
    const got = savedScale(c.stored, c.rule, never);
    if (JSON.stringify(f32(got)) !== JSON.stringify(f32(c.saved))) wrong.push(`${c.line}: got ${got}`);
  }
  assert.deepEqual(wrong, []);
});

test("a scale of 0 becomes a random one in the range: a destructable's one for all axes, a doodad's per axis", () => {
  const zeros = scales.filter((c) => c.stored.every((v) => v === 0));
  assert.equal(zeros.length, 8);
  for (const c of zeros) {
    // The measured ones are in the range, a destructable's alike on all axes.
    for (const v of c.saved) assert.ok(Math.fround(v) >= Math.fround(c.rule.min) && Math.fround(v) <= Math.fround(c.rule.max), c.line);
    if (c.rule.kind === "w3b") assert.equal(new Set(c.saved).size, 1, c.line);
    const draws = [0.25, 0.5, 0.75];
    let i = 0;
    const got = savedScale(c.stored, c.rule, () => draws[i++]);
    const want = (r: number) => c.rule.min + r * (c.rule.max - c.rule.min);
    assert.deepEqual(got, c.rule.kind === "w3b" ? [want(0.25), want(0.25), want(0.25)] : draws.map(want), c.line);
  }
  // The measured doodads of a range got three different scales: per axis.
  assert.ok(zeros.some((c) => c.rule.kind === "w3d" && new Set(c.saved).size === 3));
});

test("the measured scales tell the rules apart (controls)", () => {
  const per = (s: readonly number[], r: ScaleRule) => s.map((v) => Math.min(r.max, Math.max(r.min, v)));
  // Per axis for destructables too gets the barrel's 1, 1.3, 2 wrong (saved 1.1 on all three).
  const destr = scales.filter((c) => c.rule.kind === "w3b" && !c.stored.includes(0) && JSON.stringify(f32(per(c.stored, c.rule))) !== JSON.stringify(f32(c.saved)));
  assert.ok(destr.length >= 4, `${destr.length}`);
  // The destructables' rule for doodads gets the hay cart's 2, 1, 1.3 wrong (saved 1.2, 1, 1.2).
  const asDestr = scales.filter((c) => c.rule.kind === "w3d" && !c.stored.includes(0)
    && JSON.stringify(f32(savedScale(c.stored, { ...c.rule, kind: "w3b" }, never))) !== JSON.stringify(f32(c.saved)));
  assert.ok(asDestr.length >= 8, `${asDestr.length}`);
  // The size of the value, not the value: a clamp of |v| keeping the sign gets -1 wrong (saved as the least).
  assert.ok(scales.some((c) => c.stored[0] === -1 && c.saved[0] === c.rule.min));
  // The map's own object data counts: LOfl is 0.8 to 1.2 in the game, 0.5 to 3 by the map's w3d, and 3 stays.
  assert.ok(scales.some((c) => c.id === "LOfl" && c.stored[0] === 3 && c.saved[0] === 3));
});

test("a range the wrong way round saves every scale at its least; the tree bridges' 0.8 to 1 (measured)", () => {
  // we-drive, verification round 3 package 6: the map's LTex at bmis 1.5, bmas 1.1 and LPfp at dmis 1.4, dmas 0.9.
  const ltex: ScaleRule = { kind: "w3b", min: 1.5, max: 1.1 }, lpfp: ScaleRule = { kind: "w3d", min: 1.4, max: 0.9 };
  for (const s of [1, 1.3, 2, 1.1]) assert.deepEqual(savedScale([s, s, s], ltex, never), [1.5, 1.5, 1.5], `LTex ${s}`);
  for (const s of [1, 1.2, 2, 0.5]) assert.deepEqual(savedScale([s, s, s], lpfp, never), [1.4, 1.4, 1.4], `LPfp ${s}`);
  // Control: held to the least first, then the most, 2 would be 1.1.
  assert.equal(Math.max(ltex.max, Math.min(ltex.min, 2)), 1.5);
  assert.equal(Math.min(ltex.max, Math.max(ltex.min, 2)), 1.1);
  // LTt0, read as the editor reads its table (0.8 to 1): 0.5 to 0.8, 2 and 1.5 to 1, 0.9 and 0.8 kept.
  const bridge: ScaleRule = { kind: "w3b", min: 0.8, max: 1 };
  assert.deepEqual([0.5, 2, 1.5, 1, 0.9, 0.8].map((s) => savedScale([s, s, s], bridge, never)[0]), [0.8, 1, 1, 1, 0.9, 0.8]);
});

test("a scale that fits is returned as stored, in single precision", () => {
  const s: [number, number, number] = [1.1, 1.3, 1.5];
  assert.deepEqual(savedScale(s, { kind: "w3d", min: 1.1, max: 1.5 }, never), s);
  // The JSON's 0.8 is the file's 0.8, not below a minScale of "0.800".
  assert.deepEqual(savedScale([0.8, 0.8, 0.8], { kind: "w3b", min: 0.8, max: 1.2 }, never), [0.8, 0.8, 0.8]);
  assert.deepEqual(savedScale([0.8000001, 1, 1], { kind: "w3d", min: 0.8, max: 1.2 }, never), [0.8000001, 1, 1]);
  // Malformed: NaN goes to the least.
  assert.deepEqual(savedScale([Number.NaN, 1, 1], { kind: "w3d", min: 0.8, max: 1.2 }, never), [0.8, 1, 1]);
});

test("every measured flag is what the World Editor saved (72 cases)", () => {
  assert.equal(flags.length, 72);
  const wrong = flags.filter((c) => savedFlags(c.stored, !inArea(c.x, c.y, PLAYABLE)) !== c.saved).map((c) => c.line);
  assert.deepEqual(wrong, []);
  // Controls: each of the eight stored flags is measured inside and outside, and the edge both ways.
  for (const outside of [false, true]) for (let f = 0; f < 8; f++) assert.ok(flags.some((c) => c.stored === f && inArea(c.x, c.y, PLAYABLE) !== outside), `${f} ${outside}`);
  assert.ok(flags.some((c) => c.x === 3328 && c.stored === 3 && c.saved === 2), "on the edge is inside");
  assert.ok(flags.some((c) => c.x === 3328.5 && c.stored === 2 && c.saved === 3), "half past it is outside");
  // Higher bits stay as they are (not measured).
  assert.equal(savedFlags(8, false), 10);
});

test("doodadFixes lists only what changes, and leaves the list as it is", () => {
  const rules: Record<string, ScaleRule> = { LTbr: { kind: "w3b", min: 1.1, max: 1.5 }, LOch: { kind: "w3d", min: 0.8, max: 1.2 } };
  const at = (id: string, x: number, scale: [number, number, number], fl?: number): RuledDoodad => ({ id, position: [x, 0, 0], scale, ...(fl === undefined ? {} : { flags: fl }) });
  const list = [at("LTbr", 0, [1.1, 1.1, 1.1], 2), at("LTbr", 0, [1, 1, 1], 2), at("LOch", 4000, [1, 1, 1], 2), at("LOch", 0, [1, 1, 1], 6),
    at("XXxx", 0, [9, 9, 9], 3), at("LOch", 0, [2, 1, 1])];
  const fixes = doodadFixes(list, (id) => rules[id] ?? null, (x, y) => !inArea(x, y, PLAYABLE), never);
  assert.deepEqual(fixes.map((f) => [list.indexOf(f.entry), f.scale, f.flags]), [
    [1, [1.1, 1.1, 1.1], 2], [2, [1, 1, 1], 3], [4, [9, 9, 9], 2], [5, [1.2, 1, 1], undefined]]);
  assert.deepEqual(list[1].scale, [1, 1, 1], "the list itself isn't changed");
  // Without the playable area the flags stay.
  assert.deepEqual(doodadFixes([list[2], list[4]], (id) => rules[id] ?? null, null, never), []);
});

test("savedLife: a destructable's is held to 100, a doodad's is 255 (we-drive, doodad-life spec)", () => {
  for (const [stored, saved] of [[0, 0], [1, 1], [50, 50], [100, 100], [101, 100], [200, 100], [255, 100]]) assert.equal(savedLife(stored, "w3b"), saved, `w3b ${stored}`);
  for (const stored of [0, 50, 100, 255]) assert.equal(savedLife(stored, "w3d"), 255, `w3d ${stored}`);
  assert.equal(savedLife(77, undefined), 77, "an unknown type keeps its life");
  assert.equal(savedLife(77, "w3u"), 77);
});

test("doodadFixes sets the life; a list that already fits has no fix", () => {
  const kinds: Record<string, string> = { LTbr: "w3b", LOch: "w3d" };
  const at = (id: string, life: number | undefined): RuledDoodad => ({ id, position: [0, 0, 0], scale: [1, 1, 1], ...(life === undefined ? {} : { life }) });
  const list = [at("LTbr", 255), at("LTbr", 100), at("LTbr", 0), at("LOch", 100), at("LOch", 255), at("XXxx", 7), at("LOch", undefined)];
  const fixes = doodadFixes(list, () => null, null, never, (id) => kinds[id]);
  assert.deepEqual(fixes.map((f) => [list.indexOf(f.entry), f.life]), [[0, 100], [3, 255]]);
  assert.deepEqual(doodadFixes([list[1], list[2], list[4], list[5]], () => null, null, never, (id) => kinds[id]), []);
  assert.equal(list[0].life, 255, "the list itself isn't changed");
  assert.deepEqual(doodadFixes([list[0]], () => null, null, never), [], "without kinds the life stays");
});
