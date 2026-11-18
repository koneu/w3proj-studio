import assert from "node:assert/strict";
import { test } from "node:test";
import { isTypedCode, literalProblem, realText, typedInitialValue } from "./literals";

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
