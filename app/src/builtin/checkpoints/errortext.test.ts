import assert from "node:assert/strict";
import { test } from "node:test";
import { checkpointErrorText } from "./errortext";

const cases: [string, string, RegExp][] = [
  ["Die Datei existiert bereits. (os error 17)", "exists", /already exists/],
  ["File exists (os error 17)", "exists", /already exists/],
  ["Eine Datei kann nicht erstellt werden, wenn sie bereits vorhanden ist. (os error 183)", "exists", /already exists/],
  ["Das System kann die angegebene Datei nicht finden. (os error 2)", "not found", /wasn't found/],
  ["No such file or directory (os error 2)", "not found", /wasn't found/],
  ["Das System kann den angegebenen Pfad nicht finden. (os error 3)", "not found", /wasn't found/],
  ["Keine Berechtigung (os error 13)", "denied", /refused access/],
  ["Zugriff verweigert. (os error 5)", "denied", /refused access/],
  ["Permission denied (os error 13)", "denied", /refused access/],
  ["Auf dem Gerät ist kein Speicherplatz mehr verfügbar. (os error 28)", "full", /disk is full/],
  ["Nicht genügend Speicherplatz auf dem Datenträger. (os error 112)", "full", /disk is full/],
  ["No space left on device (os error 28)", "full", /disk is full/],
  ["the packer crashed", "other", /couldn't be completed/],
];

test("the usual checkpoint failures get a plain English line, with the system's words as details", () => {
  for (const [raw, , re] of cases) {
    const t = checkpointErrorText(new Error(raw), "map-1.w3x");
    assert.match(t, /^Checkpoint failed: /, raw);
    assert.match(t, re, raw);
    assert.ok(t.endsWith(`Details: ${raw}`), raw);
  }
});

test("the name is used when given; a non-Error is shown as text", () => {
  assert.match(checkpointErrorText("x (os error 17)", "a.w3x"), /the checkpoint a\.w3x already exists/);
  assert.match(checkpointErrorText("x (os error 17)"), /the checkpoint already exists/);
  assert.match(checkpointErrorText(42), /Details: 42$/);
});

test("control: an unrelated number is not taken for a code", () => {
  assert.match(checkpointErrorText(new Error("1700 files (os error 99)")), /couldn't be completed/);
});
