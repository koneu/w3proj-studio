import assert from "node:assert/strict";
import { test } from "node:test";
import { errorText, isNotFoundError } from "./oserror";

test("errorText: an Error's message, and the plain string a backend call rejects with (not 'undefined')", () => {
  assert.equal(errorText(new Error("bad header")), "bad header");
  assert.equal(errorText("No such file or directory (os error 2)"), "No such file or directory (os error 2)");
  assert.equal(errorText({ message: "from a DOMException-like object" }), "from a DOMException-like object");
  assert.equal(errorText(42), "42");
  const nameless = new Error(""); nameless.name = "AbortError";
  assert.equal(errorText(nameless), "AbortError");
});

test("only os errors 2 and 3 are 'not found', in any language and whether a string or an Error", () => {
  assert.equal(isNotFoundError("The system cannot find the file specified. (os error 2)"), true);
  assert.equal(isNotFoundError(new Error("Das System kann den angegebenen Pfad nicht finden. (os error 3)")), true);
  assert.equal(isNotFoundError("os error 2"), true);
  for (const n of [5, 20, 21, 22, 23, 24, 32, 33, 123, 267, 12, 13]) {
    assert.equal(isNotFoundError(`something (os error ${n})`), false, `os error ${n}`);
    assert.equal(isNotFoundError(new Error(`something (os error ${n})`)), false, `Error with os error ${n}`);
  }
  assert.equal(isNotFoundError(undefined), false);
  assert.equal(isNotFoundError({ code: 2 }), false);
  assert.equal(isNotFoundError(new Error("NOT_UTF8")), false);
});
