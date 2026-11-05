import assert from "node:assert/strict";
import { test } from "node:test";
import { changesImports } from "./filewatch";

test("the generated minimap isn't an import, or every save would reload all models", () => {
  for (const p of ["map/war3mapMap.blp", "map\\war3mapMap.blp", "MAP/WAR3MAPMAP.BLP", "map/war3mapMap.tga", "map/war3mapPreview.tga"]) assert.equal(changesImports(p), false, p);
});

test("imported art and the import list are", () => {
  for (const p of ["map/war3map.imp", "map/war3map.imp.json", "map/Hero.mdx", "map/war3mapImported/Tree.blp", "map/textures/rock.dds"]) assert.equal(changesImports(p), true, p);
});

test("the rest isn't", () => {
  for (const p of ["map/war3map.w3e.txt", "map/war3map.doo.json", "build/x.blp", "map/war3map.wpm"]) assert.equal(changesImports(p), false, p);
});
