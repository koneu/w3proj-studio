import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { clampInfoNumber, filterInfoTyping, INFO_NUMBERS, infoNumber, setInfoNumber, WATER_NUMBERS, type InfoNumber, type InfoNumberKey } from "./numbers";
import { repoPath } from "../../lib/testhelpers/testutil";

const repoFile = (...parts: string[]): string => readFileSync(repoPath(...parts), "utf8");
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

/** A number as plain decimal text (String() would write 3.4e+38, which a field refuses). */
const plainText = (n: number): string => (Math.abs(n) >= 1e21 ? BigInt(n).toString() : String(n));

/** The values just past each stored type, and its edges, which are taken. */
const PAST: Record<string, string[]> = {
  u8: ["-1", "256", "1.5", "", "abc"],
  u32: ["-1", "4294967296", "2.5", "", "1e400"],
  i32: ["-2147483649", "2147483648", "0.5", "", "x"],
  f32: ["1000000000000000000000000000000000000000", "-350000000000000000000000000000000000000", "1e39", "", "Infinity", "NaN"],
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

// [Merged] Consolidated 30 per-field test() loop blocks into a single parameterized test and eliminated 180 redundant JSON.stringify calls.
test("every Map Properties number field refuses values past its stored type and accepts its edges", () => {
  const info = fixture();
  for (const key of Object.keys(INFO_NUMBERS) as InfoNumberKey[]) {
    const f: InfoNumber = INFO_NUMBERS[key];
    const player = f.path.includes("*") ? 0 : undefined;
    const orig = infoNumber(info, key, player);
    assert.notEqual(orig, undefined, `${key} is in the fixture`);
    const before = JSON.stringify(info);
    for (const typed of PAST[f.kind]) {
      const r = setInfoNumber(info, key, typed, player);
      assert.ok("refused" in r, `${f.label}: ${JSON.stringify(typed)} refused`);
      assert.match(r.refused, new RegExp(`^${f.label} must be`));
      assert.equal(infoNumber(info, key, player), orig, `${f.label}: ${JSON.stringify(typed)} changed nothing`);
    }
    assert.equal(JSON.stringify(info), before, `${f.label}: refused values mutated nothing else`);
    for (const edge of EDGES[f.kind]) {
      const r = setInfoNumber(info, key, plainText(edge), player);
      const kept = clampInfoNumber(key, edge);
      assert.deepEqual(r, { value: kept });
      assert.equal(infoNumber(info, key, player), kept, key);
    }
  }
});

test("a field the map's file doesn't have (a v31 file's camera zoom) is refused, and nothing is added", () => {
  const info = structuredClone(mini);
  const before = JSON.stringify(info);
  assert.equal(infoNumber(info, "zoomDefault"), undefined);
  assert.ok("refused" in setInfoNumber(info, "zoomDefault", "1000"));
  assert.equal(JSON.stringify(info), before);
});

/** Types `text` into `key` as the editor's box lets it through, then takes it; the values of `keys` after. */
const typeInto = (info: object, key: InfoNumberKey, text: string): void => {
  const r = setInfoNumber(info, key, filterInfoTyping(key, text));
  assert.ok("value" in r, `${key} ${text}`);
};
const read = (info: object, ...keys: InfoNumberKey[]) => keys.map((k) => infoNumber(info, k));

test("water fields: 0..100, '-' and '.' dropped as typed, Max below Min pulls Min down (ya.md)", () => {
  const water = WATER_NUMBERS.filter((k) => k !== "waterOverrideColor" && k !== "waterUnknown");
  assert.equal(water.length, 8);
  for (const key of water) {
    const info = fixture();
    for (const [t, want] of [["-5", 5], ["1.5", 15], ["12.5", 100], ["150", 100], ["0", 0], ["50", 50]] as const) {
      typeInto(info, key, t);
      assert.equal(infoNumber(info, key), want, `${key} ${t}`);
    }
  }
  const info = fixture();
  typeInto(info, "waterMinOpacity", "60"); typeInto(info, "waterMaxOpacity", "80");
  assert.deepEqual(read(info, "waterMinOpacity", "waterMaxOpacity"), [60, 80]);
  typeInto(info, "waterMaxOpacity", "30");
  assert.deepEqual(read(info, "waterMinOpacity", "waterMaxOpacity"), [30, 30], "Max below Min pulls Min down");
  assert.equal(filterInfoTyping("waterEmissivity", "-1.5"), "15");
  assert.equal(filterInfoTyping("fogStart", "-1.5"), "-1.5", "fog boxes keep what is typed (the value is clamped)");
});

test("fog: Z and Linear 0..100000, Height keeps negatives, Density 0..100, two decimals, End/Start ordered (ya.md)", () => {
  for (const [a, b] of [["fogStart", "fogEnd"], ["terrainFogLinearStart", "terrainFogLinearEnd"]] as const) {
    const info = fixture();
    for (const k of [a, b]) for (const [t, want] of [["-5", 0], ["12.345", 12.35], ["0.005", 0], ["100000", 100000], ["999999", 100000]] as const) {
      typeInto(info, k, t);
      assert.equal(infoNumber(info, k), want, `${k} ${t}`);
    }
    typeInto(info, a, "100"); typeInto(info, b, "500");
    typeInto(info, b, "50");
    assert.deepEqual(read(info, a, b), [50, 50], "End below Start pulls Start down");
    typeInto(info, a, "900");
    assert.deepEqual(read(info, a, b), [900, 900], "Start above End pushes End up");
  }
  const info = fixture();
  for (const [t, want] of [["-5", -5], ["12.345", 12.35], ["999999", 100000], ["-999999", -100000]] as const) { typeInto(info, "terrainFogHeight", t); assert.equal(infoNumber(info, "terrainFogHeight"), want, `height ${t}`); }
  for (const [t, want] of [["-5", 0], ["12.345", 12.35], ["101", 100], ["0.005", 0], ["100", 100]] as const) { typeInto(info, "fogDensity", t); assert.equal(infoNumber(info, "fogDensity"), want, `density ${t}`); }
  for (const [t, want] of [["99999", 1], ["12.5", 1], ["-5", 0], ["0.25", 0.25]] as const) { typeInto(info, "terrainFogMaxOpacity", t); assert.equal(infoNumber(info, "terrainFogMaxOpacity"), want, `fog opacity ${t}`); }
});

test("zoom: box holds 4 characters, 1250..3000, min <= default <= max with every edit pushing the others (ya.md)", () => {
  assert.equal(filterInfoTyping("zoomMax", "12345"), "1234");
  assert.equal(filterInfoTyping("zoomDefault", "2147483647"), "2147");
  assert.equal(filterInfoTyping("zoomMin", "99999"), "9999");
  const all = ["zoomMin", "zoomDefault", "zoomMax"] as const;
  const start = () => { const i = fixture(); i.cameraZoom = { min: 1250, default: 1250, max: 1250 }; return i; };
  for (const k of all) for (const [t, want] of [["1249", 1250], ["99", 1250], ["-5", 1250], ["12.5", 1250], ["3001", 3000], ["99999", 3000], ["12345", 1250]] as const) {
    const info = start();
    typeInto(info, "zoomMax", "3000"); typeInto(info, "zoomMin", "1250"); typeInto(info, "zoomDefault", "2000");
    typeInto(info, k, t);
    assert.equal(infoNumber(info, k), k === "zoomDefault" && want > 3000 ? 3000 : want, `${k} ${t}`);
  }
  let info = start();
  typeInto(info, "zoomMax", "3000"); typeInto(info, "zoomDefault", "2000");
  typeInto(info, "zoomDefault", "3000"); typeInto(info, "zoomMax", "2500");
  assert.deepEqual(read(info, ...all), [1250, 2500, 2500], "max below default pulls default down");
  typeInto(info, "zoomMax", "1500"); typeInto(info, "zoomMin", "1400");
  assert.deepEqual(read(info, ...all), [1400, 1500, 1500]);
  typeInto(info, "zoomMax", "1300");
  assert.deepEqual(read(info, ...all), [1300, 1300, 1300], "max below default and min pulls both down");
  info = start();
  typeInto(info, "zoomMax", "3000"); typeInto(info, "zoomDefault", "2000");
  typeInto(info, "zoomDefault", "3000");
  typeInto(info, "zoomDefault", "9999");
  assert.deepEqual(read(info, ...all), [1250, 3000, 3000], "default above max is max");
  typeInto(info, "zoomMin", "2999");
  assert.deepEqual(read(info, ...all), [2999, 3000, 3000]);
  typeInto(info, "zoomMax", "2999"); typeInto(info, "zoomMin", "2999");
  assert.deepEqual(read(info, ...all), [2999, 2999, 2999]);
  info = start();
  typeInto(info, "zoomMax", "3000"); typeInto(info, "zoomMin", "1250"); typeInto(info, "zoomDefault", "1250");
  typeInto(info, "zoomMin", "2999");
  assert.deepEqual(read(info, ...all), [2999, 2999, 3000], "min above the others pushes default and max up");
});

test("typed clamps leave stored values alone: a map's own value past the limits loads and saves as it is", () => {
  const info = fixture();
  info.water.minOpacity = 500; info.fog.start = -3; info.cameraZoom = { min: 100, default: 50, max: 9000 };
  assert.deepEqual(read(info, "waterMinOpacity", "fogStart", "zoomMin", "zoomDefault", "zoomMax"), [500, -3, 100, 50, 9000]);
  typeInto(info, "fogDensity", "5"); // an edit of another field changes none of them
  assert.deepEqual(read(info, "waterMinOpacity", "fogStart", "zoomMin", "zoomDefault", "zoomMax"), [500, -3, 100, 50, 9000]);
});
