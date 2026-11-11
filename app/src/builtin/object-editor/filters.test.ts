import assert from "node:assert/strict";
import { test } from "node:test";
import type { FieldMeta } from "../../lib/objects/metadata";
import { compare, filterValue, parseQuery, resolveField } from "./filters";

const field = (id: string, label: string, column = ""): FieldMeta => ({ id, label, field: column } as FieldMeta);
const fields = [
  field("ugol", "Gold Cost", "goldcost"),
  field("uhpm", "Hit Points Maximum (Base)", "HP"),
  field("ua1r", "Attack 1 - Range", "rangeN1"),
  field("uarm", "Armor Type"),
  field("urac", "Race", "race"),
];

test("a filter key finds its field: id, column, label", () => {
  const id = (key: string) => resolveField(fields, key)?.id;
  assert.equal(id("UGOL"), "ugol", "the id");
  assert.equal(id("goldcost"), "ugol", "the game's column");
  assert.equal(id("hp"), "uhpm", "the column, in any case");
  assert.equal(id("armortype"), "uarm", "the label without spaces");
  assert.equal(id("armor_type"), "uarm", "underscores for spaces");
  assert.equal(id("range"), "ua1r", "a whole word of a label");
  assert.equal(id("arm"), "uarm", "the start of a label");
  assert.equal(id("oints"), "uhpm", "inside a label");
  assert.equal(resolveField(fields, "nothing"), null);
});

test("the id wins over the column, and the shortest label over a longer one", () => {
  assert.equal(resolveField([field("a", "x", "hp"), field("hp", "y")], "hp")?.id, "hp");
  assert.equal(resolveField([field("long", "Attack Range Extra Long"), field("short", "Range")], "range")?.id, "short");
});

test("a key with regular expression characters is only text", () => {
  assert.equal(resolveField(fields, "(base"), fields[1]);
  assert.equal(resolveField(fields, "[["), null);
});

test("what's typed splits into filters and words", () => {
  const { words, filters } = parseQuery("  Foot gold>=100 hp<5  race=Human name:x ", fields);
  assert.deepEqual(words, ["foot"]);
  assert.deepEqual(filters.map((f) => [f.key, f.op, f.value, f.field?.id ?? null]), [
    ["gold", ">=", "100", "ugol"], ["hp", "<", "5", "uhpm"], ["race", "=", "Human", "urac"], ["name", ":", "x", null],
  ]);
  assert.equal(filters[0].token, "gold>=100");
});

test("each operator: the longer one is read first, and a value can hold one", () => {
  const op = (token: string) => { const f = parseQuery(token, fields).filters[0]; return [f.op, f.value]; };
  assert.deepEqual(op("a>=1"), [">=", "1"]);
  assert.deepEqual(op("a<=1"), ["<=", "1"]);
  assert.deepEqual(op("a!=1"), ["!=", "1"]);
  assert.deepEqual(op("a:b=c"), [":", "b=c"]);
  assert.deepEqual(op("a="), ["=", ""]);
});

test("something that's only an operator is a word", () => {
  assert.deepEqual(parseQuery(">5", fields).words, [">5"]);
  assert.deepEqual(parseQuery(">5", fields).filters, []);
});

test("numbers compare as numbers", () => {
  assert.ok(compare("135", ">", "100"));
  assert.ok(!compare("99", ">", "100"), "as text, 99 comes after 100");
  assert.ok(compare("100", ">=", "100"));
  assert.ok(!compare("100", ">", "100"));
  assert.ok(compare("100", "<=", "100"));
  assert.ok(compare("5", "<", "10"));
  assert.ok(compare("1.50", "=", "1.5"), "the same number written differently");
  assert.ok(compare("2", "!=", "1"));
});

test("text compares as text, in any case", () => {
  assert.ok(compare("Human", "=", "human"));
  assert.ok(compare("Human", "!=", "orc"));
  assert.ok(compare("Night Elf", ":", "ELF"));
  assert.ok(!compare("human", ">", "abc"), "no order for text");
  assert.ok(!compare("human", "<", "zzz"));
  assert.ok(!compare("", "=", "0"), "an empty cell isn't zero");
  assert.ok(!compare("0", "=", ""), "an empty filter isn't zero");
});

test("the filter builder's underscores are spaces", () => {
  assert.equal(filterValue("Night_Elf"), "Night Elf");
  assert.ok(compare("Night Elf", "=", "Night_Elf"), "the chip says Night Elf");
  assert.ok(compare("Night Elf", ":", "t_E"));
  assert.ok(!compare("Night Elf", "!=", "Night_Elf"));
  assert.ok(compare("nightelf_a", "=", "nightelf a"), "both ways");
});

test("a field the object doesn't have only passes \"not\"", () => {
  assert.ok(compare(undefined, "!=", "1"));
  for (const op of [">", ">=", "<", "<=", "=", ":"] as const) assert.ok(!compare(undefined, op, "1"), op);
  assert.ok(compare(undefined, "!=", "1", "x"), "with a label too");
  assert.ok(!compare(undefined, "=", "1", "1"));
});

test("a choice field's filter matches the stored value or the label it shows", () => {
  // The builder writes "Night Elf" as urac:Night_Elf; the game stores "nightelf".
  assert.ok(compare("nightelf", ":", "Night_Elf", "Night Elf"), "the label, spaces as underscores");
  assert.ok(compare("nightelf", "=", "night elf", "Night Elf"), "the label, in any case");
  assert.ok(compare("nightelf", ":", "nightelf", "Night Elf"), "the stored value still");
  assert.ok(compare("nightelf", "=", "NIGHTELF", "Night Elf"));
  assert.ok(!compare("nightelf", ":", "Orc", "Night Elf"));
  assert.ok(!compare("nightelf", "!=", "Night_Elf", "Night Elf"), "not: neither may be equal");
  assert.ok(!compare("nightelf", "!=", "nightelf", "Night Elf"));
  assert.ok(compare("nightelf", "!=", "orc", "Night Elf"));
  assert.ok(compare("3", ">", "2", "Night Elf"), "an order compares the stored value");
  assert.ok(!compare("x", ">", "0", "5"), "never the label");
});
