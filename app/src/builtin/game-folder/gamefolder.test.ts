import test from "node:test";
import assert from "node:assert/strict";
import { gameFolderItems } from "./gamefolder";

test("game folder choices: the installs in the order found, the newest marked, then by hand and later", () => {
  const items = gameFolderItems([
    { path: "/steam/pfx/drive_c/Program Files (x86)/Warcraft III", version: "3.0.1.24371" },
    { path: "/lutris/drive_c/Program Files (x86)/Warcraft III", version: "2.0.2.22796" },
  ]);
  assert.deepEqual(items.map((i) => i.label), ["Warcraft III 3.0.1.24371", "Warcraft III 2.0.2.22796", "Choose folder…", "Later"]);
  assert.equal(items[0].description, "newest");
  assert.equal(items[1].description, undefined);
  assert.deepEqual(items[0].value, { kind: "install", path: "/steam/pfx/drive_c/Program Files (x86)/Warcraft III" });
  assert.deepEqual(items[2].value, { kind: "browse" });
  assert.deepEqual(items[3].value, { kind: "later" });
});

test("game folder choices: one install isn't called the newest; none leaves choosing by hand", () => {
  const one = gameFolderItems([{ path: "C:\\Games\\Warcraft III", version: "" }]);
  assert.equal(one[0].label, "Warcraft III (build unknown)");
  assert.equal(one[0].description, undefined);
  assert.deepEqual(gameFolderItems([]).map((i) => i.label), ["Choose folder…", "Later"]);
});
