import assert from "node:assert/strict";
import { test } from "node:test";
import { headerPrintf, headerPrintfIssues } from "./printf";

// What the World Editor's save wrote for each header text (we-compare header-printf and the 2026-11-22 round's pct
// specs: target/evidence/verify-2026-11-22/wb.md).
const MEASURED: [string, string][] = [
  ["%%", "%"], ["%*", ""], ["100%|", "100|"], ["%%%|", "%|"], ["%%%%", "%%"], ["%%*", "%*"], ["%*%", "%"], ["%%d", "%d"],
  ["a%%b%%c", "a%b%c"], ["%%%*%%|", "%%|"], ["%**", "*"], ["%%%%%*|", "%%|"], ["x%|", "x|"], ["%%%%%%", "%%%"],
  ["// c1 100%% and %* and 5%\n", "// c1 100% and  and 5\n"], ["%z %q %y", " q y"], ["%*|", "|"],
  // The text ends inside a sequence: nothing of it is written (header-printf-end1, -end2).
  ["// end x%", "// end x"], ["// end y%5", "// end y"],
  // Lua's modulo: "% 3)" is a space flag, a width and a char that ends it (header-printf-lua-mod).
  ["tostring(7 % 3)", "tostring(7 )"],
  // The grammar before a char that ends the sequence (header-printf-new, each followed by "|").
  ...([["%5%", "%"], ["%.3", ""], ["%hh", ""], ["%I64", ""], ["%-", ""], ["%0", ""], ["%#", ""], ["%+", ""], ["%l%", "%"], ["%5*", "*"],
    ["%.*", ""], ["%*5", ""], ["%I3", "3"], ["%I32", ""], ["%w", ""], ["%T", ""], ["%L", ""], ["%j", ""], ["%t", ""], ["%q%%", "q%"],
    ["%-5.2%", "%"], ["%.", ""], ["%.5.", "."], ["%h%", "%"], ["% ", ""], ["%!", "!"], ["%'", "'"], ["%$", "$"], ["%1$", "$"], ["%b", "b"],
    ["%D", "D"], ["%ll", ""], ["%I64%", "%"], ["%v", "v"], ["%k", "k"], ["%r", "r"]] as [string, string][]).map(([t, w]): [string, string] => [`${t}|`, `${w}|`]),
];

test("the header as the World Editor's printf writes it", () => {
  for (const [text, want] of MEASURED) assert.equal(headerPrintf(text), want, JSON.stringify(text));
});

test("a header without % is the same string; conversions stay as written", () => {
  const plain = "function H takes nothing returns nothing\r\nendfunction\n";
  assert.equal(headerPrintf(plain), plain);
  assert.equal(headerPrintf("x %d %5d %-x %*d %s % s %n %%d"), "x %d %5d %-x %*d %s % s %n %d");
});

test("the conversions the editor prints garbage for or crashes on are reported with their line; %% and the rest aren't", () => {
  assert.deepEqual(headerPrintfIssues("a %d\n100% sure\n%%s %5.2f %ls"), [
    { spec: "%d", at: 2, line: 1, kind: "garbage" },
    { spec: "% s", at: 8, line: 2, kind: "crash" },
    { spec: "%5.2f", at: 19, line: 3, kind: "garbage" },
    { spec: "%ls", at: 25, line: 3, kind: "crash" },
  ]);
  assert.deepEqual(headerPrintfIssues("%% %* %| x% 100% %hh| %ll| %I64| %I3|"), []);
  assert.deepEqual(headerPrintfIssues("%n").map((i) => i.kind), ["crash"]);
});

test("N and a second length modifier after a whole one crash the editor's save (header-printf-new: %lz, %N)", () => {
  assert.deepEqual(headerPrintfIssues("a %lz| b %N| c %hhh| d %I64l|").map((i) => [i.spec, i.kind]), [["%lz", "crash"], ["%N", "crash"], ["%hhh", "crash"], ["%I64l", "crash"]]);
  assert.equal(headerPrintf("a %lz|"), "a %lz|", "kept as written");
});
