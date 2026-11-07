import assert from "node:assert/strict";
import { test } from "node:test";
import { GameDataError, gameDataError } from "./gameerror";

test("a failure to open the game's data says what's needed and where to set it, keeping the system's words as detail", () => {
  const e = gameDataError("game data: .build.info: Das System kann den angegebenen Pfad nicht finden. (os error 3)", "D:/Games/W3");
  assert.ok(e instanceof GameDataError);
  assert.match(e.message, /^The game's data couldn't be opened in "D:\/Games\/W3"\./);
  assert.match(e.message, /set "game\.installDir" to the game's folder \(Preferences: Open Settings \(JSON\)\)/);
  assert.match(e.message, /Details: \.build\.info: Das System .*\(os error 3\)$/);
  assert.equal(e.detail, ".build.info: Das System kann den angegebenen Pfad nicht finden. (os error 3)");
  assert.doesNotMatch((gameDataError(new Error("game data: x"), undefined) as Error).message, / in "/, "no folder set: none named");
});

test("other errors of the game's files pass through unchanged", () => {
  const other = "not in the storage: Units\Nope.slk";
  assert.equal(gameDataError(other, "D:/W3"), other);
  const err = new Error("unknown graphics mode");
  assert.equal(gameDataError(err, "D:/W3"), err);
});
