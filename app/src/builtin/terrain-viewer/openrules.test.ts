import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fixturePath } from "../../lib/testhelpers/testutil";
import type { W3Api } from "../../extensions/api";
import { applyOpenRulesToProject, type OpenRulesIo } from "./openrules";
import type { PathingData } from "./pathmap";
import type { Skin } from "./objects";

const FIXTURE = fixturePath("mini-map");
const DOO = "map/war3map.doo.json", UNITS = "map/war3mapUnits.doo.json";

/** A copy of the mini map, opened as a project with no editor at all: files on disk and the backend's JSON calls. */
function project() {
  const root = mkdtempSync(join(tmpdir(), "openrules-"));
  cpSync(FIXTURE, root, { recursive: true });
  const abs = (p: string) => join(root, ...p.split("/"));
  const missing = (p: string) => new Error(`${p}: not found (os error 2)`);
  const list = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? list(join(dir, n)) : [join(dir, n)]));
  let open: string | null = root;
  const writes: string[] = [];
  const w3 = {
    workspace: {
      project: () => (open ? { root: open } : null),
      files: () => list(root).map((f) => ({ path: relative(root, f).split(/[\\/]/).join("/"), size: statSync(f).size, modified: statSync(f).mtimeMs })),
      readText: async (p: string) => { try { return readFileSync(abs(p), "utf8"); } catch { throw missing(p); } },
      readBytes: async (p: string) => { try { return new Uint8Array(readFileSync(abs(p))); } catch { throw missing(p); } },
      writeText: async (p: string, t: string) => { writes.push(p); writeFileSync(abs(p), t); },
    },
    backend: {
      invoke: async (cmd: string, args: { text?: string }) => {
        if (cmd === "codec_canonicalize") return JSON.stringify(JSON.parse(args.text!), null, 2);
        throw new Error(`no ${cmd} here`);
      },
    },
  } as unknown as W3Api;
  return { root, w3, writes, read: (p: string) => JSON.parse(readFileSync(abs(p), "utf8")), abs, close: () => { open = null; }, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

const skin = (kind: string, minScale = 1, maxScale = 1) => ({ kind, minScale, maxScale, fixedRot: null } as unknown as Skin);
/** The game's types as far as the test needs them: LOtr (a 4×2 pathing texture, scale 0.8 to 1.2), the barrel LTbr
 *  (2×2), the tree ATtr without a texture here. */
const SIZES: Record<string, [number, number]> = { LOtr: [4, 2], LTbr: [2, 2] };
function io(onPathing: () => void = () => {}): OpenRulesIo {
  return {
    objects: async () => ({ skins: new Map([["LOtr", skin("w3d", 0.8, 1.2)], ["LTbr", skin("w3d")], ["ATtr", skin("w3d")]]), bases: new Map(), unread: [] }),
    pathing: async () => {
      onPathing();
      return {
        placedTex: (id: string) => (SIZES[id] ? { path: `PathTextures\\${id}.tga`, dest: false, walkable: false } : null),
        placedImage: async (info: { path: string }) => {
          const [w, h] = SIZES[info.path.slice(13, -4)];
          return { image: { width: w, height: h, rgba: new Uint8Array(w * h * 4).fill(255) } };
        },
      } as unknown as PathingData;
    },
  };
}

const at = (doc: { doodads: { id: string; position: number[]; angle: number }[] }, id: string) => doc.doodads.find((d) => d.id === id);

test("a project the terrain view never opened: its doodads go on their grids, its units get the facings, written to the files", async () => {
  const p = project();
  try {
    const doo = p.read(DOO);
    doo.doodads.push({ ...doo.doodads[1], id: "LTbr", skinId: "LTbr", position: [40, 40, 0], editorId: 50 });
    writeFileSync(p.abs(DOO), JSON.stringify(doo, null, 2));
    const units = p.read(UNITS);
    units.units.push({ ...units.units[0], id: "hrif", skinId: "hrif", angle: 2, position: [-64, 0, 0], editorId: 91 });
    writeFileSync(p.abs(UNITS), JSON.stringify(units, null, 2));
    assert.deepEqual(at(p.read(DOO), "LOtr")?.position.slice(0, 2), [-64, 32], "control: stored off its grid");

    const done = await applyOpenRulesToProject(p.w3, p.root, { snap: true, fix: false }, io());
    assert.equal(done.snapped, 2);
    assert.ok(done.doodadsBefore, "the doodads before, for the shadows");
    const after = p.read(DOO);
    assert.deepEqual(at(after, "LOtr")?.position.slice(0, 2), [-32, 64], "LOtr (4×2) as the World Editor's open puts it");
    assert.deepEqual(at(after, "LTbr")?.position.slice(0, 2), [32, 32], "the barrel (2×2) at 64n + 32");
    assert.deepEqual(at(after, "ATtr")?.position, [64, -64, 0], "no pathing texture: it stays");
    assert.ok(Math.abs(p.read(UNITS).units.find((u: { id: string }) => u.id === "hrif").angle - (2 * Math.PI) / 180) < 1e-6, "a whole number is degrees");
    assert.equal(done.units, 1);
    assert.deepEqual(p.writes.sort(), [DOO, UNITS]);

    // Applied to their own result, the rules change nothing: nothing written again.
    p.writes.length = 0;
    const again = await applyOpenRulesToProject(p.w3, p.root, { snap: true, fix: false }, io());
    assert.deepEqual([again.snapped, again.fixed, again.units, p.writes.length], [0, 0, 0, 0]);
  } finally { p.dispose(); }
});

test("Fix Doodads on Load on its own: scales into the type's range, flags from the playable area", async () => {
  const p = project();
  try {
    const done = await applyOpenRulesToProject(p.w3, p.root, { snap: false, fix: true }, io());
    const lotr = p.read(DOO).doodads.find((d: { id: string }) => d.id === "LOtr");
    assert.deepEqual(lotr.position.slice(0, 2), [-64, 32], "the grid is the snap's");
    assert.deepEqual(lotr.scale.map(Math.fround), [0.8, 0.8, 1.2].map(Math.fround));
    assert.ok(done.fixed >= 1);
  } finally { p.dispose(); }
});

test("both settings off: no file is written", async () => {
  const p = project();
  try {
    const before = readFileSync(p.abs(DOO), "utf8");
    const done = await applyOpenRulesToProject(p.w3, p.root, { snap: false, fix: false }, io());
    assert.deepEqual([done.snapped, done.fixed, done.units, p.writes.length], [0, 0, 0, 0]);
    assert.equal(readFileSync(p.abs(DOO), "utf8"), before);
  } finally { p.dispose(); }
});

test("a doodad file that is there but can't be read is left as it is, and said", async () => {
  const p = project();
  try {
    writeFileSync(p.abs(DOO), "{ not json");
    const done = await applyOpenRulesToProject(p.w3, p.root, { snap: true, fix: true }, io());
    assert.equal(readFileSync(p.abs(DOO), "utf8"), "{ not json");
    assert.ok(!p.writes.includes(DOO));
    assert.ok(done.notes.some((n) => /war3map\.doo can't be read/.test(n)), done.notes.join("; "));
  } finally { p.dispose(); }
});

test("a file written while the rules ran keeps that write; another project opened meanwhile gets nothing", async () => {
  const p = project();
  try {
    let theirs = "";
    const done = await applyOpenRulesToProject(p.w3, p.root, { snap: true, fix: false }, io(() => {
      const doo = p.read(DOO);
      doo.doodads[1].position = [-64, 160, 0];
      theirs = JSON.stringify(doo, null, 2);
      writeFileSync(p.abs(DOO), theirs);
    }));
    assert.equal(readFileSync(p.abs(DOO), "utf8"), theirs);
    assert.equal(done.snapped, 0);
    assert.ok(done.notes.some((n) => /written meanwhile/.test(n)), done.notes.join("; "));

    const q = project();
    try {
      const before = readFileSync(q.abs(DOO), "utf8");
      await applyOpenRulesToProject(q.w3, q.root, { snap: true, fix: false }, io(() => q.close()));
      assert.equal(readFileSync(q.abs(DOO), "utf8"), before);
      assert.deepEqual(q.writes, []);
    } finally { q.dispose(); }
  } finally { p.dispose(); }
});
