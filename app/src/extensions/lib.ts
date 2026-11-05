// What extensions get from `await w3.lib()`: the same parsers, writers and checks the built-ins
// use. Built-ins import src/lib directly; user and project extensions are plain modules without
// a build step, so this is their way in. Loaded on first use.
//
// `version` goes up when something here changes in a way that breaks extensions.

import { toArchiveName, toProjectPath } from "../lib/formats/archivepath";
import { readIni, setIniValue } from "../lib/formats/iniedit";
import { decodeLossless, encodeLossless } from "../lib/formats/lossless";
import { parseIni, parseSlk, westring } from "../lib/formats/text";
import { StringTable } from "../lib/formats/wts";
import { encodeBlp1Jpeg } from "../lib/image/encode";
import { decodeImage } from "../lib/image/index.ts";
import { checkJass } from "../lib/jass/check";
import { gameJassEnv } from "../lib/jass/env";
import { checkLua } from "../lib/lua/check";
import { parseMdx } from "../lib/model/mdx";
import { loadKind } from "../lib/objects/metadata";
import { lostFunctions } from "../lib/script/guard";
import { generateScript } from "../lib/script/jass";
import { heightAt, parseW3e, writeW3e } from "../lib/terrain/w3e";
import { readTerrainBytes, terrainPath, writeTerrainBytes } from "../lib/terrain/w3etext";
import { missingRefs, triggerRefs } from "../lib/triggers/refs";
import { parseTriggerData } from "../lib/triggers/triggerdata";
import { parseWct, parseWctText, parseWtg, parseWtgJson, readWctFile, readWtgFile, writeWct, writeWctFile, writeWctText, writeWtg, writeWtgFile, writeWtgJson, wtgPath } from "../lib/triggers/wtg";

export const version = 1;

export const formats = { parseIni, parseSlk, westring, readIni, setIniValue, StringTable, decodeLossless, encodeLossless, toArchiveName, toProjectPath };
export const terrain = { parseW3e, writeW3e, heightAt, terrainPath, readTerrainBytes, writeTerrainBytes };
export const triggers = {
  parseTriggerData, parseWtg, writeWtg, parseWtgJson, writeWtgJson, readWtgFile, writeWtgFile, wtgPath,
  parseWct, writeWct, parseWctText, writeWctText, readWctFile, writeWctFile, triggerRefs, missingRefs,
};
export const objects = { loadKind };
export const image = { decodeImage, encodeBlp1Jpeg };
export const model = { parseMdx };
export const script = { generateScript, lostFunctions, checkJass, gameJassEnv, checkLua };
