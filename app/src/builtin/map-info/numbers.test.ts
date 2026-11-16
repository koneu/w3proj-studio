import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { INFO_NUMBERS, infoNumber, setInfoNumber, WATER_NUMBERS, type InfoNumber, type InfoNumberKey } from "./numbers";

/** A file of the repository, found from where the tests run (app/ or the repository). */
function repoFile(...parts: string[]): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    const p = join(dir, ...parts);
    if (existsSync(p)) return readFileSync(p, "utf8");
    if (dirname(dir) === dir) throw new Error(`${parts.join("/")} not found`);
  }
}
const mini = JSON.parse(repoFile("tests", "fixtures", "mini-map", "map", "war3map.w3i.json"));
/** The mini map's map info, with the 3.0 parts it lacks (crest race, camera zoom, terrain fog, water) as a v39 file has them. */
const fixture = () => {
  const info = structuredClone(mini);
  info.version = 39;
  info.loadingScreen.crestRace = 0;
  info.cameraZoom = { default: 1650, max: 3000, min: 100 };
  info.terrainFog = { style: 0, overSky: 0, linearStart: 3000, linearEnd: 5000, maxOpacity: 1, height: 0 };
  info.water = Object.fromEntries(WATER_NUMBERS.map((k) => [INFO_NUMBERS[k].path[1], 0]));
  return info;
};

/** Each field's type in crates/w3proj/formats/w3i.json, by its path there ("*" for a list's item, a number for an array's place). */
function w3iTypes(): Map<string, string> {
  const text = repoFile("crates", "w3proj", "formats", "w3i.json").replace(/^\s*\/\/.*$/gm, "");
  const out = new Map<string, string>();
  const walk = (fields: { name: string; type: string; fields?: unknown[]; count?: unknown }[], at: string[]) => {
    for (const f of fields) {
      const path = typeof f.count === "string" && f.type === "struct" ? [...at, f.name, "*"] : [...at, f.name];
      if (f.fields) walk(f.fields as never, path);
      else out.set(path.join("."), f.type);
    }
  };
  walk(JSON.parse(text).fields, []);
  return out;
}

/** The values just past each stored type, and its edges, which are taken. */
const PAST: Record<string, string[]> = {
  u8: ["-1", "256", "1.5", "", "abc"],
  u32: ["-1", "4294967296", "2.5", "", "1e400"],
  i32: ["-2147483649", "2147483648", "0.5", "", "x"],
  f32: ["1e39", "-3.5e38", "", "Infinity", "NaN"],
};
const EDGES: Record<string, number[]> = {
  u8: [0, 255], u32: [0, 4294967295], i32: [-2147483648, 2147483647], f32: [-3.4028234663852886e38, 3.4028234663852886e38, 0.1],
};

test("every number field of Map Properties has the type war3map.w3i stores it in", () => {
  const types = w3iTypes();
  for (const [key, f] of Object.entries(INFO_NUMBERS)) {
    const path = f.path.filter((k) => typeof k === "string").join(".");
    const t = types.get(path);
    // Colours (rgba) hold a byte each; a field with a count holds its type in each place.
    assert.equal(t === "rgba" ? "u8" : t, f.kind, `${key} (${path})`);
  }
});

for (const key of Object.keys(INFO_NUMBERS) as InfoNumberKey[]) {
  const f: InfoNumber = INFO_NUMBERS[key];
  const player = f.path.includes("*") ? 0 : undefined;
  test(`Map Properties ${f.label}: a value its ${f.kind} can't hold is refused and the map info stays as it was; its edges are taken`, () => {
    const info = fixture();
    const before = JSON.stringify(info);
    assert.notEqual(infoNumber(info, key, player), undefined, "the field is in the fixture");
    for (const typed of PAST[f.kind]) {
      const r = setInfoNumber(info, key, typed, player);
      assert.ok("refused" in r, `${JSON.stringify(typed)} refused`);
      assert.match(r.refused, new RegExp(`^${f.label} must be`));
      assert.equal(JSON.stringify(info), before, `${JSON.stringify(typed)} changed nothing`);
    }
    for (const edge of EDGES[f.kind]) {
      const r = setInfoNumber(info, key, String(edge), player);
      assert.deepEqual(r, { value: edge });
      assert.equal(infoNumber(info, key, player), edge);
    }
  });
}

test("a field the map's file doesn't have (a v31 file's camera zoom) is refused, and nothing is added", () => {
  const info = structuredClone(mini);
  const before = JSON.stringify(info);
  assert.equal(infoNumber(info, "zoomDefault"), undefined);
  assert.ok("refused" in setInfoNumber(info, "zoomDefault", "1000"));
  assert.equal(JSON.stringify(info), before);
});
