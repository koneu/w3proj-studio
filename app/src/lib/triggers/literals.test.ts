import assert from "node:assert/strict";
import { test } from "node:test";
import { filterTriggerTyping, isTypedCode, literalProblem, realText, typedInitialValue, typedTriggerNumber } from "./literals";

test("an integer parameter value the script can't hold (past 32 bits, not whole, an exponent) is refused; its edges are taken", () => {
  for (const typed of ["2147483648", "-2147483649", "99999999999", "0x80000000", "0xFFFFFFFF", "1.5", "1e5", "", "abc", "+5", "Infinity"]) {
    assert.notEqual(literalProblem("integer", typed), null, JSON.stringify(typed));
  }
  for (const typed of ["2147483647", "-2147483648", "0", " 12 ", "0x7FFFFFFF", "0x10"]) assert.equal(literalProblem("integer", typed), null, JSON.stringify(typed));
  assert.match(literalProblem("integer", "2147483648")!, /from -2147483648 to 2147483647/);
});

test("a real parameter value the script can't hold (past a 32-bit float, an exponent, not a number) is refused; its edges are taken", () => {
  for (const typed of ["1e39", "1.5e3", "", "x", "Infinity", "NaN", "1".padEnd(40, "0"), "-" + "4".padEnd(39, "0")]) {
    assert.notEqual(literalProblem("real", typed), null, JSON.stringify(typed));
  }
  for (const typed of ["0", "-1.5", ".5", "5.", "340282346638528859811704183484516925440", "-340282346638528859811704183484516925440"]) {
    assert.equal(literalProblem("real", typed), null, JSON.stringify(typed));
  }
  assert.match(literalProblem("real", "1".padEnd(40, "0"))!, /32-bit float/);
  assert.equal(literalProblem("string", "1e99"), null, "other types aren't numbers");
});

test("a variable's initial value it can't hold is refused (integer past 32 bits, real past a 32-bit float, a code not 4 long); its edges are taken", () => {
  for (const [base, type, typed] of [["integer", "integer", "2147483648"], ["integer", "integer", "1.5"], ["integer", "integer", "x"],
    ["real", "real", "1e39"], ["real", "real", "x"], ["integer", "unitcode", "hfo"]] as const) {
    assert.ok("refused" in typedInitialValue(base, type, typed), `${type} ${typed}`);
  }
  assert.deepEqual(typedInitialValue("integer", "integer", "-2147483648"), { value: "-2147483648" });
  assert.deepEqual(typedInitialValue("integer", "integer", ""), { value: null }, "empty: the default");
  assert.deepEqual(typedInitialValue("real", "real", "1.5"), { value: "1.50" });
  const big = typedInitialValue("real", "real", "3.4e38");
  assert.ok("value" in big && /^\d{39}\.00$/.test(big.value!) && Number(big.value) === 3.4e38, `large, without an exponent: ${JSON.stringify(big)}`);
  assert.deepEqual(typedInitialValue("integer", "unitcode", "hfoo"), { value: "hfoo" });
  assert.deepEqual(typedInitialValue("string", "string", " a "), { value: " a " });
  assert.equal(realText(1e21), "1000000000000000000000.00");
  assert.equal(realText(-2.5), "-2.50");
});

test("a 4-character code typed for a code type is taken as it is, not read as a number", () => {
  assert.equal(isTypedCode("unitcode", "hfoo"), true);
  assert.equal(isTypedCode("abilcode", " AHbz "), true);
  for (const [type, typed] of [["unitcode", "hfo"], ["unitcode", "hfooo"], ["integer", "hfoo"], ["unitcode", "'hfo'"], ["unitcode", "h\\oo"]]) assert.equal(isTypedCode(type, typed), false, `${type} ${typed}`);
});

/** What the World Editor's Integer / Real box keeps for text typed into it (ya.md 2026-11-22). */
const typedIn = (base: "integer" | "real", text: string) => { const r = typedTriggerNumber(base, filterTriggerTyping(base, text)); return "value" in r ? r.value : `refused: ${r.refused}`; };

test("a typed Integer value goes through wrap, float32 and the 1e9 limit as the World Editor does (ya.md)", () => {
  for (const [typed, want] of [["123456789", "123456792"], ["999999999", "1000000000"], ["12.5", "125"], ["2147483648", "-1000000000"],
    ["3000000000", "-1000000000"], ["4294967297", "1"], ["99999999999", "1000000000"], ["-99999999999", "-1000000000"], ["-5", "-5"],
    ["0", "0"], ["-0", "0"], ["1000000000", "1000000000"], ["1000000001", "1000000000"], ["", null]] as const) {
    assert.equal(typedIn("integer", typed), want, typed);
  }
  assert.match(typedIn("integer", "-")!, /^refused/);
  assert.equal(filterTriggerTyping("integer", "1.5e3"), "153");
  assert.equal(filterTriggerTyping("string", "1.5e3"), "1.5e3");
});

test("a typed Real value is limited to 1e9 with two decimals as the World Editor does (ya.md)", () => {
  for (const [typed, want] of [["-5", "-5.00"], ["12.5", "12.50"], ["12.345", "12.35"], ["100000", "100000.00"], ["1.5e3", "1.53"],
    ["99999999999", "1000000000.00"], ["-99999999999", "-1000000000.00"], ["0.001", "0.00"], ["0.005", "0.00"], ["-0.001", "0.00"], [".5", "0.50"]] as const) {
    assert.equal(typedIn("real", typed), want, typed);
  }
  assert.match(typedIn("real", "-")!, /^refused/);
  assert.match(typedIn("real", "1-2")!, /^refused/);
});

test("the MCP path still refuses what the box would wrap or clamp (a typed edit is the only one that is pulled in)", () => {
  assert.ok("refused" in typedInitialValue("integer", "integer", "2147483648"));
  assert.deepEqual(typedInitialValue("integer", "integer", "1500000000"), { value: "1500000000" });
});
