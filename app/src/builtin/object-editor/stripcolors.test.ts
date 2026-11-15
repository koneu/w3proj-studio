// Colour tags as the game's own texts write them (2026-11-15, the enUS string files of the game's storage and the
// string tables of its 273 maps and smoketest_maps): always `|c` and 8 hex digits, alpha first (`|cff…` 4539 times,
// `|c00…` 157), `|C` 414 times, hex digits in either case or mixed within one tag (747), `|r` and `|R` to end one,
// colours left open to the end of the text (292 strings) and a colour opened inside another (89). Names in lists and
// pickers are shown with every tag taken out.

import assert from "node:assert/strict";
import { test } from "node:test";
import { stripColors } from "./service";

test("names lose their colour tags in every form the game's texts use", () => {
  const cases: [string, string][] = [
    ["|c00FF0303Player 1|r", "Player 1"], // alpha 00
    ["|cffff0303Red|r", "Red"], // alpha ff
    ["|c00fEBA0EOrange|r", "Orange"], // mixed-case digits
    ["|CFFAAAAAA Grey|R", " Grey"], // capital C and R (smoketest_maps, the game's string files)
    ["|cffffcc00Gold", "Gold"], // left open
    ["|cffff0000a|cff00ff00b|r c", "ab c"], // one opened inside another
  ];
  for (const [shown, plain] of cases) assert.equal(stripColors(shown), plain, shown);
});

test("other pipes stay: a line break, a pipe on its own, a |c without 8 hex digits", () => {
  // `|n` / `|N` is a line break in the game's texts (5794 / 129 times in its string files), "x | y" and "Exodus|of|the
  // Horde" are plain pipes there; a |c with fewer digits occurs nowhere, and isn't taken for a colour.
  for (const s of ["one|ntwo", "Bit Or Operation (x | y)", "Exodus|of|the Horde", "|c12 short", "|cgggggggg"]) assert.equal(stripColors(s), s);
});
